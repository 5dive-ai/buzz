use super::*;

/// Decision for a delete retry that finds (or does not find) a pending
/// tombstone already retained at the agent's coordinate. Keeps the immutable
/// tombstone from ever being rebuilt at a fresh event id/timestamp.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TombstoneRetry {
    /// The exact pending tombstone for THIS deletion already exists; resume it
    /// (return `DeferErase`) without touching retention.
    Resume,
    /// No pending tombstone exists and the record is still authoritative — mint
    /// the tombstone now (the normal first-delete path, and the cascade
    /// enqueue-before-flip path).
    Build,
    /// Refuse to proceed: either a mid-deletion (`Deleting`) record has no
    /// pending tombstone to resume (inconsistent — its tombstone should exist),
    /// or a pending row exists but does not match this agent's verified head
    /// (foreign/drifted). Rebuilding would violate immutable retention.
    FailClosed,
}

/// Pure retry classifier for [`tombstone_managed_agent_pending`].
///
/// * `pending_row_present` — a `state="deleted"`, `pending_sync` row exists at
///   the coordinate.
/// * `matches_this_deletion` — that row's generation is `evidence.gen + 1` and
///   its decrypted predecessor is the record's verified head.
/// * `is_deleting` — the record's authority is `Deleting` (vs
///   `RelayAuthoritative`).
pub(crate) fn classify_tombstone_retry(
    pending_row_present: bool,
    matches_this_deletion: bool,
    is_deleting: bool,
) -> TombstoneRetry {
    match (pending_row_present, matches_this_deletion, is_deleting) {
        // Exact pending tombstone for this deletion: idempotent resume.
        (true, true, _) => TombstoneRetry::Resume,
        // A row exists but is foreign/drifted: never rebuild over it.
        (true, false, _) => TombstoneRetry::FailClosed,
        // No row, still authoritative: first delete (or cascade pre-flip) builds.
        (false, _, false) => TombstoneRetry::Build,
        // No row, but already Deleting: inconsistent — its tombstone should exist.
        (false, _, true) => TombstoneRetry::FailClosed,
    }
}

/// What the caller must do to the local record after
/// [`tombstone_managed_agent_pending`] has durably enqueued the tombstone.
///
/// The variant enforces enqueue-before-erase: a `RelayAuthoritative` agent's
/// authoritative tombstone must be verified at the relay before the local
/// record/key are destroyed, so its record stays on disk in `Deleting` state
/// and erase is deferred to the boot deletion flush. A `LegacyOnly` agent has
/// no async relay confirmation, so once its kind:5 tombstone is durably
/// enqueued the caller erases in the same lock.
pub(crate) enum TombstoneDisposition {
    /// Legacy kind:5 path: the tombstone is durably enqueued; erase the record
    /// and key now, in the same lock.
    EraseNow,
    /// Relay-canonical path: the authoritative deleted aggregate is durably
    /// retained (`pending_sync = 1`). The caller MUST NOT erase yet — flip the
    /// record to [`RelayAuthority::Deleting`] with this evidence and keep it on
    /// disk. The deletion flush erases only after verified relay confirmation.
    DeferErase {
        evidence: crate::managed_agents::RelayAuthorityEvidence,
    },
}

