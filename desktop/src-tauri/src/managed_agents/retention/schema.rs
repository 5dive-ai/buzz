//! Additive schema migration for the retention store.
//!
//! Three columns were added after the original seven-column
//! `persona_events` table shipped, and one new table (`persona_baselines`)
//! was added later:
//!
//! - `event_id` — the NIP-01 id of the row's own `raw_event`. Ordering has to
//!   match the relay's NIP-33 comparator, which breaks an equal `created_at`
//!   by lowest event id; without a real column every compare would have to
//!   reparse `raw_event`.
//! - `publish_blocked` — the publication gate. A pending row is normally
//!   published by the flush loop; a row the boot pass suppressed must stay
//!   retained but unpublished, and there is no other state that expresses
//!   "durable, but must not go out."
//! - `persona_baselines` — coordinate-keyed baseline provenance table. Stores
//!   the full canonical projection (event_id, content, shared) for what this
//!   install last agreed was published at each coordinate. Lives in its own
//!   table so that deleting the live row never destroys its provenance: an
//!   offline delete that misses the relay can still present a baseline on the
//!   next boot and reach gate C's timestamp arbitration rather than parking
//!   forever.
//!
//! The earlier `baseline_event_id` / `baseline_content` columns on
//! `persona_events` are superseded by `persona_baselines`. Existing data is
//! migrated upward; the old columns are left in place for schema hygiene (SQLite
//! does not support `DROP COLUMN` on older versions) but are never read after
//! migration.
//!
//! # Crash and concurrency safety
//!
//! A cheap read-only probe decides whether anything is missing, and only then
//! does the migration open a `BEGIN EXCLUSIVE` transaction, re-probe inside
//! it, and apply the changes together with the `event_id` backfill.
//! Serializing on the write lock is what makes two processes opening the same
//! database at once safe: the loser waits, re-probes, and finds nothing to do.
//! A crash mid-migration rolls back the whole transaction, so no column or
//! table can exist with its backfill half-applied.

use rusqlite::{Connection, TransactionBehavior};

/// Columns added after the initial `persona_events` shape.
///
/// `baseline_event_id` and `baseline_content` are retained for schema
/// hygiene (SQLite ≤ 3.35 does not support `DROP COLUMN`) but are superseded
/// by the `persona_baselines` table and are never read after migration.
const ADDED_COLUMNS: [(&str, &str); 4] = [
    ("event_id", "TEXT"),
    ("baseline_event_id", "TEXT"),
    ("baseline_content", "TEXT"),
    ("publish_blocked", "INTEGER NOT NULL DEFAULT 0"),
];

/// Whether the `persona_baselines` table needs to be created.
fn baselines_table_missing(conn: &Connection) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='persona_baselines'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("failed to probe persona_baselines table: {e}"))?;
    Ok(count == 0)
}

/// Bring `persona_events` up to the current column set and ensure
/// `persona_baselines` exists.
///
/// A no-op on a database created by the current `CREATE TABLE` (and on any
/// database already migrated), so it stays on the cheap path for every open
/// after the first.
pub(super) fn migrate(conn: &mut Connection) -> Result<(), String> {
    let missing_cols = missing_columns(conn)?;
    let missing_table = baselines_table_missing(conn)?;
    if missing_cols.is_empty() && !missing_table {
        return Ok(());
    }

    let transaction = conn
        .transaction_with_behavior(TransactionBehavior::Exclusive)
        .map_err(|e| format!("failed to open retention schema transaction: {e}"))?;

    // Re-probe under the write lock: a concurrent opener may have migrated the
    // database while this one waited for the lock.
    for (column, column_type) in missing_columns(&transaction)? {
        transaction
            .execute_batch(&format!(
                "ALTER TABLE persona_events ADD COLUMN {column} {column_type}"
            ))
            .map_err(|e| format!("failed to add retention column {column}: {e}"))?;
    }
    backfill_event_ids(&transaction)?;

    if baselines_table_missing(&transaction)? {
        transaction
            .execute_batch(
                "CREATE TABLE persona_baselines (
                    kind INTEGER NOT NULL,
                    pubkey TEXT NOT NULL,
                    d_tag TEXT NOT NULL,
                    baseline_event_id TEXT NOT NULL,
                    baseline_content TEXT NOT NULL,
                    baseline_shared INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (kind, pubkey, d_tag)
                );",
            )
            .map_err(|e| format!("failed to create persona_baselines table: {e}"))?;
        // Migrate existing baseline data from the old columns into the new table.
        // `shared` was never stored in the old columns, so it defaults to 0.
        transaction
            .execute_batch(
                "INSERT OR IGNORE INTO persona_baselines
                    (kind, pubkey, d_tag, baseline_event_id, baseline_content, baseline_shared)
                 SELECT kind, pubkey, d_tag, baseline_event_id, baseline_content, 0
                 FROM persona_events
                 WHERE baseline_event_id IS NOT NULL AND baseline_content IS NOT NULL;",
            )
            .map_err(|e| format!("failed to migrate baseline data: {e}"))?;
    }

    transaction
        .commit()
        .map_err(|e| format!("failed to commit retention schema migration: {e}"))
}

/// Which of [`ADDED_COLUMNS`] the table does not have yet, in declaration
/// order.
fn missing_columns(conn: &Connection) -> Result<Vec<(&'static str, &'static str)>, String> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info('persona_events')")
        .map_err(|e| format!("failed to probe retention columns: {e}"))?;
    let existing = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("failed to read retention columns: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to read retention column row: {e}"))?;

    Ok(ADDED_COLUMNS
        .into_iter()
        .filter(|(column, _)| !existing.iter().any(|name| name == column))
        .collect())
}

/// Recover `event_id` for rows written before the column existed.
///
/// The id comes from re-deriving it out of the stored event
/// ([`super::event_id_from_raw`]), never from the JSON's own `id` field: a row
/// whose stored bytes do not hash and verify to the id they claim has no
/// trustworthy ordering key, and inventing one would let it win a comparator
/// tie it should lose. Such a row keeps `event_id IS NULL` and the comparator
/// treats it as unresolved instead.
fn backfill_event_ids(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT rowid, raw_event FROM persona_events WHERE event_id IS NULL")
        .map_err(|e| format!("failed to prepare retention backfill query: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("failed to read retention backfill rows: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to read retention backfill row: {e}"))?;

    for (rowid, raw_event) in rows {
        let Some(event_id) = super::event_id_from_raw(&raw_event) else {
            continue; // unverifiable: no ordering key rather than a fabricated one
        };
        conn.execute(
            "UPDATE persona_events SET event_id = ?1 WHERE rowid = ?2",
            rusqlite::params![event_id, rowid],
        )
        .map_err(|e| format!("failed to backfill retention event id: {e}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests;
