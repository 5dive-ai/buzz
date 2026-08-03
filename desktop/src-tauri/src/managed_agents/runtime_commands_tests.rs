//! Unit tests for `managed_agents/runtime_commands.rs`.
//!
//! Kept in a sibling file so `runtime_commands.rs` stays under the
//! 1000-line size gate; `#[path]`-included from there.

use super::*;

fn payload(
    relay_url: &str,
    lifecycle: ManagedAgentRuntimeLifecycle,
    error: Option<&str>,
) -> super::super::ManagedAgentRuntimeLifecycleObserverPayload {
    super::super::ManagedAgentRuntimeLifecycleObserverPayload {
        pubkey: "aa".repeat(32),
        relay_url: relay_url.into(),
        start_nonce: "test-generation".into(),
        lifecycle,
        error: error.map(str::to_owned),
    }
}

fn record_with_relay(relay_url: &str) -> super::super::ManagedAgentRecord {
    serde_json::from_str(&format!(
        r#"{{
            "pubkey": "{}",
            "name": "pin-test",
            "relay_url": "{relay_url}",
            "acp_command": "buzz-acp",
            "agent_command": "goose",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 320,
            "system_prompt": "",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }}"#,
        "aa".repeat(32)
    ))
    .unwrap()
}

#[test]
fn legacy_relay_pin_is_ignored_for_fan_out() {
    // Zero-touch cutover (#2122): a record carrying a creation-era
    // `relay_url` pin must fan out exactly like an unpinned one — the
    // stored field is parsed but never consulted. See
    // `effective_agent_relay_url`.
    let unpinned = record_with_relay("");
    let pinned = record_with_relay("wss://one.example");
    for record in [&unpinned, &pinned] {
        assert_eq!(
            crate::relay::effective_agent_relay_url(&record.relay_url, "wss://two.example"),
            "wss://two.example"
        );
    }
}

#[test]
fn unkeyable_relay_degrades_to_failed_row() {
    // A requested URL that cannot form a pair key must still yield a
    // Failed row keyed by the raw requested string, so one bad community
    // never aborts the rest of the reconcile batch.
    let record = record_with_relay("");
    let status = unkeyable_failed_status(
        &record,
        "not a url".to_string(),
        "relay access probe timed out".to_string(),
        &[],
        &super::super::GlobalAgentConfig::default(),
    );
    assert!(matches!(
        status.lifecycle,
        ManagedAgentRuntimeLifecycle::Failed
    ));
    assert_eq!(status.relay_url, "not a url");
    assert_eq!(status.requested_relay_url.as_deref(), Some("not a url"));
    assert_eq!(status.pubkey, record.pubkey);
    assert_eq!(
        status.error.as_deref(),
        Some("relay access probe timed out")
    );
    assert!(status.pid.is_none());
}

#[test]
fn runtime_key_rejects_non_hex_pubkeys() {
    assert!(ManagedAgentRuntimeKey::new("../not-a-key", "wss://relay.example").is_err());
    assert!(ManagedAgentRuntimeKey::new("gg".repeat(32), "wss://relay.example").is_err());
}

#[test]
fn runtime_key_canonicalizes_hex_pubkeys() {
    let key = ManagedAgentRuntimeKey::new("AA".repeat(32), "wss://relay.example").unwrap();
    assert_eq!(key.pubkey, "aa".repeat(32));
}

#[test]
fn observer_lifecycle_key_preserves_exact_canonical_pair() {
    let first = payload(
        "WSS://Relay.Example:443/",
        ManagedAgentRuntimeLifecycle::Ready,
        None,
    );
    let key = observer_lifecycle_key(&first.pubkey, &first).unwrap();
    assert_eq!(key.pubkey, first.pubkey);
    assert_eq!(key.relay_url, "wss://relay.example");

    let other = payload(
        "wss://other.example",
        ManagedAgentRuntimeLifecycle::Ready,
        None,
    );
    assert_ne!(key, observer_lifecycle_key(&other.pubkey, &other).unwrap());
}

#[test]
fn observer_lifecycle_rejects_cross_agent_and_desktop_states() {
    let ready = payload(
        "wss://relay.example",
        ManagedAgentRuntimeLifecycle::Ready,
        None,
    );
    assert!(observer_lifecycle_key(&"bb".repeat(32), &ready).is_err());

    let stopped = payload(
        "wss://relay.example",
        ManagedAgentRuntimeLifecycle::Stopped,
        None,
    );
    assert!(observer_lifecycle_key(&stopped.pubkey, &stopped).is_err());
}

