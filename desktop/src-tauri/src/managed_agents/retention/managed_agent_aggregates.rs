use rusqlite::{params, Connection, OptionalExtension};

/// One durable kind:30179 aggregate request retained for offline retry.
///
/// The exact serialized request is immutable for a generation: retrying must
/// submit the same signed events and CAS predecessor, never rebuild them with a
/// fresh timestamp after local state has moved.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // Consumed by the PMA aggregate submit/retry driver in the next slice.
pub struct RetainedManagedAgentAggregate {
    pub owner_pubkey: String,
    pub agent_pubkey: String,
    pub generation: u64,
    pub private_event_id: String,
    pub state: String,
    pub request_json: String,
    pub pending_sync: bool,
    pub last_error: Option<String>,
    /// Durable proof that a verified deletion has already applied the local
    /// record/key erase for this exact generation. Only ever set on a
    /// `state = "deleted"` row, immediately before `pending_sync` is cleared,
    /// so crash-replay can distinguish "our verified deletion erased the
    /// record" from an unrelated/manual local deletion. Always `false` on a
    /// freshly retained row.
    pub local_authority_applied: bool,
}

pub fn retire_managed_agent_aggregate(
    conn: &Connection,
    owner_pubkey: &str,
    agent_pubkey: &str,
    generation: u64,
    private_event_id: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "DELETE FROM managed_agent_aggregates
              WHERE owner_pubkey = ?1 AND agent_pubkey = ?2
                AND generation = ?3 AND private_event_id = ?4 AND pending_sync = 1",
            params![
                owner_pubkey,
                agent_pubkey,
                generation as i64,
                private_event_id
            ],
        )
        .map_err(|error| format!("failed to retire managed-agent aggregate: {error}"))?;
    Ok(changed == 1)
}

pub fn seed_confirmed_managed_agent_aggregate(
    conn: &Connection,
    aggregate: &RetainedManagedAgentAggregate,
) -> Result<(), String> {
    if aggregate.pending_sync || aggregate.state != "active" {
        return Err("confirmed managed-agent seed must be a synced active head".to_string());
    }
    conn.execute(
        "INSERT OR IGNORE INTO managed_agent_aggregates
            (owner_pubkey, agent_pubkey, generation, private_event_id, state,
             request_json, pending_sync, last_error, local_authority_applied)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, 0)",
        params![
            aggregate.owner_pubkey,
            aggregate.agent_pubkey,
            aggregate.generation as i64,
            aggregate.private_event_id,
            aggregate.state,
            aggregate.request_json,
        ],
    )
    .map_err(|error| format!("failed to seed confirmed managed-agent aggregate: {error}"))?;
    Ok(())
}

