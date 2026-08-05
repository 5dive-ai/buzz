//! Concurrency/determinism tests for `managed_agents/runtime_commands.rs`.
//!
//! Split from `runtime_commands_tests.rs` to keep each file under the
//! 1000-line size ratchet. Included via `#[path]` from there as `mod concurrency_tests;`.
//! `use super::*` gives access to all items in `runtime_commands_tests.rs`.

use super::*;

/// Writer-vs-compensation store-lock contention via the `compensate_drain_with_hook` seam.
///
/// Invariant: if `managed_agents_store_lock` is dropped before the adapter's
/// `on_after_restore` callback, the writer acquires the lock before `COMP_SENTINEL`
/// reaches disk, loads records without it, and saves only `WRITER_EDIT` —
/// making the `COMP_SENTINEL` assertion fail deterministically.
///
/// Flow:
///   1. Seed the store with one agent record; seed a live runtime so that
///      `start_pair_under_held_locks` returns `AlreadyRunning` (compensation
///      succeeds without spawning — `comp_result` is `None`).
///   2. Acquire `managed_agent_runtime_transition`; call `compensate_drain_with_hook`.
///   3. `on_records_loaded` hook fires AFTER both locks are held:
///      a. signals the writer thread (`records_loaded_tx`);
///      b. waits for writer's pre-lock signal (`writer_at_store_lock_rx`) — sent
///      immediately before `managed_agents_store_lock.lock()`, so when received,
///      the writer's next instruction is that lock call (which blocks).
///   4. `compensate_drain_for` runs under the held store lock (succeeds — AlreadyRunning).
///   5. `on_after_restore` hook fires while the store lock is STILL held:
///      mutates `COMP_SENTINEL` on the adapter-loaded records and saves to disk
///      (assert/unwrap). Writer remains blocked.
///   6. Adapter releases the store lock. Writer acquires it, loads records
///      (which now include `COMP_SENTINEL`), writes `WRITER_EDIT`, saves.
///   7. Final disk record must contain BOTH `COMP_SENTINEL` AND `WRITER_EDIT`.
///      `comp_result` must be `None` (compensation succeeded).
///
/// What breaks it: if the store guard is dropped before `on_after_restore`,
/// the writer acquires `managed_agents_store_lock` before `COMP_SENTINEL`
/// reaches disk, loads records without it, and saves only `WRITER_EDIT` —
/// the first assertion fails deterministically.
#[test]
fn test_compensate_drain_writer_vs_compensation_deterministic() {
    use crate::managed_agents::scope::{
        current_scope_generation, WorkspaceAgentScope, SCOPE_GENERATION_TEST_LOCK,
    };
    use std::thread;
    use tauri::Manager;

    let _gen_guard = SCOPE_GENERATION_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());

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

    // Seed a live runtime so `start_pair_under_held_locks` returns AlreadyRunning.
    // This makes `compensate_drain_for` succeed (`comp_result = None`) without
    // needing a real agent binary — compensation finds the agent already started.
    let rt_key =
        crate::managed_agents::ManagedAgentRuntimeKey::new(pubkey1.clone(), "wss://relay.example")
            .unwrap();
    {
        let mut runtimes = state.managed_agent_processes.lock().unwrap();
        let child = spawn_long_lived_child_for_test();
        let process = crate::managed_agents::ManagedAgentProcess {
            child,
            log_path: std::path::PathBuf::new(),
            spawn_config: crate::managed_agents::spawn_snapshot::prospective_spawn_config_snapshot(
                &initial_record,
                &[],
                &[],
                "wss://relay.example",
                &Default::default(),
            ),
            setup_mode: false,
            adapter_availability: None,
            start_nonce: "test-nonce-writer".to_string(),
            #[cfg(windows)]
            job: None,
        };
        runtimes.insert(
            rt_key.clone(),
            crate::managed_agents::ManagedAgentPairRuntime::starting(
                process,
                Some("comp-drain-writer-test".to_string()),
            ),
        );
    }

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

    // records_loaded:       hook → writer   (compensation holds store lock; writer may proceed)
    // writer_at_store_lock: writer → hook   (writer is about to call managed_agents_store_lock.lock())
    //
    // The writer sends writer_at_store_lock immediately BEFORE the lock call, so the
    // hook's recv() completing is a happens-before guarantee that the writer's next
    // instruction is managed_agents_store_lock.lock() — which blocks because
    // compensation holds it.
    let (records_loaded_tx, records_loaded_rx) = std::sync::mpsc::channel::<()>();
    let (writer_at_store_lock_tx, writer_at_store_lock_rx) = std::sync::mpsc::channel::<()>();

    // Spawn the writer thread BEFORE acquiring the transition guard.
    // The writer directly acquires managed_agents_store_lock after signalling —
    // no intermediate lock — so its blocking is specifically on the store lock
    // that compensate_drain_with_hook holds. This makes the test fail if the
    // adapter drops the store guard before on_after_restore saves.
    let tmp_wr = tmp_path.clone();
    let app_handle_wr = app_handle.clone();
    let wr_thread = thread::spawn(move || {
        // Wait until on_records_loaded signals that compensation holds the store lock.
        records_loaded_rx.recv().unwrap();

        // Signal the hook that we are about to call managed_agents_store_lock.lock().
        // The hook's recv() will happen-before our lock call, so when on_after_restore
        // mutates COMP_SENTINEL and saves, we are guaranteed to be BLOCKED on the
        // store lock — not merely about to call it.
        writer_at_store_lock_tx.send(()).unwrap();

        // Block on the store lock. Compensation still holds it; we wait here until
        // on_after_restore saves COMP_SENTINEL and the lock is released.
        let writer_state = app_handle_wr.state::<crate::app_state::AppState>();
        let _store = writer_state.managed_agents_store_lock.lock().unwrap();

        // Store lock acquired: on_after_restore has finished and released the lock.
        // Load records — COMP_SENTINEL must be present because on_after_restore
        // saved it before releasing the lock.
        let mut records =
            crate::managed_agents::storage::load_managed_agents_at(&tmp_wr).unwrap_or_default();
        for r in &mut records {
            r.env_vars
                .insert("WRITER_EDIT".to_string(), "yes".to_string());
        }
        crate::managed_agents::storage::save_managed_agents_at(&tmp_wr, &records).unwrap();
    });

    let rt_guard = state.managed_agent_runtime_transition.lock().unwrap();

    // on_records_loaded fires after load, while BOTH locks are held:
    //   (a) signal the writer thread that compensation holds the store lock;
    //   (b) wait for the writer to confirm it is at the store-lock boundary —
    //       the writer sends this immediately BEFORE managed_agents_store_lock.lock(),
    //       so by the time recv() returns, the writer's next instruction is that lock
    //       call (which blocks because compensation holds it).
    //
    // on_after_restore fires AFTER compensate_drain_for returns, still under BOTH locks:
    //   mutates COMP_SENTINEL in-memory and saves to disk (assert/unwrap).
    //   The store lock is still held — the writer remains blocked until this save returns
    //   and the lock is released.
    //
    // What breaks it: if the store guard is dropped before on_after_restore, the writer
    // acquires managed_agents_store_lock before COMP_SENTINEL reaches disk — the writer's
    // final save omits COMP_SENTINEL, and the first assertion below fails.
    let comp_result = compensate_drain_with_hook(
        &app_handle,
        &stopped,
        &scope,
        rt_guard,
        // on_records_loaded: synchronise with the writer — both locks are held here.
        |_records| {
            // (a) Tell the writer that records are loaded; compensation holds both locks.
            records_loaded_tx.send(()).unwrap();

            // (b) Wait for the writer to reach the store-lock boundary.
            // After recv() completes, the writer's next instruction is
            // managed_agents_store_lock.lock() — which blocks because we hold it.
            writer_at_store_lock_rx.recv().unwrap();
        },
        // on_after_restore: save the COMP_SENTINEL mutation while BOTH locks are still held.
        // The writer is blocked on managed_agents_store_lock. This save reaching disk before
        // the lock is released is the load-bearing property: shortening the guard before this
        // callback lets the writer interleave and load records without COMP_SENTINEL.
        |records| {
            for r in records.iter_mut() {
                r.env_vars
                    .insert("COMP_SENTINEL".to_string(), "yes".to_string());
            }
            crate::managed_agents::storage::save_managed_agents_at(&tmp_path, records)
                .expect("on_after_restore: save must succeed — store lock held");
        },
    );

    wr_thread.join().expect("writer thread panicked");

    // Kill the seeded long-lived child.
    let seeded_pid = {
        let runtimes = state.managed_agent_processes.lock().unwrap();
        runtimes.get(&rt_key).map(|r| r.child.id())
    };
    if let Some(pid) = seeded_pid {
        let _ = crate::managed_agents::terminate_process(pid);
    }

    // Compensation must have succeeded: agent was AlreadyRunning, no errors.
    assert!(
        comp_result.is_none(),
        "compensation must succeed (AlreadyRunning path): {comp_result:?}"
    );

    // ── Final disk state: BOTH effects must be present ───────────────────────
    // COMP_SENTINEL: mutated and saved by on_after_restore while the store lock
    //               was still held — before the writer could acquire and load.
    // WRITER_EDIT:   written by the writer after the adapter released the lock.
    //
    // If the store guard is dropped before on_after_restore, the writer acquires
    // managed_agents_store_lock before COMP_SENTINEL reaches disk — the writer's
    // save omits COMP_SENTINEL, and the first assertion below fails.
    let final_records =
        crate::managed_agents::storage::load_managed_agents_at(&tmp_path).unwrap_or_default();
    let final_rec = final_records
        .iter()
        .find(|r| r.pubkey == pubkey1)
        .expect("agent record must be present on disk after both phases");

    assert_eq!(
        final_rec.env_vars.get("COMP_SENTINEL").map(String::as_str),
        Some("yes"),
        "COMP_SENTINEL must reach disk via on_after_restore while the store lock is held; \
         fails if the store guard is dropped before on_after_restore, allowing \
         the writer to load and save records without COMP_SENTINEL"
    );
    assert_eq!(
        final_rec.env_vars.get("WRITER_EDIT").map(String::as_str),
        Some("yes"),
        "WRITER_EDIT must be present — the writer runs after compensation releases the store lock"
    );
}