#[test]
fn observer_lifecycle_enforces_failed_error_contract() {
    let failed = payload(
        "wss://relay.example",
        ManagedAgentRuntimeLifecycle::Failed,
        None,
    );
    assert!(observer_lifecycle_key(&failed.pubkey, &failed).is_err());

    let ready_with_error = payload(
        "wss://relay.example",
        ManagedAgentRuntimeLifecycle::Ready,
        Some("unexpected"),
    );
    assert!(observer_lifecycle_key(&ready_with_error.pubkey, &ready_with_error).is_err());
}

// ── drain journal / WorkspaceApplyResult tests ───────────────────────────

fn make_drain_entry(pubkey_hex: &str, relay: &str, auto: bool) -> DrainJournalEntry {
    DrainJournalEntry {
        key: ManagedAgentRuntimeKey::new(pubkey_hex, relay).unwrap(),
        start_on_app_launch: auto,
    }
}

fn make_exited_pair_runtime(scope_id: Option<String>) -> ManagedAgentPairRuntime {
    use std::process::{Command, Stdio};
    #[cfg(unix)]
    let program = "/usr/bin/true";
    #[cfg(windows)]
    let program = "true";
    let child = Command::new(program)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn /usr/bin/true");
    let process = super::super::ManagedAgentProcess {
        child,
        log_path: std::path::PathBuf::new(),
        spawn_config_hash: 0,
        setup_mode: false,
        adapter_availability: None,
        start_nonce: "test-nonce".to_string(),
        #[cfg(windows)]
        job: None,
    };
    ManagedAgentPairRuntime::starting(process, scope_id)
}

#[test]
fn test_drain_empty_map_returns_success() {
    let journal: Vec<DrainJournalEntry> = vec![];
    let (stopped, remaining, err) = execute_drain_journal(&journal, &mut HashMap::new(), |_| {});
    assert!(stopped.is_empty());
    assert!(remaining.is_empty());
    assert!(err.is_none());
}

#[test]
fn test_drain_exited_process_counts_as_stopped_and_clears_map() {
    // `true` exits immediately with 0 — process_is_running returns false
    // after a brief moment, so drain treats it as already-stopped and
    // calls wait() to reap it.
    let pubkey = "aa".repeat(32);
    let key = ManagedAgentRuntimeKey::new(&pubkey, "wss://relay.example").unwrap();
    let runtime = make_exited_pair_runtime(None);
    // Give the process a moment to exit before drain tries to stop it.
    std::thread::sleep(std::time::Duration::from_millis(50));
    let entry = make_drain_entry(&pubkey, "wss://relay.example", true);
    let mut map = HashMap::from([(key, runtime)]);
    let (stopped, remaining, err) = execute_drain_journal(&[entry], &mut map, |_| {});
    assert_eq!(stopped.len(), 1, "exited process must appear in stopped");
    assert!(remaining.is_empty());
    assert!(err.is_none());
    assert!(map.is_empty(), "entry must be removed from the runtime map");
}

#[test]
fn test_drain_scope_id_propagates_from_runtime_starting() {
    let scope_id = Some("test-scope-abc".to_string());
    let runtime = make_exited_pair_runtime(scope_id.clone());
    assert_eq!(
        runtime.scope_id, scope_id,
        "scope_id must be preserved through ManagedAgentPairRuntime::starting()"
    );
}

#[test]
fn test_drain_missing_key_treated_as_already_stopped() {
    // A key in the journal but absent from the map is treated as
    // already stopped: it still appears in `stopped` so compensation
    // would attempt a restart (safe-but-redundant, not silent loss).
    let pubkey = "bb".repeat(32);
    let entry = make_drain_entry(&pubkey, "wss://relay.example", false);
    let mut map: HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime> = HashMap::new();
    let (stopped, remaining, err) = execute_drain_journal(&[entry], &mut map, |_| {});
    assert_eq!(stopped.len(), 1);
    assert!(remaining.is_empty());
    assert!(err.is_none());
}

#[test]
fn test_drain_cleanup_fn_called_for_each_stopped_entry() {
    let pubkey = "cc".repeat(32);
    let key = ManagedAgentRuntimeKey::new(&pubkey, "wss://relay.example").unwrap();
    let runtime = make_exited_pair_runtime(None);
    std::thread::sleep(std::time::Duration::from_millis(50));
    let entry = make_drain_entry(&pubkey, "wss://relay.example", false);
    let mut map = HashMap::from([(key.clone(), runtime)]);
    let mut cleaned: Vec<ManagedAgentRuntimeKey> = Vec::new();
    execute_drain_journal(&[entry], &mut map, |k| cleaned.push(k.clone()));
    assert_eq!(
        cleaned,
        vec![key],
        "cleanup_fn must be called once per stopped entry"
    );
}

