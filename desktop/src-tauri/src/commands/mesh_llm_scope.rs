//! Scope-aware helpers for the Mesh LLM command layer.
//!
//! Extracted from `mesh_llm.rs` to stay within the file-size ratchet.
//! Most items here are `pub(super)` so they remain private to the module;
//! `mesh_stop_client` is `pub(crate)` and re-exported as `pub` from `mesh_llm`.

use tauri::{AppHandle, Manager, State};

use crate::app_state::AppState;
use crate::mesh_llm;
type CmdResult<T> = Result<T, String>;

/// Check whether the currently live Mesh runtime's relay matches the active
/// workspace scope's relay.
///
/// Returns:
/// - `Ok(true)`  — relays match; the caller should proceed to a liveness probe.
/// - `Ok(false)` — stale client runtime from another scope; treat as absent
///                 and fall through to re-arm.
/// - `Err(msg)`  — serve-mode runtime pinned to another relay (fail closed), or
///                 no active workspace scope.
///
/// Assumes `state.mesh_llm_runtime.lock()` is NOT held by the caller.
pub(super) async fn check_mesh_runtime_relay_scope(state: &AppState) -> Result<bool, String> {
    let scope_relay = state
        .capture_active_scope()
        .map(|s| s.relay_url.clone())
        .ok_or("Buzz shared compute cannot start: no active workspace scope")?;
    let (runtime_relay, runtime_mode) = {
        let guard = state.mesh_llm_runtime.lock().await;
        let relay = guard
            .as_ref()
            .and_then(|r| r.start_request().relay_url.clone());
        let mode = guard.as_ref().map(|r| r.mode());
        (relay, mode)
    };

    let relay_matches = runtime_relay.as_deref().map_or(false, |bound| {
        crate::managed_agents::scope::normalize_relay_for_scope(bound)
            == crate::managed_agents::scope::normalize_relay_for_scope(&scope_relay)
    });

    if relay_matches {
        return Ok(true);
    }

    match runtime_mode {
        Some(mesh_llm::MeshNodeMode::Serve) => {
            // Fail closed: Share Compute is pinned to another relay.
            // The process has one runtime slot and one :9337 ingress.
            // No client can start while serve occupies it.
            let pinned_relay = runtime_relay.as_deref().unwrap_or("another relay");
            Err(format!(
                "Share Compute is currently pinned to {pinned_relay}. \
                 Stop sharing first, then switch workspaces to use \
                 Buzz shared compute on this workspace."
            ))
        }
        Some(mesh_llm::MeshNodeMode::Client) | None => {
            // Stale client from a prior workspace. Treat as absent —
            // fall through to re-arm a new client for the active scope.
            // The drain stage in apply_workspace should have cleared
            // this; this is a safety net for missed drains.
            Ok(false)
        }
    }
}

/// Check whether a client-mode Mesh runtime is currently active.
///
/// Returns `Err(msg)` with a user-facing message when a client runtime is
/// present — the caller should fail the workspace switch / identity import
/// with this message so the user knows to stop Mesh first.
///
/// Serve-mode runtimes and absent runtimes both return `Ok(())` — they are
/// machine-level (serve) or simply not running (absent) and do not block
/// a workspace switch.
///
/// Called from the Layer-1 async stage of `apply_workspace` and
/// `import_identity` before entering `spawn_blocking`.
pub(crate) async fn fail_if_client_mesh_active(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let guard = state.mesh_llm_runtime.lock().await;
    let is_client = guard
        .as_ref()
        .map_or(false, |r| r.mode() == mesh_llm::MeshNodeMode::Client);
    if is_client {
        return Err("A Buzz shared compute (client) session is active. \
             Stop it in the Shared Compute settings before switching workspaces."
            .to_string());
    }
    Ok(())
}

/// Stop the local Mesh **client** (consuming) runtime.
///
/// Only tears down a client-mode runtime. Serve-mode and absent runtimes are
/// left unchanged — this command has no effect on sharing nodes.
///
/// Required by Option A: a workspace switch fails while a client is active;
/// the user calls this command to stop the client before the switch proceeds.
#[tauri::command]
pub(crate) async fn mesh_stop_client(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<mesh_llm::MeshNodeStatus> {
    let (taken, bound_relay_url) = {
        let mut guard = state.mesh_llm_runtime.lock().await;
        if let Some(runtime) = guard.as_ref() {
            if runtime.mode() != mesh_llm::MeshNodeMode::Client {
                return runtime.status().await.map_err(|e| e.to_string());
            }
        } else {
            return Ok(mesh_llm::stopped_status());
        }
        let bound_relay_url = guard
            .as_ref()
            .and_then(|r| r.start_request().relay_url.clone());
        (guard.take(), bound_relay_url)
    };
    if let Some(runtime) = taken {
        runtime.stop().await.map_err(|e| e.to_string())?;
    }
    mesh_llm::publish_stopped_status_once_at(&app, bound_relay_url.as_deref(), "stop").await;
    Ok(mesh_llm::stopped_status())
}
