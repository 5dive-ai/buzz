use super::super::create_time_agent_command_override_state;
use super::{create_time_agent_command_override, persona_with_runtime};

#[test]
fn preserves_deliberate_override_of_installed_runtime() {
    let personas = vec![persona_with_runtime("p1", Some("claude"))];
    assert_eq!(
        create_time_agent_command_override(Some("p1"), &personas, Some("codex-acp"), true),
        Some("codex-acp".to_string())
    );
}

#[test]
fn pins_visible_fallback_for_runtime_less_persona() {
    let personas = vec![persona_with_runtime("p1", None)];
    assert_eq!(
        create_time_agent_command_override(Some("p1"), &personas, Some("goose"), true),
        Some("goose".to_string())
    );
}

#[test]
fn marks_only_runtime_less_automatic_fallback_pins_as_implicit() {
    let runtime_less = vec![persona_with_runtime("p1", None)];
    assert_eq!(
        create_time_agent_command_override_state(
            Some("p1"),
            &runtime_less,
            Some("goose"),
            true,
            true,
        ),
        (Some("goose".to_string()), true)
    );

    let configured = vec![persona_with_runtime("p1", Some("claude"))];
    assert_eq!(
        create_time_agent_command_override_state(
            Some("p1"),
            &configured,
            Some("codex-acp"),
            true,
            true,
        ),
        (Some("codex-acp".to_string()), false)
    );
}
