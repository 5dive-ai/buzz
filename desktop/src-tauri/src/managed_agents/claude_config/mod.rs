//! Claude Code agent-config isolation and settings projection.
//!
//! This module implements the B1/B2/B3/B7 contracts from the claude-config-gaps
//! plan of record:
//!
//! * **B1** — paired `CLAUDE_CONFIG_DIR` + `CLAUDE_SECURESTORAGE_CONFIG_DIR=""`
//!   atoms injected at spawn so every managed Claude agent has an isolated config
//!   root while sharing the owner's default Keychain credential namespace.
//! * **B2** — typed `ClaudeLaunchPolicy` value generated at spawn time, never
//!   persisted; it is the single startup-authority source for both the isolation
//!   pair and the seeded `effortLevel`.
//! * **B3** — resource-lifecycle helper that removes the per-agent config root on
//!   agent deletion; cleanup failure must NOT block deletion.
//! * **B7** — layered settings projection: owner `~/.claude/settings.json` as a
//!   read-only base, Buzz canonical overlay on top, with a protected-key filter
//!   applied to the base's `env` object.  Written atomically at spawn; spawn fails
//!   if the write fails.

use std::path::{Path, PathBuf};

use serde_json::Value;

// ── Protected-key ownership predicate ────────────────────────────────────────
//
// This is the SINGLE predicate consumed by BOTH:
//   - `project_owner_settings_json` (projection — strips protected keys from
//     the owner base's `env` object before merging)
//   - `spawn_agent_child` (launch assembly — injects Buzz-owned values last)
//
// Thufir invariant (verbatim from CLEAR verdict):
//   Every env key the launch policy generates, removes, reserves, or treats as
//   an atomic-policy member is protected from owner-settings projection;
//   projection and final launch assembly call the SAME case-insensitive
//   predicate. One predicate/type — not two lists.

/// Returns `true` when `key` is owned by Buzz's Claude launch policy and must
/// NOT be inherited from the owner's personal `settings.json` `env` block.
///
/// Case-insensitive — matches `ANTHROPIC_MODEL`, `anthropic_model`, etc.
///
/// **Enumeration is frozen. To add a new protected class, add it here AND write
/// a test in `tests.rs` (one test per class + the invariant test) so the suite
/// fails if a new launch-policy key is introduced without protection.**
pub fn is_launch_policy_protected_key(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    let k = k.as_str();

    // ── Buzz policy namespace ──────────────────────────────────────────────
    // All BUZZ_* keys are Buzz-owned.  Covers BUZZ_PRIVATE_KEY,
    // BUZZ_RELAY_URL, BUZZ_ACP_*, BUZZ_MANAGED_AGENT*, and any future keys.
    if k.starts_with("BUZZ_") {
        return true;
    }

    // ── Identity / secrets (RESERVED_ENV_KEYS parity) ─────────────────────
    // These overlap with BUZZ_* above for most reserved keys, but NOSTR_*
    // does not carry the BUZZ_ prefix.
    if k.starts_with("NOSTR_") {
        return true;
    }

    // ── Model authority ────────────────────────────────────────────────────
    // These are the highest-priority model source in the claude-agent-acp
    // adapter (acp-agent.ts) and can lock the session model against live
    // switches (claude-code >= 2.1.216, anthropics/claude-code#79805).
    matches!(k, "ANTHROPIC_MODEL" | "ANTHROPIC_SMALL_FAST_MODEL")
        // ── Config and credential roots (B1 paired atom) ──────────────────
        // CLAUDE_CONFIG_DIR = per-agent isolated root.
        // CLAUDE_SECURESTORAGE_CONFIG_DIR = "" (owner default Keychain namespace).
        || matches!(k, "CLAUDE_CONFIG_DIR" | "CLAUDE_SECURESTORAGE_CONFIG_DIR")
        // ── Isolation flags ───────────────────────────────────────────────
        || matches!(
            k,
            "CLAUDE_CODE_DISABLE_CLAUDE_MDS"
                | "CLAUDE_CODE_DISABLE_AUTO_MEMORY"
                | "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
                | "CLAUDE_CODE_SKIP_PERMISSIONS_CHECK"
        )
        // ── Provider / endpoint / auth routing ────────────────────────────
        || matches!(
            k,
            "ANTHROPIC_BASE_URL"
                | "ANTHROPIC_AUTH_TOKEN"
                | "ANTHROPIC_API_KEY"
                | "AWS_BEARER_TOKEN_BEDROCK"
                | "ANTHROPIC_VERTEX_PROJECT_ID"
                | "CLOUD_ML_REGION"
                | "ANTHROPIC_VERTEX_REGION"
                | "ANTHROPIC_VERTEX_KEY_PATH"
        )
}

