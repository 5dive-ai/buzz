use super::test_helpers::{coordinate, retain_prompt, run_pass, test_db, OWNER};
use super::*;
use crate::managed_agents::{
    decision::{decide, ParkReason},
    retention::{
        get_baseline, get_pending_sync, get_retained_event, is_publish_blocked,
        tombstone_retention_d_tag,
    },
};
use buzz_core_pkg::kind::{KIND_DELETION, KIND_PERSONA};

/// The retention key the coordinate's queued tombstone occupies — a DIFFERENT
/// primary key from the coordinate itself, which is the whole reason the gate
/// has two halves.
fn tombstone_key() -> String {
    tombstone_retention_d_tag(KIND_PERSONA, "test-persona")
}

fn projection(content: &str) -> CanonicalProjection {
    CanonicalProjection {
        content: content.to_string(),
        shared: false,
    }
}

/// A relay head carrying `content` at `created_at`, with an id derived from it.
fn head(content: &str, created_at: i64) -> Head {
    Head {
        event_id: format!("id-{content}"),
        created_at,
        projection: projection(content),
    }
}

/// Retain a row at the coordinate, optionally pending. Returns the signed
/// event so a caller can stamp a baseline naming it.
fn retain_row(conn: &Connection, kind: u32, d_tag: &str, pending: bool) -> nostr::Event {
    retain_prompt(conn, kind, d_tag, pending, "prompt")
}

// ── local_state: reading the observation off a real store ──────────────────

#[test]
fn test_no_local_row_reports_nothing_queued_and_no_baseline() {
    let conn = test_db();
    let observation = local_state(
        &conn,
        OWNER,
        &coordinate(),
        Some(projection("v1")),
        HeadState::Present(head("v1", 100)),
        TombstoneEvidence::NotFound,
    )
    .unwrap();

    assert!(observation.queued.is_none());
    assert!(observation.queued_deletion_at.is_none());
    assert!(observation.baseline.is_none());
}

/// The queued projection is read from the row's own `raw_event`, because those
/// are the bytes the flush loop publishes.
#[test]
fn test_pending_live_row_reports_its_own_queued_projection() {
    let conn = test_db();
    retain_prompt(&conn, KIND_PERSONA, "test-persona", true, "queued-prompt");

    let observation = local_state(
        &conn,
        OWNER,
        &coordinate(),
        Some(projection("whatever-is-on-disk")),
        HeadState::Present(head("v2", 200)),
        TombstoneEvidence::NotFound,
    )
    .unwrap();

    let queued = observation.queued.expect("the pending row must be queued");
    assert!(
        queued.content.contains("queued-prompt"),
        "the queued projection must come from the row's raw_event, got {queued:?}"
    );
    assert!(
        observation.queued_deletion_at.is_none(),
        "a queued edit is not a queued deletion"
    );
}

/// A queued DELETION lives at a different primary key than the record itself.
/// Reporting only the live row was the cross-coordinate hole from review.
#[test]
fn test_pending_tombstone_row_is_reported_for_its_target_coordinate() {
    let conn = test_db();
    // The live row is NOT pending; only the paired tombstone is.
    retain_row(&conn, KIND_PERSONA, "test-persona", false);
    let tombstone = retain_row(&conn, KIND_DELETION, &tombstone_key(), true);

    let observation = local_state(
        &conn,
        OWNER,
        &coordinate(),
        Some(projection("v1")),
        HeadState::Present(head("v2", 200)),
        TombstoneEvidence::NotFound,
    )
    .unwrap();

    assert_eq!(
        observation.queued_deletion_at,
        Some(tombstone.created_at.as_secs() as i64),
        "a pending tombstone must be reported against its TARGET coordinate"
    );
    assert!(
        observation.queued.is_none(),
        "the live row is settled; only the tombstone is queued"
    );
}

/// A settled tombstone row must not pin the coordinate as queued forever.
#[test]
fn test_non_pending_tombstone_row_is_not_reported_as_queued() {
    let conn = test_db();
    retain_row(&conn, KIND_PERSONA, "test-persona", false);
    retain_row(&conn, KIND_DELETION, &tombstone_key(), false);

    let observation = local_state(
        &conn,
        OWNER,
        &coordinate(),
        Some(projection("v1")),
        HeadState::Present(head("v1", 100)),
        TombstoneEvidence::NotFound,
    )
    .unwrap();

    assert!(observation.queued.is_none());
    assert!(observation.queued_deletion_at.is_none());
}