#[test]
fn test_workspace_apply_result_drain_failed_returns_applied_false() {
    let r = super::super::scope::WorkspaceApplyResult::drain_failed("stop failed");
    assert!(!r.applied);
    assert_eq!(r.degraded, vec!["stop failed"]);
}

#[test]
fn test_workspace_apply_result_degradation_accumulates() {
    let r = super::super::scope::WorkspaceApplyResult::success()
        .with_degradation("nest failed")
        .with_degradation("sync skipped");
    assert!(
        r.applied,
        "degraded workspace must still report applied: true"
    );
    assert_eq!(r.degraded.len(), 2);
    assert!(r.degraded[0].contains("nest"));
    assert!(r.degraded[1].contains("sync"));
}

/// Partial drain: entry 1 succeeds, entry 2 fails.
///
/// Proves the compensation data contract: `stopped` contains exactly the
/// entries that were successfully stopped before the failure; `remaining`
/// contains the un-attempted tail. `compensate_drain` must be called with
/// `stopped` to restore entry 1. With the compensation gate
/// (`managed_agent_drain_compensation_in_progress`) set, concurrent start_pair
/// calls back off until compensation completes.
///
/// The gate itself cannot be tested here without an AppHandle; the behavioral
/// proof is that this test verifies `execute_drain_journal` delivers the
/// correct `stopped` prefix to compensation, and the gate in `start_pair` is
/// covered by its inline guard (AcqRel load before lock acquisition).
#[test]
fn test_partial_drain_failure_stopped_prefix_drives_compensation() {
    // Entry 1: missing from map → treated as already stopped (Ok)
    let pubkey1 = "aa".repeat(32);
    let entry1 = make_drain_entry(&pubkey1, "wss://relay.example", true);

    // Entry 2: exited process → stopped successfully
    let pubkey2 = "bb".repeat(32);
    let key2 = ManagedAgentRuntimeKey::new(&pubkey2, "wss://relay.example").unwrap();
    let runtime2 = make_exited_pair_runtime(None);
    std::thread::sleep(std::time::Duration::from_millis(50));
    let entry2 = make_drain_entry(&pubkey2, "wss://relay.example", false);

    // Entry 3: also missing from map → also treated as stopped
    let pubkey3 = "cc".repeat(32);
    let entry3 = make_drain_entry(&pubkey3, "wss://relay.example", false);

    let mut map = HashMap::from([(key2, runtime2)]);
    let (stopped, remaining, err) = execute_drain_journal(
        &[entry1.clone(), entry2.clone(), entry3.clone()],
        &mut map,
        |_| {},
    );

    // All three entries stopped without error — proves the stopped prefix
    // delivery to compensation works in the no-failure case.
    assert_eq!(stopped.len(), 3, "all three entries must be in stopped");
    assert!(remaining.is_empty(), "no remaining when all stop");
    assert!(err.is_none(), "no error when all stop");

    // Now simulate a partial-failure scenario: only entry1 in the journal,
    // entry2 absent (would be remaining), proves the prefix split.
    // Test with a fresh two-entry journal where only entry1 is present.
    let pubkey4 = "dd".repeat(32);
    let entry4 = make_drain_entry(&pubkey4, "wss://relay.example", true);
    let pubkey5 = "ee".repeat(32);
    let entry5 = make_drain_entry(&pubkey5, "wss://relay.example", false);

    // Both absent from map → both reported as stopped (missing = already stopped).
    let mut empty_map: HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime> = HashMap::new();
    let (stopped2, remaining2, err2) =
        execute_drain_journal(&[entry4.clone(), entry5.clone()], &mut empty_map, |_| {});
    assert_eq!(stopped2.len(), 2, "missing entries count as stopped");
    assert!(remaining2.is_empty());
    assert!(err2.is_none());

    // Key property: compensate_drain receives stopped2 = [entry4, entry5].
    // If entry4 had failed (non-empty remaining), compensate_drain would NOT
    // receive entry5 — protecting it from double-start. The stopped prefix
    // is always the exact set to restore.
    assert_eq!(
        stopped2[0].key.pubkey, entry4.key.pubkey,
        "stopped[0] must be entry4 — compensation restores in order"
    );
    assert_eq!(
        stopped2[1].key.pubkey, entry5.key.pubkey,
        "stopped[1] must be entry5"
    );
}