// ── ClaudeLaunchPolicy ───────────────────────────────────────────────────────

/// Pure value type generated at spawn time.  **Never persisted.**
///
/// Encodes the full B2 startup authority for a Claude Code managed agent:
/// * Config root isolation (`CLAUDE_CONFIG_DIR`).
/// * Credential-namespace sharing (`CLAUDE_SECURESTORAGE_CONFIG_DIR=""`).
/// * Canonical effort level seeded into `settings.json` at spawn.
///
/// Remote agents do not receive this policy — they get `ANTHROPIC_MODEL` in
/// `policy_env` via a separate path.
#[derive(Debug, Clone)]
pub struct ClaudeLaunchPolicy {
    /// `CLAUDE_CONFIG_DIR`: `<managed_agents_base_dir>/claude/<hex_pubkey>`.
    pub config_dir: PathBuf,
    /// `CLAUDE_SECURESTORAGE_CONFIG_DIR`: **always `""`**.
    ///
    /// Empty string activates the owner's unhashed default Keychain namespace
    /// (confirmed by Phase 1.5 binary analysis of claude 2.1.220).
    pub secure_storage_config_dir: String,
    /// Value written to `effortLevel` in the projected `settings.json`.
    pub effort_level: Option<String>,
}

impl ClaudeLaunchPolicy {
    /// Build a `ClaudeLaunchPolicy` for the agent identified by `pubkey`.
    ///
    /// Validates `pubkey` as non-empty, hex-only (`[0-9a-fA-F]`), and at most
    /// 64 bytes — rejecting any value that could be used to escape the
    /// `claude/` directory via path traversal.
    ///
    /// `managed_root` is the result of `managed_agents_base_dir(app)`.
    pub fn build(
        pubkey: &str,
        managed_root: &Path,
        effort_level: Option<String>,
    ) -> Result<Self, String> {
        validate_pubkey_for_path(pubkey)?;
        Ok(Self {
            config_dir: claude_config_dir(managed_root, pubkey),
            secure_storage_config_dir: String::new(), // invariant: always ""
            effort_level,
        })
    }
}

/// Validate that `pubkey` is safe to use as a path component under `claude/`.
///
/// Rejects: empty, non-hex chars, length > 64.
fn validate_pubkey_for_path(pubkey: &str) -> Result<(), String> {
    if pubkey.is_empty() {
        return Err("agent pubkey is empty; cannot build Claude config path".to_string());
    }
    if pubkey.len() > 64 {
        return Err(format!(
            "agent pubkey is too long ({} bytes); max 64",
            pubkey.len()
        ));
    }
    if !pubkey.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "agent pubkey contains non-hex characters; cannot build Claude config path: {pubkey}"
        ));
    }
    Ok(())
}

/// Compute the per-agent Claude config directory path.
///
/// `managed_root/claude/<pubkey>` — validated before use by
/// [`validate_pubkey_for_path`] so `pubkey` is guaranteed to be a safe
/// single-component filename.
fn claude_config_dir(managed_root: &Path, pubkey: &str) -> PathBuf {
    managed_root.join("claude").join(pubkey)
}

