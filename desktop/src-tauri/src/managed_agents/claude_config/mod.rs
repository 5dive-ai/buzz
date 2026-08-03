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

/// Default owner MCP config path: `~/.claude.json`.
///
/// Claude Code stores MCP server definitions here. Exposed so callers use the
/// same path as `config_bridge::claude::read_config_file` and `config_bridge::reader`
/// rather than each hard-coding `~/.claude.json` independently.
pub fn owner_mcp_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude.json"))
}

/// Per-agent MCP config path: `<managed_root>/claude/<pubkey>/.claude.json`.
///
/// Returns the path where B8 writes the merged MCP config for an isolated agent.
/// Used by the config panel to display the file the spawned process actually reads.
pub fn agent_mcp_config_path(managed_root: &Path, pubkey: &str) -> PathBuf {
    managed_root
        .join("claude")
        .join(pubkey)
        .join(".claude.json")
}

// ── B8: Owner MCP server inheritance ─────────────────────────────────────────
//
// At each local claude spawn, after the B7 settings.json projection:
//  1. Read the owner's ~/.claude.json for top-level `mcpServers` (user scope).
//  2. Filter out any entry whose name collides with the ACP-provided server
//     name (case-insensitive) — Buzz wins by construction, no SDK reliance.
//  3. Read the agent-root .claude.json (missing / invalid → {}), overwrite its
//     `mcpServers` key with the filtered set, write back atomically.
//
// Fault semantics (deliberately asymmetric to B7.5 spawn-fail):
//  - Owner unreadable / invalid → preserve agent file's existing mcpServers,
//    warn. A transient owner failure must NOT destroy inherited servers.
//  - Agent file invalid → treat as {}, replace with owner servers, warn.
//  - Agent file write failure → warn, spawn CONTINUES. B8 is inheritance, not
//    policy integrity — its failure mode == pre-B8 status quo.

/// Merge the owner's user-scope MCP servers into the agent-root `.claude.json`.
///
/// `agent_config_dir` is the per-agent config root (B1 `CLAUDE_CONFIG_DIR`).
/// `owner_mcp_path` is `~/.claude.json`.
/// `acp_server_name` is the file stem of the ACP MCP binary (e.g. `"buzz-mcp"`);
/// any inherited server with this name (case-insensitive) is omitted and warned
/// so Buzz's channel cannot be shadowed.
///
/// All errors are logged and swallowed; spawn always continues.
pub fn merge_agent_mcp_servers(
    agent_config_dir: &Path,
    owner_mcp_path: &Path,
    acp_server_name: &str,
) {
    // 1. Read owner user-scope mcpServers.
    let owner_mcp_servers = match read_owner_mcp_servers(owner_mcp_path) {
        Ok(servers) => servers,
        Err(e) => {
            // Owner unreadable: preserve existing agent servers, warn.
            eprintln!(
                "buzz-desktop: failed to read owner MCP config; \
                 prior inherited servers preserved: {e}"
            );
            return;
        }
    };

    // 2. Filter colliding entries.
    let acp_upper = acp_server_name.to_ascii_uppercase();
    let (servers, filtered): (serde_json::Map<String, Value>, Vec<String>) =
        owner_mcp_servers.into_iter().fold(
            (serde_json::Map::new(), Vec::new()),
            |(mut kept, mut dropped), (name, def)| {
                if !acp_upper.is_empty() && name.to_ascii_uppercase() == acp_upper {
                    dropped.push(name);
                } else {
                    kept.insert(name, def);
                }
                (kept, dropped)
            },
        );
    for name in &filtered {
        eprintln!(
            "buzz-desktop: inherited MCP server {name:?} omitted — \
             name collides with Buzz's ACP-provided server"
        );
    }

    // 3. Read agent .claude.json (missing / invalid → {}).
    let agent_file = agent_config_dir.join(".claude.json");
    let mut agent_json = match read_agent_mcp_file(&agent_file) {
        Ok(json) => json,
        Err(e) => {
            eprintln!(
                "buzz-desktop: agent MCP config was unparsable — \
                 state replaced with owner user-scope servers: {e}"
            );
            serde_json::Map::new()
        }
    };

    // 4. Set mcpServers key and write back atomically.
    agent_json.insert("mcpServers".to_string(), Value::Object(servers));
    if let Err(e) = write_agent_mcp_file(&agent_file, agent_json) {
        eprintln!(
            "buzz-desktop: failed to write agent MCP config; \
             inherited servers may be stale: {e}"
        );
    }
}

