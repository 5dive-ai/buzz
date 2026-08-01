//! Regression tests for am#1, peon-P1#1/P1#2, am#2/peon-P2#1,
//! and Thufir pass-1 findings.
//!
//! Kept separate from `tests.rs` to respect the 1000-line ceiling on new files.

use std::path::Path;

use super::*;
use crate::managed_agents::{
    decision::{Decision, HeadState, TombstoneEvidence},
    persona_events::build_persona_event,
    reconcile::retain_agent_record,
    retention::{
        delete_retained_event, get_baseline, get_retained_event, is_publish_blocked,
        mark_synced_and_stamp_baseline, open_retention_db, retain_event, retain_user_intent_event,
        set_baseline, set_publish_blocked, tombstone_retention_d_tag, RetainedEvent,
    },
    ManagedAgentRecord,
};
use buzz_core_pkg::kind::{KIND_DELETION, KIND_MANAGED_AGENT, KIND_PERSONA};
use rusqlite::Connection;

const OWNER: &str = "ownerpubkeyhex";

fn test_db() -> Connection {
    open_retention_db(Path::new(":memory:")).unwrap()
}

fn coordinate() -> Coordinate {
    Coordinate {
        kind: KIND_PERSONA,
        d_tag: "test-persona".to_string(),
    }
}

fn signed_persona(system_prompt: &str) -> nostr::Event {
    use std::collections::BTreeMap;
    let record = crate::managed_agents::AgentDefinition {
        id: "test-persona".to_string(),
        display_name: "Test".to_string(),
        avatar_url: None,
        system_prompt: system_prompt.to_string(),
        runtime: None,
        model: None,
        provider: None,
        name_pool: Vec::new(),
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        env_vars: BTreeMap::new(),
        respond_to: None,
        respond_to_allowlist: Vec::new(),
        parallelism: None,
        created_at: "2025-01-01T00:00:00Z".to_string(),
        updated_at: "2025-01-01T00:00:00Z".to_string(),
    };
    build_persona_event(&record)
        .unwrap()
        .sign_with_keys(&nostr::Keys::generate())
        .unwrap()
}

fn retain_prompt(
    conn: &Connection,
    kind: u32,
    d_tag: &str,
    pending: bool,
    system_prompt: &str,
) -> nostr::Event {
    let event = signed_persona(system_prompt);
    retain_event(
        conn,
        &RetainedEvent {
            kind,
            pubkey: OWNER.to_string(),
            d_tag: d_tag.to_string(),
            content: event.content.to_string(),
            created_at: event.created_at.as_secs() as i64,
            raw_event: {
                use nostr::JsonUtil;
                event.as_json()
            },
            pending_sync: pending,
            event_id: Some(event.id.to_hex()),
            publish_blocked: false,
        },
    )
    .unwrap();
    event
}

fn set_pending(conn: &Connection, kind: u32, d_tag: &str) {
    conn.execute(
        "UPDATE persona_events SET pending_sync = 1
         WHERE kind = ?1 AND pubkey = ?2 AND d_tag = ?3",
        rusqlite::params![kind, OWNER, d_tag],
    )
    .unwrap();
}

fn run_pass(conn: &Connection, observation: &Observation) -> (Decision, usize) {
    use crate::managed_agents::retention::get_pending_sync;
    let (plan, _) = run_decision_pass(
        conn,
        OWNER,
        &[CoordinateState {
            coordinate: coordinate(),
            observation: observation.clone(),
        }],
    )
    .unwrap();
    (
        plan[0].1.decision.clone(),
        get_pending_sync(conn).unwrap().len(),
    )
}