// ── settings.json projection (B7) ────────────────────────────────────────────

/// Result of reading the owner's base settings file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerBaseStatus {
    /// File read and parsed successfully.
    Ok,
    /// File did not exist — projection uses overlay only (not an error).
    Missing,
    /// File existed but could not be read or was not valid JSON.
    Unreadable { reason: String },
}

/// Project the per-agent `settings.json` from two inputs:
/// * **base**: owner's `~/.claude/settings.json` (read-only; never written).
/// * **overlay**: Buzz canonical fields (`effortLevel` etc.).
///
/// Returns the projected JSON bytes and the base-read status for panel
/// provenance.  The projected object never contains a protected env key
/// (see [`is_launch_policy_protected_key`]).
///
/// Merge rules (B7):
/// 1. Start with a clone of the owner base (all keys pass through verbatim).
/// 2. For the `env` sub-object: strip protected keys case-insensitively.
/// 3. Apply Buzz canonical overlay fields on top — `effortLevel` is owned by
///    the overlay, so strip it from the base first, then apply canonical.
/// 4. If the base is missing/unreadable → start with an empty object;
///    status = `Missing` / `Unreadable`.
pub fn project_settings_json(
    owner_settings_path: &Path,
    policy: &ClaudeLaunchPolicy,
) -> (serde_json::Map<String, Value>, OwnerBaseStatus) {
    let (mut base, status) = read_owner_base(owner_settings_path);

    // Strip canonical overlay keys from the base so the overlay owns them.
    // The only canonical key today is `effortLevel`.
    base.remove("effortLevel");

    // Strip protected env keys from the base's `env` sub-object.
    if let Some(Value::Object(env_obj)) = base.get_mut("env") {
        let protected: Vec<String> = env_obj
            .keys()
            .filter(|k| is_launch_policy_protected_key(k))
            .cloned()
            .collect();
        for k in protected {
            env_obj.remove(&k);
        }
        // Remove `env` entirely if it became empty — no noise for the common case.
        if env_obj.is_empty() {
            base.remove("env");
        }
    }

    // Apply canonical overlay.
    if let Some(effort) = &policy.effort_level {
        if !effort.is_empty() {
            base.insert("effortLevel".to_string(), Value::String(effort.clone()));
        }
    }

    (base, status)
}

/// Stripped keys that came from the owner's `env` block.
///
/// Used for provenance reporting in the config panel ("owner setting overridden
/// by Buzz policy").
#[allow(dead_code)] // consumed by the B4/B5 panel provenance endpoint (Desktop TS, forthcoming)
pub fn collect_stripped_env_keys(owner_settings_path: &Path) -> Vec<String> {
    let (base, status) = read_owner_base(owner_settings_path);
    if matches!(
        status,
        OwnerBaseStatus::Missing | OwnerBaseStatus::Unreadable { .. }
    ) {
        return Vec::new();
    }
    if let Some(Value::Object(env_obj)) = base.get("env") {
        env_obj
            .keys()
            .filter(|k| is_launch_policy_protected_key(k))
            .cloned()
            .collect()
    } else {
        Vec::new()
    }
}

fn read_owner_base(
    owner_settings_path: &Path,
) -> (serde_json::Map<String, Value>, OwnerBaseStatus) {
    if !owner_settings_path.exists() {
        return (serde_json::Map::new(), OwnerBaseStatus::Missing);
    }
    match std::fs::read_to_string(owner_settings_path) {
        Err(e) => (
            serde_json::Map::new(),
            OwnerBaseStatus::Unreadable {
                reason: e.to_string(),
            },
        ),
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(map)) => (map, OwnerBaseStatus::Ok),
            Ok(_) => (
                serde_json::Map::new(),
                OwnerBaseStatus::Unreadable {
                    reason: "settings.json root is not a JSON object".to_string(),
                },
            ),
            Err(e) => (
                serde_json::Map::new(),
                OwnerBaseStatus::Unreadable {
                    reason: e.to_string(),
                },
            ),
        },
    }
}

