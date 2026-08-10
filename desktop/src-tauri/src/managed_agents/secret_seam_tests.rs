//! Tests for the strip-on-save / hydrate-on-load seam.
//!
//! The load-bearing property proven here is the CRITICAL F1 fix: a save NEVER
//! eagerly deletes the old generation. The atomic JSON write is the commit
//! point; if it fails, the on-disk record still points at the OLD generation,
//! so that generation must remain in the keyring and stay hydratable. Old-gen
//! retirement is left entirely to the two-cycle GC.

use super::*;
use crate::managed_agents::secret_projection::{
    agent_auth_tag_key, agent_env_key, agent_provider_config_key, definition_env_key,
    global_env_key, write_secret, WriteOutcome,
};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

// ── Fake store (mirrors secret_projection_tests::FakeProjectionStore) ──────

struct FakeProjectionStore {
    data: RefCell<HashMap<String, String>>,
}

impl FakeProjectionStore {
    fn new() -> Self {
        Self {
            data: RefCell::new(HashMap::new()),
        }
    }
    fn with_entry(self, key: &str, value: &str) -> Self {
        self.data
            .borrow_mut()
            .insert(key.to_string(), value.to_string());
        self
    }
    fn contains(&self, key: &str) -> bool {
        self.data.borrow().contains_key(key)
    }
}

impl ProjectionStore for FakeProjectionStore {
    fn write_and_verify(&self, key: &str, value: &str) -> Result<(), String> {
        self.data
            .borrow_mut()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }
    fn load_key(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.data.borrow().get(key).cloned())
    }
    fn load_all(&self) -> Result<Option<HashMap<String, String>>, String> {
        Ok(Some(self.data.borrow().clone()))
    }
    fn store_batch(&self, entries: &HashMap<String, String>) -> Result<(), String> {
        for (k, v) in entries {
            self.data.borrow_mut().insert(k.clone(), v.clone());
        }
        Ok(())
    }
    fn remove_batch(&self, keys: &[&str]) -> Result<(), String> {
        for k in keys {
            self.data.borrow_mut().remove(*k);
        }
        Ok(())
    }
}

// ── Fake store that fails loads for keys pointing at a specific gen ─────────
//
// Simulates a keyring outage where an entry's *_ref is present in JSON but the
// blob is unreachable — the exact condition that sets `secrets_unavailable`.
struct FailingLoadStore {
    fail_substr: String,
}

impl FailingLoadStore {
    fn new(fail_substr: &str) -> Self {
        Self {
            fail_substr: fail_substr.to_string(),
        }
    }
}

impl ProjectionStore for FailingLoadStore {
    fn write_and_verify(&self, _key: &str, _value: &str) -> Result<(), String> {
        Ok(())
    }
    fn load_key(&self, key: &str) -> Result<Option<String>, String> {
        if key.contains(&self.fail_substr) {
            Err(format!("simulated keyring outage for {key}"))
        } else {
            Ok(None)
        }
    }
    fn load_all(&self) -> Result<Option<HashMap<String, String>>, String> {
        Ok(Some(HashMap::new()))
    }
    fn store_batch(&self, _entries: &HashMap<String, String>) -> Result<(), String> {
        Ok(())
    }
    fn remove_batch(&self, _keys: &[&str]) -> Result<(), String> {
        Ok(())
    }
}

// ── Record builders ────────────────────────────────────────────────────────

fn instance_record(pubkey: &str) -> ManagedAgentRecord {
    serde_json::from_str(&format!(
        r#"{{
            "pubkey": "{pubkey}",
            "name": "test-agent",
            "private_key_nsec": "nsec1realkey",
            "relay_url": "wss://localhost:3000",
            "acp_command": "buzz-acp",
            "agent_command": "goose",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 320,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }}"#
    ))
    .expect("instance record")
}

fn definition_record(slug: &str) -> ManagedAgentRecord {
    serde_json::from_str(&format!(
        r#"{{
            "pubkey": "",
            "name": "test-def",
            "slug": "{slug}",
            "relay_url": "",
            "acp_command": "buzz-acp",
            "agent_command": "goose",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 320,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }}"#
    ))
    .expect("definition record")
}

