//! Workspace-epoch seqlock: types exported by [`crate::app_state`].
//!
//! [`ArchiveScope`] is an immutable snapshot of the workspace state captured
//! atomically via the seqlock protocol implemented in
//! [`AppState::capture_archive_scope`]. [`WorkspaceEpochWriteGuard`] is the
//! RAII writer guard obtained via [`AppState::begin_workspace_write`].

use std::sync::atomic::{AtomicU64, Ordering};

/// A scoped snapshot of the active workspace state captured atomically via
/// the seqlock protocol. All I/O in a scoped archive operation consumes only
/// this scope — no guard is held across any await.
#[derive(Clone)]
pub struct ArchiveScope {
    pub keys: nostr::Keys,
    /// Owner pubkey (hex) derived from `keys` at capture time.
    pub actor: String,
    /// Workspace relay URL override at capture time. `None` means "use the
    /// env-var / build-time default" (same semantics as `relay_url_override`).
    pub relay_url_override: Option<String>,
    /// Epoch value at capture time (even). Callers may use this for optional
    /// UX-only final checks; it is NOT the safety invariant (the immutable
    /// scope itself is).
    // Only read in tests; intentionally kept for caller-side UX assertions.
    #[allow(dead_code)]
    pub workspace_epoch: u64,
}

/// Deliberately hide the secret key from debug output to prevent accidental
/// key exposure in logs, panics, or test output.
impl std::fmt::Debug for ArchiveScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArchiveScope")
            .field("actor", &self.actor)
            .field("relay_url_override", &self.relay_url_override)
            .field("workspace_epoch", &self.workspace_epoch)
            .field("keys", &"<redacted>")
            .finish()
    }
}

/// RAII guard that serializes all production workspace-state writers and
/// restores the epoch to the next even value on every exit path.
///
/// Obtained via [`crate::app_state::AppState::begin_workspace_write`]. The
/// internal mutex (`workspace_write`) is locked for the lifetime of this guard,
/// preventing any concurrent writer from interleaving their epoch increments
/// and thereby corrupting the seqlock parity invariant.
pub struct WorkspaceEpochWriteGuard<'a> {
    pub(crate) epoch: &'a AtomicU64,
    pub(crate) _guard: std::sync::MutexGuard<'a, ()>,
}

impl Drop for WorkspaceEpochWriteGuard<'_> {
    fn drop(&mut self) {
        // Restore even → writer is done. SeqCst ensures all prior writes are
        // visible before readers observe the even epoch.
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }
}