/// A half-written baseline (id without content, or vice versa) is not a usable
/// provenance record and must read as "no baseline".
#[test]
fn test_partial_baseline_reads_as_absent() {
    let conn = test_db();
    retain_row(&conn, KIND_PERSONA, "test-persona", false);
    conn.execute(
        "UPDATE persona_events SET baseline_event_id = 'someid', baseline_content = NULL
         WHERE kind = ?1 AND pubkey = ?2 AND d_tag = ?3",
        rusqlite::params![KIND_PERSONA, OWNER, "test-persona"],
    )
    .unwrap();

    let observation = local_state(
        &conn,
        OWNER,
        &coordinate(),
        Some(projection("local")),
        HeadState::Present(head("remote", 200)),
        TombstoneEvidence::NotFound,
    )
    .unwrap();

    assert!(observation.baseline.is_none());
    assert_eq!(decide(&observation).decision, Decision::Defer);
}

#[test]
fn test_plan_pairs_every_coordinate_with_its_decision() {
    let base = Observation {
        disk: Some(projection("v1")),
        queued: None,
        head: HeadState::Present(head("v2", 200)),
        baseline: Some(projection("v1")),
        queued_deletion_at: None,
        tombstone: TombstoneEvidence::NotFound,
    };
    let states = vec![
        CoordinateState {
            coordinate: Coordinate {
                kind: KIND_PERSONA,
                d_tag: "adopts".to_string(),
            },
            observation: base.clone(),
        },
        CoordinateState {
            coordinate: Coordinate {
                kind: KIND_PERSONA,
                d_tag: "parks".to_string(),
            },
            observation: Observation {
                disk: Some(projection("edited")),
                head: HeadState::Absent,
                ..base
            },
        },
    ];

    let plan = plan(&states);

    assert_eq!(plan.len(), 2);
    assert_eq!(plan[0].0.d_tag, "adopts");
    assert_eq!(plan[0].1.decision, Decision::ApplyHead);
    assert_eq!(plan[1].0.d_tag, "parks");
    assert_eq!(
        plan[1].1.decision,
        Decision::Park(ParkReason::LocalEditWithNoHead)
    );
}

// ── The publication gates (V3.9) ───────────────────────────────────────────

fn resolution(decision: Decision) -> Resolution {
    Resolution {
        decision,
        clear_queued_publish: false,
    }
}

/// The live-row gate is deny-by-default over the decision set, so a variant
/// added later is withheld until someone deliberately admits it.
#[test]
fn test_exactly_the_publishing_decisions_release_the_live_gate() {
    for decision in [
        Decision::SuppressPublish,
        Decision::Park(ParkReason::LocalEditWithNoHead),
        Decision::Park(ParkReason::NoBaselineWithHead),
        Decision::StampBaseline,
        Decision::DeleteLocal,
        Decision::Defer,
        // The deletion publishes from the tombstone row; the live row it
        // deletes must not race it.
        Decision::PublishDeletion,
        // The one adopt-the-relay cell reachable with NO baseline, so it must
        // not leave an open gate behind for a row queued after the pass.
        Decision::RestoreFromRelay,
    ] {
        assert!(
            blocks_publication(&resolution(decision.clone())),
            "{decision:?} must withhold the live row"
        );
    }

    for decision in [
        Decision::PublishLocalEdit,
        // Only reachable with a baseline present and nothing queued, so
        // gating it would strand a later edit and suppress nothing.
        Decision::ApplyHead,
    ] {
        assert!(
            !blocks_publication(&resolution(decision.clone())),
            "{decision:?} must not withhold the live row"
        );
    }
}

/// Exactly one decision releases the tombstone row. Anything else — including
/// the timestamp arbitration falling through to the live cells — means the
/// queued deletion did not win.
#[test]
fn test_only_publish_deletion_releases_the_tombstone_gate() {
    for decision in [
        Decision::PublishLocalEdit,
        Decision::ApplyHead,
        Decision::RestoreFromRelay,
        Decision::StampBaseline,
        Decision::SuppressPublish,
        Decision::DeleteLocal,
        Decision::Defer,
        Decision::Park(ParkReason::NoBaselineWithHead),
        Decision::Park(ParkReason::LocalEditWithNoHead),
    ] {
        assert!(
            blocks_tombstone_publication(&resolution(decision.clone())),
            "{decision:?} must withhold the queued tombstone"
        );
    }
    assert!(!blocks_tombstone_publication(&resolution(
        Decision::PublishDeletion
    )));
}

