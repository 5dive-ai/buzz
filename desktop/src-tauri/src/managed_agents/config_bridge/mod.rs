mod buzz_agent;
mod claude;
mod codex;
mod goose;
pub(crate) mod reader;
mod schema_walker;
pub(crate) mod types;

pub(crate) use types::*;

/// The legacy effort env key written by pre-migration saves.
///
/// Harnesses whose native `thinking_env_var` differs from this constant
/// (currently: Goose uses `GOOSE_THINKING_EFFORT`) need the alias resolver
/// below to translate old saves. buzz-agent's native key equals this constant,
/// so no aliasing applies there.
pub(crate) const LEGACY_THINKING_EFFORT_KEY: &str = "BUZZ_AGENT_THINKING_EFFORT";

/// The set of all known native thinking-effort env keys across all runtimes.
/// Used to strip foreign effort keys from a runtime's effective descriptor.
/// Must stay in sync with `KnownAcpRuntime::thinking_env_var` declarations.
#[allow(dead_code)] // used in Phase 3 (spawn foreign-key stripping in readiness.rs)
pub(crate) const ALL_KNOWN_EFFORT_KEYS: &[&str] = &[
    LEGACY_THINKING_EFFORT_KEY, // buzz-agent native
    "GOOSE_THINKING_EFFORT",    // Goose native
];

/// Resolve the thinking-effort value for a single env-var tier map, with
/// within-tier legacy aliasing and normalization.
///
/// Returns the **canonical** value (normalized via `norm`) for the tier, or
/// `None` when no usable candidate exists.
///
/// Lookup order (applied independently per tier, not globally):
///   1. Native key (`native_key`) — value normalized; invalid values skip as absent.
///   2. Legacy key (`BUZZ_AGENT_THINKING_EFFORT`) — honoured only when:
///      (a) `native_key` differs from the legacy key (i.e. non-buzz-agent runtime), AND
///      (b) `global_tier` is false (legacy alias excluded from global tier), AND
///      (c) the value normalizes to a canonical form.
///      An invalid legacy value is skipped so the next tier can supply a candidate.
///
/// The `norm` function normalizes a raw value to canonical form; `None` = invalid.
pub(crate) fn effort_tier_alias(
    map: &std::collections::BTreeMap<String, String>,
    native_key: &str,
    norm: impl Fn(&str) -> Option<String>,
    global_tier: bool,
) -> Option<String> {
    // Native key first — normalize the value; invalid → skip.
    if let Some(raw) = map.get(native_key) {
        if let Some(canonical) = norm(raw) {
            return Some(canonical);
        }
        // Invalid native value: skip-as-absent, fall through to legacy.
    }
    // Legacy alias — only when keys differ and this is not the global tier.
    if !global_tier && native_key != LEGACY_THINKING_EFFORT_KEY {
        if let Some(raw) = map.get(LEGACY_THINKING_EFFORT_KEY) {
            if let Some(canonical) = norm(raw) {
                return Some(canonical);
            }
            // Invalid legacy value for this harness: skip, fall through to next tier.
        }
    }
    None
}

/// Read the goose harness config file (`~/.config/goose/config.yaml`).
///
/// Used by readiness evaluation to silence requirements that are already
/// satisfied in the file config layer — the harness reads this file at startup
/// so env vars we would otherwise require are not needed from Buzz.
pub(crate) fn read_goose_file_config() -> Option<RuntimeFileConfig> {
    goose::read_config_file()
}
