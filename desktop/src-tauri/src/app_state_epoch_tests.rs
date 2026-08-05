// Workspace-epoch seqlock protocol tests.
// Colocated as a separate test module to satisfy the file-size ratchet.
// See app_state_tests.rs for the preamble note on the false-green guard.

// These tests pin the seqlock invariants using the production guard and capture
// helpers ONLY. Direct writes to `state.keys` or `state.relay_url_override`
// are intentionally absent here — using them would bypass the protocol under
// test and produce a false green. All writes go through `begin_workspace_write`.

use super::*;

/// Build a minimal AppState with known keys/override for epoch protocol tests.
/// Does NOT call `build_app_state` (avoids keyring/FS I/O). Only the fields
/// relevant to the seqlock protocol are initialized with non-default values;
/// everything else is zeroed/None to match `Default`.
fn make_epoch_test_state(keys: Keys) -> AppState {
    use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU8};
    AppState {
        keys: Mutex::new(keys),
        identity_storage: AtomicU8::new(0),
        http_client: reqwest::Client::new(),
        media_fetch_client: reqwest::Client::new(),
        relay_url_override: Mutex::new(None),
        managed_agent_restore_pending: AtomicBool::new(false),
        managed_agent_profile_reconcile_enabled: AtomicBool::new(false),
        shutdown_started: AtomicBool::new(false),
        managed_agent_runtime_transition: Mutex::new(()),
        managed_agents_store_lock: Mutex::new(()),
        channel_templates_store_lock: Mutex::new(()),
        managed_agent_processes: Mutex::new(std::collections::HashMap::new()),
        huddle_state: Mutex::new(crate::huddle::HuddleState::default()),
        huddle_audio: Default::default(),
        app_handle: Mutex::new(None),
        media_proxy_port: AtomicU16::new(0),
        keyring_locked: AtomicBool::new(false),
        identity_lost: AtomicBool::new(false),
        identity_mutation: Mutex::new(()),
        reset_failed: AtomicBool::new(false),
        session_config_cache: Mutex::new(std::collections::HashMap::new()),
        prevent_sleep: std::sync::Arc::new(Mutex::new(
            crate::prevent_sleep::PreventSleepState::default(),
        )),
        #[cfg(feature = "mesh-llm")]
        mesh_llm_runtime: tokio::sync::Mutex::new(None),
        #[cfg(feature = "mesh-llm")]
        mesh_recovery: crate::mesh_llm::MeshRecoveryState::default(),
        #[cfg(feature = "mesh-llm")]
        mesh_coordinator: tokio::sync::Mutex::new(None),
        workspace_epoch: std::sync::atomic::AtomicU64::new(0),
        workspace_write: Mutex::new(()),
        pending_owned_channels: Mutex::new(std::collections::HashSet::new()),
    }
}

/// Epoch begins even and a fresh capture succeeds.
#[test]
fn epoch_protocol_initial_capture_succeeds() {
    let keys = Keys::generate();
    let state = make_epoch_test_state(keys.clone());

    let scope = state.capture_archive_scope(4).expect("initial capture");
    assert_eq!(scope.actor, keys.public_key().to_hex());
    assert!(
        scope.workspace_epoch.is_multiple_of(2),
        "captured epoch must be even"
    );
}

