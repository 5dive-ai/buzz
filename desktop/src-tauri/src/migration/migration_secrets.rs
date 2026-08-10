//! Boot-time secret extraction: lifts inline env vars, auth tags, and
//! provider configs from JSON into the OS keyring via the generation-reference
//! protocol, then runs the two-cycle GC sweeps and artifact cleanup.
//!
//! Runs ONCE at the END of `run_boot_migrations_inner` (after
//! `materialize_agent_runtimes`) so raw-JSON migrations see inline values.
//! Idempotent: records that already have refs skip the write path.

use tauri::Manager;

/// Extract inline secrets (env vars, auth tags, provider configs) from JSON
/// into the keyring.  Also runs the two-cycle GC sweeps and, when the keyring
/// is reachable, Phase 2 artifact cleanup.
pub(super) fn migrate_inline_secrets_to_keyring(app: &tauri::AppHandle) {
    // Track whether the keyring is reachable — Phase 2 cleanup must not run
    // when the keyring is unavailable (we must never delete the only copy of a
    // secret).
    let keyring_reachable = crate::managed_agents::storage::agent_secret_store_pub().is_some();

    if let Ok(mut records) = crate::managed_agents::storage::load_agent_store_raw(app) {
        let changed = migrate_inline_secrets_in_records(app, &mut records);
        if changed {
            if let Err(e) = crate::managed_agents::storage::write_agent_store_raw(app, &records) {
                eprintln!("buzz-desktop: boot-migration: failed to write agent store: {e}");
            }
        }
    } else {
        eprintln!("buzz-desktop: boot-migration: could not load agent store for secret migration");
    }
    if let Ok(global) = crate::managed_agents::global_config::load_global_agent_config(app) {
        if !global.env_vars.is_empty() || global.env_vars_ref.is_none() {
            if let Err(e) =
                crate::managed_agents::global_config::save_global_agent_config(app, &global)
            {
                eprintln!("buzz-desktop: boot-migration: global config save failed: {e}");
            }
        }
    }
    run_secret_gc(app);
    // Phase 2: artifact cleanup — only when the keyring is reachable.
    if keyring_reachable {
        if let Ok(agents_dir) = crate::managed_agents::storage::managed_agents_base_dir(app) {
            cleanup_secret_artifacts(&agents_dir);
        }
        // Also clean the legacy Sprout app-data agents dir if it still exists.
        // `migrate_legacy_app_data_dir` copies files from there but never removes
        // the source — it can hold the original plaintext managed-agents.json and
        // its backups indefinitely.
        if let Ok(current_dir) = app.path().app_data_dir() {
            if let Some(legacy_dir) = super::legacy_app_data_dir(&current_dir) {
                let legacy_agents_dir = legacy_dir.join("agents");
                if legacy_agents_dir.exists() {
                    cleanup_secret_artifacts(&legacy_agents_dir);
                }
            }
        }
    }
}

/// Run the two-cycle GC sweeps for the secret projection.
pub(crate) fn run_secret_gc(app: &tauri::AppHandle) {
    let agents_path = match crate::managed_agents::storage::managed_agents_store_path(app) {
        Ok(p) => p,
        Err(_) => return,
    };
    let global_path = match app.path().app_data_dir() {
        Ok(d) => d.join("agents/global-agent-config.json"),
        Err(_) => return,
    };
    if let Some(store) = crate::managed_agents::storage::agent_secret_store_pub() {
        // Two-cycle GC: DELETE candidates from the PREVIOUS boot first, THEN
        // mark new candidates for this boot.  This ordering is the safety
        // invariant: a generation written and verified in boot N is only ever
        // eligible for deletion in boot N+2 or later, giving a full boot cycle
        // of grace for any cross-process save that is sitting between its
        // keyring write and its JSON commit when GC runs.
        crate::managed_agents::secret_projection::delete_gc_candidates(
            store,
            &agents_path,
            &global_path,
        );
        crate::managed_agents::secret_projection::mark_gc_candidates(
            store,
            &agents_path,
            &global_path,
        );
    }
}

