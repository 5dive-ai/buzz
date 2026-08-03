//! Shared test scaffolding used by `tests.rs` and `regression_tests.rs`.
//!
//! Both files need the same five helpers and three constants. Keeping a single
//! copy here means a change to (e.g.) `signed_persona` is made once and the
//! duplicate cannot drift.

use std::path::Path;

use super::*;
use crate::managed_agents::{
    persona_events::build_persona_event,
    retention::{get_pending_sync, open_retention_db, retain_event, RetainedEvent},
};
use buzz_core_pkg::kind::KIND_PERSONA;
use rusqlite::Connection;

pub(super) const OWNER: &str = "ownerpubkeyhex";

pub(super) fn test_db() -> Connection {
    open_retention_db(Path::new(":memory:")).unwrap()
}

pub(super) fn coordinate() -> Coordinate {
    Coordinate {
        kind: KIND_PERSONA,
        d_tag: "test-persona".to_string(),
    }
}

pub(super) fn signed_persona(system_prompt: &str) -> nostr::Event {
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

pub(super) fn retain_prompt(
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

pub(super) fn set_pending(conn: &Connection, kind: u32, d_tag: &str) {
    conn.execute(
        "UPDATE persona_events SET pending_sync = 1
         WHERE kind = ?1 AND pubkey = ?2 AND d_tag = ?3",
        rusqlite::params![kind, OWNER, d_tag],
    )
    .unwrap();
}

pub(super) fn run_pass(conn: &Connection, observation: &Observation) -> (Decision, usize) {
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
