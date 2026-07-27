//! Environment configuration, translated into Goose's native vocabulary.
//!
//! This replaces `crates/buzz-agent/src/config.rs` (2,709 lines). Most of that
//! file existed to *implement* provider configuration: the `Provider` enum,
//! per-provider base URLs, model-name normalization, Databricks host parsing,
//! OpenAI auto-upgrade rules, and the resolution order between them.
//!
//! Goose already owns all of that (`goose::config`, `goose::providers`). So
//! what remains here is a translation table: read the `BUZZ_AGENT_*` variables
//! `buzz-acp` injects (see `desktop/src-tauri/src/managed_agents/runtime.rs`),
//! and set the `GOOSE_*` / provider variables Goose reads.
//!
//! The mapping is applied to the *process* environment before the Goose
//! `Config` singleton is first touched, because `Config::global()` reads env at
//! initialization.

/// ACP protocol version. Buzz squats on v2 ahead of the upstream RFD; see the
/// note in `lib.rs::initialize`.
pub const PROTOCOL_VERSION: u32 = 2;

/// Hard caps preserved from buzz-agent's wire contract. These are protocol
/// limits (rejections are `invalid_params`), not loop tuning, so they stay.
pub const MAX_PROMPT_BYTES: usize = 1024 * 1024;
pub const MAX_SYSTEM_PROMPT_BYTES: usize = 512 * 1024;
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Config {
    /// Model id, if pinned by the harness. `None` lets Goose resolve its own
    /// default from `GOOSE_MODEL` / its config file.
    pub model: Option<String>,
    /// Max provider round-trips per turn. Maps to `SessionConfig.max_turns`.
    pub max_rounds: Option<u32>,
    /// Concurrent sessions this process will hold.
    pub max_sessions: usize,
    /// Default system prompt, used only when `session/new` omits one.
    pub system_prompt: Option<String>,
    /// Per-turn wall-clock budget for a single provider request.
    pub llm_timeout_secs: u64,
}

fn env_str(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.trim().is_empty())
}

fn env_parse<T: std::str::FromStr>(key: &str) -> Option<T> {
    env_str(key).and_then(|s| s.parse().ok())
}

impl Config {
    /// Read `BUZZ_AGENT_*` from the environment and, as a side effect, project
    /// the provider-shaped ones onto the `GOOSE_*` names Goose reads.
    pub fn from_env() -> Self {
        Self::project_goose_env();

        let system_prompt = env_str("BUZZ_AGENT_SYSTEM_PROMPT").or_else(|| {
            env_str("BUZZ_AGENT_SYSTEM_PROMPT_FILE")
                .and_then(|p| std::fs::read_to_string(p).ok())
                .filter(|s| !s.trim().is_empty())
        });

        Self {
            model: env_str("BUZZ_AGENT_MODEL"),
            max_rounds: env_parse::<u32>("BUZZ_AGENT_MAX_ROUNDS").filter(|n| *n > 0),
            max_sessions: env_parse("BUZZ_AGENT_MAX_SESSIONS").unwrap_or(8),
            system_prompt,
            llm_timeout_secs: env_parse("BUZZ_AGENT_LLM_TIMEOUT_SECS").unwrap_or(600),
        }
    }

    /// Translate Buzz's provider configuration into Goose's environment.
    ///
    /// Mirrors `goose_env.rs` from PR #1526, with one deliberate difference:
    /// **`GOOSE_MODE` is not forced to `auto` here.** The desktop catalog
    /// currently ships `default_env: &[("GOOSE_MODE", "auto")]`
    /// (`discovery.rs:89`), i.e. auto-approve every tool call
    /// (`goose_mode.rs:22-31`). Because this binary drives the agent in-process
    /// we can gate tool calls ourselves later without inheriting that default;
    /// leaving it unset means Goose falls back to its own default rather than
    /// Buzz silently widening it. Callers that genuinely want auto-approve can
    /// still set `GOOSE_MODE` explicitly.
    fn project_goose_env() {
        // Provider: Buzz's `openai-compat` and `relay-mesh` are both
        // OpenAI-wire-compatible, and Goose knows them as plain `openai`.
        if let Some(provider) = env_str("BUZZ_AGENT_PROVIDER") {
            let goose_provider = match provider.as_str() {
                "openai-compat" | "openai_compat" | "relay-mesh" | "relay_mesh" => "openai",
                other => other,
            };
            set_if_absent("GOOSE_PROVIDER", goose_provider);
        }

        if let Some(model) = env_str("BUZZ_AGENT_MODEL") {
            set_if_absent("GOOSE_MODEL", &model);
        }

        // Key/base-url aliasing: native Goose names win if already present.
        if let Some(key) = env_str("OPENAI_COMPAT_API_KEY") {
            set_if_absent("OPENAI_API_KEY", &key);
        }
        if let Some(base) = env_str("OPENAI_COMPAT_BASE_URL") {
            set_if_absent("OPENAI_BASE_URL", &base);
        }

        if let Some(effort) = env_str("BUZZ_AGENT_THINKING_EFFORT") {
            set_if_absent("GOOSE_THINKING_EFFORT", &effort);
        }
        if let Some(max_tokens) = env_str("BUZZ_AGENT_MAX_OUTPUT_TOKENS") {
            set_if_absent("GOOSE_MAX_TOKENS", &max_tokens);
        }
        if let Some(ctx) = env_str("BUZZ_AGENT_MAX_CONTEXT_TOKENS") {
            set_if_absent("GOOSE_CONTEXT_LIMIT", &ctx);
        }
    }
}

fn set_if_absent(key: &str, value: &str) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Env is process-global; these tests set disjoint keys and assert only on
    // the pure mapping helpers where possible.

    #[test]
    fn set_if_absent_does_not_clobber() {
        std::env::set_var("BUZZ_TEST_EXISTING", "native");
        set_if_absent("BUZZ_TEST_EXISTING", "translated");
        assert_eq!(std::env::var("BUZZ_TEST_EXISTING").unwrap(), "native");
        std::env::remove_var("BUZZ_TEST_EXISTING");
    }

    #[test]
    fn set_if_absent_fills_missing() {
        std::env::remove_var("BUZZ_TEST_MISSING");
        set_if_absent("BUZZ_TEST_MISSING", "translated");
        assert_eq!(std::env::var("BUZZ_TEST_MISSING").unwrap(), "translated");
        std::env::remove_var("BUZZ_TEST_MISSING");
    }

    #[test]
    fn stop_reason_wire_strings_are_stable() {
        use crate::types::StopReason;
        // buzz-acp parses these; drift breaks turn completion.
        assert_eq!(StopReason::EndTurn.as_wire(), "end_turn");
        assert_eq!(StopReason::Cancelled.as_wire(), "cancelled");
        assert_eq!(StopReason::MaxTurnRequests.as_wire(), "max_turn_requests");
    }
}