/// Phase 2 artifact cleanup, run after a verified extraction boot.
///
/// Invariants:
/// - ONLY called when the keyring is reachable (caller gate).
/// - NEVER follows symlinks outside `agents_dir`.
/// - Parseable `*.bak-*` / `*.bak` backup files are re-serialized with all
///   secret fields stripped (env_vars, auth_tag, private_key_nsec, provider
///   config).
/// - Unparseable / `.invalid` / atomic-write temp siblings are DELETED — they
///   cannot be recovered and may carry plaintext credentials.
/// - All JSON-shaped files in `agents_dir` (top level only) receive a 0o600
///   permission sweep.
/// - Errors on individual files are logged and never abort the sweep.
pub(crate) fn cleanup_secret_artifacts(agents_dir: &std::path::Path) {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    // Canonicalize the agents dir so we have a stable root for escape checks.
    let canonical_dir = match std::fs::canonicalize(agents_dir) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("buzz-desktop: artifact-cleanup: cannot canonicalize agents dir: {e}");
            return;
        }
    };

    let entries = match std::fs::read_dir(&canonical_dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("buzz-desktop: artifact-cleanup: cannot read agents dir: {e}");
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();

        // Resolve the real path and reject anything that escapes agents_dir.
        let real_path = match std::fs::canonicalize(&path) {
            Ok(p) => p,
            Err(_) => path.clone(), // dangling symlink or unresolvable — skip
        };
        if !real_path.starts_with(&canonical_dir) {
            eprintln!(
                "buzz-desktop: artifact-cleanup: skipping symlink escape: {}",
                path.display()
            );
            continue;
        }

        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }

        let fname = match path.file_name().and_then(|n| n.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        // ── 0o600 sweep ──────────────────────────────────────────────────
        #[cfg(unix)]
        if fname.ends_with(".json")
            || fname.contains(".json.bak")
            || fname.ends_with(".json.invalid")
        {
            let _ = std::fs::set_permissions(&real_path, std::fs::Permissions::from_mode(0o600));
        }

        // ── Atomic-write temp siblings ────────────────────────────────────
        // `atomic-write-file` names temps as random hex strings with no
        // extension on Unix.  Identify and delete them.
        if is_atomic_write_temp(&fname) {
            if let Err(e) = std::fs::remove_file(&real_path) {
                eprintln!("buzz-desktop: artifact-cleanup: cannot remove temp file {fname}: {e}");
            } else {
                eprintln!("buzz-desktop: artifact-cleanup: removed stale temp file {fname}");
            }
            continue;
        }

        // ── .invalid files ────────────────────────────────────────────────
        if fname.ends_with(".invalid") {
            if let Err(e) = std::fs::remove_file(&real_path) {
                eprintln!(
                    "buzz-desktop: artifact-cleanup: cannot remove .invalid file {fname}: {e}"
                );
            } else {
                eprintln!("buzz-desktop: artifact-cleanup: removed .invalid artifact {fname}");
            }
            continue;
        }

        // ── Backup files (.bak-*, .bak) ───────────────────────────────────
        if is_backup_filename(&fname) {
            scrub_backup_file(&real_path, &fname);
        }
    }
}

/// Returns true when `fname` looks like an atomic-write-file temp: no
/// extension, at least 8 characters, all ASCII hex digits.
fn is_atomic_write_temp(fname: &str) -> bool {
    !fname.contains('.') && fname.len() >= 8 && fname.chars().all(|c| c.is_ascii_hexdigit())
}

