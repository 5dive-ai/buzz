//! Relay-primary overlay regressions for team export.
//!
//! Separate module so the main `team_snapshot` test file stays under the
//! desktop file-size ratchet.

use crate::commands::team_snapshot::{
    build_team_export_snapshot,
    tests::{no_overlay, sample_team_instance},
};
use crate::managed_agents::{agent_snapshot::MemoryLevel, AgentDefinition, TeamRecord};

/// A relay-config overlay patch carrying `env_vars`, hydrated the same way the
/// live subscription hydrates it (`PrivateConfigPatch::from_payload` over a
/// decrypted payload).
fn overlay_with_env(
    pubkey: &str,
    name: &str,
    runtime: &str,
    env_vars: serde_json::Value,
) -> crate::managed_agents::private_config_overlay::PrivateConfigOverlay {
    let payload: buzz_core_pkg::private_managed_agent::Payload =
        serde_json::from_value(serde_json::json!({
            "format": buzz_core_pkg::private_managed_agent::FORMAT,
            "version": buzz_core_pkg::private_managed_agent::VERSION,
            "agent_pubkey": pubkey,
            "owner_pubkey": "b".repeat(64),
            "generation": 2,
            "updated_at": "2026-01-02T00:00:00Z",
            "identity": { "private_key_nsec": "nsec1fake" },
            "config": {
                "relay_url": "wss://relay.test",
                "name": name,
                "persona_id": "alice",
                "runtime": runtime,
                "team_id": "t1",
                "env_vars": env_vars,
                "backend": { "type": "local" },
            },
        }))
        .expect("payload fixture deserializes");
    let mut overlay =
        crate::managed_agents::private_config_overlay::PrivateConfigOverlay::default();
    overlay.insert_patch(
        crate::managed_agents::private_config_overlay::PrivateConfigPatch::from_payload(payload)
            .expect("patch hydrates"),
    );
    overlay
}

/// Regression: on a device that follows another device's relay head, team
/// export must serialize the OVERLAY's thinking effort, not the stale value in
/// `managed-agents.json`.
///
/// This is a real failure mode rather than a hypothetical: the overlay's `apply`
/// replaces `env_vars` wholesale (it does not merge), and the portable thinking
/// effort is stored inside `env_vars`, so an export that reads raw disk emits a
/// stale — or, when the effort was set on the other device only, entirely
/// missing — value. Asserting on the exported snapshot rather than on
/// `resolved_records` output is deliberate: the two must agree, and testing each
/// side against its own expectation independently is exactly how a join like
/// this stays green while being broken.
#[test]
fn team_export_prefers_overlay_thinking_effort_over_stale_disk() {
    let definitions = vec![AgentDefinition {
        id: "alice".to_string(),
        display_name: "Alice".to_string(),
        avatar_url: None,
        system_prompt: "Alice prompt".to_string(),
        runtime: Some("codex".to_string()),
        model: None,
        provider: None,
        name_pool: vec![],
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        env_vars: Default::default(),
        respond_to: None,
        respond_to_allowlist: vec![],
        parallelism: None,
        created_at: "now".to_string(),
        updated_at: "now".to_string(),
    }];
    let team = TeamRecord {
        id: "t1".to_string(),
        name: "Team".to_string(),
        description: None,
        instructions: None,
        persona_ids: vec!["alice".to_string()],
        is_builtin: false,
        source_dir: None,
        is_symlink: false,
        symlink_target: None,
        version: None,
        created_at: "now".to_string(),
        updated_at: "now".to_string(),
    };

    // Disk: what this follower device last wrote locally — effort "low".
    let mut disk = sample_team_instance();
    disk.runtime = Some("codex".to_string());
    disk.env_vars.insert(
        "CODEX_CONFIG".to_string(),
        r#"{"model_reasoning_effort":"low"}"#.to_string(),
    );

    // Relay head, authored on the other device: effort "high".
    let overlay = overlay_with_env(
        &disk.pubkey,
        &disk.name,
        "codex",
        serde_json::json!({ "CODEX_CONFIG": r#"{"model_reasoning_effort":"high"}"# }),
    );

    let exported = build_team_export_snapshot(
        &team,
        &definitions,
        &overlay.resolve_all(std::slice::from_ref(&disk)),
        MemoryLevel::None,
        &std::collections::HashMap::new(),
    )
    .unwrap();
    assert_eq!(
        exported.members[0].definition.thinking_effort.as_deref(),
        Some("high"),
        "export must serialize the relay head's effort, not stale disk"
    );

    // Control 1: the disk value is genuinely "low", so the assertion above is
    // the overlay winning rather than a fixture that never had a stale value.
    let no_patch = build_team_export_snapshot(
        &team,
        &definitions,
        &no_overlay(std::slice::from_ref(&disk)),
        MemoryLevel::None,
        &std::collections::HashMap::new(),
    )
    .unwrap();
    assert_eq!(
        no_patch.members[0].definition.thinking_effort.as_deref(),
        Some("low"),
        "control: with no relay head the disk value is exported, not cleared"
    );

    // Control 2: the head can also ADD an effort the disk never had — the
    // missing-value half of the same defect.
    let mut effortless = disk.clone();
    effortless.env_vars.remove("CODEX_CONFIG");
    let added = build_team_export_snapshot(
        &team,
        &definitions,
        &overlay.resolve_all(std::slice::from_ref(&effortless)),
        MemoryLevel::None,
        &std::collections::HashMap::new(),
    )
    .unwrap();
    assert_eq!(
        added.members[0].definition.thinking_effort.as_deref(),
        Some("high"),
        "control: head-only effort is exported even when disk has none"
    );
    assert!(
        build_team_export_snapshot(
            &team,
            &definitions,
            &no_overlay(std::slice::from_ref(&effortless)),
            MemoryLevel::None,
            &std::collections::HashMap::new(),
        )
        .unwrap()
        .members[0]
            .definition
            .thinking_effort
            .is_none(),
        "control: without the overlay that same record exports no effort at all"
    );
}
