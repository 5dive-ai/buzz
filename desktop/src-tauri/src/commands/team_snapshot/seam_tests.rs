//! Phase-boundary seam tests for team snapshot import (Area 3).
//!
//! Split from `tests.rs` to keep each file under the 1000-line ratchet.
//! Included via `#[path = "seam_tests.rs"] mod seam_tests;` from `tests.rs`.
//! `use super::*` gives access to all items in `tests.rs`.
use super::*;

// ── Phase-boundary seam tests (Area 3 — team) ─────────────────────────────

/// Serializes tests that modify the process-global scope generation counter.
/// See the equivalent comment in `import_tests.rs` for rationale.
use crate::managed_agents::scope::SCOPE_GENERATION_TEST_LOCK as GENERATION_TEST_LOCK;

fn setup_team_import_app_with_scope(
    tmp: &tempfile::TempDir,
) -> (tauri::App<tauri::test::MockRuntime>, nostr::Keys) {
    use crate::managed_agents::scope::{next_scope_generation, WorkspaceAgentScope};

    let owner_keys = nostr::Keys::generate();
    let state = crate::app_state::build_app_state();
    {
        let mut locked = state.keys.lock().unwrap();
        *locked = owner_keys.clone();
    }

    let app = tauri::test::mock_builder()
        .manage(state)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("failed to build mock app for team import test");

    {
        use tauri::Manager;
        let s = app.state::<crate::app_state::AppState>();
        let gen = next_scope_generation();
        let scope = WorkspaceAgentScope {
            scope_id: "ts-test-scope".to_string(),
            relay_url: "wss://captured.example".to_string(),
            owner_pubkey: owner_keys.public_key().to_hex(),
            definitions_dir: tmp.path().to_path_buf(),
            generation: gen,
        };
        s.commit_active_scope(scope);
    }

    (app, owner_keys)
}

/// `after_store` hook commits a genuinely different live scope + owner —
/// Phase 4/5 outbound must use the OLD (captured) relay URL, not the new
/// live relay.
///
/// Thufir requirement: `after_store` must commit a genuinely different live
/// scope and owner, not merely increment a counter. We swap the active scope
/// to a different relay + fresh owner inside the hook; all per-member profile
/// adapters must receive the old captured relay URL.
#[tokio::test]
// SAFETY: single-threaded tokio runtime; lock held to serialize generation
// counter mutations — cannot deadlock. See import_tests.rs for full rationale.
#[allow(clippy::await_holding_lock)]
async fn test_confirm_team_snapshot_import_switch_between_store_and_profile() {
    let _gen_guard = GENERATION_TEST_LOCK.lock().unwrap();

    use crate::commands::personas::snapshot::import::{MemoryPublish, ProfilePublish};
    use crate::commands::team_snapshot::confirm_team_snapshot_import_core;
    use crate::managed_agents::scope::{current_scope_generation, WorkspaceAgentScope};
    use std::sync::{Arc, Mutex};
    use tauri::Manager;

    let tmp = tempfile::tempdir().unwrap();
    let (app, _owner_keys) = setup_team_import_app_with_scope(&tmp);
    let handle = app.handle();

    let snap = snapshot(vec![member("Alice"), member("Bob")]);
    let encoded = crate::managed_agents::team_snapshot::encode_team_snapshot_json(&snap).unwrap();
    let input = TeamSnapshotImportConfirm {
        file_bytes: encoded,
        keep_allowlist: false,
    };

    let expected_relay = "wss://captured.example".to_string();
    let profile_relays: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let memory_relays: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let pr = profile_relays.clone();
    let mr = memory_relays.clone();

    let state = app.state::<crate::app_state::AppState>();
    let handle_for_hook = handle.clone();

    let result = confirm_team_snapshot_import_core(
        input,
        handle,
        &state,
        || {},
        move || {
            // after_store: commit a genuinely DIFFERENT live scope + owner.
            let new_owner = nostr::Keys::generate();
            let new_scope = WorkspaceAgentScope {
                scope_id: "switched-scope".to_string(),
                relay_url: "wss://new-relay-after-switch.example".to_string(),
                owner_pubkey: new_owner.public_key().to_hex(),
                definitions_dir: std::path::PathBuf::from("/tmp/switched"),
                generation: current_scope_generation(),
            };
            let s = handle_for_hook.state::<crate::app_state::AppState>();
            s.commit_active_scope(new_scope);
        },
        move |p: ProfilePublish<'_>| {
            let relay = p.relay_url.to_string();
            pr.lock().unwrap().push(relay.clone());
            Box::pin(async move {
                let _ = relay;
                Ok(())
            })
        },
        move |m: MemoryPublish<'_>| {
            let relay = m.relay_url.to_string();
            mr.lock().unwrap().push(relay.clone());
            Box::pin(async move {
                let _ = relay;
                Ok(())
            })
        },
    )
    .await;

    assert!(
        result.is_ok(),
        "team import must succeed: {:?}",
        result.err()
    );

    // Every member's profile adapter received the captured relay URL.
    let seen = profile_relays.lock().unwrap();
    assert_eq!(
        seen.len(),
        2,
        "profile adapter must be called once per member"
    );
    for relay in seen.iter() {
        assert_eq!(
            relay, &expected_relay,
            "profile adapter must receive captured relay, got: {relay}"
        );
    }
    // No memory entries in these members — memory adapter not called.
}

/// `before_store` hook advances scope generation — Phase 3 must reject BEFORE
/// any write and BEFORE any outbound call.
#[tokio::test]
// SAFETY: single-threaded tokio runtime; lock held to serialize generation
// counter mutations — cannot deadlock. See import_tests.rs for full rationale.
#[allow(clippy::await_holding_lock)]
async fn test_team_identity_switch_before_store_is_rejected() {
    let _gen_guard = GENERATION_TEST_LOCK.lock().unwrap();

    use crate::commands::personas::snapshot::import::{MemoryPublish, ProfilePublish};
    use crate::commands::team_snapshot::confirm_team_snapshot_import_core;
    use crate::managed_agents::scope::next_scope_generation;
    use tauri::Manager;

    let tmp = tempfile::tempdir().unwrap();
    let (app, _owner_keys) = setup_team_import_app_with_scope(&tmp);
    let handle = app.handle();
    let state = app.state::<crate::app_state::AppState>();

    let snap = snapshot(vec![member("Alice")]);
    let encoded = crate::managed_agents::team_snapshot::encode_team_snapshot_json(&snap).unwrap();
    let input = TeamSnapshotImportConfirm {
        file_bytes: encoded,
        keep_allowlist: false,
    };

    let result = confirm_team_snapshot_import_core(
        input,
        handle,
        &state,
        move || {
            next_scope_generation();
        },
        || {},
        |_p: ProfilePublish<'_>| {
            Box::pin(async { panic!("profile must not be called: store rejected") })
        },
        |_m: MemoryPublish<'_>| {
            Box::pin(async { panic!("memory must not be called: store rejected") })
        },
    )
    .await;

    assert!(
        result.is_err(),
        "pre-store switch must cause Phase 3 rejection"
    );
    let err = result.unwrap_err();
    assert!(
        err.contains("stale") || err.contains("generation") || err.contains("mismatch"),
        "error must describe generation mismatch: {err}"
    );
}
