//! Scope-aware helpers for the Mesh LLM command layer.
//!
//! Extracted from `mesh_llm.rs` to stay within the file-size ratchet.
//! All items here are `pub(super)` so they remain private to the module.

use tauri::AppHandle;

use crate::app_state::AppState;
use crate::mesh_llm;

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
            == crate::managed_agents::scope::normalize_relay_for_scope(scope_relay)
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

/// Drain the Mesh client runtime if it is bound to a relay other than
/// `active_relay_url` (i.e. it belongs to a workspace that is being
/// switched away from).
///
/// Serve-mode runtimes are machine-level and are deliberately NOT drained
/// on workspace switch — they stay pinned to their configured relay.
///
/// Called from the Layer-1 async serialization stage of `apply_workspace`
/// (before `spawn_blocking`), while holding `workspace_transition` but
/// without any synchronous Layer-2 guards.
pub(crate) async fn drain_mesh_client_if_stale(
    app: &AppHandle,
    active_relay_url: &str,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (should_drain, taken) = {
        let mut guard = state.mesh_llm_runtime.lock().await;
        let is_client = guard
            .as_ref()
            .map_or(false, |r| r.mode() == mesh_llm::MeshNodeMode::Client);
        if !is_client {
            // Serve mode or no runtime — nothing to drain.
            (false, None)
        } else {
            // Check relay match; drain only on mismatch.
            let runtime_relay = guard
                .as_ref()
                .and_then(|r| r.start_request().relay_url.clone());
            let relay_matches = runtime_relay.as_deref().map_or(false, |bound| {
                crate::managed_agents::scope::normalize_relay_for_scope(bound)
                    == crate::managed_agents::scope::normalize_relay_for_scope(active_relay_url)
            });
            if relay_matches {
                (false, None)
            } else {
                (true, guard.take())
            }
        }
    };

    if should_drain {
        if let Some(runtime) = taken {
            if let Err(error) = runtime.stop().await {
                eprintln!(
                    "buzz-mesh: failed to drain stale client runtime during workspace switch: {error}"
                );
                // Non-fatal: the old client may have already exited or will be
                // reclaimed by the watchdog. Log and continue — not stopping
                // an old client is safer than blocking the workspace switch.
            }
        }
        mesh_llm::publish_current_status_once(app, "workspace switch drain").await;
    }
    Ok(())
}
