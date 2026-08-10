//! Hydrate-on-load / strip-on-save seam for the generation-reference protocol.
//!
//! Each public function here is the single call site that moves secret values
//! (env vars, auth tags, provider configs) between in-memory records and the
//! OS keyring. `storage.rs` calls these at the top of every load path and at
//! the bottom of every save path.

use crate::managed_agents::{
    secret_projection::{
        agent_auth_tag_key, agent_env_key, agent_provider_config_key, cancel_gc_candidacy,
        definition_env_key, delete_generation_best_effort, deserialize_env_map,
        deserialize_provider_config, load_secret, serialize_env_map, serialize_provider_config,
        write_secret, ProjectionStore, WriteOutcome,
    },
    BackendKind, ManagedAgentRecord,
};

// ── Inline precedence rule (spec §1) ──────────────────────────────────────
//
//   - Non-empty env_vars / Some(auth_tag) / non-Null provider config →
//     AUTHORITATIVE (inline fallback state). Keyring ref is ignored on load.
//   - On save: success → clear inline, set ref, cancel candidacy, delete old.
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
pub(crate) fn strip_and_persist_agent_secrets_with<S: ProjectionStore>(
    store: &S,
    record: &mut ManagedAgentRecord,
) {
    let pubkey = record.pubkey.clone();
    let inline_env = if !record.env_vars.is_empty() {
        serialize_env_map(&record.env_vars).ok()
    } else {
        None
    };
    let old_env_ref = record.env_vars_ref.clone();
    match write_secret(
        store,
        |gen| agent_env_key(&pubkey, gen),
        inline_env.as_deref(),
        &format!("agent:{pubkey} env_vars"),
    ) {
        WriteOutcome::Persisted { gen } => {
            cancel_gc_candidacy(store, &agent_env_key(&pubkey, &gen));
            record.env_vars.clear();
            record.env_vars_ref = Some(gen.clone());
            if let Some(old) = old_env_ref.filter(|g| *g != gen) {
                delete_generation_best_effort(
                    store,
                    &agent_env_key(&pubkey, &old),
                    &format!("agent:{pubkey} old env_vars"),
                );
            }
        }
        WriteOutcome::KeptInline { .. } | WriteOutcome::Nothing => {
            record.env_vars_ref = None;
        }
    }
    let auth_val = record.auth_tag.clone();
    let old_auth_ref = record.auth_tag_ref.clone();
    match write_secret(
        store,
        |gen| agent_auth_tag_key(&pubkey, gen),
        auth_val.as_deref(),
        &format!("agent:{pubkey} auth_tag"),
    ) {
        WriteOutcome::Persisted { gen } => {
            cancel_gc_candidacy(store, &agent_auth_tag_key(&pubkey, &gen));
            record.auth_tag = None;
            record.auth_tag_ref = Some(gen.clone());
            if let Some(old) = old_auth_ref.filter(|g| *g != gen) {
                delete_generation_best_effort(
                    store,
                    &agent_auth_tag_key(&pubkey, &old),
                    &format!("agent:{pubkey} old auth_tag"),
                );
            }
        }
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
        let old_pc_ref = record.provider_config_ref.clone();
        match write_secret(
            store,
            |gen| agent_provider_config_key(&pubkey, gen),
            serialized.as_deref(),
            &format!("agent:{pubkey} provider_config ({id})"),
        ) {
            WriteOutcome::Persisted { gen } => {
                cancel_gc_candidacy(store, &agent_provider_config_key(&pubkey, &gen));
                *config = serde_json::Value::Null;
                record.provider_config_ref = Some(gen.clone());
                if let Some(old) = old_pc_ref.filter(|g| *g != gen) {
                    delete_generation_best_effort(
                        store,
                        &agent_provider_config_key(&pubkey, &old),
                        &format!("agent:{pubkey} old provider_config"),
                    );
                }
            }
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
pub(crate) fn strip_and_persist_definition_secrets_with<S: ProjectionStore>(
    store: &S,
    record: &mut ManagedAgentRecord,
) {
    let Some(slug) = record.slug.as_deref().map(str::to_string) else {
        return;
    };
    let inline_env = if !record.env_vars.is_empty() {
        serialize_env_map(&record.env_vars).ok()
    } else {
        None
    };
    let old_ref = record.env_vars_ref.clone();
    match write_secret(
        store,
        |gen| definition_env_key(&slug, gen),
        inline_env.as_deref(),
        &format!("definition:{slug} env_vars"),
    ) {
        WriteOutcome::Persisted { gen } => {
            cancel_gc_candidacy(store, &definition_env_key(&slug, &gen));
            record.env_vars.clear();
            record.env_vars_ref = Some(gen.clone());
            if let Some(old) = old_ref.filter(|g| *g != gen) {
                delete_generation_best_effort(
                    store,
                    &definition_env_key(&slug, &old),
                    &format!("definition:{slug} old env_vars"),
                );
            }
        }
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
            for e in hydrate_definition_secrets_with(store, record) {
                eprintln!("buzz-desktop: {e}");
            }
        } else {
            let errors = hydrate_agent_secrets_with(store, record);
            for e in &errors {
                eprintln!("buzz-desktop: {e}");
            }
            if !errors.is_empty() {
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
