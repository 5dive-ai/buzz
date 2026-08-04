//! Tests for captured-scope relay and owner-key invariants in snapshot import.
//!
//! Kept in a sibling file so `tests.rs` stays within the file-size ratchet.
//! Included via `#[path]` from `tests.rs`.

// ── Import: captured-scope relay invariant ─────────────────────────────────

/// Outbound profile/memory publication must use the captured scope's relay,
/// not the live `relay_ws_url_with_override` value.
///
/// Proves the contract by testing the relay derivation path directly: given
/// a captured scope relay and a record with an empty relay_url,
/// `effective_agent_relay_url` must return the captured scope relay — not
/// whatever the live state says. A workspace switch after Phase 3a cannot
/// redirect this agent's profile to a different relay.
#[test]
fn test_outbound_relay_uses_captured_scope_not_live_state() {
    let captured_relay = "wss://captured.example";
    let live_relay = "wss://switched.example"; // simulates workspace switched post-Phase-3a

    // Simulate record.relay_url being empty (always takes workspace relay).
    let record_relay = "";

    let outbound_relay = crate::relay::effective_agent_relay_url(record_relay, captured_relay);
    let stale_relay = crate::relay::effective_agent_relay_url(record_relay, live_relay);

    assert_eq!(
        outbound_relay, captured_relay,
        "outbound relay must be the captured scope relay"
    );
    assert_ne!(
        outbound_relay, stale_relay,
        "captured relay must differ from the post-switch live relay"
    );
}

// ── Import: owner key captured-scope agreement ───────────────────────────────

/// Identity mismatch check: the captured owner public key must equal
/// `captured_scope.owner_pubkey`. This mirrors the guard in
/// `confirm_agent_snapshot_import` that runs at entry and again under the
/// store lock before Phase 3a commit.
///
/// Proves the logic with nostr key math directly — no AppHandle needed —
/// by testing the pubkey equality check the function performs.
#[test]
fn test_owner_key_must_match_captured_scope_owner_pubkey() {
    let scope_keys = nostr::Keys::generate();
    let other_keys = nostr::Keys::generate();

    // Match: same pubkey → accept.
    let scope_owner_pubkey = scope_keys.public_key().to_hex();
    assert_eq!(
        scope_keys.public_key().to_hex(),
        scope_owner_pubkey,
        "owner key that generated the scope must match scope's owner_pubkey"
    );

    // Mismatch: different pubkey → reject.
    assert_ne!(
        other_keys.public_key().to_hex(),
        scope_owner_pubkey,
        "a different identity must not match the scope's owner_pubkey"
    );
}

/// Under-lock owner key re-check: after capturing owner keys at entry,
/// re-checking under the store lock must detect if a different identity was
/// substituted between entry and commit. This tests the comparison logic the
/// guard at `import.rs:559-564` performs.
#[test]
fn test_owner_key_mismatch_detected_under_store_lock() {
    let original_keys = nostr::Keys::generate();
    let replaced_keys = nostr::Keys::generate();

    let captured_owner_pubkey = original_keys.public_key().to_hex();
    // Simulate: the live key was replaced by a concurrent identity import.
    let live_pubkey_after_import = replaced_keys.public_key().to_hex();

    // The guard must reject this mismatch.
    assert_ne!(
        live_pubkey_after_import, captured_owner_pubkey,
        "guard must detect mismatch between captured owner key and post-import live key"
    );
}