// ── Atomic write of projected settings.json ─────────────────────────────────

/// Write the projected `settings.json` atomically into the per-agent config dir.
///
/// Creates `<policy.config_dir>` (and `<managed_root>/claude/`) if absent.
/// Writes to a `.tmp` sibling and renames — an in-progress write cannot
/// be observed as a partial file.
///
/// Returns `Err` if the write fails; **spawn must fail in that case** (B7.5).
pub fn write_projected_settings(
    policy: &ClaudeLaunchPolicy,
    projected: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    let config_dir = &policy.config_dir;
    std::fs::create_dir_all(config_dir).map_err(|e| {
        format!(
            "failed to create Claude agent config dir {}: {e}",
            config_dir.display()
        )
    })?;

    let settings_path = config_dir.join("settings.json");
    let tmp_path = config_dir.join("settings.json.tmp");

    let json = serde_json::to_vec_pretty(&Value::Object(projected.clone()))
        .map_err(|e| format!("failed to serialize projected settings.json: {e}"))?;

    std::fs::write(&tmp_path, &json).map_err(|e| {
        format!(
            "failed to write projected settings.json (tmp) at {}: {e}",
            tmp_path.display()
        )
    })?;

    std::fs::rename(&tmp_path, &settings_path).map_err(|e| {
        // Best-effort cleanup of the temp file; ignore errors.
        let _ = std::fs::remove_file(&tmp_path);
        format!(
            "failed to finalize projected settings.json at {}: {e}",
            settings_path.display()
        )
    })?;

    Ok(())
}

// ── Resource-lifecycle helper (B3) ───────────────────────────────────────────

/// Remove the per-agent Claude config root.
///
/// Path: `managed_root/claude/<pubkey>`.  The path is validated before any
/// filesystem operation:
/// * `pubkey` must pass [`validate_pubkey_for_path`] (hex-only, no traversal).
/// * The resolved path must be strictly under `managed_root/claude/`.
/// * Symlinks are NOT followed — only a real directory is removed.
///
/// Returns `Ok(())` whether the directory existed or not (idempotent).
/// Returns `Err` only for validation failures (bad pubkey / traversal attempt).
/// Filesystem errors (permission denied, I/O error) are logged and swallowed
/// so that **cleanup failure MUST NOT block agent deletion** (B3).
pub fn cleanup_claude_config_root(pubkey: &str, managed_root: &Path) -> Result<(), String> {
    validate_pubkey_for_path(pubkey)?;

    let claude_dir = managed_root.join("claude");
    let target = claude_dir.join(pubkey);

    // Guard: the target must be strictly under `managed_root/claude/`.
    // `validate_pubkey_for_path` already ensures `pubkey` is hex-only (no `/`
    // or `..`), so this is belt-and-suspenders in case of OS-specific
    // edge cases or future callers that bypass the validator.
    // We use `starts_with` on the lexical path because we never want to
    // follow symlinks to check the canonical path — a symlink attack should
    // simply fail here.
    if !target.starts_with(&claude_dir) {
        return Err(format!(
            "agent pubkey produces a path that escapes the claude config directory: {}",
            target.display()
        ));
    }

    if !target.exists() && !target.is_symlink() {
        // Nothing to remove — idempotent success.
        return Ok(());
    }

    // Remove directory and all contents.
    if let Err(e) = std::fs::remove_dir_all(&target) {
        // Log and swallow — B3: cleanup failure must not block deletion.
        eprintln!(
            "buzz-desktop: failed to remove Claude agent config root {}: {e} (non-fatal, cleanup skipped)",
            target.display()
        );
    }

    Ok(())
}

/// Default owner `settings.json` path: `~/.claude/settings.json`.
///
/// Exposed so callers use the same path as `config_bridge::claude::read_config_file`.
pub fn owner_settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("settings.json"))
}

#[cfg(test)]
mod tests;