/// Suppression must be reversible: once the head is visible again the same
/// coordinate resumes publishing, or the gate latches shut permanently.
#[test]
fn test_gate_reopens_when_a_later_decision_publishes() {
    let conn = test_db();
    retain_row(&conn, KIND_PERSONA, "test-persona", true);

    let suppressed = Observation {
        disk: Some(projection("v1")),
        queued: None,
        head: HeadState::Absent,
        baseline: Some(projection("v1")),
        queued_deletion_at: None,
        tombstone: TombstoneEvidence::NotFound,
    };
    apply_gate(
        &conn,
        OWNER,
        &coordinate(),
        &suppressed,
        &resolution(Decision::SuppressPublish),
    )
    .unwrap();
    assert!(is_publish_blocked(&conn, KIND_PERSONA, OWNER, "test-persona").unwrap());

    // Next boot: the head is visible and disk carries a real edit.
    let recovered = Observation {
        disk: Some(projection("edited")),
        head: HeadState::Present(head("v1", 100)),
        ..suppressed
    };
    apply_gate(
        &conn,
        OWNER,
        &coordinate(),
        &recovered,
        &resolution(Decision::PublishLocalEdit),
    )
    .unwrap();

    assert!(!is_publish_blocked(&conn, KIND_PERSONA, OWNER, "test-persona").unwrap());
    assert_eq!(
        get_pending_sync(&conn).unwrap().len(),
        1,
        "the coordinate must be publishable again"
    );
}

/// The gate is stored per coordinate: withholding one persona must not
/// withhold another, or one unreachable head would silence the whole store.
#[test]
fn test_gate_is_scoped_to_its_own_coordinate() {
    let conn = test_db();
    retain_row(&conn, KIND_PERSONA, "test-persona", true);
    retain_row(&conn, KIND_PERSONA, "other-persona", true);

    let observation = Observation {
        disk: Some(projection("v1")),
        queued: None,
        head: HeadState::Absent,
        baseline: Some(projection("v1")),
        queued_deletion_at: None,
        tombstone: TombstoneEvidence::NotFound,
    };
    apply_gate(
        &conn,
        OWNER,
        &coordinate(),
        &observation,
        &resolution(Decision::SuppressPublish),
    )
    .unwrap();

    let pending = get_pending_sync(&conn).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].d_tag, "other-persona");
}

// ── Composition: the whole pass, not one layer ─────────────────────────────
//
// Every test above exercises one layer in isolation, which is exactly how a
// gate that can never fire passed a full suite: `decide` was tested with
// hand-built observations and `apply_gate` with hand-picked decisions, so
// nothing asserted that the decision a REAL pending row produces is one the
// gate actually blocks. These run the composition — retained row →
// `local_state` → `decide` → `apply_gate` → `get_pending_sync` — because that
// path is the product behaviour, and the seam between layers is where the bug
// lived.

/// Build the observation for a coordinate the way the barrier does, from rows
/// that are actually in the store.
fn observe(conn: &Connection, head: HeadState, disk: Option<CanonicalProjection>) -> Observation {
    local_state(
        conn,
        OWNER,
        &coordinate(),
        disk,
        head,
        TombstoneEvidence::NotFound,
    )
    .unwrap()
}