/// Returns true when `fname` is a backup file we should scrub.
fn is_backup_filename(fname: &str) -> bool {
    // managed-agents.json.bak-<timestamp>
    // managed-agents.json.bak
    // personas.json.bak-<timestamp> / teams.json.bak-<timestamp>
    let is_json_bak = fname.contains(".json.bak");
    is_json_bak
        && (fname.starts_with("managed-agents")
            || fname.starts_with("personas")
            || fname.starts_with("teams"))
}

/// Strip secret fields from a parseable backup and overwrite it at 0o600.
/// Delete the file when unparseable (may carry plaintext credentials).
fn scrub_backup_file(path: &std::path::Path, fname: &str) {
    let content = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("buzz-desktop: artifact-cleanup: cannot read backup {fname}: {e}");
            return;
        }
    };

    match strip_secrets_from_json(&content) {
        Some(clean) => {
            match crate::managed_agents::storage::atomic_write_json_restricted(
                path,
                clean.as_bytes(),
            ) {
                Ok(()) => eprintln!("buzz-desktop: artifact-cleanup: scrubbed backup {fname}"),
                Err(e) => eprintln!(
                    "buzz-desktop: artifact-cleanup: cannot write scrubbed backup {fname}: {e}"
                ),
            }
        }
        None => {
            // Unparseable → delete.
            if let Err(e) = std::fs::remove_file(path) {
                eprintln!(
                    "buzz-desktop: artifact-cleanup: cannot remove unparseable backup {fname}: {e}"
                );
            } else {
                eprintln!("buzz-desktop: artifact-cleanup: removed unparseable backup {fname}");
            }
        }
    }
}

/// Attempt to strip secret fields from a JSON document.
///
/// Handles two shapes:
/// - Array of agent records → strips `env_vars`, `auth_tag`,
///   `private_key_nsec`, and `BackendKind::Provider.config`.
/// - Object (global-agent-config) → strips `env_vars`.
///
/// Returns `None` when the content cannot be parsed as either shape.
fn strip_secrets_from_json(content: &str) -> Option<String> {
    use serde_json::Value;

    let mut v: Value = serde_json::from_str(content).ok()?;
    match &mut v {
        Value::Array(records) => {
            for record in records.iter_mut() {
                if let Value::Object(map) = record {
                    map.remove("env_vars");
                    map.remove("auth_tag");
                    map.remove("private_key_nsec");
                    // Strip BackendKind::Provider.config.
                    // BackendKind uses #[serde(tag = "type", rename_all = "snake_case")],
                    // so provider is stored as {"type": "provider", "id": "...", "config": {...}}.
                    if let Some(Value::Object(backend)) = map.get_mut("backend") {
                        let is_provider = backend
                            .get("type")
                            .and_then(Value::as_str)
                            .map(|t| t == "provider")
                            .unwrap_or(false);
                        if is_provider {
                            backend.remove("config");
                        }
                    }
                }
            }
        }
        Value::Object(map) => {
            map.remove("env_vars");
        }
        _ => return None,
    }
    serde_json::to_string_pretty(&v).ok()
}