// ── (a) am#1 / peon-P1#1: publish-confirm stamps baseline so next boot
// suppresses revert.
//
// Mutation-sensitive: removing `mark_synced_and_stamp_baseline`'s baseline
// write causes queued != baseline and the test fails on the ApplyHead assert.
#[test]
fn test_publish_confirm_stamps_baseline_so_next_boot_suppresses_revert() {
    let conn = test_db();
    const D_TAG: &str = "test-persona";

    // Retain v2 as a queued edit (simulates what reconcile produced at boot).
    let v2_event = retain_prompt(&conn, KIND_PERSONA, D_TAG, true, "v2-prompt");
    let v2_id = v2_event.id.to_hex();
    let v2_content = v2_event.content.to_string();

    // Simulate the flush loop accepting v2: mark synced + stamp baseline.
    mark_synced_and_stamp_baseline(
        &conn,
        KIND_PERSONA,
        OWNER,
        D_TAG,
        v2_event.created_at.as_secs() as i64,
        &v2_content,
        &v2_id,
        false,
    )
    .unwrap();

    let baseline = get_baseline(&conn, KIND_PERSONA, OWNER, D_TAG)
        .unwrap()
        .expect("baseline must be stamped after publish-confirm");
    assert_eq!(
        baseline.0, v2_id,
        "baseline event_id must be the published event"
    );
    assert_eq!(
        baseline.1, v2_content,
        "baseline content must be the published content"
    );

    // Second boot: reconcile re-queued v2 (disk still has it).
    set_pending(&conn, KIND_PERSONA, D_TAG);

    // The relay now has v3 (a newer edit from the other device).
    let v3_head = Head {
        event_id: "id-v3".to_string(),
        created_at: v2_event.created_at.as_secs() as i64 + 1,
        projection: CanonicalProjection {
            content: "v3-content-json".to_string(),
            shared: false,
        },
    };
    // Build the observation directly from the real DB so queued == baseline.
    let observation = local_state(
        &conn,
        OWNER,
        &Coordinate {
            kind: KIND_PERSONA,
            d_tag: D_TAG.to_string(),
        },
        Some(CanonicalProjection {
            content: v2_content.clone(),
            shared: false,
        }),
        HeadState::Present(v3_head),
        TombstoneEvidence::NotFound,
    )
    .unwrap();

    let q = observation.queued.as_ref().expect("queued must be Some");
    let b = observation
        .baseline
        .as_ref()
        .expect("baseline must be Some");
    assert_eq!(q, b, "queued == baseline → vacuous ApplyHead");

    let (decision, publishable) = run_pass(&conn, &observation);
    assert_eq!(
        decision,
        Decision::ApplyHead,
        "must adopt v3, not publish stale v2"
    );
    assert_eq!(publishable, 0, "no pending rows after vacuous clear");
}

// ── (b) peon-P1#2: offline delete preserves baseline so next boot reaches
// Gate C (timestamp arbitration), not park-forever.
//
// Mutation-sensitive: if `delete_retained_event` also deleted the
// `persona_baselines` row, observation.baseline would be None and decide()
// would return Park(NoBaselineWithHead) instead of PublishDeletion.
#[test]
fn test_offline_delete_preserves_baseline_so_next_boot_reaches_gate_c() {
    let conn = test_db();
    const D_TAG: &str = "test-persona";

    let live_event = retain_prompt(&conn, KIND_PERSONA, D_TAG, false, "original-prompt");
    let live_id = live_event.id.to_hex();
    let live_content = live_event.content.to_string();
    set_baseline(&conn, KIND_PERSONA, OWNER, D_TAG, &live_id, &live_content).unwrap();

    // Simulate `tombstone_persona_pending`: purge live row, retain tombstone.
    delete_retained_event(&conn, KIND_PERSONA, OWNER, D_TAG).unwrap();
    let tombstone_d = tombstone_retention_d_tag(KIND_PERSONA, D_TAG);
    let tombstone_event = signed_persona("tombstone");
    retain_user_intent_event(
        &conn,
        &RetainedEvent {
            kind: KIND_DELETION,
            pubkey: OWNER.to_string(),
            d_tag: tombstone_d.clone(),
            content: tombstone_event.content.to_string(),
            created_at: tombstone_event.created_at.as_secs() as i64 + 1,
            raw_event: {
                use nostr::JsonUtil;
                tombstone_event.as_json()
            },
            event_id: Some(tombstone_event.id.to_hex()),
            pending_sync: true,
            publish_blocked: false,
        },
    )
    .unwrap();

    // Baseline must survive the live-row deletion.
    assert!(
        get_baseline(&conn, KIND_PERSONA, OWNER, D_TAG)
            .unwrap()
            .is_some(),
        "baseline must survive delete_retained_event (lives in persona_baselines)"
    );
    assert!(
        get_retained_event(&conn, KIND_PERSONA, OWNER, D_TAG)
            .unwrap()
            .is_none(),
        "live row must be purged"
    );

    // Next boot: relay still shows the live head (delete didn't reach it).
    let observation = local_state(
        &conn,
        OWNER,
        &coordinate(),
        Some(CanonicalProjection {
            content: live_content.clone(),
            shared: false,
        }),
        HeadState::Present(Head {
            event_id: live_id.clone(),
            created_at: live_event.created_at.as_secs() as i64,
            projection: CanonicalProjection {
                content: live_content.clone(),
                shared: false,
            },
        }),
        TombstoneEvidence::NotFound,
    )
    .unwrap();

    assert!(
        observation.baseline.is_some(),
        "baseline present → avoids park cell"
    );
    assert!(
        observation.queued_deletion_at.is_some(),
        "tombstone visible"
    );
    let (decision, _) = run_pass(&conn, &observation);
    assert_eq!(
        decision,
        Decision::PublishDeletion,
        "must reach Gate C, not park"
    );
}

