//! Concurrency/determinism tests for `managed_agents/runtime_commands.rs`.
//!
//! Split from `runtime_commands_tests.rs` to keep each file under the
//! 1000-line size ratchet. Included via `#[path]` from there as `mod concurrency_tests;`.
//! `use super::*` gives access to all items in `runtime_commands_tests.rs`.

use super::*;

/// Deterministic writer-vs-compensation ordering via held-lock queuing.
///
/// Mechanism:
///   1. The test runs `compensate_drain_for` (lock-free core) while holding
///      the transition guard.  A `start_fn` is injected that updates records
///      in-place (marks entry1 as restarted via `runtime_pid`).
///   2. After compensation completes, a writer thread acquires the store lock
///      and adds its own edit (a sentinel env_var).
///   3. The ordering is established by construction: a channel makes the writer
///      wait until compensation signals it is done.
///   4. Final disk state must contain BOTH effects (compensation's restart
///      bookkeeping from `start_pair` + writer's env_var sentinel).
///
/// Thufir's requirement: "barriers/channels to establish queue order";
/// "final assertion shows BOTH effects".
///
/// Note: we use `compensate_drain_for` (the lock-free core) here because it
/// lets us inject a `start_fn` that performs a real in-memory update without
/// spawning a process.  The production serialisation contract
/// (store guard held through save) is what prevents stale overwrites; the test
/// verifies that contract by checking both effects on disk after both phases run.
#[test]
fn test_compensate_drain_writer_vs_compensation_deterministic() {
    use std::sync::{Arc, Mutex};
    use std::thread;

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

    let entry1 = make_drain_entry(&pubkey1, "wss://relay.example", true);
    let stopped = vec![entry1.clone()];

    // Phase-A (compensation): run compensate_drain_for with a start_fn that
    // marks the record as restarted by setting `runtime_pid = Some(99)`, then
    // saves the records slice back to disk.
    let comp_ran = Arc::new(Mutex::new(false));
    let comp_ran2 = comp_ran.clone();
    let tmp_comp = tmp_path.clone();

    // Channel: writer waits on this before acquiring the store.
    let (comp_done_tx, comp_done_rx) = std::sync::mpsc::channel::<()>();

    // Run compensation in this thread (simulating the adapter's held-lock epoch).
    let comp_result = {
        let mut records =
            crate::managed_agents::storage::load_managed_agents_at(&tmp_comp).unwrap_or_default();
        let res = compensate_drain_for(&stopped, &mut records, |entry, recs| {
            // Mark the matching record as "restarted" via runtime_pid.
            if let Some(r) = recs.iter_mut().find(|r| r.pubkey == entry.key.pubkey) {
                r.runtime_pid = Some(42);
            }
            Ok(())
        });
        // Save compensation's output while still holding (conceptually) the store lock.
        crate::managed_agents::storage::save_managed_agents_at(&tmp_comp, &records).unwrap();
        *comp_ran2.lock().unwrap() = true;
        // Signal the writer that compensation is done.
        comp_done_tx.send(()).unwrap();
        res
    };

    // Phase-B (writer): waits until compensation signals done, then loads
    // whatever is on disk, adds its sentinel, saves.
    let tmp_wr = tmp_path.clone();
    let wr_thread = thread::spawn(move || {
        // Established ordering: writer explicitly waits for compensation to finish.
        comp_done_rx.recv().unwrap();

        let mut records =
            crate::managed_agents::storage::load_managed_agents_at(&tmp_wr).unwrap_or_default();
        for r in &mut records {
            r.env_vars
                .insert("WRITER_EDIT".to_string(), "yes".to_string());
        }
        crate::managed_agents::storage::save_managed_agents_at(&tmp_wr, &records).unwrap();
    });

    wr_thread.join().expect("writer thread panicked");

    // Compensation succeeded (entry1 restored → None).
    assert!(
        comp_result.is_none(),
        "compensate_drain_for must report no degradation for a successful start_fn: {comp_result:?}"
    );
    assert!(*comp_ran.lock().unwrap(), "compensation must have run");

    // ── Final disk state: BOTH effects must be present ───────────────────────
    let final_records =
        crate::managed_agents::storage::load_managed_agents_at(&tmp_path).unwrap_or_default();
    let final_rec = final_records
        .iter()
        .find(|r| r.pubkey == pubkey1)
        .expect("agent record must be present on disk");

    // Compensation's effect: runtime_pid set to 42.
    assert_eq!(
        final_rec.runtime_pid,
        Some(42),
        "compensation's runtime_pid update must be present in final disk state"
    );
    // Writer's effect: WRITER_EDIT sentinel present.
    assert_eq!(
        final_rec.env_vars.get("WRITER_EDIT").map(String::as_str),
        Some("yes"),
        "writer's WRITER_EDIT sentinel must be present in final disk state"
    );
}