/// Durably enqueue a managed agent's authoritative tombstone, returning what
/// the caller must do to the local record — WITHOUT erasing anything itself.
///
/// This is the crash-safe enqueue-before-erase seam. It runs inside the
/// `managed_agents_store_lock`-held delete body and NEVER across an `.await`.
///
/// * **RelayAuthoritative**: builds the next-generation deleted kind:30179
///   aggregate from the record's verified head evidence and retains it with
///   `pending_sync = 1`. This durable row is the retry input; it MUST land
///   before the record/key are destroyed, so a crash between enqueue and the
///   (deferred, verified) erase retries cleanly and the evidence needed to
///   re-sign the tombstone survives. Returns [`TombstoneDisposition::DeferErase`]
///   — the caller keeps the record on disk in [`RelayAuthority::Deleting`].
///   A failure here is FATAL and propagates: the record is left fully intact
///   ([`RelayAuthority::RelayAuthoritative`]) and the delete is retryable, never
///   erased against a missing durable tombstone.
/// * **LegacyOnly**: retains the kind:5 NIP-09 tombstone at its own coordinate.
///   Returns [`TombstoneDisposition::EraseNow`]. A retention hiccup here is
///   logged and swallowed (legacy has no live authoritative aggregate to leak
///   and no async confirmation), so a disk-authoritative delete is never blocked.
///
/// Mirrors `commands::personas::tombstone_persona_pending`: the agent row at
/// `(30177, owner, agent_pubkey)` is purged first so an unpublished edit can
/// never resurrect it after the tombstone publishes.
pub(crate) fn tombstone_managed_agent_pending(
    app: &AppHandle,
    state: &AppState,
    agent_pubkey: &str,
    relay_authority: &crate::managed_agents::RelayAuthority,
) -> Result<TombstoneDisposition, String> {
    use crate::managed_agents::{
        agent_events::build_agent_delete,
        migration::build_tombstone_event,
        retention::{
            delete_retained_event, open_retention_db, retain_event, retain_managed_agent_aggregate,
            tombstone_retention_d_tag, RetainedEvent, RetainedManagedAgentAggregate,
        },
    };
    use buzz_core_pkg::kind::KIND_MANAGED_AGENT;
    use nostr::JsonUtil;

    const KIND_DELETE: u32 = 5;

    // Relay-canonical agents durably enqueue the authoritative tombstone before
    // ANY local destruction. A failure propagates so the caller never erases
    // against a missing retry — the record stays RelayAuthoritative and the
    // delete is retryable.
    if let Some(evidence) = relay_authority.evidence() {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        let owner_pubkey = scope.owner_keys.public_key().to_hex();

        // Idempotent retry recognition. A repeat delete on this coordinate may
        // find its immutable tombstone ALREADY enqueued — either because the
        // record is now `Deleting` (its authority flip/save landed) or because it
        // is still `RelayAuthoritative` (a cascade crash after enqueue N but
        // before the batch authority save, per the self-heal contract). In BOTH
        // cases rebuilding would mint a new event id / timestamp at the same
        // coordinate and hit immutable-retention drift. So recognize the exact
        // pending tombstone bound to THIS verified head and return DeferErase
        // without touching retention; the deletion flush self-heals the authority
        // state. If a pending tombstone exists but does NOT match its predecessor,
        // fail closed — never rebuild over a foreign row.
        {
            let conn = open_retention_db(&scope.db_path)?;
            let pending_deleted =
                crate::managed_agents::retention::get_retained_managed_agent_aggregate(
                    &conn,
                    &owner_pubkey,
                    agent_pubkey,
                )?
                .filter(|retained| retained.state == "deleted" && retained.pending_sync);

            // Decrypt the pending row (if any) and reduce it to a single fact:
            // does it name THIS exact deletion (generation = evidence.gen+1 and
            // decrypted predecessor = the record's verified head)? Decryption
            // stays here; the branch decision is a pure classifier below.
            let matches_this_deletion = match &pending_deleted {
                Some(retained) => {
                    let generation_ok = evidence
                        .generation
                        .checked_add(1)
                        .is_some_and(|next| retained.generation == next);
                    generation_ok && {
                        let parsed: serde_json::Value =
                            serde_json::from_str(&retained.request_json).map_err(|e| {
                                format!("retained deleted request json invalid: {e}")
                            })?;
                        let private_event: nostr::Event = serde_json::from_value(
                            parsed.get("private_event").cloned().ok_or_else(|| {
                                "retained deleted request missing private_event".to_string()
                            })?,
                        )
                        .map_err(|e| format!("retained deleted private_event invalid: {e}"))?;
                        let (_, payload) =
                            buzz_core_pkg::private_managed_agent::validate_and_decrypt(
                                &private_event,
                                &scope.owner_keys,
                            )
                            .map_err(|e| format!("retained deletion head does not decrypt: {e}"))?;
                        payload.state == buzz_core_pkg::private_managed_agent::State::Deleted
                            && payload.owner_pubkey == owner_pubkey
                            && payload.agent_pubkey == agent_pubkey
                            && payload.previous_event_id.as_deref()
                                == Some(&evidence.private_event_id)
                    }
                }
                None => false,
            };

            match classify_tombstone_retry(
                pending_deleted.is_some(),
                matches_this_deletion,
                relay_authority.is_deleting(),
            ) {
                TombstoneRetry::Resume => {
                    return Ok(TombstoneDisposition::DeferErase {
                        evidence: evidence.clone(),
                    })
                }
                TombstoneRetry::FailClosed => {
                    return Err(
                        "delete retry cannot rebuild an immutable tombstone: a pending row is \
                         missing or does not match this agent's verified head (fail closed)"
                            .to_string(),
                    )
                }
                TombstoneRetry::Build => {}
            }
        }

        let mut conn = open_retention_db(&scope.db_path)?;
        // Build path: no pending tombstone yet exists for this coordinate.
        // Purge the agent's 30177 row first so an unpublished edit can never
        // resurrect it after the tombstone publishes.
        delete_retained_event(&conn, KIND_MANAGED_AGENT, &owner_pubkey, agent_pubkey)?;

        let timestamp = crate::util::now_iso();
        let event = build_tombstone_event(
            &scope.owner_keys,
            agent_pubkey,
            evidence.generation,
            &evidence.private_event_id,
            &timestamp,
            nostr::Timestamp::now().as_secs(),
        )
        .map_err(|error| format!("failed to build managed-agent aggregate tombstone: {error:?}"))?;
        let generation = evidence
            .generation
            .checked_add(1)
            .ok_or_else(|| "managed-agent aggregate generation overflow".to_string())?;
        let request_json = serde_json::to_string(&serde_json::json!({
            "private_event": event,
            "definition_event": null,
            "instance_event": null,
            "expected_definition_revision": null
        }))
        .map_err(|error| format!("failed to serialize managed-agent tombstone: {error}"))?;
        retain_managed_agent_aggregate(
            &mut conn,
            &RetainedManagedAgentAggregate {
                owner_pubkey,
                agent_pubkey: agent_pubkey.to_string(),
                generation,
                private_event_id: event.id.to_hex(),
                state: "deleted".to_string(),
                request_json,
                pending_sync: true,
                last_error: None,
                local_authority_applied: false,
            },
        )?;
        return Ok(TombstoneDisposition::DeferErase {
            evidence: evidence.clone(),
        });
    }

    // LegacyOnly: enqueue the kind:5 tombstone before erase, but best-effort —
    // a retention hiccup never blocks the disk-authoritative delete.
    let result = (|| -> Result<(), String> {
        let scope = crate::managed_agents::retention::active_retention_scope(app, state)?;
        let owner_pubkey = scope.owner_keys.public_key().to_hex();
        let conn = open_retention_db(&scope.db_path)?;
        delete_retained_event(&conn, KIND_MANAGED_AGENT, &owner_pubkey, agent_pubkey)?;

        let event = build_agent_delete(agent_pubkey, &owner_pubkey)?
            .sign_with_keys(&scope.owner_keys)
            .map_err(|e| format!("failed to sign managed-agent tombstone: {e}"))?;
        retain_event(
            &conn,
            &RetainedEvent {
                kind: KIND_DELETE,
                pubkey: owner_pubkey,
                // Key by the target coordinate so cross-kind d-tag tombstones
                // occupy distinct rows (F2c).
                d_tag: tombstone_retention_d_tag(KIND_MANAGED_AGENT, agent_pubkey),
                content: event.content.to_string(),
                created_at: event.created_at.as_secs() as i64,
                raw_event: event.as_json(),
                pending_sync: true,
            },
        )
    })();
    if let Err(e) = result {
        eprintln!("buzz-desktop: agent-tombstone: {e}");
    }
    Ok(TombstoneDisposition::EraseNow)
}