/// Read the top-level `mcpServers` object from an owner `.claude.json`.
/// Returns `Ok(map)` (possibly empty) or `Err` when the file is unreadable or
/// the JSON cannot be parsed.
fn read_owner_mcp_servers(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(json
        .get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default())
}

/// Read the agent-root `.claude.json` as an object map.
/// Returns `Err` when the file exists but cannot be read or parsed
/// (missing file → `Ok(empty map)`).
fn read_agent_mcp_file(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    json.as_object()
        .cloned()
        .ok_or_else(|| "agent .claude.json is not a JSON object".to_string())
}

/// Write `map` to `path` atomically (temp file + rename).
fn write_agent_mcp_file(path: &Path, map: serde_json::Map<String, Value>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Apply the Claude-specific spawn policy to `command` (A1 + B1 + B7 + B8).
///
/// Called from `spawn_agent_child` for local Claude agents only.  Writes the
/// projected `settings.json` (B7), inherits owner MCP servers (B8), injects
/// `ANTHROPIC_MODEL` (A1) and the B1 paired atom
/// (`CLAUDE_CONFIG_DIR` + `CLAUDE_SECURESTORAGE_CONFIG_DIR`).
///
/// `effective_model` is `None` when no model is resolved; the env key is
/// removed so Claude Code uses its own default.
///
/// `acp_mcp_command` is the resolved path to the ACP MCP binary (e.g.
/// `buzz-mcp`) — used by B8 to filter name-colliding inherited servers.
pub fn apply_claude_spawn_policy(
    command: &mut std::process::Command,
    pubkey: &str,
    managed_root: &Path,
    effort_level: Option<String>,
    effective_model: Option<&str>,
    acp_mcp_command: Option<&std::path::Path>,
) -> Result<(), String> {
    // A1: claude's startup model authority is ANTHROPIC_MODEL injected below.
    // Remove BUZZ_ACP_MODEL first so the harness never sees two model authorities
    // simultaneously (BUZZ_ACP_MODEL drives the catalog switch path; ANTHROPIC_MODEL
    // locks the session model directly in the adapter env since claude >= 2.1.216).
    command.env_remove("BUZZ_ACP_MODEL");
    let policy = ClaudeLaunchPolicy::build(pubkey, managed_root, effort_level)?;
    let owner_path = owner_settings_path()
        .unwrap_or_else(|| PathBuf::from("/nonexistent/no-home-dir/.claude/settings.json"));
    let (projected, base_status) = project_settings_json(&owner_path, &policy);
    if matches!(base_status, OwnerBaseStatus::Unreadable { .. }) {
        eprintln!(
            "buzz-desktop: owner ~/.claude/settings.json unreadable — \
             launching with overlay-only settings (non-fatal): {base_status:?}"
        );
    }
    write_projected_settings(&policy, &projected)?;
    // B8: inherit owner user-scope MCP servers into the per-agent .claude.json.
    if let Some(owner_mcp) = owner_mcp_config_path() {
        let acp_name = acp_mcp_command
            .and_then(|p| p.file_stem())
            .and_then(|s| s.to_str())
            .unwrap_or("");
        merge_agent_mcp_servers(&policy.config_dir, &owner_mcp, acp_name);
    }
    // A1: single startup model authority.
    match effective_model {
        Some(m) => command.env("ANTHROPIC_MODEL", m),
        None => command.env_remove("ANTHROPIC_MODEL"),
    };
    // B1: paired isolation atom.
    command.env("CLAUDE_CONFIG_DIR", &policy.config_dir);
    command.env(
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        &policy.secure_storage_config_dir,
    );
    Ok(())
}

/// B3: clean up the per-agent Claude config root, swallowing errors so
/// deletion is never blocked by a failed cleanup.
pub fn try_cleanup_claude_config_root(pubkey: &str, managed_root: &Path) {
    if let Err(e) = cleanup_claude_config_root(pubkey, managed_root) {
        eprintln!(
            "buzz-desktop: failed to clean up Claude config root for {pubkey}: {e} (non-fatal)"
        );
    }
}

#[cfg(test)]
mod tests;
