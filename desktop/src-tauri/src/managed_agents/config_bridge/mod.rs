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

/// Apply the spawn-side legacy effort bridge to an already-merged effective env.
///
/// For runtimes with a static effort vocabulary (`effort_normalization` is `Some`):
/// 1. Walk per-tier sanitized maps in tier-first precedence order and resolve the
///    canonical effort value.
/// 2. Strip all foreign known effort keys from `env` (runtime-scoped invariant).
/// 3. Remove any raw (possibly invalid/alias-form) entry for the native key.
/// 4. Insert the canonical value under the native key (if any tier resolved one).
///
/// Tier order (spawn; ACP and file tiers absent):
///   record native → record legacy → persona native → persona legacy
///   → global native → definition native
///
/// Global legacy is excluded end-to-end (plan v3 Delta 2).
pub(crate) fn apply_effort_bridge(
    env: &mut std::collections::BTreeMap<String, String>,
    runtime: Option<&crate::managed_agents::discovery::KnownAcpRuntime>,
    record_env: &std::collections::BTreeMap<String, String>,
    personas: &[crate::managed_agents::types::AgentDefinition],
    persona_id: Option<&str>,
    global_env: &std::collections::BTreeMap<String, String>,
    harness_def: Option<&crate::managed_agents::custom_harnesses::HarnessDefinition>,
) {
    use std::collections::BTreeMap;

    let rt = match runtime {
        Some(rt) => rt,
        None => return,
    };
    // Strip foreign known effort keys for any runtime that has a native effort key,
    // regardless of whether it has an effort_normalization contract.
    // This ensures GOOSE_THINKING_EFFORT is absent from buzz-agent descriptors and vice versa.
    if let Some(native_key) = &rt.thinking_env_var {
        for &key in ALL_KNOWN_EFFORT_KEYS {
            if key != *native_key {
                env.remove(key);
            }
        }
    }
    // Effort tier resolution and alias normalization require effort_normalization.
    let (norm, native_key) = match (&rt.effort_normalization, &rt.thinking_env_var) {
        (Some(n), Some(k)) => (n, k),
        _ => return,
    };
    let norm_fn = |raw: &str| norm.normalize_str(raw);
    let mue = crate::managed_agents::env_vars::merged_user_env;
    let is_reserved = crate::managed_agents::env_vars::is_reserved_env_key;
    let live_persona_env = crate::managed_agents::env_vars::live_persona_env;

    let s_record = mue(&BTreeMap::new(), record_env);
    let s_persona = mue(&BTreeMap::new(), &live_persona_env(personas, persona_id));
    let s_global = mue(&BTreeMap::new(), global_env);
    let s_def: BTreeMap<String, String> = harness_def
        .map(|d| {
            d.env
                .iter()
                .filter(|(k, _)| !is_reserved(k))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();

    let canonical = None
        .or_else(|| effort_tier_alias(&s_record, native_key, norm_fn, false))
        .or_else(|| effort_tier_alias(&s_persona, native_key, norm_fn, false))
        .or_else(|| effort_tier_alias(&s_global, native_key, norm_fn, true))
        .or_else(|| effort_tier_alias(&s_def, native_key, norm_fn, false));

    // Remove raw native key (may be alias-form or invalid); canonical re-inserted below.
    env.remove(*native_key);
    if let Some(value) = canonical {
        env.insert(native_key.to_string(), value);
    }
}
