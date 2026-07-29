use nostr::Keys;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::managed_agents::{
    effective_repos_dir, ensure_repos_symlink, nest_dir, restore_managed_agents_on_launch,
    try_regenerate_nest, write_persisted_repos_dir,
};
use crate::relay;

#[cfg(feature = "mesh-llm")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MeshWorkspaceApplyAction {
    Continue,
    RestartProcess,
}

/// Decide whether an embedded MeshLLM runtime belongs to the workspace that
/// has just been applied. A running node is relay-scoped through `mesh_name`;
/// carrying it across a workspace boundary would publish old-community state
/// on the new relay. Rebuilding it also requires a process boundary because
/// MeshLLM's native listeners are not safe to stop and recreate in-process.
#[cfg(feature = "mesh-llm")]
fn mesh_workspace_apply_action(
    request: Option<&crate::mesh_llm::StartMeshNodeRequest>,
    expected_mesh_name: &str,
) -> MeshWorkspaceApplyAction {
    match request {
        None => MeshWorkspaceApplyAction::Continue,
        Some(request) if request.mesh_name.as_deref() == Some(expected_mesh_name) => {
            MeshWorkspaceApplyAction::Continue
        }
        Some(_) => MeshWorkspaceApplyAction::RestartProcess,
    }
}

/// Adopt the pre-scoping global retention database's pending rows into `scope`.
///
/// Best-effort: a failure is logged and the boot proceeds. The migration's own
/// crash-safety guards make the next launch retry safely, and blocking the
/// workspace apply on it would be worse than a delayed publish.
fn migrate_legacy_retention_into(
    app: &AppHandle,
    scope: &crate::managed_agents::retention::RetentionScope,
) {
    let Ok(base_dir) = crate::managed_agents::managed_agents_base_dir(app) else {
        return;
    };
    match crate::managed_agents::retention::migrate_legacy_retention_db(
        &base_dir,
        &scope.db_path,
        &scope.owner_keys.public_key().to_hex(),
    ) {
        Ok(0) => {}
        Ok(copied) => {
            eprintln!("buzz-desktop: adopted {copied} legacy retained event(s) into this community")
        }
        Err(error) => eprintln!("buzz-desktop: legacy retention migration failed: {error}"),
    }
}

#[derive(Deserialize)]
struct RelayInfoIcon {
    #[serde(default)]
    icon: Option<String>,
}