// ── (c) am#2 / peon-P2#1: user-intent retain clears the gate; reconcile
// retain does NOT.
//
// Mutation-sensitive: swapping `retain_user_intent_event` for `retain_event`
// in `prepare_persona_publication` causes the user-intent branch to keep the
// gate set, breaking the first assertion.
#[test]
fn test_user_edit_reopens_gated_row_but_reconcile_retain_does_not() {
    let conn = test_db();
    const D_TAG: &str = "test-persona";

    // Part 1: user-intent retain clears the gate.
    let event = signed_persona("user-edit-v1");
    retain_event(
        &conn,
        &RetainedEvent {
            kind: KIND_PERSONA,
            pubkey: OWNER.to_string(),
            d_tag: D_TAG.to_string(),
            content: event.content.to_string(),
            created_at: event.created_at.as_secs() as i64,
            raw_event: {
                use nostr::JsonUtil;
                event.as_json()
            },
            event_id: Some(event.id.to_hex()),
            pending_sync: false,
            publish_blocked: false,
        },
    )
    .unwrap();
    set_publish_blocked(&conn, KIND_PERSONA, OWNER, D_TAG, true).unwrap();
    assert!(
        is_publish_blocked(&conn, KIND_PERSONA, OWNER, D_TAG).unwrap(),
        "precondition"
    );

    let user_edit = signed_persona("user-edit-v2");
    retain_user_intent_event(
        &conn,
        &RetainedEvent {
            kind: KIND_PERSONA,
            pubkey: OWNER.to_string(),
            d_tag: D_TAG.to_string(),
            content: user_edit.content.to_string(),
            created_at: user_edit.created_at.as_secs() as i64 + 1,
            raw_event: {
                use nostr::JsonUtil;
                user_edit.as_json()
            },
            event_id: Some(user_edit.id.to_hex()),
            pending_sync: true,
            publish_blocked: false,
        },
    )
    .unwrap();
    assert!(
        !is_publish_blocked(&conn, KIND_PERSONA, OWNER, D_TAG).unwrap(),
        "user-intent retain must clear publish_blocked"
    );

    // Part 2: reconcile retain must NOT clear a gate it finds set.
    conn.execute(
        "UPDATE persona_events SET publish_blocked = 1
         WHERE kind = ?1 AND pubkey = ?2 AND d_tag = ?3",
        rusqlite::params![KIND_PERSONA, OWNER, D_TAG],
    )
    .unwrap();
    assert!(
        is_publish_blocked(&conn, KIND_PERSONA, OWNER, D_TAG).unwrap(),
        "gate re-set"
    );

    let reconcile = signed_persona("user-edit-v2"); // same prompt, fresh timestamp
    retain_event(
        &conn,
        &RetainedEvent {
            kind: KIND_PERSONA,
            pubkey: OWNER.to_string(),
            d_tag: D_TAG.to_string(),
            content: reconcile.content.to_string(),
            created_at: reconcile.created_at.as_secs() as i64 + 2,
            raw_event: {
                use nostr::JsonUtil;
                reconcile.as_json()
            },
            event_id: Some(reconcile.id.to_hex()),
            pending_sync: true,
            publish_blocked: false, // reconcile always passes false — gate must not be read
        },
    )
    .unwrap();
    assert!(
        is_publish_blocked(&conn, KIND_PERSONA, OWNER, D_TAG).unwrap(),
        "reconcile retain must NOT clear publish_blocked"
    );
}