/// **Will's bug, end to end, and the regression test for this whole PR.**
///
/// A second install holds the OLD system prompt on disk with a FRESH retention
/// database — so no baseline, which is what a dev build against the same relay
/// always looks like. The good edit was made on the other install and is the
/// relay head. Boot's reconcile has already re-signed the stale disk content
/// at `monotonic_created_at = max(now, head + 1)` and queued it, so it would
/// win the relay's last-write-wins compare on `created_at` every time.
///
/// Composed through the real path rather than asserted on `decide` alone: 43
/// layer-isolated tests passed while the composition was a no-op, and that is
/// the gap class this closes. Zero rows publishable is the only acceptable
/// outcome.
#[test]
fn test_stale_store_with_no_baseline_cannot_revert_a_newer_head() {
    let conn = test_db();
    // The reconcile's queued re-sign of the stale disk content. No baseline is
    // stamped: this install has never agreed to anything at this coordinate.
    retain_prompt(&conn, KIND_PERSONA, "test-persona", true, "old-prompt");
    assert_eq!(
        get_pending_sync(&conn).unwrap().len(),
        1,
        "precondition: without the barrier this row publishes"
    );
    assert!(
        get_baseline(&conn, KIND_PERSONA, OWNER, "test-persona")
            .unwrap()
            .is_none(),
        "precondition: a fresh retention database has no baseline"
    );

    let observation = observe(
        &conn,
        // The good edit, on the relay, at an OLDER wall-clock time than the
        // re-sign — which is precisely why `created_at` cannot arbitrate this.
        HeadState::Present(head("good-edit", 1)),
        Some(projection("old-prompt")),
    );
    let (decision, publishable) = run_pass(&conn, &observation);

    assert_eq!(
        decision,
        Decision::Park(ParkReason::NoBaselineWithHead),
        "the no-baseline-with-head cell must park"
    );
    assert_eq!(
        publishable, 0,
        "the stale revert reached the publisher (decision: {decision:?})"
    );
    // Withheld, not destroyed — the device still holds its copy, and the row
    // keeps its pending flag so a later resolution can act on it.
    let row = get_retained_event(&conn, KIND_PERSONA, OWNER, "test-persona")
        .unwrap()
        .expect("the record must survive suppression");
    assert!(row.pending_sync);
}

/// **The tombstone escape, composed over BOTH rows.**
///
/// A coordinate's record and its queued tombstone occupy different primary
/// keys — `(kind, owner, d_tag)` versus `(5, owner, "<kind>:<d_tag>")` — and
/// the flush loop reads them independently. A pass that computes the right
/// decision but enforces it on one key is indistinguishable from no gate at
/// all for the other, so the no-baseline invariant is only meaningful stated
/// over both.
///
/// The deletion here is deliberately NEWER than the head, which is the exact
/// input `deletion_at >= head.created_at` would resolve to `PublishDeletion`.
/// It must not get there: the no-baseline gate runs first, so an install that
/// cannot show it ever agreed to anything at this coordinate never destroys a
/// head it has not seen. Asserted through `get_pending_sync` — what the flush
/// loop actually selects — not through the decision alone.
#[test]
fn test_no_baseline_store_withholds_both_the_record_and_its_tombstone() {
    let conn = test_db();
    // Both halves queued at once: the reconcile's re-sign of stale disk
    // content, and a tombstone targeting the same coordinate.
    retain_prompt(&conn, KIND_PERSONA, "test-persona", true, "old-prompt");
    let tombstone = retain_row(&conn, KIND_DELETION, &tombstone_key(), true);
    assert_eq!(
        get_pending_sync(&conn).unwrap().len(),
        2,
        "precondition: without the barrier both rows publish"
    );
    assert!(
        get_baseline(&conn, KIND_PERSONA, OWNER, "test-persona")
            .unwrap()
            .is_none(),
        "precondition: a fresh retention database has no baseline"
    );

    // The head predates the tombstone, so cell 4's timestamp arbitration would
    // hand this to `PublishDeletion` if the baseline gate did not run first.
    let head_created_at = tombstone.created_at.as_secs() as i64 - 1;
    let observation = observe(
        &conn,
        HeadState::Present(head("good-edit", head_created_at)),
        Some(projection("old-prompt")),
    );
    assert!(
        observation.queued_deletion_at.unwrap() >= head_created_at,
        "precondition: the queued deletion must be the newer of the two"
    );

    let (decision, publishable) = run_pass(&conn, &observation);

    assert_eq!(
        decision,
        Decision::Park(ParkReason::NoBaselineWithHead),
        "the no-baseline gate must take this before the timestamp compare"
    );
    assert_eq!(
        publishable, 0,
        "a row escaped the flush-selection gate (decision: {decision:?})"
    );
    assert!(
        is_publish_blocked(&conn, KIND_PERSONA, OWNER, "test-persona").unwrap(),
        "the record's own row must be gated"
    );
    assert!(
        is_publish_blocked(&conn, KIND_DELETION, OWNER, &tombstone_key()).unwrap(),
        "the tombstone row must be gated at its own primary key"
    );
}