fn migrate_inline_secrets_in_records(
    _app: &tauri::AppHandle,
    records: &mut [crate::managed_agents::ManagedAgentRecord],
) -> bool {
    let Some(store) = crate::managed_agents::storage::agent_secret_store_pub() else {
        return false;
    };
    let mut changed = false;
    for record in records.iter_mut() {
        let before_env_ref = record.env_vars_ref.clone();
        let before_auth_ref = record.auth_tag_ref.clone();
        let before_pc_ref = record.provider_config_ref.clone();
        if record.pubkey.is_empty() {
            crate::managed_agents::secret_seam::strip_and_persist_definition_secrets_with(
                store, record,
            );
        } else {
            crate::managed_agents::secret_seam::strip_and_persist_agent_secrets_with(store, record);
        }
        if record.env_vars_ref != before_env_ref
            || record.auth_tag_ref != before_auth_ref
            || record.provider_config_ref != before_pc_ref
        {
            changed = true;
        }
    }
    changed
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_atomic_write_temp_recognizes_hex_names() {
        assert!(is_atomic_write_temp("deadbeefcafe0123"));
        assert!(!is_atomic_write_temp("managed-agents.json"));
        assert!(!is_atomic_write_temp("abc")); // too short
        assert!(!is_atomic_write_temp("deadbeef.tmp")); // has extension
        assert!(!is_atomic_write_temp("not-hex-at-all"));
    }

    #[test]
    fn test_is_backup_filename_recognizes_backups() {
        assert!(is_backup_filename(
            "managed-agents.json.bak-20260608-175938"
        ));
        assert!(is_backup_filename("managed-agents.json.bak"));
        assert!(is_backup_filename("personas.json.bak-20260608-175938"));
        assert!(is_backup_filename("teams.json.bak-20260608-175938"));
        assert!(!is_backup_filename("managed-agents.json"));
        assert!(!is_backup_filename("managed-agents.json.invalid"));
        assert!(!is_backup_filename("global-agent-config.json.bak-20260608")); // not in our set
    }

    #[test]
    fn test_strip_secrets_from_json_strips_agent_records() {
        let input = r#"[
          {
            "pubkey": "abc123",
            "name": "test-agent",
            "env_vars": {"ANTHROPIC_API_KEY": "sk-ant-secret"},
            "auth_tag": "some-auth-tag",
            "private_key_nsec": "nsec1secret",
            "backend": {"type": "provider", "id": "anthropic", "config": {"key": "secret"}},
            "created_at": "2026-01-01",
            "updated_at": "2026-01-01"
          }
        ]"#;
        let stripped = strip_secrets_from_json(input).unwrap();
        let v: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        let record = &v[0];
        assert!(
            record.get("env_vars").is_none(),
            "env_vars must be stripped"
        );
        assert!(
            record.get("auth_tag").is_none(),
            "auth_tag must be stripped"
        );
        assert!(
            record.get("private_key_nsec").is_none(),
            "private_key_nsec must be stripped"
        );
        let provider_config = record.get("backend").and_then(|b| b.get("config"));
        assert!(
            provider_config.is_none(),
            "provider config must be stripped"
        );
        // Non-secret fields survive.
        assert_eq!(
            record.get("name").and_then(|n| n.as_str()),
            Some("test-agent")
        );
    }

    #[test]
    fn test_strip_secrets_from_json_preserves_local_backend() {
        let input = r#"[
          {
            "pubkey": "abc123",
            "name": "local-agent",
            "backend": {"type": "local"},
            "created_at": "2026-01-01",
            "updated_at": "2026-01-01"
          }
        ]"#;
        let stripped = strip_secrets_from_json(input).unwrap();
        let v: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        // Local backend must survive unchanged — no config field to strip.
        let backend = v[0].get("backend").expect("backend must be present");
        assert_eq!(backend.get("type").and_then(|t| t.as_str()), Some("local"));
        assert!(
            backend.get("config").is_none(),
            "local backend has no config"
        );
    }

    #[test]
    fn test_strip_secrets_from_json_strips_global_config() {
        let input = r#"{"env_vars": {"KEY": "value"}, "other_field": "keep"}"#;
        let stripped = strip_secrets_from_json(input).unwrap();
        let v: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert!(v.get("env_vars").is_none(), "env_vars must be stripped");
        assert_eq!(v.get("other_field").and_then(|f| f.as_str()), Some("keep"));
    }

    #[test]
    fn test_strip_secrets_from_json_returns_none_on_unparseable() {
        assert!(strip_secrets_from_json("not valid json").is_none());
        assert!(strip_secrets_from_json("").is_none());
    }

    // ── cleanup_secret_artifacts filesystem tests ─────────────────────────

    /// Atomic-write-file temp siblings (hex-only names, no extension) are
    /// deleted during cleanup.  These can carry plaintext if a write was
    /// interrupted before the atomic rename.
    #[test]
    fn test_cleanup_deletes_atomic_write_temps() {
        let dir = tempfile::tempdir().expect("tempdir");
        let temp_path = dir.path().join("deadbeefcafe0123");
        std::fs::write(&temp_path, b"leftover content").expect("write temp");
        assert!(temp_path.exists());
        cleanup_secret_artifacts(dir.path());
        assert!(
            !temp_path.exists(),
            "atomic-write temp must be deleted by cleanup"
        );
    }

    /// Unparseable `.invalid` files are deleted during cleanup.
    #[test]
    fn test_cleanup_deletes_invalid_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let invalid_path = dir.path().join("managed-agents.json.invalid");
        std::fs::write(&invalid_path, b"not valid json with sk-ant-secret").expect("write");
        cleanup_secret_artifacts(dir.path());
        assert!(
            !invalid_path.exists(),
            ".invalid file must be deleted by cleanup"
        );
    }

    /// A backup file with parseable content is scrubbed (secrets stripped) rather
    /// than deleted.  The file should survive but without the secret value.
    #[test]
    fn test_cleanup_scrubs_parseable_backup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backup_path = dir.path().join("managed-agents.json.bak-20260608-175938");
        let content = r#"[{"pubkey":"abc","name":"test","env_vars":{"K":"v"},"created_at":"2026","updated_at":"2026"}]"#;
        std::fs::write(&backup_path, content).expect("write backup");
        cleanup_secret_artifacts(dir.path());
        assert!(backup_path.exists(), "parseable backup must survive");
        let result = std::fs::read_to_string(&backup_path).expect("read");
        assert!(
            !result.contains("\"env_vars\""),
            "secrets must be stripped from parseable backup"
        );
    }

    /// Cleanup must not follow symlinks that escape the agents dir.
    #[cfg(unix)]
    #[test]
    fn test_cleanup_skips_symlink_escape() {
        let agents_dir = tempfile::tempdir().expect("agents dir");
        // Create a target OUTSIDE the agents dir.
        let outside_dir = tempfile::tempdir().expect("outside dir");
        let outside_file = outside_dir.path().join("secret.txt");
        std::fs::write(&outside_file, b"outside-secret").expect("write outside");

        // Create a symlink inside agents_dir that points outside.
        let symlink_path = agents_dir.path().join("escape.json");
        std::os::unix::fs::symlink(&outside_file, &symlink_path).expect("create symlink");

        cleanup_secret_artifacts(agents_dir.path());

        // The file outside agents_dir must NOT be deleted.
        assert!(
            outside_file.exists(),
            "symlink escape must not delete the target outside agents dir"
        );
    }

    /// Cleanup must handle deletion failures gracefully: if a file cannot be
    /// removed (e.g. read-only), the rest of the sweep continues and no panic
    /// occurs.
    #[cfg(unix)]
    #[test]
    fn test_cleanup_tolerates_deletion_failure() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        // Make a read-only .invalid file that cannot be deleted.
        let undeletable = dir.path().join("managed-agents.json.invalid");
        std::fs::write(&undeletable, b"bad json").expect("write");

        // Also add a normal .invalid file that CAN be deleted.
        let deletable = dir.path().join("personas.json.invalid");
        std::fs::write(&deletable, b"also bad").expect("write");

        // Set the dir to read-only to prevent deletion of its entries.
        let dir_meta = std::fs::metadata(dir.path()).expect("dir meta");
        let mut perms = dir_meta.permissions();
        perms.set_mode(0o555); // r-xr-xr-x: no write
        std::fs::set_permissions(dir.path(), perms.clone()).expect("set perms");

        // Cleanup should not panic despite the failure.
        cleanup_secret_artifacts(dir.path());

        // Restore permissions so tempdir cleanup can succeed.
        perms.set_mode(0o755);
        std::fs::set_permissions(dir.path(), perms).ok();
    }
}