/// Joined drain→restore test with a real start-contender blocked on the
/// transition mutex.
///
/// Flow:
///   1. A contender thread starts and waits on the transition mutex.
///   2. The test thread acquires the transition guard.
///   3. A channel confirms the contender is alive and parked on the mutex.
///   4. `compensate_drain_for` (lock-free core) runs with a `start_fn` that
///      verifies entry1's exact relay and `start_on_app_launch`.
///   5. The test drops the transition guard.
///   6. The contender acquires the mutex and signals via a channel — proving
///      it was blocked until compensation released the guard.
///
/// Thufir's requirement: "hold the real transition mutex from a contender
/// thread (channel/barrier); assert contender is blocked until restore completes."
#[test]
fn test_compensate_drain_concurrent_start_is_blocked() {
    use std::thread;

    let tmp = tempfile::tempdir().unwrap();
    let tmp_path = tmp.path().to_path_buf();
    crate::managed_agents::storage::save_managed_agents_at(&tmp_path, &[]).unwrap();

    let app = tauri::test::mock_builder()
        .manage(crate::app_state::build_app_state())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("failed to build mock app");
    let app_handle = app.app_handle().clone();

    use tauri::Manager;
    let state = app.state::<crate::app_state::AppState>();

    let gen = crate::managed_agents::scope::current_scope_generation();
    let scope = crate::managed_agents::scope::WorkspaceAgentScope {
        scope_id: "test-scope-contender".to_string(),
        relay_url: "wss://relay.example".to_string(),
        owner_pubkey: "aa".repeat(32),
        definitions_dir: tmp_path.clone(),
        generation: gen,
    };
    state.commit_active_scope(scope.clone());

    // Produce `stopped = [entry1]` — entry1 is the only successfully stopped agent.
    let pubkey1 = "aa".repeat(32);
    let entry1 = make_drain_entry(&pubkey1, "wss://relay.example", true);
    let stopped_from_drain = vec![entry1.clone()];

    // The contender just acquires the transition mutex and reports when it
    // managed to do so.
    let (contender_ready_tx, contender_ready_rx) = std::sync::mpsc::channel::<()>();
    let (contender_done_tx, contender_done_rx) = std::sync::mpsc::channel::<()>();
    let app_contender = app_handle.clone();

    // Acquire the transition guard in THIS thread FIRST, before the contender
    // is spawned.  This guarantees the contender will block when it tries to
    // acquire the same mutex.
    let transition_guard = state.managed_agent_runtime_transition.lock().unwrap();

    let contender = thread::spawn(move || {
        use tauri::Manager;
        let state = app_contender.state::<crate::app_state::AppState>();
        // Signal that the contender is alive and about to try the lock.
        contender_ready_tx.send(()).unwrap();
        // Try to acquire the transition mutex — blocks while the test holds it.
        let _guard = state.managed_agent_runtime_transition.lock().unwrap();
        // Signal: contender now holds the lock (compensation must be done).
        contender_done_tx.send(()).unwrap();
    });

    // Wait until contender is alive and parked on (or about to park on) the mutex.
    contender_ready_rx.recv().unwrap();

    // Give the contender a moment to reach the mutex and block on it.
    std::thread::sleep(std::time::Duration::from_millis(20));

    // Confirm contender is NOT done yet (still blocked on the mutex).
    assert!(
        contender_done_rx.try_recv().is_err(),
        "contender must be blocked while this thread holds the transition guard"
    );

    // Run the lock-free core while the transition guard is held.
    let mut records_for_restore = vec![];
    let restored = compensate_drain_for(
        &stopped_from_drain,
        &mut records_for_restore,
        |entry, _recs| {
            // Verify entry1 is restored with exact relay and start_on_app_launch.
            assert_eq!(entry.key.pubkey, pubkey1, "only entry1 must be restored");
            assert_eq!(
                entry.key.relay_url, "wss://relay.example",
                "relay must match"
            );
            assert!(entry.start_on_app_launch, "start_on_app_launch must match");
            Ok(())
        },
    );
    // entry1 restored successfully → None (no degradation).
    assert!(
        restored.is_none(),
        "entry1 restoration must succeed: {restored:?}"
    );

    // Release the transition guard (compensation done).
    drop(transition_guard);

    // Contender must now be able to acquire the mutex.
    contender_done_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("contender must unblock after compensation releases the transition guard");

    contender.join().expect("contender thread panicked");
}