/// Fetch a relay's workspace icon from its NIP-11 relay information document.
///
/// Works for any workspace (active or not) with a plain unauthenticated HTTP
/// GET — no WebSocket session needed. Returns `None` when the relay has no
/// icon set, is unreachable, or serves a malformed document: the rail falls
/// back to initials in all three cases.
#[tauri::command]
pub async fn fetch_workspace_icon(
    relay_url: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let http_url = relay::relay_http_base_url(&relay_url);
    let Ok(response) = state
        .http_client
        .get(&http_url)
        .header("Accept", "application/nostr+json")
        .send()
        .await
    else {
        return Ok(None);
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    let doc = response
        .json::<RelayInfoIcon>()
        .await
        .unwrap_or(RelayInfoIcon { icon: None });
    Ok(doc.icon.filter(|icon| !icon.is_empty()))
}

#[derive(Serialize)]
pub struct ActiveWorkspaceInfo {
    relay_url: String,
    pubkey: String,
}

/// Returns the current active workspace info (relay URL + pubkey).
#[tauri::command]
pub fn get_active_workspace(state: State<'_, AppState>) -> Result<ActiveWorkspaceInfo, String> {
    let keys = state.keys.lock().map_err(|e| e.to_string())?;
    let relay_url = relay::relay_ws_url_with_override(&state);
    Ok(ActiveWorkspaceInfo {
        relay_url,
        pubkey: keys.public_key().to_hex(),
    })
}

/// Validate a candidate `repos_dir` without mutating the filesystem.
///
/// The Add/Edit workspace dialogs call this on submit to block Save on a bad
/// path, so a typo never reaches `apply_workspace`. Reuses the same
/// `validate_repos_dir` the boot/apply path uses — one source of truth for
/// "what's a valid repos dir". An empty/whitespace value clears the override
/// and is valid. `Err` carries the human-readable reason for inline display.
#[tauri::command]
pub async fn validate_repos_dir(dir: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let trimmed = dir.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        let nest = nest_dir().ok_or("cannot resolve home directory for nest")?;
        crate::managed_agents::validate_repos_dir(&nest, trimmed).map(|_| ())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Apply a workspace's configuration to the backend session.
///
/// Called by the frontend on app init (after reload) to configure the
/// Tauri backend with the selected workspace's relay URL, keys, and repos
/// directory.
///
/// A bad `repos_dir` is non-fatal: relay/keys always apply (the relay is the
/// active workspace's own choice — orthogonal to the filesystem repos dir),
/// the bad value is NOT persisted (so the next boot starts clean), the
/// `REPOS` symlink is skipped (REPOS stays a real dir), a `repos-dir-error`
/// event surfaces the reason, and the command returns `Ok`. The dialogs
/// already block a bad path at Save (`validate_repos_dir`); this fallback only
/// catches a value that went bad after save (deleted dir, unmounted volume).
#[tauri::command]
pub async fn apply_workspace(
    relay_url: String,
    nsec: Option<String>,
    repos_dir: Option<String>,
    agent_managed_profiles: Option<bool>,
    app: AppHandle,
) -> Result<(), String> {
    let restore_app = app.clone();
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();

        // ── Validate before mutating ──────────────────────────────────────────
        let parsed_keys = match nsec.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(nsec_trimmed) => {
                Some(Keys::parse(nsec_trimmed).map_err(|e| format!("invalid nsec: {e}"))?)
            }
            None => None,
        };

        // Decide the effective repos_dir from the candidate. A bad path does NOT
        // reject — it is treated as if no override were set: relay/keys still
        // apply, the bad value is not persisted, and a `repos-dir-error` surfaces
        // the reason. Persisting a bad path would make every later boot read it,
        // fail to resolve the symlink, and silently skip agent restore. One
        // validate (inside `effective_repos_dir`) drives both the emit and the
        // persisted value. `nest` is resolved softly: when absent there is nothing
        // to persist or symlink, and relay/keys must still apply unconditionally.
        let nest = nest_dir();
        let effective_repos_dir = match nest.as_deref() {
            Some(nest) => match effective_repos_dir(nest, repos_dir.as_deref()) {
                Ok(value) => value,
                Err(error) => {
                    let _ = app.emit("repos-dir-error", error);
                    None
                }
            },
            None => None,
        };

        // ── Apply all state changes (nothing below can fail) ──────────────────
        {
            let mut override_guard = state.relay_url_override.lock().map_err(|e| e.to_string())?;
            *override_guard = Some(relay_url);
        }
        // Reset the Rust-side admission gate when switching workspace/community,
        // matching `resetRateLimitGate()` on the TS side (useCommunityInit.ts:38).
        crate::relay_admission::reset_gate_for_workspace_change();

        if let Some(keys) = parsed_keys {
            let mut keys_guard = state.keys.lock().map_err(|e| e.to_string())?;
            *keys_guard = keys;
        }

        // Keep the backend-side reconcile guard aligned with the frontend
        // experiment before launch-time restore can spawn any agents. Missing
        // means the stable behavior: desktop remains authoritative.
        state
            .managed_agent_profile_reconcile_enabled
            .store(!agent_managed_profiles.unwrap_or(false), Ordering::Release);

        // ── Filesystem side-effect (non-fatal) ────────────────────────────────
        // Persist the *effective* repos_dir (None when the candidate failed
        // validation) for the backend to read at boot, then re-point REPOS to
        // match. Persisting first makes the dotfile authoritative even if the
        // symlink apply fails here (e.g. a non-empty real REPOS): the next boot
        // reads the persisted value and resolves the symlink before any agent can
        // clone into REPOS. A bad candidate persists `None`, so the next boot is
        // clean and agent restore proceeds. Failure of either must NOT fail the
        // command — relay/keys are already applied. Surface symlink errors via
        // `repos-dir-error`.
        if let Some(nest) = nest.as_deref() {
            if let Err(error) = write_persisted_repos_dir(nest, effective_repos_dir.as_deref()) {
                eprintln!("buzz-desktop: persist repos dir failed: {error}");
            }
            if let Err(error) = ensure_repos_symlink(nest, effective_repos_dir.as_deref()) {
                eprintln!("buzz-desktop: repos dir setup failed: {error}");
                let _ = app.emit("repos-dir-error", error);
            }
        }

        try_regenerate_nest(&app);

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))??;

    let state = restore_app.state::<AppState>();

    // A running MeshLLM node is bound to the relay-derived community mesh
    // name it started with. Never let the old runtime survive a workspace
    // switch: besides advertising the wrong community, trying to repair it by
    // stopping and starting the embedded native runtime can terminate Buzz.
    // The persisted Share Compute config is intentionally left intact, so the
    // normal launch restore recreates the same serving model for this workspace.
    #[cfg(feature = "mesh-llm")]
    {
        let expected_mesh_name = crate::commands::mesh_llm::buzz_mesh_name(&state);
        let action = {
            let runtime = state.mesh_llm_runtime.lock().await;
            mesh_workspace_apply_action(
                runtime.as_ref().map(|runtime| runtime.start_request()),
                &expected_mesh_name,
            )
        };
        if action == MeshWorkspaceApplyAction::RestartProcess {
            eprintln!(
                "buzz-mesh: workspace community changed; restarting Buzz to bind MeshLLM to the selected relay"
            );
            restore_app.request_restart();
            return Ok(());
        }
    }

    // Backfill this exact relay+owner scope only after the workspace has been
    // applied. Running at process boot would target the fallback relay and
    // collapse every community into one pending-event store.
    match crate::managed_agents::retention::active_retention_scope(&restore_app, &state) {
        Ok(scope) => {
            // Adopt whatever the pre-scoping release left queued in the global
            // retention database BEFORE the scoped reconcile and flush run, so
            // stranded tombstones and archive requests publish on this boot
            // instead of being abandoned by the storage cutover.
            migrate_legacy_retention_into(&restore_app, &scope);
            crate::event_sync::spawn_event_sync(
                restore_app.clone(),
                scope.owner_keys,
                scope.db_path,
            )
        }
        Err(error) => {
            eprintln!("buzz-desktop: scoped event-sync unavailable after workspace apply: {error}");
        }
    }

    let restore_pending = state
        .managed_agent_restore_pending
        .swap(false, Ordering::AcqRel);

    // The coordinator starts before React applies the selected workspace, so
    // its startup publication may have used the fallback relay and placeholder
    // identity. Correct it off the command path so an unavailable relay cannot
    // hold the frontend on its loading gate. On initial launch, restore MeshLLM
    // first so a slow stopped-status request cannot overwrite a newly restored
    // serving status, then restore managed agents after the admission identity
    // has been published (or the bounded publication attempt has timed out).
    #[cfg(feature = "mesh-llm")]
    {
        let app = restore_app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            if restore_pending {
                if let Err(error) =
                    crate::commands::mesh_llm::restore_mesh_sharing(&app, &state).await
                {
                    eprintln!("buzz-desktop: failed to restore Share Compute: {error}");
                }
            }
            crate::mesh_llm::publish_current_status_once(&app, "workspace apply").await;
            if restore_pending {
                if let Err(error) =
                    restore_managed_agents_on_launch(&app, &state.shutdown_started).await
                {
                    eprintln!("buzz-desktop: failed to restore managed agents: {error}");
                }
            }
        });
    }

    #[cfg(not(feature = "mesh-llm"))]
    if restore_pending {
        let app = restore_app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            if let Err(error) =
                restore_managed_agents_on_launch(&app, &state.shutdown_started).await
            {
                eprintln!("buzz-desktop: failed to restore managed agents: {error}");
            }
        });
    }

    Ok(())
}