/// Production start-path contender is blocked on `managed_agent_runtime_transition`
/// while `compensate_drain_with_hook` holds it, and the `on_transition_acquired` hook
/// in `start_pair_lazy_for_with_hook` fires only AFTER the transition lock is released.
///
/// `start_pair_lazy_for_with_hook` is the production-callable seam: production
/// `start_managed_agent_runtime_pair_lazy` → `start_pair_lazy_for` → `start_pair_lazy_for_with_hook`
/// → `start_pair_for_with_hook`. Removing `managed_agent_runtime_transition` from the
/// production path also removes it from this test seam, making the test a faithful proxy.
///
/// Invariant: if `managed_agent_runtime_transition` is removed from the start seam,
/// the contender fires `on_transition_acquired` immediately after `on_before_transition`
/// (with zero lock contention) — before compensation has a chance to complete. The
/// `on_records_loaded` hook detects this via `try_recv()` on the channel that
/// `on_transition_acquired` sends to, making the test fail deterministically:
///
///   - With the lock PRESENT: contender blocks at `managed_agent_runtime_transition.lock()`
///     immediately after `on_before_transition`. `on_transition_acquired` cannot fire while
///     compensation holds the lock. `try_recv()` inside `on_records_loaded` returns `Err(Empty)`.
///     After compensation releases the lock, contender fires `on_transition_acquired` and the
///     `recv_timeout()` below succeeds.
///
///   - With the lock REMOVED: contender fires `on_before_transition` (sends
///     `contender_at_boundary`), then immediately fires `on_transition_acquired` (sends
///     to `contender_transition_acquired_rx`). This fires in nanoseconds. By the time
///     compensation reaches `on_records_loaded` (after file I/O for load_managed_agents),
///     the channel already contains the message. `try_recv()` succeeds → assertion fails.
///
/// Flow:
///   1. Seed the store; acquire `managed_agent_runtime_transition` in this thread.
///   2. Spawn the contender. It calls `start_pair_lazy_for_with_hook`:
///      - `on_before_transition` fires (BEFORE the lock call) and sends
///        `contender_at_boundary` — at this point the contender is inside the seam,
///        about to block on `managed_agent_runtime_transition`.
///   3. Wait for `contender_at_boundary` — the contender is now blocked at the
///      transition lock because we hold it.
///   4. Call `compensate_drain_with_hook`. The `on_records_loaded` hook:
///      (a) asserts `transition_hook_fired` is false (atomic bool sanity check);
///      (b) asserts `transition_hook_check_rx.try_recv()` is `Err(Empty)` — the
///      deterministic proof that `on_transition_acquired` has not fired yet.
///   5. `compensate_drain_with_hook` finishes; releases the transition guard.
///   6. The contender acquires the guard; `on_transition_acquired` fires and
///      sends `contender_transition_acquired`.
///   7. Test asserts that `contender_transition_acquired` fires within a timeout.
///
/// What breaks it: if `managed_agent_runtime_transition` is removed from
/// `start_pair_for_with_hook`, `on_transition_acquired` fires before step 4's assertion
/// (the contender fires it in nanoseconds; compensation needs milliseconds for
/// file I/O before reaching `on_records_loaded`), making both the `try_recv()` and the
/// atomic check fail.
#[test]
fn test_compensate_drain_concurrent_start_is_blocked() {
    use crate::managed_agents::scope::{
        current_scope_generation, WorkspaceAgentScope, SCOPE_GENERATION_TEST_LOCK,
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::thread;
    use tauri::Manager;

    let _gen_guard = SCOPE_GENERATION_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());

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

    // (A) contender_at_boundary:         contender → test  (inside seam, about to block on transition lock)
    // (B) contender_transition_acquired: contender → test  (start seam acquired transition guard)
    //     Two receivers for the same semantic signal:
    //     - transition_hook_check_rx: moved into on_records_loaded for try_recv() check
    //     - contender_transition_acquired_rx: used after compensation for recv_timeout() check
    let (contender_at_boundary_tx, contender_at_boundary_rx) = std::sync::mpsc::channel::<()>();
    let (transition_hook_check_tx, transition_hook_check_rx) = std::sync::mpsc::channel::<()>();
    let (contender_transition_acquired_tx, contender_transition_acquired_rx) =
        std::sync::mpsc::channel::<()>();

    // Shared flag: set to true when `on_transition_acquired` fires inside start_pair_for_with_hook.
    // Belt-and-suspenders companion to the try_recv() check in on_records_loaded.
    let transition_hook_fired = Arc::new(AtomicBool::new(false));
    let transition_hook_fired2 = transition_hook_fired.clone();

    // Acquire the transition guard FIRST so the contender will block on it.
    let rt_guard = state.managed_agent_runtime_transition.lock().unwrap();

    let app_contender = app_handle.clone();
    let pubkey_contender = pubkey1.clone();
    let contender = thread::spawn(move || {
        // `start_pair_lazy_for_with_hook` is the production-called seam.
        // on_before_transition fires just BEFORE managed_agent_runtime_transition.lock().
        // At that point we are inside the seam, about to block on the transition guard
        // (which the test holds). Signaling from here proves the contender is inside
        // the seam and will block on the next line — not merely about to call the function.
        let _ = start_pair_lazy_for_with_hook(
            pubkey_contender,
            "wss://relay.example".to_string(),
            app_contender,
            // on_before_transition: fires inside the seam, just before the lock call.
            // The contender is now committed to acquiring managed_agent_runtime_transition
            // and will block there immediately after this hook returns.
            move || {
                contender_at_boundary_tx.send(()).unwrap();
                // Next line in the seam: managed_agent_runtime_transition.lock() — blocks.
            },
            // on_transition_acquired: fires AFTER the transition guard is acquired,
            // BEFORE the store lock. Signals the test that start has passed the
            // transition-lock boundary. Sends to two channels: one for the
            // try_recv() check inside on_records_loaded, one for the final
            // recv_timeout() check after compensation returns.
            move || {
                transition_hook_fired2.store(true, Ordering::SeqCst);
                transition_hook_check_tx.send(()).unwrap();
                contender_transition_acquired_tx.send(()).unwrap();
            },
        );
    });

    // Wait for the contender to be inside the seam and about to block on the
    // transition lock. After this signal the contender is on the next line:
    // managed_agent_runtime_transition.lock() — which blocks because we hold it.
    contender_at_boundary_rx.recv().unwrap();

    // on_records_loaded hook: fires while BOTH locks are held.
    //
    // Two complementary checks that on_transition_acquired has NOT fired:
    //   (1) Atomic bool: fast sanity check.
    //   (2) try_recv(): channel-based proof — on_transition_acquired sends to the
    //       channel; if the channel is empty here, the hook has not fired.
    //
    // Why (2) is deterministic when the lock is removed: on_before_transition fires,
    // on_transition_acquired fires immediately (zero lock contention), and the send
    // completes in nanoseconds. By the time compensation reaches on_records_loaded
    // (after acquiring the store lock and loading records from disk — milliseconds
    // of I/O), the channel is guaranteed to contain the message. try_recv() finds it
    // and the assertion fails, catching the missing lock.
    //
    // When the lock IS present: on_before_transition fires, then the contender
    // blocks at managed_agent_runtime_transition.lock(). on_transition_acquired
    // cannot fire until after compensation releases the guard. try_recv() correctly
    // returns Err(Empty).
    let _comp_result = compensate_drain_with_hook(
        &app_handle,
        &stopped,
        &scope,
        rt_guard,
        // on_records_loaded: fires while BOTH locks are held. Checks that
        // on_transition_acquired has NOT fired — the contender is still blocked
        // at managed_agent_runtime_transition.lock() because we hold it.
        |_records| {
            // Check 1: atomic bool.
            assert!(
                !transition_hook_fired.load(Ordering::SeqCst),
                "start seam must not acquire the transition guard while compensation holds it; \
                 fails if managed_agent_runtime_transition is removed from start_pair_for_with_hook"
            );
            // Check 2: channel try_recv — deterministic proof via file-I/O time differential.
            // transition_hook_check_rx is a dedicated receiver that on_transition_acquired
            // sends to; this closure moves it so the outer recv_timeout() uses the
            // separate contender_transition_acquired_rx.
            assert!(
                transition_hook_check_rx.try_recv().is_err(),
                "on_transition_acquired must not fire while compensation holds the transition \
                 guard; fails if managed_agent_runtime_transition is removed from \
                 start_pair_for_with_hook \
                 (the hook fires in nanoseconds; this check runs after ms of file I/O)"
            );
        },
        // on_after_restore: no-op for the contender test — this test's load-bearing
        // property is the transition guard, not the store-lock lifetime.
        |_records| {},
    );

    // After compensation returns, the contender can acquire the transition guard.
    // `on_transition_acquired` fires and sends the signal.
    contender_transition_acquired_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect(
            "contender's on_transition_acquired must fire after compensate_drain_with_hook \
             releases the transition guard; fails if start_pair_for_with_hook does not acquire \
             managed_agent_runtime_transition before calling on_transition_acquired",
        );

    contender.join().expect("contender thread panicked");
}