// ── (c-ext) Thufir pass-1 finding #2: retain_agent_record user-intent clears
// the gate; boot-reconcile (user_intent=false) does NOT.
//
// Mutation-sensitive: passing `false` (reconcile mode) to both calls would
// leave the gate set after the first assert succeeds (reconcile doesn't clear
// it) and would cause the second assert to pass trivially — but the assert on
// the gate being CLEAR after user_intent=true would fail because nothing
// cleared it, catching the regression. Conversely, passing `true` to both
// would make the reconcile call incorrectly clear the gate, failing the final
// "reconcile must NOT clear" assertion.
#[test]
fn test_retain_agent_record_user_intent_clears_gate_but_reconcile_does_not() {
    let conn = test_db();
    let keys = nostr::Keys::generate();
    let owner = keys.public_key().to_hex();
    let record = make_sample_agent_record();

    // Seed the row as blocked (simulates what the boot barrier would have set).
    retain_agent_record(&conn, &keys, &record, false).unwrap();
    set_publish_blocked(&conn, KIND_MANAGED_AGENT, &owner, &record.pubkey, true).unwrap();
    assert!(
        is_publish_blocked(&conn, KIND_MANAGED_AGENT, &owner, &record.pubkey).unwrap(),
        "precondition: gate must be set"
    );

    // Interactive save (user_intent = true) must reopen the gate.
    retain_agent_record(&conn, &keys, &record, true).unwrap();
    assert!(
        !is_publish_blocked(&conn, KIND_MANAGED_AGENT, &owner, &record.pubkey).unwrap(),
        "user-intent retain_agent_record must clear publish_blocked"
    );

    // Re-gate to simulate a fresh boot decision.
    set_publish_blocked(&conn, KIND_MANAGED_AGENT, &owner, &record.pubkey, true).unwrap();

    // Boot reconcile (user_intent = false) must NOT clear it.
    retain_agent_record(&conn, &keys, &record, false).unwrap();
    assert!(
        is_publish_blocked(&conn, KIND_MANAGED_AGENT, &owner, &record.pubkey).unwrap(),
        "reconcile retain_agent_record must NOT clear publish_blocked"
    );
}

// ── (c-ext2) Thufir pass-1 finding #2: non-persona tombstone (kind:5 for
// a managed-agent coordinate) via retain_user_intent_event clears the gate;
// bare retain_event does NOT.
//
// Mutation-sensitive: the production paths in `tombstone_managed_agent_pending`
// and `tombstone_team_pending` now call `retain_user_intent_event`; if they
// were accidentally reverted to `retain_event`, the first assertion would fail.
#[test]
fn test_non_persona_tombstone_user_intent_clears_gate() {
    use nostr::JsonUtil;
    let conn = test_db();
    const KIND_DELETE: u32 = 5;
    let tombstone_d = tombstone_retention_d_tag(KIND_MANAGED_AGENT, "agent-abc123");
    let keys = nostr::Keys::generate();
    let owner = keys.public_key().to_hex();

    let event = nostr::EventBuilder::new(nostr::Kind::Custom(KIND_DELETE as u16), "{}".to_string())
        .sign_with_keys(&keys)
        .unwrap();

    // Gate a placeholder row at the tombstone coordinate.
    retain_event(
        &conn,
        &RetainedEvent {
            kind: KIND_DELETE,
            pubkey: owner.clone(),
            d_tag: tombstone_d.clone(),
            content: "{}".to_string(),
            created_at: event.created_at.as_secs() as i64,
            raw_event: event.as_json(),
            event_id: Some(event.id.to_hex()),
            pending_sync: false,
            publish_blocked: false,
        },
    )
    .unwrap();
    set_publish_blocked(&conn, KIND_DELETE, &owner, &tombstone_d, true).unwrap();
    assert!(
        is_publish_blocked(&conn, KIND_DELETE, &owner, &tombstone_d).unwrap(),
        "precondition: gate must be set"
    );

    // User-intent tombstone retain must clear the gate.
    let event2 =
        nostr::EventBuilder::new(nostr::Kind::Custom(KIND_DELETE as u16), "{}".to_string())
            .sign_with_keys(&keys)
            .unwrap();
    retain_user_intent_event(
        &conn,
        &RetainedEvent {
            kind: KIND_DELETE,
            pubkey: owner.clone(),
            d_tag: tombstone_d.clone(),
            content: "{}".to_string(),
            created_at: event2.created_at.as_secs() as i64 + 1,
            raw_event: event2.as_json(),
            event_id: Some(event2.id.to_hex()),
            pending_sync: true,
            publish_blocked: false,
        },
    )
    .unwrap();
    assert!(
        !is_publish_blocked(&conn, KIND_DELETE, &owner, &tombstone_d).unwrap(),
        "user-intent tombstone retain must clear publish_blocked"
    );
}

