//! Hydrate-on-load / strip-on-save seam for the generation-reference protocol.
//!
//! Each public function here is the single call site that moves secret values
//! (env vars, auth tags, provider configs) between in-memory records and the
//! OS keyring. `storage.rs` calls these at the top of every load path and at
//! the bottom of every save path.

use crate::managed_agents::{
    secret_projection::{
        agent_auth_tag_key, agent_env_key, agent_provider_config_key, cancel_gc_candidacy,
        definition_env_key, deserialize_env_map, deserialize_provider_config, load_secret,
        serialize_env_map, serialize_provider_config, write_secret, ProjectionStore, WriteOutcome,
    },
    BackendKind, ManagedAgentRecord,
};

// ── Inline precedence rule (spec §1) ──────────────────────────────────────
//
//   - Non-empty env_vars / Some(auth_tag) / non-Null provider config →
//     AUTHORITATIVE (inline fallback state). Keyring ref is ignored on load.
//   - On save: success → clear inline, set ref, cancel candidacy. The old
//             generation is retired by the two-cycle GC, never eagerly here —
//             deleting before the JSON commit could orphan a committed secret.
//             failure → keep inline, clear ref (retry next boot).

/// Hydrate secret fields of an instance record from the keyring.
pub(crate) fn hydrate_agent_secrets_with<S: ProjectionStore>(
    store: &S,
    record: &mut ManagedAgentRecord,
) -> Vec<String> {
    let mut errors = Vec::new();
    if record.env_vars.is_empty() {
        match load_secret(
            store,
            record.env_vars_ref.as_deref(),
            |gen| agent_env_key(&record.pubkey, gen),
            &format!("agent:{} env_vars", record.pubkey),
        ) {
            Ok(Some(s)) => match deserialize_env_map(&s) {
                Ok(map) => record.env_vars = map,
                Err(e) => errors.push(format!(
                    "agent {} env_vars deserialization failed: {e}",
                    record.pubkey
                )),
            },
            Ok(None) => {}
            Err(e) => errors.push(e),
        }
    }
    if record.auth_tag.is_none() {
        match load_secret(
            store,
            record.auth_tag_ref.as_deref(),
            |gen| agent_auth_tag_key(&record.pubkey, gen),
            &format!("agent:{} auth_tag", record.pubkey),
        ) {
            Ok(Some(v)) => record.auth_tag = Some(v),
            Ok(None) => {}
            Err(e) => errors.push(e),
        }
    }
    if let BackendKind::Provider {
        ref id,
        ref mut config,
    } = record.backend
    {
        if config.is_null() {
            match load_secret(
                store,
                record.provider_config_ref.as_deref(),
                |gen| agent_provider_config_key(&record.pubkey, gen),
                &format!("agent:{} provider_config", record.pubkey),
            ) {
                Ok(Some(s)) => match deserialize_provider_config(&s) {
                    Ok(v) => *config = v,
                    Err(e) => errors.push(format!(
                        "agent {} provider_config deserialization failed: {e}",
                        record.pubkey
                    )),
                },
                Ok(None) => {}
                Err(e) => errors.push(e),
            }
        }
        let _ = id;
    }
    errors
}

/// Strip and persist secret fields of an instance record before JSON write.
///
/// # Fail-closed against empty-projection over unavailable
///
/// When `record.secrets_unavailable` is set (a `*_ref` failed to hydrate on
/// load, leaving the field empty in memory), a naive persist would call
/// `write_secret` with an empty value, get [`WriteOutcome::Nothing`], and
/// CLEAR the still-live `*_ref` — orphaning the generation permanently. On the
/// `Nothing` branch we therefore PRESERVE any pre-existing ref instead of
/// clearing it, so a transient keyring outage never destroys the pointer to a
/// live secret. Real user-cleared fields on an available record still clear
/// normally (`secrets_unavailable` is false).
pub(crate) fn strip_and_persist_agent_secrets_with<S: ProjectionStore>(
    store: &S,
    record: &mut ManagedAgentRecord,
) {
    let unavailable = record.secrets_unavailable;
    let pubkey = record.pubkey.clone();
    let inline_env = if !record.env_vars.is_empty() {
        serialize_env_map(&record.env_vars).ok()
    } else {
        None
    };
    match write_secret(
        store,
        |gen| agent_env_key(&pubkey, gen),
        inline_env.as_deref(),
        &format!("agent:{pubkey} env_vars"),
    ) {
        WriteOutcome::Persisted { gen } => {
            cancel_gc_candidacy(store, &agent_env_key(&pubkey, &gen));
            record.env_vars.clear();
            record.env_vars_ref = Some(gen);
        }
        // Empty projection: preserve an existing ref when unavailable so a
        // failed-hydrate save does not orphan the live generation.
        WriteOutcome::Nothing if unavailable => {}
        WriteOutcome::KeptInline { .. } | WriteOutcome::Nothing => {
            record.env_vars_ref = None;
        }
    }
    let auth_val = record.auth_tag.clone();
    match write_secret(
        store,
        |gen| agent_auth_tag_key(&pubkey, gen),
        auth_val.as_deref(),
        &format!("agent:{pubkey} auth_tag"),
    ) {
        WriteOutcome::Persisted { gen } => {
            cancel_gc_candidacy(store, &agent_auth_tag_key(&pubkey, &gen));
            record.auth_tag = None;
            record.auth_tag_ref = Some(gen);
        }
        WriteOutcome::Nothing if unavailable => {}
        WriteOutcome::KeptInline { .. } | WriteOutcome::Nothing => {
            record.auth_tag_ref = None;
        }
    }
    if let BackendKind::Provider {
        ref id,
        ref mut config,
    } = record.backend
    {
        let serialized = if !config.is_null() {
            serialize_provider_config(config).ok()
        } else {
            None
        };
        match write_secret(
            store,
            |gen| agent_provider_config_key(&pubkey, gen),
            serialized.as_deref(),
            &format!("agent:{pubkey} provider_config ({id})"),
        ) {
            WriteOutcome::Persisted { gen } => {
                cancel_gc_candidacy(store, &agent_provider_config_key(&pubkey, &gen));
                *config = serde_json::Value::Null;
                record.provider_config_ref = Some(gen);
            }
            WriteOutcome::Nothing if unavailable => {}
            WriteOutcome::KeptInline { .. } | WriteOutcome::Nothing => {
                record.provider_config_ref = None;
            }
        }
    } else {
        record.provider_config_ref = None; // Provider→Local: clear stale ref
    }
}

