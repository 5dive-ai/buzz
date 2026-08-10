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

    let DevMigrationPlan {
        to_write,
        conflict_keys,
        write_marker,
    } = plan_dev_secrets_migration(&src_map, &dest_map, &global_refs);

    for key in &conflict_keys {
        eprintln!(
            "buzz-desktop: keyring-dev-secrets-migration: \
             conflict on key {key} between {src_service} and {dest_service}; \
             refusing to overwrite (manual resolution required)"
        );
    }
    let conflict_count = conflict_keys.len();

    // Nothing to persist (no copyable keys and, being unclean, no marker):
    // skip the write entirely so an unclean boot with zero copyable keys does
    // not touch the destination keyring.
    if to_write.is_empty() {
        if conflict_count > 0 {
            eprintln!(
                "buzz-desktop: keyring-dev-secrets-migration: \
                 {conflict_count} conflict(s), nothing copyable; will retry next boot"
            );
        }
        return;
    }

    if let Err(e) = dest_store.store_all(&to_write) {
        eprintln!(
            "buzz-desktop: keyring-dev-secrets-migration: \
             cannot write to dest keyring ({dest_service}): {e}"
        );
        return;
    }

    // Subtract the marker (if any) from the copied count.
    let copied = to_write.len() - usize::from(write_marker);
    if copied > 0 {
        eprintln!(
            "buzz-desktop: keyring-dev-secrets-migration: \
             copied {copied} projection key(s) from {src_service} → {dest_service}"
        );
    }
    if conflict_count > 0 {
        eprintln!(
            "buzz-desktop: keyring-dev-secrets-migration: \
             {conflict_count} key(s) had conflicts and were NOT copied; \
             marker withheld — migration will retry on the next boot"
        );
    }
}

/// Output of [`plan_dev_secrets_migration`]: the batch to write to the
/// destination keyring, the number of unresolved conflicts, and whether the
/// completion marker is included in the batch.
#[cfg(debug_assertions)]
struct DevMigrationPlan {
    to_write: std::collections::HashMap<String, String>,
    conflict_keys: Vec<String>,
    write_marker: bool,
}

