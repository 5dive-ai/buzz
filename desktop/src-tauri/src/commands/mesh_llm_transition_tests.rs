//! Area-4 workspace-transition serialization tests for `commands/mesh_llm.rs`.
//!
//! Split from `mesh_llm_tests.rs` to keep each file under the 1000-line ratchet.
//! Included via `#[path]` from `mesh_llm_tests.rs` as `mod transition_tests;`.
//! `use super::*` gives access to all items in `mesh_llm_tests.rs`.

// ── Area 4 serialization direction tests ─────────────────────────────────────
//
// These three tests prove the lock-serialization contract between
// `with_workspace_transition_preflight` and `install_client_under_workspace_transition`.
// No port (`127.0.0.1:9337`) is touched — the install closure is always injected.

/// Active mock client → `mesh_stop_client` → runtime slot is `None` →
/// `with_workspace_transition_preflight` with a no-op body succeeds.
///
/// Proves the two-step Option A user flow:
/// 1. user calls "stop shared compute" (`mesh_stop_client`);
/// 2. workspace switch proceeds via the production transition-preflight helper.
///
/// The production `fail_if_client_mesh_active` is called inside
/// `with_workspace_transition_preflight` (under the guard). It must see an
/// absent runtime and return `Ok(())` — not the stale client that was there
/// before `mesh_stop_client` cleared it.
#[tokio::test]
async fn test_active_client_stop_then_transition_preflight_succeeds() {
    use tauri::Manager;

    let app = tauri::test::mock_builder()
        .manage(crate::app_state::build_app_state())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("failed to build mock app");
    let app_handle = app.handle().clone();
    let state = app.state::<crate::app_state::AppState>();

    // Install a client-mode runtime — simulates "Mesh is running as a client".
    {
        let client_runtime = crate::mesh_llm::build_mock_client_runtime_for_test();
        *state.mesh_llm_runtime.lock().await = Some(client_runtime);
    }

    // Verify the client is present before the stop.
    {
        let guard = state.mesh_llm_runtime.lock().await;
        assert!(
            guard.is_some(),
            "pre-condition: a client runtime must be installed before stop"
        );
    }

    // Step 1 — production `mesh_stop_client` tears down the client.
    let stop_status = super::mesh_stop_client(app_handle.clone(), state.clone())
        .await
        .expect("mesh_stop_client must not error");
    assert_eq!(
        stop_status.state,
        crate::mesh_llm::MeshNodeState::Off,
        "mesh_stop_client must return Off status after tearing down the client"
    );

    // Step 2 — runtime slot must now be None.
    {
        let guard = state.mesh_llm_runtime.lock().await;
        assert!(
            guard.is_none(),
            "mesh_stop_client must clear the runtime slot; got {:?}",
            guard.as_ref().map(|r| r.mode())
        );
    }

    // Step 3 — production transition preflight must succeed (no client active).
    // The no-op body proves the lock was acquired and the preflight passed.
    let result = super::scope_impl::with_workspace_transition_preflight(&app_handle, || {
        Ok::<&str, String>("body ran")
    })
    .await;

    assert!(
        result.is_ok(),
        "with_workspace_transition_preflight must succeed after mesh_stop_client cleared the slot: {result:?}"
    );
    assert_eq!(
        result.unwrap(),
        "body ran",
        "transition body must have been invoked and its return value propagated"
    );
}