#[cfg(all(test, feature = "mesh-llm"))]
mod tests {
    use super::*;

    fn mesh_request(mesh_name: Option<&str>) -> crate::mesh_llm::StartMeshNodeRequest {
        crate::mesh_llm::StartMeshNodeRequest {
            mode: crate::mesh_llm::MeshNodeMode::Serve,
            model_id: Some("test-model".to_string()),
            max_vram_gb: None,
            join_token: None,
            mesh_name: mesh_name.map(str::to_string),
            trusted_owner_ids: Some(Vec::new()),
        }
    }

    #[test]
    fn workspace_apply_continues_without_a_mesh_runtime() {
        assert_eq!(
            mesh_workspace_apply_action(None, "buzz-community-new"),
            MeshWorkspaceApplyAction::Continue
        );
    }

    #[test]
    fn workspace_apply_keeps_runtime_bound_to_selected_community() {
        let request = mesh_request(Some("buzz-community-current"));
        assert_eq!(
            mesh_workspace_apply_action(Some(&request), "buzz-community-current"),
            MeshWorkspaceApplyAction::Continue
        );
    }

    #[test]
    fn workspace_apply_restarts_for_runtime_bound_to_another_community() {
        let request = mesh_request(Some("buzz-community-old"));
        assert_eq!(
            mesh_workspace_apply_action(Some(&request), "buzz-community-new"),
            MeshWorkspaceApplyAction::RestartProcess
        );
    }

    #[test]
    fn workspace_apply_restarts_when_runtime_binding_is_unknown() {
        let request = mesh_request(None);
        assert_eq!(
            mesh_workspace_apply_action(Some(&request), "buzz-community-new"),
            MeshWorkspaceApplyAction::RestartProcess
        );
    }
}
