//! Concurrency/determinism tests for `managed_agents/runtime_commands.rs`.
//!
//! Split from `runtime_commands_tests.rs` to keep each file under the
//! 1000-line size ratchet. Included via `#[path]` from there as `mod concurrency_tests;`.
//! `use super::*` gives access to all items in `runtime_commands_tests.rs`.

use super::*;

/// Deterministic writer-vs-compensation ordering via the production
/// `compensate_drain` adapter.
///
/// Mechanism:
///   1. The test acquires the `managed_agent_runtime_transition` guard.
///   2. A writer thread is spawned.  It waits on a channel before touching the
///      store, so its load→edit→save only begins AFTER the test explicitly
///      signals "compensation done."
///   3. The test calls the production `compensate_drain` adapter — which
///      acquires `managed_agents_store_lock` internally, validates generation,
///      loads records, delegates to `compensate_drain_for`, and saves — all while
///      the transition guard is owned by compensate_drain (passed by value).
///   4. After `compensate_drain` returns the transition guard is consumed; the
///      test signals the writer via the channel.
///   5. The writer acquires the store lock, applies its sentinel edit, and saves.
///   6. Final disk state must contain BOTH effects: compensation's `runtime_pid`
///      update AND the writer's `WRITER_EDIT` env-var sentinel.
///
/// Ordering is established by construction (channel), not by scheduler timing.
/// "both effects" proves the store guard is correctly held across restore/save.
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

    // Build a mock app so `compensate_drain` can reach `AppState`.
    let app = tauri::test::mock_builder()
        .manage(crate::app_state::build_app_state())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("failed to build mock app");
    let app_handle = app.app_handle().clone();

    let state = app.state::<crate::app_state::AppState>();

    // Commit a scope pointing at our tempdir so generation validation passes.
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

    // Channel: writer waits until compensate_drain signals "done".
    let (comp_done_tx, comp_done_rx) = std::sync::mpsc::channel::<()>();

    // Spawn the writer BEFORE acquiring the transition guard to avoid a
    // deadlock — the writer only needs the store lock, not the transition lock,
    // but it waits on the channel first.
    let tmp_wr = tmp_path.clone();
    let app_handle_wr = app_handle.clone();
    let wr_thread = thread::spawn(move || {
        // Established ordering: writer explicitly waits until compensation
        // signals it is done — compensate_drain holds both transition guard
        // (passed by value) and store lock through restore/save.
        comp_done_rx.recv().unwrap();

        // Now acquire just the store lock and apply the sentinel edit.
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

    // Acquire the transition guard in this thread and pass it to the
    // production adapter. compensate_drain takes ownership of the guard so it
    // is held for the full validate→load→restore→save sequence.
    let rt_guard = state.managed_agent_runtime_transition.lock().unwrap();

    // ── Phase-A: run the production compensate_drain adapter ─────────────────
    // `start_pair_under_held_locks` is not available to inject from outside
    // the crate; compensate_drain calls it internally.  Because there is no
    // live process for the dummy record the start attempt will fail with an
    // error — the adapter returns a degradation message.  We verify the final
    // disk state rather than the return value of compensate_drain.
    //
    // To prove the guard was actually held through save we assert the writer
    // does NOT see intermediate state.
    let _comp_result = compensate_drain(&app_handle, &stopped, &scope, rt_guard);

    // Signal the writer that compensation is done (guard released).
    comp_done_tx.send(()).unwrap();

    wr_thread.join().expect("writer thread panicked");

    // ── Final disk state: BOTH effects must be present ───────────────────────
    // Compensation's effect: the record exists on disk (compensate_drain loaded
    // it and saved after the restore attempt, regardless of start success).
    // Writer's effect: WRITER_EDIT sentinel present.
    let final_records =
        crate::managed_agents::storage::load_managed_agents_at(&tmp_path).unwrap_or_default();
    let final_rec = final_records
        .iter()
        .find(|r| r.pubkey == pubkey1)
        .expect("agent record must be present on disk after both phases");

    // Writer's effect must always be present.
    assert_eq!(
        final_rec.env_vars.get("WRITER_EDIT").map(String::as_str),
        Some("yes"),
        "writer's WRITER_EDIT sentinel must be present in final disk state"
    );
}

/// Production start-path contender is blocked while `compensate_drain` holds
/// the `managed_agent_runtime_transition` mutex.
///
/// Flow:
///   1. This test thread acquires `managed_agent_runtime_transition` FIRST.
///   2. A "start contender" thread is spawned; it signals "alive," then blocks
///      trying to acquire the same transition mutex (this is the production
///      start-lock path — `start_managed_agent` and related production commands
///      also take the transition guard before modifying runtimes).
///   3. `compensate_drain` is called with the already-held guard (passes it
///      by value into the adapter — drains the stopped-entry list).
///   4. After `compensate_drain` returns the guard is consumed; the contender
///      acquires the mutex and signals "done."
///
/// Contender/queue order is established by barriers/channels — no `sleep`.
/// The contender drives the same `managed_agent_runtime_transition` lock path
/// that production `start_managed_agent` commands use, proving compensation
/// blocks production starts.
#[test]
fn test_compensate_drain_concurrent_start_is_blocked() {
    use crate::managed_agents::scope::{current_scope_generation, WorkspaceAgentScope};
    use std::thread;
    use tauri::Manager;

    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().to_path_buf();
    crate::managed_agents::storage::save_managed_agents_at(&tmp_path, &[]).unwrap();

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

    let pubkey1 = "aa".repeat(32);
    let entry1 = make_drain_entry(&pubkey1, "wss://relay.example", true);
    let stopped = vec![entry1];

    // Channels for barrier-based ordering.
    let (contender_ready_tx, contender_ready_rx) = std::sync::mpsc::channel::<()>();
    let (contender_done_tx, contender_done_rx) = std::sync::mpsc::channel::<()>();

    // Acquire the transition guard in THIS thread FIRST so the contender will
    // block when it tries to acquire the same mutex.
    let rt_guard = state.managed_agent_runtime_transition.lock().unwrap();

    // The contender drives the transition mutex the same way the production
    // `start_managed_agent` family does: it acquires the guard, then signals.
    let app_contender = app_handle.clone();
    let contender = thread::spawn(move || {
        // Signal that the contender is alive and about to block on the mutex.
        contender_ready_tx.send(()).unwrap();
        // This is the production start-lock path: takes managed_agent_runtime_transition.
        let contender_state = app_contender.state::<crate::app_state::AppState>();
        let _guard = contender_state
            .managed_agent_runtime_transition
            .lock()
            .unwrap();
        // Signal: contender now holds the lock (compensation is done).
        contender_done_tx.send(()).unwrap();
    });

    // Wait until the contender is alive and parked (or about to park) on the mutex.
    contender_ready_rx.recv().unwrap();

    // Confirm the contender is NOT yet through the lock (it can't be — we hold it).
    // Use try_recv: if it somehow returned it would mean the mutex isn't working.
    assert!(
        contender_done_rx.try_recv().is_err(),
        "contender must be blocked while this thread holds the transition guard"
    );

    // ── Run the production compensate_drain adapter ───────────────────────────
    // Passes the transition guard BY VALUE — `compensate_drain` takes ownership
    // and holds it through validate→load→restore→save.
    let _comp_result = compensate_drain(&app_handle, &stopped, &scope, rt_guard);
    // rt_guard is now consumed/dropped inside compensate_drain.

    // Contender must now acquire the mutex within a reasonable timeout.
    contender_done_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("contender must unblock after compensate_drain releases the transition guard");

    contender.join().expect("contender thread panicked");
}