/// Hydrate secret fields of a definition (key-less) record.
pub(crate) fn hydrate_definition_secrets_with<S: ProjectionStore>(
    store: &S,
    record: &mut ManagedAgentRecord,
) -> Vec<String> {
    let Some(slug) = record.slug.as_deref().map(str::to_string) else {
        return Vec::new();
    };
    let mut errors = Vec::new();
    if record.env_vars.is_empty() {
        match load_secret(
            store,
            record.env_vars_ref.as_deref(),
            |gen| definition_env_key(&slug, gen),
            &format!("definition:{slug} env_vars"),
        ) {
            Ok(Some(s)) => match deserialize_env_map(&s) {
                Ok(map) => record.env_vars = map,
                Err(e) => errors.push(format!("definition {slug} env_vars deserialize: {e}")),
            },
            Ok(None) => {}
            Err(e) => errors.push(e),
        }
    }
    errors
}

/// Strip and persist a definition record's env_vars.
///
/// Mirrors the empty-projection guard in
/// [`strip_and_persist_agent_secrets_with`]: when the definition is
/// `secrets_unavailable` (its `env_vars_ref` failed to hydrate on load,
/// leaving `env_vars` empty in memory), preserve the existing ref on the
/// empty-projection branch rather than orphaning the live generation.
pub(crate) fn strip_and_persist_definition_secrets_with<S: ProjectionStore>(
    store: &S,
    record: &mut ManagedAgentRecord,
) {
    let unavailable = record.secrets_unavailable;
    let Some(slug) = record.slug.as_deref().map(str::to_string) else {
        return;
    };
    let inline_env = if !record.env_vars.is_empty() {
        serialize_env_map(&record.env_vars).ok()
    } else {
        None
    };
    match write_secret(
        store,
        |gen| definition_env_key(&slug, gen),
        inline_env.as_deref(),
        &format!("definition:{slug} env_vars"),
    ) {
        WriteOutcome::Persisted { gen } => {
            cancel_gc_candidacy(store, &definition_env_key(&slug, &gen));
            record.env_vars.clear();
            record.env_vars_ref = Some(gen);
        }
        WriteOutcome::Nothing if unavailable => {}
        WriteOutcome::KeptInline { .. } | WriteOutcome::Nothing => {
            record.env_vars_ref = None;
        }
    }
}

/// Hydrate all secret fields in `records`, returning pubkeys of unavailable agents.
pub(crate) fn hydrate_all_secrets_for_records<S: ProjectionStore>(
    store: &S,
    records: &mut [ManagedAgentRecord],
) -> Vec<String> {
    let mut unavailable = Vec::new();
    for record in records.iter_mut() {
        if record.pubkey.is_empty() {
            let errors = hydrate_definition_secrets_with(store, record);
            for e in &errors {
                eprintln!("buzz-desktop: {e}");
            }
            // A definition whose env_vars_ref could not be hydrated is now
            // holding an EMPTY env map with a live ref. Mark it unavailable so
            // the strip-on-save path preserves the ref instead of committing
            // the empty projection (which would orphan the still-live
            // generation permanently). Definitions carry a slug, not a pubkey,
            // so they are not pushed to the pubkey-keyed `unavailable` summary.
            if !errors.is_empty() {
                record.secrets_unavailable = true;
            }
        } else {
            let errors = hydrate_agent_secrets_with(store, record);
            for e in &errors {
                eprintln!("buzz-desktop: {e}");
            }
            if !errors.is_empty() {
                record.secrets_unavailable = true;
                unavailable.push(record.pubkey.clone());
            }
        }
    }
    unavailable
}

/// Strip and persist all secret fields in `records`.
pub(crate) fn strip_and_persist_all_for_records<S: ProjectionStore>(
    store: &S,
    records: &mut [ManagedAgentRecord],
) {
    for record in records.iter_mut() {
        if record.pubkey.is_empty() {
            strip_and_persist_definition_secrets_with(store, record);
        } else {
            strip_and_persist_agent_secrets_with(store, record);
        }
    }
}

#[cfg(test)]
#[path = "secret_seam_tests.rs"]
mod tests;
