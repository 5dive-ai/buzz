//! Definition-tier fail-closed tests: verify that a linked instance's spawn
//! and readiness gate correctly refuse when the definition's secrets are
//! unavailable (env_vars_ref present but could not be hydrated from keyring).
use super::test_fixtures::fixture;
use crate::managed_agents::types::{ManagedAgentRecord, RespondTo};

fn pin_persona(record: &mut ManagedAgentRecord, persona: &crate::managed_agents::AgentDefinition) {
    record.persona_id = Some(persona.id.clone());
}

fn persona_v(
    id: &str,
    prompt: &str,
    env: &[(&str, &str)],
) -> crate::managed_agents::AgentDefinition {
    use std::collections::BTreeMap;
    crate::managed_agents::AgentDefinition {
        id: id.to_string(),
        display_name: id.to_string(),
        avatar_url: None,
        system_prompt: prompt.to_string(),
        runtime: Some("goose".to_string()),
        model: None,
        provider: None,
        name_pool: vec![],
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        env_vars: env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<BTreeMap<_, _>>(),
        respond_to: None,
        respond_to_allowlist: vec![],
        parallelism: None,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
        secrets_unavailable: false,
    }
}

/// Test the pure definition-unavailable predicate that `spawn_agent_child`
/// uses before reaching the `require_resolved` or AppHandle-dependent paths.
///
/// `spawn_agent_child` gates on:
///   if let Some(pid) = record.persona_id { if def.secrets_unavailable → Err }
///
/// This mirrors the test shape of `orphaned_linked_instance_returns_error` in
/// the same file: we test the predicate directly without a full AppHandle.
#[test]
fn definition_unavailable_spawn_predicate_fires() {
    // A definition whose env_vars_ref could not be hydrated carries
    // secrets_unavailable=true. Any linked instance must be refused at spawn.
    let mut def = persona_v("def-slug", "prompt", &[("ANTHROPIC_API_KEY", "secret")]);
    def.secrets_unavailable = true;

    let mut record = fixture(RespondTo::Anyone, vec![], Some("tag".into()));
    pin_persona(&mut record, &def);
    assert_eq!(record.persona_id.as_deref(), Some("def-slug"));

    // Simulate the spawn predicate: look up the persona in the personas slice.
    let personas = std::slice::from_ref(&def);
    let definition_unavailable = record
        .persona_id
        .as_deref()
        .and_then(|pid| personas.iter().find(|p| p.id == pid))
        .map(|d| d.secrets_unavailable)
        .unwrap_or(false);

    assert!(
        definition_unavailable,
        "spawn must detect unavailable definition via secrets_unavailable flag"
    );
}

#[test]
fn definition_available_spawn_predicate_does_not_fire() {
    // Same setup but the definition is available — the predicate must return false.
    let mut def = persona_v("def-slug", "prompt", &[("ANTHROPIC_API_KEY", "secret")]);
    def.secrets_unavailable = false;

    let mut record = fixture(RespondTo::Anyone, vec![], Some("tag".into()));
    pin_persona(&mut record, &def);

    let personas = std::slice::from_ref(&def);
    let definition_unavailable = record
        .persona_id
        .as_deref()
        .and_then(|pid| personas.iter().find(|p| p.id == pid))
        .map(|d| d.secrets_unavailable)
        .unwrap_or(false);

    assert!(
        !definition_unavailable,
        "spawn must not refuse a linked instance whose definition is available"
    );
}

#[test]
fn definition_unavailable_propagates_via_to_definition_view() {
    // `to_definition_view` must carry the definition record's
    // secrets_unavailable flag into the AgentDefinition shape so that
    // spawn/readiness callers get accurate availability state.
    let mut def_record: ManagedAgentRecord = serde_json::from_str(
        r#"{
            "pubkey": "",
            "relay_url": "",
            "slug": "def-slug",
            "name": "Def",
            "acp_command": "buzz-acp",
            "agent_command": "goose",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 320,
            "system_prompt": "p",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }"#,
    )
    .expect("definition fixture");
    def_record.secrets_unavailable = true;

    let view = def_record
        .to_definition_view()
        .expect("definition must produce a view");
    assert!(
        view.secrets_unavailable,
        "to_definition_view must propagate secrets_unavailable from the record"
    );

    // And the inverse: available record → available view.
    def_record.secrets_unavailable = false;
    let view2 = def_record.to_definition_view().expect("second view");
    assert!(
        !view2.secrets_unavailable,
        "to_definition_view must propagate false when the definition is available"
    );
}