/// Transition helper holds the lock, commits a distinct scope (advancing
/// generation); queued install detects the stale captured scope and aborts
/// without invoking the injected install closure.
///
/// Proves the first serialization direction: a workspace switch commits between
/// scope-capture and lock-acquisition for the install path. The install helper
/// must reject the stale scope under the lock rather than invoke install.
///
/// Concurrency model: `workspace_transition` is acquired directly in the test
/// body to simulate a long-running transition. A spawned install task queues
/// on the same lock. When the test body drops the guard the install task
/// acquires, validates, and finds the captured scope stale.
#[tokio::test]
// SAFETY: single-threaded tokio runtime; lock serializes generation counter
// mutations — cannot deadlock. See import_tests.rs for full rationale.
#[allow(clippy::await_holding_lock)]
async fn test_transition_held_queued_install_detects_stale_scope() {
    use crate::managed_agents::scope::{
        next_scope_generation, WorkspaceAgentScope, SCOPE_GENERATION_TEST_LOCK,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tauri::Manager;

    // Serialise generation-sensitive work across parallel tests.
    let _gen_guard = SCOPE_GENERATION_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let app = tauri::test::mock_builder()
        .manage(crate::app_state::build_app_state())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("failed to build mock app");
    let app_handle = app.handle().clone();
    let state = app.state::<crate::app_state::AppState>();

    let base = std::path::PathBuf::from("/tmp/area4-test-dir");
    let relay_a = "wss://transition-test-a.example";
    let owner_a = "aa".repeat(32); // 64-char hex-looking pubkey

    // Capture a scope at the current generation — this is the scope the install
    // task will carry after "discovering a bootstrap target".
    let gen_a = next_scope_generation();
    let captured_scope =
        WorkspaceAgentScope::new(relay_a.to_string(), owner_a.clone(), &base, gen_a);
    // Make it the active scope so the identity check inside the helper can compare.
    state.commit_active_scope(captured_scope.clone());

    // Acquire the workspace_transition lock directly — simulates the transition
    // helper holding the lock during a workspace switch.
    let transition_guard = state.workspace_transition.lock().await;

    // Advance generation and commit a DISTINCT scope (different relay) to
    // simulate a committed workspace switch while the lock was held.
    let gen_b = next_scope_generation();
    let new_scope = WorkspaceAgentScope::new(
        "wss://transition-test-b.example".to_string(),
        "bb".repeat(32),
        &base,
        gen_b,
    );
    state.commit_active_scope(new_scope);

    // Spawn the install task. It blocks on workspace_transition until we drop the guard.
    let install_was_called = Arc::new(AtomicBool::new(false));
    let install_called_clone = Arc::clone(&install_was_called);
    let app_handle_clone = app_handle.clone();
    let install_task = tokio::task::spawn(async move {
        super::scope_impl::install_client_under_workspace_transition(
            &app_handle_clone,
            &captured_scope,
            || {
                let called = Arc::clone(&install_called_clone);
                async move {
                    called.store(true, Ordering::SeqCst);
                    Ok::<(), String>(())
                }
            },
        )
        .await
    });

    // Yield to give the install task a chance to queue on the lock before we
    // release it.  This is not required for correctness (the generation check
    // fires regardless of ordering) but makes the concurrent queuing observable.
    tokio::task::yield_now().await;

    // Release the transition lock → install task acquires it and validates.
    drop(transition_guard);

    let install_result = install_task.await.expect("install task must not panic");

    // The install helper must have rejected the stale scope without invoking install.
    assert!(
        install_result.is_err(),
        "install_client_under_workspace_transition must return Err for a stale captured scope; \
         got Ok"
    );
    let err = install_result.unwrap_err();
    assert!(
        err.contains("stale") || err.contains("mismatch") || err.contains("scope"),
        "error must describe the stale/mismatched scope: {err}"
    );
    assert!(
        !install_was_called.load(Ordering::SeqCst),
        "install closure must NOT have been invoked when the scope was stale"
    );
}

/// Install helper acquires the lock first and installs a mock client; after
/// release, the transition preflight observes the client and rejects.
///
/// Proves the second serialization direction: a client install commits between
/// "preflight check" and lock-acquisition for the transition path. The
/// transition helper must observe the installed client under the lock and fail.
///
/// Concurrency model: `workspace_transition` is acquired directly in the test
/// body to simulate a long-running install. A spawned transition task queues
/// on the same lock. When the test body drops the guard the transition task
/// acquires, runs `fail_if_client_mesh_active`, and finds the installed client.
#[tokio::test]
// SAFETY: single-threaded tokio runtime; lock serializes generation counter
// mutations — cannot deadlock. See import_tests.rs for full rationale.
#[allow(clippy::await_holding_lock)]
async fn test_install_held_transition_preflight_observes_client() {
    use crate::managed_agents::scope::{
        next_scope_generation, WorkspaceAgentScope, SCOPE_GENERATION_TEST_LOCK,
    };
    use tauri::Manager;

    // Serialise generation-sensitive work across parallel tests.
    let _gen_guard = SCOPE_GENERATION_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let app = tauri::test::mock_builder()
        .manage(crate::app_state::build_app_state())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("failed to build mock app");
    let app_handle = app.handle().clone();
    let state = app.state::<crate::app_state::AppState>();

    let base = std::path::PathBuf::from("/tmp/area4-test-dir-inv");
    let relay = "wss://install-first-test.example";
    let owner = "cc".repeat(32);

    // Set up an active scope so install_client_under_workspace_transition can
    // validate full scope identity under the guard.
    let gen = next_scope_generation();
    let scope = WorkspaceAgentScope::new(relay.to_string(), owner.clone(), &base, gen);
    state.commit_active_scope(scope.clone());

    // Acquire workspace_transition directly — simulates the install helper
    // holding the lock during target acquisition + client startup.
    let install_guard = state.workspace_transition.lock().await;

    // Install the mock client runtime while we hold the lock.
    // This is the "install closure ran while holding the lock" effect.
    {
        let client_runtime = crate::mesh_llm::build_mock_client_runtime_for_test();
        *state.mesh_llm_runtime.lock().await = Some(client_runtime);
    }

    // Spawn the transition task. It blocks on workspace_transition until we drop
    // the install guard.
    let app_handle_clone = app_handle.clone();
    let transition_task = tokio::task::spawn(async move {
        super::scope_impl::with_workspace_transition_preflight(&app_handle_clone, || {
            Ok::<&str, String>("body ran")
        })
        .await
    });

    // Yield to give the transition task a chance to queue on the lock before we
    // release it.  Not required for correctness but makes the concurrent queuing
    // observable.
    tokio::task::yield_now().await;

    // Release the install lock → transition task acquires it and runs preflight.
    drop(install_guard);

    let transition_result = transition_task
        .await
        .expect("transition task must not panic");

    // `fail_if_client_mesh_active` must observe the installed client and reject.
    assert!(
        transition_result.is_err(),
        "with_workspace_transition_preflight must return Err when a client was installed \
         while holding the lock; got Ok"
    );
    let err = transition_result.unwrap_err();
    assert!(
        err.contains("client") || err.contains("Stop") || err.contains("shared compute"),
        "error must describe the active client and how to stop it: {err}"
    );
}
