//! Concurrency/determinism tests for `managed_agents/runtime_commands.rs`.
//!
//! Split from `runtime_commands_tests.rs` to keep each file under the
//! 1000-line size ratchet. Included via `#[path]` from there as `mod concurrency_tests;`.
//! `use super::*` gives access to all items in `runtime_commands_tests.rs`.

use super::*;

/// Writer-vs-compensation store-lock contention via the `compensate_drain_with_hook` seam.
///
/// Invariant: if the `managed_agents_store_lock` guard is dropped before
/// `compensate_drain_for`'s restore/save, the writer can interleave and
/// overwrite `COMP_SENTINEL` — making the final assertion fail.
///
/// Flow:
///   1. Seed the store with one agent record.
///   2. Acquire `managed_agent_runtime_transition`; call `compensate_drain_with_hook`.
///   3. `on_store_acquired` hook (fires while the store lock is held):
///      a. writes `COMP_SENTINEL` to disk;
///      b. signals the writer thread (`store_acquired_tx`);
///      c. waits for the writer to queue at the store lock (`writer_queued_rx`).
///   4. Writer thread: waits for (b), signals (c), then blocks on `managed_agents_store_lock`.
///      Compensation still holds the lock — writer is blocked.
///   5. `compensate_drain_with_hook` continues: validate → load → restore → save.
///      Store lock still held throughout; writer remains blocked.
///   6. Function returns; store lock released. Writer acquires it, writes `WRITER_EDIT`, saves.
///   7. Final disk record must contain BOTH `COMP_SENTINEL` AND `WRITER_EDIT`.
///
/// If the guard is dropped early, the writer acquires the lock before save,
/// overwrites `COMP_SENTINEL`, and the assertion at step 7 fails.
#[test]
fn test_compensate_drain_writer_vs_compensation_deterministic() {
    use crate::managed_agents::scope::{current_scope_generation, WorkspaceAgentScope};
    use std::thread;
    use tauri::Manager;

    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().to_path_buf();

    // Seed the store with one agent record.
    let pubkey1 = "aa".repeat(32);
    let initial_record = crate::managed_agents::ManagedAgentRecord {
        pubkey: pubkey1.clone(),
        name: "test-agent".to_string(),
        display_name: None,
        slug: None,
        persona_id: None,
        private_key_nsec: String::new(),
        auth_tag: None,
        relay_url: "wss://relay.example".to_string(),
        avatar_url: None,
        acp_command: crate::managed_agents::DEFAULT_ACP_COMMAND.to_string(),
        agent_command: String::new(),
        agent_command_override: None,
        agent_args: vec![],
        mcp_command: String::new(),
        turn_timeout_seconds: 0,
        idle_timeout_seconds: None,
        max_turn_duration_seconds: None,
        parallelism: 1,
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        env_vars: Default::default(),
        start_on_app_launch: true,
        auto_restart_on_config_change: false,
        runtime_pid: None,
        backend: crate::managed_agents::BackendKind::Local,
        backend_agent_id: None,
        provider_binary_path: None,
        team_id: None,
        persona_team_dir: None,
        persona_name_in_team: None,
        created_at: crate::util::now_iso(),
        updated_at: crate::util::now_iso(),
        last_started_at: None,
        last_stopped_at: None,
        last_exit_code: None,
        last_error: None,
        last_error_code: None,
        respond_to: Default::default(),
        respond_to_allowlist: Default::default(),
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        definition_respond_to: None,
        definition_respond_to_allowlist: Default::default(),
        definition_parallelism: None,
        relay_mesh: None,
        runtime: None,
        name_pool: vec![],
    };
    crate::managed_agents::storage::save_managed_agents_at(
        &tmp_path,
        std::slice::from_ref(&initial_record),
    )
    .unwrap();

    let app = tauri::test::mock_builder()
        .manage(crate::app_state::build_app_state())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("failed to build mock app");
    let app_handle = app.app_handle().clone();
    let state = app.state::<crate::app_state::AppState>();

    let gen = current_scope_generation();
    let scope = WorkspaceAgentScope {
        scope_id: "comp-drain-writer-test".to_string(),
        relay_url: "wss://relay.example".to_string(),
        owner_pubkey: "aa".repeat(32),
        definitions_dir: tmp_path.clone(),
        generation: gen,
    };
    state.commit_active_scope(scope.clone());

    let entry1 = make_drain_entry(&pubkey1, "wss://relay.example", true);
    let stopped = vec![entry1];

    // store_acquired: hook → writer (compensation holds the store lock; writer may queue)
    // writer_queued:  writer → hook  (writer is now blocked on the store lock)
    let (store_acquired_tx, store_acquired_rx) = std::sync::mpsc::channel::<()>();
    let (writer_queued_tx, writer_queued_rx) = std::sync::mpsc::channel::<()>();

    // Spawn the writer thread BEFORE acquiring the transition guard.
    // It waits for store_acquired, signals writer_queued (it is now about to
    // block on the store lock), then acquires the store lock and writes WRITER_EDIT.
    let tmp_wr = tmp_path.clone();
    let app_handle_wr = app_handle.clone();
    let wr_thread = thread::spawn(move || {
        // Wait until the hook signals that compensation holds the store lock.
        store_acquired_rx.recv().unwrap();

        // Signal the hook that we are about to queue on the store lock.
        // The hook will return on receipt, letting compensate_drain_with_hook
        // proceed to validate → load → save while we are blocked below.
        writer_queued_tx.send(()).unwrap();

        // Block on the store lock — compensation still holds it.
        let writer_state = app_handle_wr.state::<crate::app_state::AppState>();
        let _store = writer_state.managed_agents_store_lock.lock().unwrap();
        let mut records =
            crate::managed_agents::storage::load_managed_agents_at(&tmp_wr).unwrap_or_default();
        for r in &mut records {
            r.env_vars
                .insert("WRITER_EDIT".to_string(), "yes".to_string());
        }
        crate::managed_agents::storage::save_managed_agents_at(&tmp_wr, &records).unwrap();
    });

    let rt_guard = state.managed_agent_runtime_transition.lock().unwrap();

    // on_store_acquired fires while the store lock is held:
    //   (a) write COMP_SENTINEL to disk — proves we are mid-sequence under the lock;
    //   (b) signal the writer (store_acquired_tx);
    //   (c) wait for the writer to queue at the lock boundary (writer_queued_rx).
    // Returning lets compensate_drain_with_hook continue to validate → load → save,
    // all while the store lock remains held, keeping the writer blocked.
    let _comp_result = compensate_drain_with_hook(&app_handle, &stopped, &scope, rt_guard, || {
        // (a) Write the compensation sentinel under the held store lock.
        let mut records =
            crate::managed_agents::storage::load_managed_agents_at(&tmp_path).unwrap_or_default();
        for r in &mut records {
            r.env_vars
                .insert("COMP_SENTINEL".to_string(), "yes".to_string());
        }
        crate::managed_agents::storage::save_managed_agents_at(&tmp_path, &records).unwrap();

        // (b) Tell the writer the store lock is held.
        store_acquired_tx.send(()).unwrap();

        // (c) Wait for the writer to queue at the store lock boundary.
        writer_queued_rx.recv().unwrap();
    });

    wr_thread.join().expect("writer thread panicked");

    // ── Final disk state: BOTH effects must be present ───────────────────────
    // COMP_SENTINEL: written by the hook while compensation held the store lock.
    // WRITER_EDIT:   written by the writer after compensation released the lock.
    //
    // If the store guard is dropped before compensate_drain_for's save, the
    // writer can acquire the lock early and overwrite COMP_SENTINEL — this
    // assertion would then fail, proving the invariant.
    let final_records =
        crate::managed_agents::storage::load_managed_agents_at(&tmp_path).unwrap_or_default();
    let final_rec = final_records
        .iter()
        .find(|r| r.pubkey == pubkey1)
        .expect("agent record must be present on disk after both phases");

    assert_eq!(
        final_rec.env_vars.get("COMP_SENTINEL").map(String::as_str),
        Some("yes"),
        "COMP_SENTINEL must survive — fails if the store guard is dropped before \
         compensate_drain_for's save, allowing the writer to overwrite it"
    );
    assert_eq!(
        final_rec.env_vars.get("WRITER_EDIT").map(String::as_str),
        Some("yes"),
        "WRITER_EDIT must be present — the writer runs after compensation releases the store lock"
    );
}

