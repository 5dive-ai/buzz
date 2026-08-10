//! Boot-time secret extraction: lifts inline env vars, auth tags, and
//! provider configs from JSON into the OS keyring via the generation-reference
//! protocol, then runs the two-cycle GC sweeps.
//!
//! Runs ONCE at the END of `run_boot_migrations_inner` (after
//! `materialize_agent_runtimes`) so raw-JSON migrations see inline values.
//! Idempotent: records that already have refs skip the write path.

use tauri::Manager;

/// Extract inline secrets (env vars, auth tags, provider configs) from JSON
/// into the keyring. Also runs the two-cycle GC sweeps.
pub(super) fn migrate_inline_secrets_to_keyring(app: &tauri::AppHandle) {
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
        crate::managed_agents::secret_projection::mark_gc_candidates(
            store,
            &agents_path,
            &global_path,
        );
        crate::managed_agents::secret_projection::delete_gc_candidates(
            store,
            &agents_path,
            &global_path,
        );
    }
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
