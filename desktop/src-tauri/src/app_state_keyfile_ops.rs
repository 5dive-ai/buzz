//! File-system and OS-keyring helpers extracted from `app_state` to keep that
//! module under the file-size ratchet. Included as a child module of
//! `app_state` so every item here has unrestricted access to the parent's
//! private items (constants, trait, types) via `super::`.

use std::io::Write;

use nostr::ToBech32;

use super::{
    keyring_config, keyring_service, IdentityKeyStore, IdentityStorage, Keys, IDENTITY_KEY_NAME,
    MIGRATION_MARKER_NAME,
};

/// Path of the migration-completed marker within `data_dir`.
pub(super) fn migration_marker_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join(keyring_config::migration_marker_name(
        keyring_service(),
        MIGRATION_MARKER_NAME,
    ))
}

/// Atomically write (and fsync) the migration-completed marker. The content is
/// irrelevant — only the file's durable existence is the signal — so a single
/// byte keeps it minimal. Atomicity + fsync guarantee that once this returns
/// `Ok`, the marker survives a crash, which is what makes deleting the legacy
/// file afterward safe.
pub(super) fn write_migration_marker(marker_path: &std::path::Path) -> Result<(), String> {
    use atomic_write_file::AtomicWriteFile;

    let mut file = AtomicWriteFile::open(marker_path)
        .map_err(|e| format!("open migration marker for atomic write: {e}"))?;
    file.write_all(b"1")
        .map_err(|e| format!("write migration marker: {e}"))?;
    file.commit()
        .map_err(|e| format!("commit migration marker: {e}"))
}

/// Generate a fresh identity, persist it through the store, return it.
///
/// On a keyring-backed persist no file is written, so a later
/// keyring-Unreachable boot would see "no file, no marker" (identical to a
/// fresh install) and silently rotate the identity. Writing the marker here
/// makes that boot fail closed. If the marker write fails, fall back to the
/// `0o600` file so the key is never keyring-only-without-marker.
pub(super) fn generate_and_persist(
    store: &impl IdentityKeyStore,
    legacy_path: &std::path::Path,
    data_dir: &std::path::Path,
) -> Result<(Keys, IdentityStorage), String> {
    let keys = Keys::generate();
    let storage = store_key_preferring_keyring(store, &keys, legacy_path)?;
    if storage == IdentityStorage::SystemKeyring {
        let marker_path = migration_marker_path(data_dir);
        if let Err(e) = write_migration_marker(&marker_path) {
            eprintln!(
                "buzz-desktop: stored identity in keyring but failed to write migration marker \
                 ({e}); saving identity.key fallback so the key is not stranded"
            );
            save_key_file(legacy_path, &keys)?;
        }
    }
    eprintln!(
        "buzz-desktop: generated and saved identity pubkey {}",
        keys.public_key().to_hex()
    );
    Ok((keys, storage))
}

/// Persist `keys` through the store, silently falling back to the `0o600` file
/// when the keyring write fails on an availability error. Reports which backend
/// held the key (no verify/marker/delete — those belong to callers that own the
/// full migration contract) so the caller can write the migration marker only on
/// keyring success.
pub(super) fn store_key_preferring_keyring(
    store: &impl IdentityKeyStore,
    keys: &Keys,
    legacy_path: &std::path::Path,
) -> Result<IdentityStorage, String> {
    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|e| format!("encode nsec: {e}"))?;
    match store.store(IDENTITY_KEY_NAME, &nsec) {
        Ok(()) => Ok(IdentityStorage::SystemKeyring),
        Err(keyring_err) => {
            eprintln!("buzz-desktop: keyring write failed ({keyring_err}), using file fallback");
            save_key_file(legacy_path, keys)?;
            Ok(IdentityStorage::LocalFile)
        }
    }
}

/// Ensure the migration marker exists (writing it if absent), then remove the
/// leftover `identity.key`. Crash-safe ordering: the marker is written and
/// fsync-committed before the file is deleted, so a crash between the two
/// leaves the marker on disk and the file intact — the invariant "keyring-only
/// implies marker exists" is preserved. If the marker write fails, the file is
/// kept so a later keyring-unreachable boot can use it as a fallback.
pub(super) fn ensure_marker_then_cleanup(
    data_dir: &std::path::Path,
    legacy_path: &std::path::Path,
) {
    let marker_path = migration_marker_path(data_dir);
    let marker_ok = marker_path.exists()
        || write_migration_marker(&marker_path)
            .map_err(|e| {
                eprintln!(
                    "buzz-desktop: keyring present but marker missing; \
                     failed to write marker ({e}), keeping identity.key"
                );
            })
            .is_ok();
    if marker_ok {
        cleanup_leftover_identity_file(legacy_path);
    }
}

/// Best-effort removal of a leftover `identity.key` once the keyring is the
/// authoritative store. Idempotent: a missing file is success. Logs but does
/// not error on failure — a delete failure must never block startup.
pub(super) fn cleanup_leftover_identity_file(legacy_path: &std::path::Path) {
    if !legacy_path.exists() {
        return;
    }
    match std::fs::remove_file(legacy_path) {
        Ok(()) => eprintln!("buzz-desktop: removed leftover identity.key (key is in keyring)"),
        Err(e) => eprintln!("buzz-desktop: failed to remove leftover identity.key: {e}"),
    }
}

/// Quarantine a corrupt `identity.key` with a timestamp so prior backups are
/// never overwritten.
pub(super) fn quarantine_corrupt_key(
    key_path: &std::path::Path,
    data_dir: &std::path::Path,
    error: &str,
) {
    if !key_path.exists() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let bad_name = format!("identity.key.bad.{ts}");
    eprintln!("buzz-desktop: corrupt identity.key ({error}), quarantining to {bad_name}");
    let bad_path = data_dir.join(bad_name);
    if std::fs::rename(key_path, &bad_path).is_err() {
        let _ = std::fs::remove_file(key_path);
    }
}

pub(super) fn load_key_file(path: &std::path::Path) -> Result<Keys, String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("read identity.key: {e}"))?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("empty identity.key".to_string());
    }
    Keys::parse(trimmed).map_err(|e| format!("parse identity.key: {e}"))
}

/// Atomically write the key to disk. Uses `atomic-write-file` which:
/// 1. Writes to a temp file in the same directory
/// 2. Calls fsync on the file
/// 3. Renames temp → target (atomic on POSIX, best-effort on Windows)
/// 4. Calls fsync on the parent directory
///
/// On Unix, the file is created with mode 0600 (owner read/write only).
/// On Windows, default ACLs apply — the app data directory is already
/// per-user, so the key is not world-readable in practice.
pub(crate) fn save_key_file(path: &std::path::Path, keys: &Keys) -> Result<(), String> {
    use atomic_write_file::AtomicWriteFile;

    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|e| format!("encode nsec: {e}"))?;

    let mut file = AtomicWriteFile::open(path)
        .map_err(|e| format!("open identity.key for atomic write: {e}"))?;

    // Set owner-only permissions before writing the secret.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("set identity.key permissions: {e}"))?;
    }

    file.write_all(nsec.as_bytes())
        .map_err(|e| format!("write identity.key: {e}"))?;
    file.commit()
        .map_err(|e| format!("commit identity.key: {e}"))
}