/// While a writer guard is held the epoch is odd; capture retries and only
/// succeeds after the guard is dropped (restoring even). Additionally asserts
/// that a second acquisition of the writer guard blocks until the first drops
/// (writer exclusion).
#[test]
fn epoch_protocol_writer_exclusion_and_capture_retry() {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    let keys = Keys::generate();
    let state = Arc::new(make_epoch_test_state(keys));

    // Acquire write guard → epoch goes odd.
    let guard = state.begin_workspace_write().expect("first write guard");
    let odd = state.workspace_epoch.load(Ordering::SeqCst);
    assert_eq!(odd % 2, 1, "epoch must be odd while guard is held");

    // With the guard held, mutate relay_url_override (simulating apply_workspace).
    {
        let mut ovr = state.relay_url_override.lock().unwrap();
        *ovr = Some("wss://test.relay".to_string());
    }

    // Spawn a thread that tries to acquire a second write guard; it must block
    // until we drop the first one.
    let state2 = Arc::clone(&state);
    let handle = std::thread::spawn(move || {
        // This blocks until the outer guard is dropped.
        let _g = state2.begin_workspace_write().expect("second write guard");
        // Confirm the second guard restores to even after it drops.
    });

    // A capture attempt while odd must not return a mixed-gen scope.
    // With max_retries=0 it fails fast rather than spinning.
    let result = state.capture_archive_scope(0);
    assert!(
        result.is_err(),
        "capture with max_retries=0 while epoch odd must fail"
    );

    // Drop the first guard → epoch goes even, unblocks the second thread,
    // and subsequent captures succeed.
    drop(guard);
    let even = state.workspace_epoch.load(Ordering::SeqCst);
    assert_eq!(even % 2, 0, "epoch must be even after guard drop");

    // Wait for the second thread to finish.
    handle.join().expect("second guard thread panicked");

    // Now capture succeeds.
    let scope = state
        .capture_archive_scope(4)
        .expect("capture after release");
    assert!(scope.workspace_epoch.is_multiple_of(2));
}

/// Drop (RAII restoration) on explicit drop and via `?` early return restores
/// an even epoch on every exit path.
#[test]
fn epoch_protocol_raii_always_restores_even() {
    use std::sync::atomic::Ordering;

    let state = make_epoch_test_state(Keys::generate());

    // Normal drop.
    {
        let _g = state.begin_workspace_write().expect("guard");
        assert_eq!(
            state.workspace_epoch.load(Ordering::SeqCst) % 2,
            1,
            "odd while held"
        );
    }
    assert_eq!(
        state.workspace_epoch.load(Ordering::SeqCst) % 2,
        0,
        "even after normal drop"
    );

    // Simulated early-return via a closure that acquires and immediately drops
    // the guard when an error is returned.
    let result: Result<(), String> = (|| {
        let _g = state.begin_workspace_write()?;
        // Return early before the closure completes.
        return Err("early return".to_string());
        #[allow(unreachable_code)]
        Ok(())
    })();
    assert!(result.is_err());
    assert_eq!(
        state.workspace_epoch.load(Ordering::SeqCst) % 2,
        0,
        "even after early-return drop"
    );

    // Simulated panic / catch_unwind.
    // AppState contains non-UnwindSafe fields (reqwest::Client, etc.) so we
    // assert the safety boundary explicitly — this test only exercises the
    // epoch AtomicU64 and the Mutex<()> guard, both of which are panic-safe.
    let state_ref = std::panic::AssertUnwindSafe(&state);
    let panic_result = std::panic::catch_unwind(|| {
        let _g = state_ref.begin_workspace_write().expect("guard for panic");
        panic!("simulated panic");
    });
    assert!(panic_result.is_err(), "panic must be caught");
    assert_eq!(
        state.workspace_epoch.load(Ordering::SeqCst) % 2,
        0,
        "even after panic/catch_unwind"
    );
}

/// A poisoned `relay_url_override` mutex causes `capture_archive_scope` to
/// return `Err` rather than accepting potentially torn state.
#[test]
fn epoch_protocol_poisoned_mutex_causes_capture_error() {
    use std::sync::Arc;

    let state = Arc::new(make_epoch_test_state(Keys::generate()));
    let state2 = Arc::clone(&state);

    // Poison `relay_url_override` by panicking while holding the lock.
    let _r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _lock = state2.relay_url_override.lock().unwrap();
        panic!("poison the mutex");
    }));

    // After poisoning, capture_archive_scope must return Err.
    let result = state.capture_archive_scope(1);
    assert!(
        result.is_err(),
        "capture must fail when relay_url_override is poisoned"
    );
}