// ── (f) Thufir pass-1 finding: mark_synced_and_stamp_baseline atomically
// clears pending AND stamps the baseline in a single transaction.
//
// Mutation-sensitive: if the function is split back into two independent
// autocommit statements, the test still passes on the happy path — but the
// invariant that "pending_sync = 0 iff baseline is stamped" becomes testable
// by verifying both columns together. If only one statement ran, one of the
// two final assertions would fail, catching the regression.
#[test]
fn test_mark_synced_and_stamp_baseline_atomic_both_written_on_success() {
    let conn = test_db();
    const D_TAG: &str = "atomic-test";

    let event = signed_persona("atomic-prompt");
    let event_id = event.id.to_hex();
    let content = event.content.to_string();
    let created_at = event.created_at.as_secs() as i64;

    retain_event(
        &conn,
        &RetainedEvent {
            kind: KIND_PERSONA,
            pubkey: OWNER.to_string(),
            d_tag: D_TAG.to_string(),
            content: content.clone(),
            created_at,
            raw_event: {
                use nostr::JsonUtil;
                event.as_json()
            },
            event_id: Some(event_id.clone()),
            pending_sync: true,
            publish_blocked: false,
        },
    )
    .unwrap();

    // No baseline before the call.
    assert!(
        get_baseline(&conn, KIND_PERSONA, OWNER, D_TAG)
            .unwrap()
            .is_none(),
        "no baseline before mark_synced_and_stamp_baseline"
    );

    mark_synced_and_stamp_baseline(
        &conn,
        KIND_PERSONA,
        OWNER,
        D_TAG,
        created_at,
        &content,
        &event_id,
        false,
    )
    .unwrap();

    // Both effects must have landed atomically.
    let row = get_retained_event(&conn, KIND_PERSONA, OWNER, D_TAG)
        .unwrap()
        .expect("row must still exist");
    assert!(
        !row.pending_sync,
        "pending_sync must be cleared by mark_synced_and_stamp_baseline"
    );

    let baseline = get_baseline(&conn, KIND_PERSONA, OWNER, D_TAG)
        .unwrap()
        .expect("baseline must be stamped by mark_synced_and_stamp_baseline");
    assert_eq!(
        baseline.0, event_id,
        "baseline event_id must match the published event"
    );
    assert_eq!(
        baseline.1, content,
        "baseline content must match the published content"
    );
}

/// Helper shared by the agent-record tests in this module.
pub(super) fn make_sample_agent_record() -> ManagedAgentRecord {
    serde_json::from_str(
        r#"{
            "pubkey": "abababababababababababababababababababababababababababababababababab",
            "name": "regression-test-agent",
            "relay_url": "wss://localhost:3000",
            "acp_command": "buzz-acp",
            "agent_command": "goose",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 320,
            "system_prompt": "You are a regression-test agent.",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "last_started_at": null,
            "last_stopped_at": null,
            "last_exit_code": null,
            "last_error": null
        }"#,
    )
    .unwrap()
}
