//! Dev-build keyring secrets migration.
//!
//! Extracted from `storage.rs` to keep that module under the desktop
//! file-size ratchet. Copies secret-projection keys into the dev keyring
//! service on debug boots; a no-op in release builds.

use crate::app_state::keyring_service;
use tauri::Manager;

/// Marker key for the secrets migration to the dev keyring service.
/// Versioned separately from `_dev_migration_v1` (which covers only nsec keys)
/// so this migration runs even for installs that already completed v1.
#[cfg(debug_assertions)]
const DEV_SECRETS_MIGRATION_MARKER: &str = "_dev_secrets_migration_v2";

/// One-time migration of secret-projection keys (env vars, auth tags, provider
/// configs, definition env vars) from the source keyring service to the
/// destination dev service.
///
/// Called at dev-build boot, AFTER `migrate_agent_keys_to_dev_service` and
/// AFTER `migrate_inline_secrets_to_keyring` (so projection keys are present
/// in the source before we copy them).
///
/// Source determination:
/// - `buzz-desktop-dev` → source is `buzz-desktop` (production).
/// - `buzz-desktop-dev.<slug>` (scoped) → source is `buzz-desktop-dev`
///   (canonical dev), NOT production.
///
/// `global:env` is only copied when the destination's JSON reference requires
/// it (`global-agent-config.json` is not in `SHARED_AGENT_FILES`).
///
/// A coordinate present in both source and destination with different values
/// is a conflict; the migration fails closed for that coordinate and logs an
/// error rather than silently overwriting.
///
/// Idempotent: guarded by `DEV_SECRETS_MIGRATION_MARKER`; skips any key
/// already present in the destination.
#[cfg(debug_assertions)]
pub fn migrate_agent_secrets_to_dev_service(app: &tauri::AppHandle) {
    use crate::managed_agents::secret_projection::is_projection_key;

    if !cfg!(feature = "system-keyring") {
        return;
    }
    let dest_service = keyring_service();
    if dest_service == "buzz-desktop" {
        return; // never run in a release build via this path
    }
    // Determine source: scoped dev → canonical dev; canonical dev → prod.
    let is_scoped = dest_service != "buzz-desktop-dev";
    let src_service = if is_scoped {
        "buzz-desktop-dev"
    } else {
        "buzz-desktop"
    };

    let dest_store = crate::secret_store::SecretStore::shared(dest_service);

    // Read destination blob.  If the v2 migration marker is present, we ran
    // this migration already — skip entirely.
    let dest_map: std::collections::HashMap<String, String> = match dest_store.load_all_readonly() {
        Ok(Some(map)) if map.contains_key(DEV_SECRETS_MIGRATION_MARKER) => {
            return; // already done
        }
        Ok(Some(map)) => map,
        Ok(None) => std::collections::HashMap::new(),
        Err(e) => {
            eprintln!(
                "buzz-desktop: keyring-dev-secrets-migration: \
                     cannot read dest keyring ({dest_service}): {e}"
            );
            return;
        }
    };

    let src_store = crate::secret_store::SecretStore::keyring(src_service);
    let src_map: std::collections::HashMap<String, String> = match src_store.load_all_readonly() {
        Ok(Some(map)) => map,
        Ok(None) => std::collections::HashMap::new(),
        Err(e) => {
            eprintln!(
                "buzz-desktop: keyring-dev-secrets-migration: \
                 cannot read src keyring ({src_service}): {e}"
            );
            return;
        }
    };

    // Determine which projection keys to copy: those present in src, absent
    // from dest, OR where src and dest agree (idempotent).  Keys present in
    // both with DIFFERENT values are conflicts — fail closed for that key.
    //
    // Exclude `global:env:*` from the copy unless the destination JSON
    // references it (global-agent-config.json is not a shared file).
    let global_refs = collect_global_env_refs(app);

    let mut to_write: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut conflict_count = 0usize;
    for (key, src_val) in &src_map {
        if !is_projection_key(key) {
            continue; // skip non-projection keys (nsec, identity markers, etc.)
        }
        // Skip global:env:* unless the destination JSON references this gen.
        if key.starts_with("global:env:") {
            let gen = key.trim_start_matches("global:env:");
            if !global_refs.contains(gen) {
                continue;
            }
        }
        match dest_map.get(key) {
            None => {
                to_write.insert(key.clone(), src_val.clone());
            }
            Some(dest_val) if dest_val == src_val => {
                // Already identical — idempotent, no action needed.
            }
            Some(_dest_val) => {
                // Conflict: src and dest have different values.  Fail closed.
                eprintln!(
                    "buzz-desktop: keyring-dev-secrets-migration: \
                     conflict on key {key} between {src_service} and {dest_service}; \
                     refusing to overwrite (manual resolution required)"
                );
                conflict_count += 1;
            }
        }
    }

    // Always write the marker (even if there was nothing to copy) so future
    // boots skip the source-keyring read entirely.
    to_write.insert(DEV_SECRETS_MIGRATION_MARKER.to_string(), "done".to_string());

    if let Err(e) = dest_store.store_all(&to_write) {
        eprintln!(
            "buzz-desktop: keyring-dev-secrets-migration: \
             cannot write to dest keyring ({dest_service}): {e}"
        );
        return;
    }

    let copied = to_write.len().saturating_sub(1); // exclude the marker itself
    if copied > 0 {
        eprintln!(
            "buzz-desktop: keyring-dev-secrets-migration: \
             copied {copied} projection key(s) from {src_service} → {dest_service}"
        );
    }
    if conflict_count > 0 {
        eprintln!(
            "buzz-desktop: keyring-dev-secrets-migration: \
             {conflict_count} key(s) had conflicts and were NOT copied"
        );
    }
}

/// Collect the set of generation IDs referenced by `global-agent-config.json`
/// for the purposes of the dev secrets migration (to decide whether to copy
/// `global:env:*` keys).  Returns an empty set when the file is absent or
/// unparseable — in that case no global env refs exist in the destination.
#[cfg(debug_assertions)]
fn collect_global_env_refs(app: &tauri::AppHandle) -> std::collections::HashSet<String> {
    let path = match app.path().app_data_dir() {
        Ok(d) => d.join("agents/global-agent-config.json"),
        Err(_) => return std::collections::HashSet::new(),
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return std::collections::HashSet::new(),
    };
    let v: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return std::collections::HashSet::new(),
    };
    let mut refs = std::collections::HashSet::new();
    if let Some(r) = v.get("env_vars_ref").and_then(|r| r.as_str()) {
        refs.insert(r.to_string());
    }
    refs
}