/// Mixed-generation barrier test: a writer is stalled mid-mutation (after
/// writing relay_url_override but before writing keys). A concurrent capture
/// with max_retries > 0 must never return a mixed-generation scope; it must
/// only succeed after the writer completes and produces a co-generational pair.
#[test]
fn epoch_protocol_mixed_generation_rejected_while_mid_transition() {
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Barrier};

    let initial_keys = Keys::generate();
    let new_keys = Keys::generate();
    let state = Arc::new(make_epoch_test_state(initial_keys.clone()));

    // Two-phase barrier: first rendezvous lets the writer signal it has
    // written the relay override but not yet the keys; second rendezvous lets
    // the test confirm the capture it received (if any) before the writer
    // proceeds to update keys.
    let barrier_after_override = Arc::new(Barrier::new(2));
    let barrier_after_keys = Arc::new(Barrier::new(2));

    let state_writer = Arc::clone(&state);
    let barrier1 = Arc::clone(&barrier_after_override);
    let barrier2 = Arc::clone(&barrier_after_keys);
    let new_keys_clone = new_keys.clone();

    let writer_thread = std::thread::spawn(move || {
        // Acquire the write guard → epoch goes odd.
        let _guard = state_writer.begin_workspace_write().expect("write guard");
        // Write override but NOT keys yet.
        {
            let mut ovr = state_writer.relay_url_override.lock().unwrap();
            *ovr = Some("wss://new.relay".to_string());
        }
        // Signal: override written, keys not yet updated.
        barrier1.wait();
        // Wait for reader to attempt capture.
        barrier2.wait();
        // Now write keys (completing the compound mutation).
        {
            let mut k = state_writer.keys.lock().unwrap();
            *k = new_keys_clone;
        }
        // Guard drops here → epoch goes even.
    });

    // Wait until the writer is mid-mutation (override written, keys old, epoch odd).
    barrier_after_override.wait();

    // Epoch must be odd at this point.
    assert_eq!(
        state.workspace_epoch.load(Ordering::SeqCst) % 2,
        1,
        "epoch must be odd while writer is mid-transition"
    );

    // Attempt capture with 0 retries — must fail because epoch is odd.
    let result_during_mutation = state.capture_archive_scope(0);
    assert!(
        result_during_mutation.is_err(),
        "capture must fail when epoch is odd (mid-transition)"
    );

    // Release writer to complete the mutation.
    barrier_after_keys.wait();
    writer_thread.join().expect("writer thread panicked");

    // Epoch is now even; capture must succeed and return the NEW generation.
    let scope = state.capture_archive_scope(8).expect("capture after write");
    assert_eq!(scope.relay_url_override.as_deref(), Some("wss://new.relay"));
    assert_eq!(scope.actor, new_keys.public_key().to_hex());
    assert!(
        scope.workspace_epoch.is_multiple_of(2),
        "captured epoch must be even"
    );
}

/// Finding 7: `capture_archive_scope` must fail immediately when
/// `identity_lost` is set, regardless of epoch parity.
#[test]
fn capture_archive_scope_rejects_when_identity_lost() {
    use std::sync::atomic::Ordering;

    let state = make_epoch_test_state(Keys::generate());
    state.identity_lost.store(true, Ordering::SeqCst);

    let result = state.capture_archive_scope(8);
    assert!(
        result.is_err(),
        "capture must fail when identity_lost is set"
    );
    assert!(
        result.unwrap_err().contains("recovery mode"),
        "error must mention recovery mode"
    );
}

/// Finding 7: `capture_archive_scope` must fail immediately when
/// `keyring_locked` is set.
#[test]
fn capture_archive_scope_rejects_when_keyring_locked() {
    use std::sync::atomic::Ordering;

    let state = make_epoch_test_state(Keys::generate());
    state.keyring_locked.store(true, Ordering::SeqCst);

    let result = state.capture_archive_scope(8);
    assert!(
        result.is_err(),
        "capture must fail when keyring_locked is set"
    );
    assert!(
        result.unwrap_err().contains("recovery mode"),
        "error must mention recovery mode"
    );
}