/// Insert or idempotently refresh a retained aggregate generation.
///
/// Generation may advance by exactly one. A byte-identical rewrite of the
/// current generation is accepted for crash recovery; divergent same-generation
/// content and skipped/stale generations are rejected before touching disk.
#[allow(dead_code)] // Consumed by the PMA aggregate submit/retry driver in the next slice.
pub fn retain_managed_agent_aggregate(
    conn: &mut Connection,
    aggregate: &RetainedManagedAgentAggregate,
) -> Result<(), String> {
    if aggregate.generation == 0 || aggregate.generation > i64::MAX as u64 {
        return Err("managed-agent aggregate generation is out of range".to_string());
    }
    if !matches!(aggregate.state.as_str(), "active" | "deleted") {
        return Err("managed-agent aggregate state must be active or deleted".to_string());
    }

    if !aggregate.pending_sync || aggregate.last_error.is_some() {
        return Err("new managed-agent aggregate must start pending without an error".to_string());
    }
    if aggregate.local_authority_applied {
        return Err(
            "new managed-agent aggregate must not start with local authority applied".to_string(),
        );
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("failed to retain managed-agent aggregate: {e}"))?;
    let current = tx
        .query_row(
            "SELECT generation, private_event_id, state, request_json
               FROM managed_agent_aggregates
              WHERE owner_pubkey = ?1 AND agent_pubkey = ?2
              ORDER BY generation DESC
              LIMIT 1",
            params![aggregate.owner_pubkey, aggregate.agent_pubkey],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("failed to read retained managed-agent aggregate: {e}"))?;

    if let Some((generation, event_id, state, request_json)) = current {
        let generation = u64::try_from(generation)
            .map_err(|_| "retained managed-agent aggregate generation is invalid".to_string())?;
        if aggregate.generation == generation {
            if aggregate.private_event_id != event_id
                || aggregate.state != state
                || aggregate.request_json != request_json
            {
                return Err(
                    "managed-agent aggregate conflicts with retained generation".to_string()
                );
            }
            // An exact retry is a true no-op. Do not re-arm an already
            // confirmed row or erase its persisted diagnostic on startup.
            return Ok(());
        }

        let next_generation = generation.checked_add(1).ok_or_else(|| {
            "retained managed-agent aggregate generation cannot advance".to_string()
        })?;
        if aggregate.generation != next_generation {
            return Err(format!(
                "managed-agent aggregate generation must advance from {generation} to {next_generation}"
            ));
        }
    } else if aggregate.generation != 1 {
        return Err("first retained managed-agent aggregate must be generation 1".to_string());
    }

    tx.execute(
        "INSERT INTO managed_agent_aggregates
            (owner_pubkey, agent_pubkey, generation, private_event_id, state,
             request_json, pending_sync, last_error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, NULL)",
        params![
            aggregate.owner_pubkey,
            aggregate.agent_pubkey,
            aggregate.generation as i64,
            aggregate.private_event_id,
            aggregate.state,
            aggregate.request_json,
        ],
    )
    .map_err(|e| format!("failed to write retained managed-agent aggregate: {e}"))?;
    tx.commit()
        .map_err(|e| format!("failed to commit retained managed-agent aggregate: {e}"))
}

#[allow(dead_code)] // Consumed by the PMA aggregate submit/retry driver in the next slice.
pub fn get_retained_managed_agent_aggregate(
    conn: &Connection,
    owner_pubkey: &str,
    agent_pubkey: &str,
) -> Result<Option<RetainedManagedAgentAggregate>, String> {
    conn.query_row(
        "SELECT owner_pubkey, agent_pubkey, generation, private_event_id, state,
                request_json, pending_sync, last_error, local_authority_applied
           FROM managed_agent_aggregates
          WHERE owner_pubkey = ?1 AND agent_pubkey = ?2
          ORDER BY generation DESC
          LIMIT 1",
        params![owner_pubkey, agent_pubkey],
        aggregate_from_row,
    )
    .optional()
    .map_err(|e| format!("failed to get retained managed-agent aggregate: {e}"))
}

/// Snapshot every pending aggregate attempt for one captured owner scope.
///
/// At most one generation per agent may be pending during normal operation,
/// but selecting the latest pending generation defensively avoids replaying a
/// superseded row after a crash between generation advance and acknowledgement.
pub fn get_pending_managed_agent_aggregates(
    conn: &Connection,
    owner_pubkey: &str,
) -> Result<Vec<RetainedManagedAgentAggregate>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT a.owner_pubkey, a.agent_pubkey, a.generation,
                    a.private_event_id, a.state, a.request_json,
                    a.pending_sync, a.last_error, a.local_authority_applied
               FROM managed_agent_aggregates a
              WHERE a.owner_pubkey = ?1 AND a.pending_sync = 1
                AND a.generation = (
                    SELECT MAX(latest.generation)
                      FROM managed_agent_aggregates latest
                     WHERE latest.owner_pubkey = a.owner_pubkey
                       AND latest.agent_pubkey = a.agent_pubkey
                )
              ORDER BY a.agent_pubkey",
        )
        .map_err(|e| format!("failed to prepare pending managed-agent aggregates: {e}"))?;
    let rows = stmt
        .query_map(params![owner_pubkey], aggregate_from_row)
        .map_err(|e| format!("failed to query pending managed-agent aggregates: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to read pending managed-agent aggregate: {e}"))
}

