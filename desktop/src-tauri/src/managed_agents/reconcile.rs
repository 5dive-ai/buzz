//! Boot-time disk↔relay reconcile for managed-agent (kind:30177) events.
//!
//! `run_event_sync` already reconciles personas (30175) and teams (30176)
//! into the retention store at boot; managed agents were the missing leg —
//! their events were enqueued only on the interactive save path
//! (`retain_managed_agent_pending`), so a record edited on disk between
//! launches, or a save whose publish was missed, silently diverged from the
//! relay. This module mirrors `migrate_personas_in_dir`: per-coordinate
//! content diff, monotonic `created_at` bump, retain with `pending_sync = 1`
//! for the existing flush loop.
//!
//! Best-effort contract (decided in #centralize-personas-and-agents):
//! - No file watcher — hand edits are picked up at next boot only.
//! - No deletion reconcile — a record absent from `managed-agents.json` is
//!   left untouched in retention; a truncated or partial file must never
//!   trigger tombstones.
//! - A malformed store fails loudly: the broken file is preserved as
//!   `managed-agents.json.invalid` (see [`super::storage::backup_invalid_store`])
//!   and an error is returned, never silently skipped.

use std::path::Path;

use super::{
    agent_events::build_agent_event,
    persona_events::monotonic_created_at,
    retention::{
        get_retained_event, open_retention_db, retain_event, retain_user_intent_event,
        RetainedEvent,
    },
    ManagedAgentRecord,
};
use buzz_core_pkg::kind::KIND_MANAGED_AGENT;

/// Core reconcile logic, decoupled from the Tauri `AppHandle` for testing.
///
/// Reads `managed-agents.json` raw — no keyring hydration: the published
/// projection ([`super::agent_events::agent_event_content`]) is the opt-IN
/// no-secrets allowlist, so keys are never needed here. For each record it
/// compares the freshly built event's content against the retained row at
/// `(30177, owner, agent_pubkey)` and re-retains (marking `pending_sync = 1`)
/// only when the row is absent or its content differs — an unchanged agent
/// never churns `pending_sync`.
///
/// Returns the number of agents (re)written to the retention store.
/// Called from [`crate::event_sync::run_event_sync_impl`] (production) and
/// from tests via [`reconcile_agents_in_dir`].
pub(crate) fn reconcile_agents_in_dir_at(
    base_dir: &Path,
    keys: &nostr::Keys,
    db_path: &Path,
) -> Result<u32, String> {
    let store_path = base_dir.join("managed-agents.json");
    if !store_path.exists() {
        return Ok(0);
    }

    let content = std::fs::read_to_string(&store_path)
        .map_err(|e| format!("failed to read managed-agents.json: {e}"))?;

    let records: Vec<ManagedAgentRecord> = serde_json::from_str(&content).map_err(|e| {
        super::storage::backup_invalid_store(&store_path);
        format!("failed to parse managed-agents.json (preserved as .invalid): {e}")
    })?;

    if records.is_empty() {
        return Ok(0);
    }

    let conn =
        open_retention_db(db_path).map_err(|e| format!("failed to open retention db: {e}"))?;

    let mut reconciled = 0u32;

    for record in &records {
        // A record without a pubkey has no event coordinate yet (key-less
        // agents mint keys on first start) — nothing to reconcile.
        if record.pubkey.is_empty() {
            continue;
        }

        if retain_agent_record(&conn, keys, record, false)? {
            reconciled += 1;
        }
    }

    Ok(reconciled)
}