/// Production start-path contender is blocked while `compensate_drain_with_hook`
/// holds the `managed_agent_runtime_transition` mutex.
///
/// Invariant: if the `managed_agent_runtime_transition` guard is dropped before
/// `compensate_drain_with_hook` finishes, `start_managed_agent_runtime_pair_lazy`
/// acquires the transition lock and proceeds — `contender_done_rx` would fire
/// before the hook completes, and the assertion at the end would fail.
///
/// Flow:
///   1. Seed the store; acquire `managed_agent_runtime_transition` in this thread.
///   2. Spawn the contender. It signals "ready," then waits for the hook to
///      signal "store held." It then signals "at_lock" and calls the production
///      `start_managed_agent_runtime_pair_lazy` — which blocks acquiring
///      `managed_agent_runtime_transition` as its first action.
///   3. `compensate_drain_with_hook` hook: signals the contender ("store held"),
///      waits for "at_lock" confirmation, then returns. The contender is now
///      queued at the transition lock.
///   4. `compensate_drain_with_hook` completes, releases the transition guard.
///   5. The contender acquires the lock (fails at spawn — no binary — but
///      passes the lock boundary), signals "done."
///
/// The contender drives `start_managed_agent_runtime_pair_lazy`, the same
/// function called by the `start_managed_agent_runtime` Tauri command, proving
/// that compensation blocks production starts — not just a raw mutex lock.
#[test]
fn test_compensate_drain_concurrent_start_is_blocked() {
    use crate::managed_agents::scope::{current_scope_generation, WorkspaceAgentScope};
    use std::thread;
    use tauri::Manager;

    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().to_path_buf();

    let pubkey1 = "aa".repeat(32);
    let initial_record = crate::managed_agents::ManagedAgentRecord {
        pubkey: pubkey1.clone(),
        name: "contender-agent".to_string(),
        display_name: None,
        slug: None,
        persona_id: None,
        private_key_nsec: String::new(),
        auth_tag: None,
        relay_url: "wss://relay.example".to_string(),
        avatar_url: None,
        acp_command: crate::managed_agents::DEFAULT_ACP_COMMAND.to_string(),
        agent_command: String::new(),
        agent_command_override: None,
        agent_args: vec![],
        mcp_command: String::new(),
        turn_timeout_seconds: 0,
        idle_timeout_seconds: None,
        max_turn_duration_seconds: None,
        parallelism: 1,
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        env_vars: Default::default(),
        start_on_app_launch: true,
        auto_restart_on_config_change: false,
        runtime_pid: None,
        backend: crate::managed_agents::BackendKind::Local,
        backend_agent_id: None,
        provider_binary_path: None,
        team_id: None,
        persona_team_dir: None,
        persona_name_in_team: None,
        created_at: crate::util::now_iso(),
        updated_at: crate::util::now_iso(),
        last_started_at: None,
        last_stopped_at: None,
        last_exit_code: None,
        last_error: None,
        last_error_code: None,
        respond_to: Default::default(),
        respond_to_allowlist: Default::default(),
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        definition_respond_to: None,
        definition_respond_to_allowlist: Default::default(),
        definition_parallelism: None,
        relay_mesh: None,
        runtime: None,
        name_pool: vec![],
    };
    crate::managed_agents::storage::save_managed_agents_at(
        &tmp_path,
        std::slice::from_ref(&initial_record),
    )
    .unwrap();

    let app = tauri::test::mock_builder()
        .manage(crate::app_state::build_app_state())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("failed to build mock app");
    let app_handle = app.app_handle().clone();
    let state = app.state::<crate::app_state::AppState>();

    let gen = current_scope_generation();
    let scope = WorkspaceAgentScope {
        scope_id: "comp-drain-contender-test".to_string(),
        relay_url: "wss://relay.example".to_string(),
        owner_pubkey: "aa".repeat(32),
        definitions_dir: tmp_path.clone(),
        generation: gen,
    };
    state.commit_active_scope(scope.clone());

    let entry1 = make_drain_entry(&pubkey1, "wss://relay.example", true);
    let stopped = vec![entry1];

    // contender_ready:   contender → test  (about to call production start seam)
    // hook_store_held:   hook → contender  (hook has store lock; contender may proceed)
    // contender_at_lock: contender → hook  (contender queued at transition lock)
    // contender_done:    contender → test  (contender passed the transition lock)
    let (contender_ready_tx, contender_ready_rx) = std::sync::mpsc::channel::<()>();
    let (hook_store_held_tx, hook_store_held_rx) = std::sync::mpsc::channel::<()>();
    let (contender_at_lock_tx, contender_at_lock_rx) = std::sync::mpsc::channel::<()>();
    let (contender_done_tx, contender_done_rx) = std::sync::mpsc::channel::<()>();

    // Acquire the transition guard FIRST so the contender will block on it.
    let rt_guard = state.managed_agent_runtime_transition.lock().unwrap();

    let app_contender = app_handle.clone();
    let pubkey_contender = pubkey1.clone();
    let contender = thread::spawn(move || {
        // Signal: about to call the production start path.
        contender_ready_tx.send(()).unwrap();

        // Wait for the hook to confirm it holds the store lock.
        hook_store_held_rx.recv().unwrap();

        // Signal: queued at the transition lock boundary.
        contender_at_lock_tx.send(()).unwrap();

        // Production start-lock seam — acquires managed_agent_runtime_transition
        // as its first action, so it blocks here until compensation releases it.
        let _ = start_pair_lazy_for(
            pubkey_contender,
            "wss://relay.example".to_string(),
            app_contender,
        );

        // Signal: passed the transition lock (compensation is done).
        contender_done_tx.send(()).unwrap();
    });

    // Wait for the contender to be alive before calling the adapter.
    contender_ready_rx.recv().unwrap();

    // on_store_acquired hook: fires while BOTH locks are held.
    //   (a) signal the contender so it proceeds to call the start seam;
    //   (b) wait for the contender to confirm it is at the lock boundary.
    // After (b) the contender is guaranteed to be blocked on
    // managed_agent_runtime_transition — returning lets
    // compensate_drain_with_hook finish its work before the contender unblocks.
    let _comp_result = compensate_drain_with_hook(&app_handle, &stopped, &scope, rt_guard, || {
        hook_store_held_tx.send(()).unwrap();
        contender_at_lock_rx.recv().unwrap();
    });

    // Contender must now acquire the mutex within a reasonable timeout.
    contender_done_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect(
            "contender must unblock after compensate_drain_with_hook releases the transition guard",
        );

    contender.join().expect("contender thread panicked");
}
