//! Pre-admission recovery gate: resolve anchor, run file-commit recovery, then
//! invoke boot migrations — all before any canonical-store reader or writer.
//!
//! Called once per process from `lib.rs` setup, immediately after reset
//! handling succeeds.  A recovery failure (or unresolved interrupted commits)
//! propagates as `Err`; the caller sets `store_recovery_failed` and returns
//! early, keeping every journaled mutation path closed via `mutate_store`'s
//! entry guard.

use tauri::AppHandle;

use super::{run_recovery_gate, store_anchor_dir};

/// Run the pre-admission recovery gate for this process boot.
///
/// 1. Resolves the store-family anchor directory — fails closed on error
///    (no `unwrap_or_default` fallback; a guessed path would inspect the wrong
///    journal and certify a store it never repaired).
/// 2. Creates the anchor directory if absent.
/// 3. Runs `run_recovery_gate`: file-commit recovery completes with zero
///    unresolved commits, then `store_work` executes.
/// 4. `store_work` runs the appropriate boot-migration sequence based on
///    `reset_completed`.
///
/// Returns `Err` on any anchor, recovery, or migration failure.  The caller
/// (`lib.rs`) sets `store_recovery_failed` and early-returns.
pub fn run_boot_recovery_gate(app: &AppHandle, reset_completed: bool) -> Result<(), String> {
    let anchor = store_anchor_dir(app).map_err(|e| format!("resolve store anchor: {e}"))?;

    std::fs::create_dir_all(&anchor).map_err(|e| format!("create anchor dir: {e}"))?;

    run_recovery_gate(&anchor, || {
        if reset_completed {
            crate::migration::run_boot_migrations_after_reset(app);
        } else {
            crate::migration::run_boot_migrations(app);
        }
        Ok(())
    })
}
