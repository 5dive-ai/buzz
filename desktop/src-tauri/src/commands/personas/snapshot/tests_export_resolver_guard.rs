//! Source guard: every export resolver folds the private-config overlay.
//!
//! Kept in a sibling file so `snapshot/tests.rs` stays under the 1000-line
//! gate; `#[path]`-included from there as a child module.
//!
//! The behavioural tests in `tests.rs` model the fold by calling
//! `resolved_records` / `resolve_from_lists` directly. They CANNOT reach the
//! production call sites: all three live inside `#[tauri::command]` bodies
//! needing a live `AppHandle` + `State<AppState>`. Measured on the parent
//! commit — deleting any one of the three production folds leaves the full
//! workspace suite green (2283 passed, 0 failed).
//!
//! Same weakness, same remedy, as `write_site_resolve_guard` in
//! `private_config_overlay.rs`: assert the call exists at each site.

/// The fold call every export resolver must make. A resolver that reads raw
/// disk instead fails with "agent not found" for a relay-only agent that has
/// never started on this device, and bakes stale disk values into the
/// exported manifest on a follower device.
const FOLD_CALL: &str = ".resolved_records(&instances)";

/// `(file, source, expected_fold_calls)` — every export resolver that turns
/// an id into a record destined for a snapshot manifest or a card.
fn sites() -> Vec<(&'static str, &'static str, usize)> {
    vec![
        // `materialize_snapshot_bytes` — JSON + PNG + send-to-channel.
        (
            "commands/personas/snapshot.rs",
            include_str!("../snapshot.rs"),
            1,
        ),
        // Card precheck (`card_mint_key_status`) + mint resolver
        // (`mint_agent_card`). Exact, not `>= 1`: a lower bound would not
        // notice one site losing its fold while the other gained a second.
        ("commands/personas/card.rs", include_str!("../card.rs"), 2),
    ]
}

#[test]
fn every_export_resolver_folds_the_private_config_overlay() {
    for (file, source, expected) in sites() {
        let found = source.matches(FOLD_CALL).count();
        assert_eq!(
            found, expected,
            "{file}: expected {expected} `{FOLD_CALL}` call(s), found {found}. \
             An export resolver that reads raw disk fails with \"agent not found\" \
             for a relay-only agent that has never started on this device, and \
             bakes stale disk values into the exported manifest on a follower."
        );
    }
}

/// The guard above is a substring count, so prove it can FAIL: a source with
/// the fold removed must not satisfy it. Without this, a typo in `FOLD_CALL`
/// would make every row pass vacuously.
#[test]
fn guard_detects_a_missing_overlay_fold() {
    for (file, source, expected) in sites() {
        let stripped = source.replace(FOLD_CALL, ".REMOVED(&instances)");
        assert_eq!(
            stripped.matches(FOLD_CALL).count(),
            0,
            "{file}: guard string never matched, so its {expected} expected \
             call(s) passed vacuously"
        );
    }
}
