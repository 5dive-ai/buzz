//! Injectable seams for `managed_agents/runtime_commands.rs`.
//!
//! Extracted here to keep `runtime_commands.rs` under the 1000-line size ratchet.
//! Included via `#[path]` from `runtime_commands.rs`.

use super::*;

/// Lazy start seam with injectable before/after-transition hooks.
///
/// Delegates to [`start_pair_for_with_hook`] with `lazy = true`. Tests that
/// need a mock-runtime contender call this directly — it is the exact function
/// that production `start_managed_agent_runtime_pair_lazy` calls through
/// `start_pair_lazy_for`, so removing the transition guard from this path would
/// also remove it from production.
pub(crate) fn start_pair_lazy_for_with_hook<R: tauri::Runtime>(
    pubkey: String,
    relay_url: String,
    app: tauri::AppHandle<R>,
    on_before_transition: impl FnOnce(),
    on_transition_acquired: impl FnOnce(),
) -> Result<ManagedAgentRuntimeStatus, String> {
    start_pair_for_with_hook(
        pubkey,
        relay_url,
        true,
        None,
        app,
        on_before_transition,
        on_transition_acquired,
    )
}

/// Generic start-pair seam with injectable hooks.
///
/// - `on_before_transition`: fires BEFORE `managed_agent_runtime_transition` is
///   locked. Tests signal "at the lock boundary" from here — the contender is
///   committed to acquiring `managed_agent_runtime_transition` immediately after.
///
/// - `on_transition_acquired`: fires AFTER `managed_agent_runtime_transition` is
///   acquired but BEFORE `managed_agents_store_lock` is attempted. Signals that
///   start has passed the transition-lock boundary.
///
/// Production delegates with `|| {}` for both hooks — release-invisible no-ops.
pub(crate) fn start_pair_for_with_hook<R: tauri::Runtime>(
    pubkey: String,
    relay_url: String,
    lazy: bool,
    expected_updated_at: Option<&str>,
    app: tauri::AppHandle<R>,
    on_before_transition: impl FnOnce(),
    on_transition_acquired: impl FnOnce(),
) -> Result<ManagedAgentRuntimeStatus, String> {
    let state = app.state::<AppState>();
    on_before_transition();
    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|e| e.to_string())?;
    if state
        .shutdown_started
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("desktop shutdown has started".into());
    }
    on_transition_acquired();
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(&app)?;
    start_pair_under_held_locks(
        &app,
        &state,
        pubkey,
        relay_url,
        lazy,
        expected_updated_at,
        &mut records,
    )
}
