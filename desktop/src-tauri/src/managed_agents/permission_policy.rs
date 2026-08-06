//! Permission policy enum, source attribution, and the precedence resolver.
//!
//! `BUZZ_ACP_PERMISSION_POLICY` is in `RESERVED_ENV_KEYS` so users cannot
//! override it via the env-vars UI — a manual override would make the running
//! harness use a different policy than the saved/UI-visible setting.

use serde::{Deserialize, Serialize};

use super::types::ManagedAgentRecord;

/// How the agent answers `session/request_permission` requests.
///
/// - `Ask`    — show an Allow/Deny card; auto-deny after 300 s (desktop default).
/// - `Allow`  — auto-select the unique `allow_once` option; explicit opt-in.
/// - `Reject` — deny immediately; headless/CLI default.
///
/// Wire format is lowercase to match the harness CLI vocabulary and the
/// `BUZZ_ACP_PERMISSION_POLICY` env var the harness reads.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PermissionPolicy {
    Ask,
    Allow,
    Reject,
}

impl PermissionPolicy {
    /// The env-var wire string consumed by the harness
    /// (`BUZZ_ACP_PERMISSION_POLICY`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Allow => "allow",
            Self::Reject => "reject",
        }
    }

    /// The built-in desktop default: show the Allow/Deny card.
    ///
    /// Headless / bare-CLI callers use `Reject` — they never have a UI to
    /// answer a card. The desktop injects the resolved effective policy so
    /// headless sessions spawned by the desktop still pick up the user's
    /// choice.
    pub fn desktop_default() -> Self {
        Self::Ask
    }
}

/// Where the effective [`PermissionPolicy`] came from. Serialized as a
/// `snake_case` string for TypeScript's exhaustive-switch pattern.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionPolicySource {
    /// Set explicitly on this agent record.
    Agent,
    /// Inherited from the global agent config.
    GlobalDefault,
    /// Neither per-agent nor global is set; using the built-in desktop default.
    BuiltIn,
}

/// Resolve the effective permission policy for an agent.
///
/// Precedence (highest first):
/// 1. `record.permission_policy` — per-agent override.
/// 2. `global.permission_policy` — fleet-wide default.
/// 3. [`PermissionPolicy::desktop_default`] — built-in.
pub fn resolve_effective_permission_policy(
    record: &ManagedAgentRecord,
    global: &super::global_config::GlobalAgentConfig,
) -> (PermissionPolicy, PermissionPolicySource) {
    if let Some(policy) = record.permission_policy {
        return (policy, PermissionPolicySource::Agent);
    }
    if let Some(policy) = global.permission_policy {
        return (policy, PermissionPolicySource::GlobalDefault);
    }
    (
        PermissionPolicy::desktop_default(),
        PermissionPolicySource::BuiltIn,
    )
}