fn env_map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

// ── F1: old generation survives a save (no eager delete) ────────────────────

#[test]
fn test_instance_env_save_keeps_old_generation_for_failed_json_commit() {
    // Old generation is live on disk (record.env_vars_ref = "gen_old").
    let pubkey = "abc";
    let store = FakeProjectionStore::new()
        .with_entry(&agent_env_key(pubkey, "gen_old"), r#"{"OLD":"old-secret"}"#);

    // The on-disk record as it would be re-read after a FAILED JSON write:
    // it still points at the old generation because the new commit never landed.
    let mut on_disk = instance_record(pubkey);
    on_disk.env_vars_ref = Some("gen_old".to_string());

    // A save runs: new env is written to a new generation.
    let mut saving = instance_record(pubkey);
    saving.env_vars = env_map(&[("NEW", "new-secret")]);
    saving.env_vars_ref = Some("gen_old".to_string());
    strip_and_persist_agent_secrets_with(&store, &mut saving);

    // The old generation must NOT have been deleted by the save.
    assert!(
        store.contains(&agent_env_key(pubkey, "gen_old")),
        "old generation must survive the save — JSON commit could still fail"
    );

    // Simulate the JSON write failing: the on-disk record (old ref) is what
    // survives. Hydrating it must still resolve the old secret.
    let errors = hydrate_agent_secrets_with(&store, &mut on_disk);
    assert!(errors.is_empty(), "old ref must still hydrate: {errors:?}");
    assert_eq!(on_disk.env_vars, env_map(&[("OLD", "old-secret")]));
}

#[test]
fn test_instance_auth_tag_save_keeps_old_generation_for_failed_json_commit() {
    let pubkey = "abc";
    let store = FakeProjectionStore::new()
        .with_entry(&agent_auth_tag_key(pubkey, "gen_old"), "old-auth-tag");

    let mut on_disk = instance_record(pubkey);
    on_disk.auth_tag_ref = Some("gen_old".to_string());

    let mut saving = instance_record(pubkey);
    saving.auth_tag = Some("new-auth-tag".to_string());
    saving.auth_tag_ref = Some("gen_old".to_string());
    strip_and_persist_agent_secrets_with(&store, &mut saving);

    assert!(
        store.contains(&agent_auth_tag_key(pubkey, "gen_old")),
        "old auth_tag generation must survive the save"
    );

    let errors = hydrate_agent_secrets_with(&store, &mut on_disk);
    assert!(errors.is_empty(), "old auth ref must hydrate: {errors:?}");
    assert_eq!(on_disk.auth_tag.as_deref(), Some("old-auth-tag"));
}

#[test]
fn test_instance_provider_config_save_keeps_old_generation_for_failed_json_commit() {
    let pubkey = "abc";
    let old_config = r#"{"host":"old.example.com"}"#;
    let store = FakeProjectionStore::new()
        .with_entry(&agent_provider_config_key(pubkey, "gen_old"), old_config);

    let mut on_disk = instance_record(pubkey);
    on_disk.backend = BackendKind::Provider {
        id: "anthropic".to_string(),
        config: serde_json::Value::Null,
    };
    on_disk.provider_config_ref = Some("gen_old".to_string());

    let mut saving = instance_record(pubkey);
    saving.backend = BackendKind::Provider {
        id: "anthropic".to_string(),
        config: serde_json::json!({"host": "new.example.com"}),
    };
    saving.provider_config_ref = Some("gen_old".to_string());
    strip_and_persist_agent_secrets_with(&store, &mut saving);

    assert!(
        store.contains(&agent_provider_config_key(pubkey, "gen_old")),
        "old provider_config generation must survive the save"
    );

    let errors = hydrate_agent_secrets_with(&store, &mut on_disk);
    assert!(errors.is_empty(), "old pc ref must hydrate: {errors:?}");
    if let BackendKind::Provider { config, .. } = &on_disk.backend {
        assert_eq!(config, &serde_json::json!({"host": "old.example.com"}));
    } else {
        panic!("expected provider backend");
    }
}

#[test]
fn test_definition_env_save_keeps_old_generation_for_failed_json_commit() {
    let slug = "my-def";
    let store = FakeProjectionStore::new().with_entry(
        &definition_env_key(slug, "gen_old"),
        r#"{"OLD":"old-secret"}"#,
    );

    let mut on_disk = definition_record(slug);
    on_disk.env_vars_ref = Some("gen_old".to_string());

    let mut saving = definition_record(slug);
    saving.env_vars = env_map(&[("NEW", "new-secret")]);
    saving.env_vars_ref = Some("gen_old".to_string());
    strip_and_persist_definition_secrets_with(&store, &mut saving);

    assert!(
        store.contains(&definition_env_key(slug, "gen_old")),
        "old definition env generation must survive the save"
    );

    let errors = hydrate_definition_secrets_with(&store, &mut on_disk);
    assert!(errors.is_empty(), "old def ref must hydrate: {errors:?}");
    assert_eq!(on_disk.env_vars, env_map(&[("OLD", "old-secret")]));
}

#[test]
fn test_global_env_write_keeps_old_generation_for_failed_json_commit() {
    // Global config save has no seam fn (it lives in global_config::mod), but
    // its persistence uses the same write_secret primitive. Prove the
    // primitive does not disturb the prior generation: a new write creates a
    // NEW gen and the old gen stays intact and loadable.
    let store =
        FakeProjectionStore::new().with_entry(&global_env_key("gen_old"), r#"{"OLD":"old"}"#);

    let outcome = write_secret(
        &store,
        global_env_key,
        Some(r#"{"NEW":"new"}"#),
        "global env",
    );
    let new_gen = match outcome {
        WriteOutcome::Persisted { gen } => gen,
        other => panic!("expected Persisted, got {other:?}"),
    };
    assert_ne!(new_gen, "gen_old");

    // Old generation intact (JSON commit could still fail after this write).
    assert!(
        store.contains(&global_env_key("gen_old")),
        "old global env generation must survive the write"
    );
    // And still hydratable via its ref.
    let loaded = load_secret(&store, Some("gen_old"), global_env_key, "global env");
    assert_eq!(loaded, Ok(Some(r#"{"OLD":"old"}"#.to_string())));
}

// ── F3b: fail-closed — a failed hydrate never orphans the live generation ───
//
// Load path: an env_vars_ref present in JSON whose blob is unreachable must
// leave the field empty AND set `secrets_unavailable` — never silently drop
// the ref. Save path: persisting that unavailable record must PRESERVE the
// ref (empty-projection guard) so the still-live generation is not orphaned.

#[test]
fn test_instance_failed_env_hydrate_sets_secrets_unavailable() {
    let pubkey = "abc";
    let store = FailingLoadStore::new(&agent_env_key(pubkey, "gen_live"));
    let mut record = instance_record(pubkey);
    record.env_vars_ref = Some("gen_live".to_string());

    let errors = hydrate_agent_secrets_with(&store, &mut record);

    assert!(!errors.is_empty(), "a failed hydrate must surface an error");
    assert!(
        record.env_vars.is_empty(),
        "field stays empty on outage — no silent partial value"
    );
    // hydrate_all_secrets_for_records is the caller that sets the flag; assert
    // there so the propagation contract is covered end-to-end.
    let mut records = vec![{
        let mut r = instance_record(pubkey);
        r.env_vars_ref = Some("gen_live".to_string());
        r
    }];
    let unavailable = hydrate_all_secrets_for_records(&store, &mut records);
    assert!(
        records[0].secrets_unavailable,
        "outage must mark unavailable"
    );
    assert_eq!(unavailable, vec![pubkey.to_string()]);
}

#[test]
fn test_instance_save_preserves_ref_when_secrets_unavailable() {
    // The data-loss vector: a record whose env_vars_ref failed to hydrate holds
    // an empty env map. A naive save would write nothing and CLEAR the ref,
    // orphaning the live generation forever. The guard must keep the ref.
    let pubkey = "abc";
    let store =
        FakeProjectionStore::new().with_entry(&agent_env_key(pubkey, "gen_live"), r#"{"K":"v"}"#);

    let mut record = instance_record(pubkey);
    record.env_vars_ref = Some("gen_live".to_string());
    record.env_vars.clear(); // failed-hydrate state: ref present, map empty
    record.secrets_unavailable = true;

    strip_and_persist_agent_secrets_with(&store, &mut record);

    assert_eq!(
        record.env_vars_ref.as_deref(),
        Some("gen_live"),
        "ref must be preserved so the live generation is not orphaned"
    );
    assert!(
        store.contains(&agent_env_key(pubkey, "gen_live")),
        "the live generation must still exist"
    );
}

#[test]
fn test_instance_save_preserves_auth_and_provider_refs_when_unavailable() {
    let pubkey = "abc";
    let store = FakeProjectionStore::new()
        .with_entry(&agent_auth_tag_key(pubkey, "gen_a"), "live-auth")
        .with_entry(&agent_provider_config_key(pubkey, "gen_p"), r#"{"h":"x"}"#);

    let mut record = instance_record(pubkey);
    record.auth_tag_ref = Some("gen_a".to_string());
    record.backend = BackendKind::Provider {
        id: "anthropic".to_string(),
        config: serde_json::Value::Null,
    };
    record.provider_config_ref = Some("gen_p".to_string());
    record.secrets_unavailable = true;

    strip_and_persist_agent_secrets_with(&store, &mut record);

    assert_eq!(
        record.auth_tag_ref.as_deref(),
        Some("gen_a"),
        "auth_tag ref must survive an unavailable save"
    );
    assert_eq!(
        record.provider_config_ref.as_deref(),
        Some("gen_p"),
        "provider_config ref must survive an unavailable save"
    );
}

#[test]
fn test_available_record_clear_still_clears_ref() {
    // Regression guard for the guard: on an AVAILABLE record (not unavailable),
    // a genuinely-cleared field must still clear its ref — the fix must not
    // pin stale refs for a real user edit.
    let pubkey = "abc";
    let store = FakeProjectionStore::new();
    let mut record = instance_record(pubkey);
    record.env_vars_ref = Some("gen_old".to_string());
    record.env_vars.clear();
    record.secrets_unavailable = false; // available: this is a real clear

    strip_and_persist_agent_secrets_with(&store, &mut record);

    assert_eq!(
        record.env_vars_ref, None,
        "an available record's cleared field must clear its ref"
    );
}

#[test]
fn test_definition_failed_hydrate_then_save_preserves_ref() {
    // End-to-end for the definition tier: outage on load → secrets_unavailable
    // set by hydrate_all_secrets_for_records → save preserves the ref.
    let slug = "my-def";
    let mut records = vec![{
        let mut d = definition_record(slug);
        d.env_vars_ref = Some("gen_live".to_string());
        d
    }];

    let outage = FailingLoadStore::new(&definition_env_key(slug, "gen_live"));
    let unavailable = hydrate_all_secrets_for_records(&outage, &mut records);
    assert!(
        unavailable.is_empty(),
        "definitions are slug-keyed, not pushed to the pubkey summary"
    );
    assert!(
        records[0].secrets_unavailable,
        "definition outage must set secrets_unavailable"
    );
    assert!(records[0].env_vars.is_empty());

    // Now save against a store where the live gen still exists.
    let store = FakeProjectionStore::new()
        .with_entry(&definition_env_key(slug, "gen_live"), r#"{"K":"v"}"#);
    strip_and_persist_definition_secrets_with(&store, &mut records[0]);

    assert_eq!(
        records[0].env_vars_ref.as_deref(),
        Some("gen_live"),
        "definition ref must survive an unavailable save"
    );
    assert!(store.contains(&definition_env_key(slug, "gen_live")));
}