/// Retain `record`'s kind:30177 identity record, marking it `pending_sync`
/// for the flush loop, when its projection differs from the retained head.
/// Returns `Ok(true)` when a row was (re)written and `Ok(false)` when the
/// retained content already matches (a true no-op — no `pending_sync` churn).
///
/// This is the single content-diff + monotonic-bump engine shared by the
/// boot-time reconcile above and the interactive edit paths
/// (`retain_managed_agent_pending`, persona-rename propagation). Every
/// mutation of an agent's published identity must go through it so the
/// retained record can never silently drift from `managed-agents.json`.
///
/// `user_intent` must be `true` when the caller is an interactive user action
/// (create, update, delete tombstone). A `true` value unconditionally clears
/// `publish_blocked` on the retained row so that a previously-parked coordinate
/// is reopened in-session. Boot-time reconcile callers pass `false` to leave
/// the gate unchanged — the laundering path is exactly reconcile.
pub(crate) fn retain_agent_record(
    conn: &rusqlite::Connection,
    keys: &nostr::Keys,
    record: &ManagedAgentRecord,
    user_intent: bool,
) -> Result<bool, String> {
    let owner_pubkey = keys.public_key().to_hex();
    let existing = get_retained_event(conn, KIND_MANAGED_AGENT, &owner_pubkey, &record.pubkey)?;

    // Build the event first and compare ITS content, so the comparison and
    // the retained row share one serialization of the projection (mirrors
    // `migrate_personas_in_dir`). Serializing the projection independently
    // here would silently diverge if `build_agent_event` ever changed how
    // it serializes — republishing every agent every boot. Content is
    // timestamp-independent, so the monotonic bump below never forces a
    // spurious republish; an unchanged agent is still a true no-op.
    let event = build_agent_event(record)?
        .custom_created_at(monotonic_created_at(
            existing.as_ref().map(|row| row.created_at),
        ))
        .sign_with_keys(keys)
        .map_err(|e| format!("failed to sign event for '{}': {e}", record.name))?;

    let content = event.content.clone();
    if existing.as_ref().is_some_and(|row| row.content == content) {
        // Content is unchanged — no publish churn. If this is a user-intent
        // call, still clear any stale gate: the user re-confirmed the same
        // content intentionally, which is a gate-clearing action regardless.
        if user_intent {
            use crate::managed_agents::retention::set_publish_blocked;
            set_publish_blocked(
                conn,
                KIND_MANAGED_AGENT,
                &owner_pubkey,
                &record.pubkey,
                false,
            )
            .map_err(|e| format!("failed to clear gate for '{}': {e}", record.name))?;
        }
        return Ok(false);
    }

    let retained = RetainedEvent::pending(
        KIND_MANAGED_AGENT,
        owner_pubkey,
        record.pubkey.clone(),
        &event,
    );
    if user_intent {
        retain_user_intent_event(conn, &retained)
    } else {
        retain_event(conn, &retained)
    }
    .map_err(|e| format!("failed to retain '{}': {e}", record.name))?;
    Ok(true)
}

/// Convenience test wrapper: `reconcile_agents_in_dir_at` with the default
/// retention db path (`base_dir/retention.db`).
#[cfg(test)]
pub(crate) fn reconcile_agents_in_dir(base_dir: &Path, keys: &nostr::Keys) -> Result<u32, String> {
    reconcile_agents_in_dir_at(base_dir, keys, &base_dir.join("retention.db"))
}

/// AppHandle-free core of the agent tombstone flow. Extracted as a seam so the
/// retention logic is independently testable without a running Tauri app.
///
/// Deletes the pending agent row at `(30177, owner, agent_pubkey)` and retains
/// a user-intent kind:5 tombstone at `(5, owner, tombstone_d_tag)`. The
/// user-intent write unconditionally clears `publish_blocked` so a tombstone
/// always propagates in-session, even if the coordinate was previously parked.
pub(crate) fn tombstone_agent_pending_inner(
    conn: &rusqlite::Connection,
    keys: &nostr::Keys,
    agent_pubkey: &str,
) -> Result<(), String> {
    use super::{
        agent_events::build_agent_delete,
        retention::{
            delete_retained_event, retain_user_intent_event, tombstone_retention_d_tag,
            RetainedEvent,
        },
    };
    use buzz_core_pkg::kind::KIND_MANAGED_AGENT;

    const KIND_DELETE: u32 = 5;

    let owner_pubkey = keys.public_key().to_hex();
    let event = build_agent_delete(agent_pubkey, &owner_pubkey)?
        .sign_with_keys(keys)
        .map_err(|e| format!("failed to sign managed-agent tombstone: {e}"))?;
    delete_retained_event(conn, KIND_MANAGED_AGENT, &owner_pubkey, agent_pubkey)?;
    retain_user_intent_event(
        conn,
        &RetainedEvent::pending(
            KIND_DELETE,
            owner_pubkey,
            tombstone_retention_d_tag(KIND_MANAGED_AGENT, agent_pubkey),
            &event,
        ),
    )
}

#[cfg(test)]
mod tests;