fn aggregate_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RetainedManagedAgentAggregate> {
    let generation = row.get::<_, i64>(2)?;
    let generation = u64::try_from(generation).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })?;
    Ok(RetainedManagedAgentAggregate {
        owner_pubkey: row.get(0)?,
        agent_pubkey: row.get(1)?,
        generation,
        private_event_id: row.get(3)?,
        state: row.get(4)?,
        request_json: row.get(5)?,
        pending_sync: row.get::<_, i32>(6)? != 0,
        last_error: row.get(7)?,
        local_authority_applied: row.get::<_, i32>(8)? != 0,
    })
}

/// Mark one exact retained aggregate request as confirmed by relay read-back.
#[allow(dead_code)] // Consumed by the PMA aggregate submit/retry driver in the next slice.
pub fn mark_managed_agent_aggregate_synced(
    conn: &Connection,
    owner_pubkey: &str,
    agent_pubkey: &str,
    generation: u64,
    private_event_id: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE managed_agent_aggregates
                SET pending_sync = 0, last_error = NULL
              WHERE owner_pubkey = ?1 AND agent_pubkey = ?2
                AND generation = ?3 AND private_event_id = ?4",
            params![
                owner_pubkey,
                agent_pubkey,
                generation as i64,
                private_event_id
            ],
        )
        .map_err(|e| format!("failed to mark managed-agent aggregate synced: {e}"))?;
    Ok(changed == 1)
}

/// Persist a diagnostic for one exact retained attempt without clearing retry.
#[allow(dead_code)] // Consumed by the PMA aggregate submit/retry driver in the next slice.
pub fn record_managed_agent_aggregate_error(
    conn: &Connection,
    owner_pubkey: &str,
    agent_pubkey: &str,
    generation: u64,
    private_event_id: &str,
    error: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE managed_agent_aggregates
                SET last_error = ?5, pending_sync = 1
              WHERE owner_pubkey = ?1 AND agent_pubkey = ?2
                AND generation = ?3 AND private_event_id = ?4",
            params![
                owner_pubkey,
                agent_pubkey,
                generation as i64,
                private_event_id,
                error
            ],
        )
        .map_err(|e| format!("failed to record managed-agent aggregate error: {e}"))?;
    Ok(changed == 1)
}

/// Durably record that a verified deletion has applied the local record/key
/// erase for one exact retained tombstone generation.
///
/// Written on the `state = "deleted"` row immediately AFTER the local erase and
/// BEFORE [`mark_managed_agent_aggregate_synced`] clears the retry. Together
/// they order the crash-safe deletion seam: erase → mark-applied → clear. On
/// replay, a set marker (never mere record absence) proves the exact deletion
/// reached local authority, so the retry may be cleared without re-erasing an
/// unrelated agent. Returns `true` iff the exact `(owner, agent, generation,
/// event)` deleted row was updated.
#[allow(dead_code)] // Consumed by the deletion flush lane.
pub fn mark_managed_agent_deletion_local_authority_applied(
    conn: &Connection,
    owner_pubkey: &str,
    agent_pubkey: &str,
    generation: u64,
    private_event_id: &str,
) -> Result<bool, String> {
    let changed = conn
        .execute(
            "UPDATE managed_agent_aggregates
                SET local_authority_applied = 1
              WHERE owner_pubkey = ?1 AND agent_pubkey = ?2
                AND generation = ?3 AND private_event_id = ?4
                AND state = 'deleted'",
            params![
                owner_pubkey,
                agent_pubkey,
                generation as i64,
                private_event_id
            ],
        )
        .map_err(|e| format!("failed to mark managed-agent deletion authority applied: {e}"))?;
    Ok(changed == 1)
}