/// Pure decision core of [`migrate_agent_secrets_to_dev_service`]: decide which
/// projection keys to copy and whether to write the completion marker.
///
/// A projection key present in both stores with DIFFERENT values is a conflict:
/// it is NOT copied and counts toward `conflict_count`. The marker is included
/// only when `conflict_count == 0` — an unclean run must be retried on the next
/// boot after the user resolves the conflict, so the non-conflicting keys are
/// still written (partial progress persists) but the marker is withheld.
///
/// `global:env:*` keys are copied only when the gen id is in `global_refs`
/// (the destination JSON references it) — `global-agent-config.json` is not a
/// shared file, so an unreferenced global gen must not leak across services.
#[cfg(debug_assertions)]
fn plan_dev_secrets_migration(
    src_map: &std::collections::HashMap<String, String>,
    dest_map: &std::collections::HashMap<String, String>,
    global_refs: &std::collections::HashSet<String>,
) -> DevMigrationPlan {
    use crate::managed_agents::secret_projection::is_projection_key;

    let mut to_write: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut conflict_keys: Vec<String> = Vec::new();
    for (key, src_val) in src_map {
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
                conflict_keys.push(key.clone());
            }
        }
    }

    let write_marker = conflict_keys.is_empty();
    if write_marker {
        to_write.insert(DEV_SECRETS_MIGRATION_MARKER.to_string(), "done".to_string());
    }

    DevMigrationPlan {
        to_write,
        conflict_keys,
        write_marker,
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

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;
    use crate::managed_agents::secret_projection::{agent_env_key, global_env_key};
    use std::collections::{HashMap, HashSet};

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn test_clean_migration_includes_marker_and_copies() {
        // One projection key present only in src, no conflicts → copy it AND
        // write the marker (migration is complete).
        let key = agent_env_key("abc", "gen1");
        let src = map(&[(&key, "val")]);
        let plan = plan_dev_secrets_migration(&src, &HashMap::new(), &HashSet::new());

        assert!(plan.conflict_keys.is_empty());
        assert!(plan.write_marker, "clean migration must write the marker");
        assert_eq!(plan.to_write.get(&key).map(String::as_str), Some("val"));
        assert!(plan.to_write.contains_key(DEV_SECRETS_MIGRATION_MARKER));
    }

    #[test]
    fn test_conflict_withholds_marker_but_copies_non_conflicting() {
        // Two keys: one conflicts (differs in dest), one is new. The migration
        // must copy the new key (partial progress) but WITHHOLD the marker so
        // the conflict is retried after manual resolution.
        let conflict = agent_env_key("abc", "gen1");
        let fresh = agent_env_key("def", "gen2");
        let src = map(&[(&conflict, "src-val"), (&fresh, "fresh-val")]);
        let dest = map(&[(&conflict, "dest-val")]);

        let plan = plan_dev_secrets_migration(&src, &dest, &HashSet::new());

        assert_eq!(plan.conflict_keys, vec![conflict.clone()]);
        assert!(
            !plan.write_marker,
            "a conflicted migration must NOT write the marker — it must retry"
        );
        assert!(
            !plan.to_write.contains_key(DEV_SECRETS_MIGRATION_MARKER),
            "marker must be absent from the write batch on conflict"
        );
        assert_eq!(
            plan.to_write.get(&fresh).map(String::as_str),
            Some("fresh-val"),
            "non-conflicting key must still be copied for partial progress"
        );
        assert!(
            !plan.to_write.contains_key(&conflict),
            "conflicting key must NOT be overwritten"
        );
    }

    #[test]
    fn test_identical_key_is_idempotent_and_clean() {
        // A key already identical in dest is not re-copied, and (no conflict)
        // the marker is written.
        let key = agent_env_key("abc", "gen1");
        let src = map(&[(&key, "same")]);
        let dest = map(&[(&key, "same")]);

        let plan = plan_dev_secrets_migration(&src, &dest, &HashSet::new());

        assert!(plan.conflict_keys.is_empty());
        assert!(plan.write_marker);
        assert!(
            !plan.to_write.contains_key(&key),
            "identical key must not be re-written"
        );
        // Only the marker is in the batch.
        assert_eq!(plan.to_write.len(), 1);
    }

    #[test]
    fn test_empty_source_writes_only_marker() {
        // Nothing to copy, no conflict → clean: the batch is just the marker.
        let plan = plan_dev_secrets_migration(&HashMap::new(), &HashMap::new(), &HashSet::new());
        assert!(plan.write_marker);
        assert_eq!(plan.to_write.len(), 1);
        assert!(plan.to_write.contains_key(DEV_SECRETS_MIGRATION_MARKER));
    }

    #[test]
    fn test_unreferenced_global_env_is_skipped() {
        // A global:env gen not referenced by the destination JSON must not be
        // copied across services (global-agent-config.json is not shared).
        let key = global_env_key("gen-unref");
        let src = map(&[(&key, "val")]);
        let plan = plan_dev_secrets_migration(&src, &HashMap::new(), &HashSet::new());

        assert!(
            !plan.to_write.contains_key(&key),
            "unreferenced global:env gen must be skipped"
        );
        // Clean (no conflict), so only the marker is present.
        assert!(plan.write_marker);
        assert_eq!(plan.to_write.len(), 1);
    }

    #[test]
    fn test_referenced_global_env_is_copied() {
        // The same global:env gen IS copied when the destination JSON
        // references it.
        let key = global_env_key("gen-ref");
        let src = map(&[(&key, "val")]);
        let refs: HashSet<String> = ["gen-ref".to_string()].into_iter().collect();
        let plan = plan_dev_secrets_migration(&src, &HashMap::new(), &refs);

        assert_eq!(plan.to_write.get(&key).map(String::as_str), Some("val"));
    }

    #[test]
    fn test_non_projection_key_is_ignored() {
        // A non-projection key (e.g. an nsec or identity marker) present only
        // in src must never be copied by this migration.
        let src = map(&[("some-agent-nsec-key", "secret")]);
        let plan = plan_dev_secrets_migration(&src, &HashMap::new(), &HashSet::new());

        assert!(!plan.to_write.contains_key("some-agent-nsec-key"));
        assert!(plan.write_marker); // no projection conflict
        assert_eq!(plan.to_write.len(), 1); // marker only
    }
}
