//! Distribution policy for managed-agent inbound author access.

use super::{validate_respond_to_allowlist, AgentDefinition, ManagedAgentRecord, RespondTo};

/// Internal packaging sets `BUZZ_BUILD_INTERNAL`; OSS/custom builds do not.
pub(crate) fn internal_build() -> bool {
    option_env!("BUZZ_DESKTOP_BUILD_INTERNAL").is_some()
}

pub(crate) fn owner_only() -> bool {
    owner_only_with_policy(internal_build())
}

pub(crate) fn owner_only_with_policy(internal: bool) -> bool {
    internal
}

/// Normalize a persisted/projected instance for the current distribution.
pub(crate) fn normalize_managed_agent_access(record: &mut ManagedAgentRecord) -> bool {
    normalize_managed_agent_access_with_policy(record, internal_build())
}

pub(crate) fn normalize_managed_agent_access_with_policy(
    record: &mut ManagedAgentRecord,
    internal: bool,
) -> bool {
    if !owner_only_with_policy(internal) {
        return false;
    }
    let changed =
        record.respond_to != RespondTo::OwnerOnly || !record.respond_to_allowlist.is_empty();
    record.respond_to = RespondTo::OwnerOnly;
    record.respond_to_allowlist.clear();
    changed
}

/// Definitions are backend-neutral defaults. Internal builds store owner-only
/// defaults so every later mint starts safe.
pub(crate) fn normalize_definition_access(record: &mut AgentDefinition) -> bool {
    normalize_definition_access_with_policy(record, internal_build())
}

pub(crate) fn normalize_definition_access_with_policy(
    record: &mut AgentDefinition,
    internal: bool,
) -> bool {
    if !internal {
        return false;
    }
    let changed = record.respond_to.is_some() || !record.respond_to_allowlist.is_empty();
    record.respond_to = None;
    record.respond_to_allowlist.clear();
    changed
}

pub(crate) fn resolve_create_access(
    requested_mode: Option<RespondTo>,
    requested_allowlist: &[String],
) -> Result<(Option<RespondTo>, Vec<String>), String> {
    resolve_create_access_with_policy(requested_mode, requested_allowlist, internal_build())
}

pub(crate) fn resolve_create_access_with_policy(
    requested_mode: Option<RespondTo>,
    requested_allowlist: &[String],
    internal: bool,
) -> Result<(Option<RespondTo>, Vec<String>), String> {
    if owner_only_with_policy(internal) {
        return Ok((Some(RespondTo::OwnerOnly), Vec::new()));
    }
    let allowlist = validate_respond_to_allowlist(requested_allowlist)?;
    if requested_mode == Some(RespondTo::Allowlist) && allowlist.is_empty() {
        return Err(
            "respond-to mode 'allowlist' requires at least one pubkey in the allowlist".into(),
        );
    }
    Ok((requested_mode, allowlist))
}

pub(crate) fn apply_update_access(
    record: &mut ManagedAgentRecord,
    requested_mode: Option<RespondTo>,
    requested_allowlist: Option<&[String]>,
) -> Result<(), String> {
    apply_update_access_with_policy(
        record,
        requested_mode,
        requested_allowlist,
        internal_build(),
    )
}

pub(crate) fn apply_update_access_with_policy(
    record: &mut ManagedAgentRecord,
    requested_mode: Option<RespondTo>,
    requested_allowlist: Option<&[String]>,
    internal: bool,
) -> Result<(), String> {
    if owner_only_with_policy(internal) {
        record.respond_to = RespondTo::OwnerOnly;
        record.respond_to_allowlist.clear();
        return Ok(());
    }

    let mode = requested_mode.unwrap_or(record.respond_to);
    let allowlist = match requested_allowlist {
        Some(list) => validate_respond_to_allowlist(list)?,
        None => record.respond_to_allowlist.clone(),
    };
    if mode == RespondTo::Allowlist && allowlist.is_empty() {
        return Err(
            "respond-to mode 'allowlist' requires at least one pubkey in the allowlist".into(),
        );
    }
    record.respond_to = mode;
    if requested_allowlist.is_some() {
        record.respond_to_allowlist = allowlist;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_agents::BackendKind;

    fn record(backend: BackendKind) -> ManagedAgentRecord {
        let mut record: ManagedAgentRecord = serde_json::from_value(serde_json::json!({
            "pubkey": "agent", "name": "Agent", "relay_url": "", "acp_command": "",
            "agent_command": "", "agent_args": [], "mcp_command": "",
            "turn_timeout_seconds": 0, "system_prompt": null, "created_at": "",
            "updated_at": "", "last_started_at": null, "last_stopped_at": null,
            "last_exit_code": null, "last_error": null
        }))
        .unwrap();
        record.backend = backend;
        record.respond_to = RespondTo::Anyone;
        record.respond_to_allowlist = vec!["stale".into()];
        record
    }

    #[test]
    fn internal_create_clamps_every_agent() {
        let result =
            resolve_create_access_with_policy(Some(RespondTo::Anyone), &["bad".into()], true)
                .unwrap();
        assert_eq!(result, (Some(RespondTo::OwnerOnly), Vec::new()));
    }

    #[test]
    fn internal_update_clamps_local_and_provider() {
        for (label, backend) in [
            ("local", BackendKind::Local),
            (
                "provider",
                BackendKind::Provider {
                    id: "p".into(),
                    config: serde_json::json!({}),
                },
            ),
        ] {
            let mut record = record(backend);
            apply_update_access_with_policy(&mut record, None, None, true).unwrap();
            assert_eq!(
                record.respond_to,
                RespondTo::OwnerOnly,
                "internal update did not clamp {label} agent",
            );
            assert!(
                record.respond_to_allowlist.is_empty(),
                "internal update did not clear {label} agent allowlist",
            );
        }
    }

    #[test]
    fn internal_normalization_clamps_local_and_provider() {
        for (label, backend) in [
            ("local", BackendKind::Local),
            (
                "provider",
                BackendKind::Provider {
                    id: "p".into(),
                    config: serde_json::json!({}),
                },
            ),
        ] {
            let mut record = record(backend);
            assert!(
                normalize_managed_agent_access_with_policy(&mut record, true),
                "internal normalization did not change {label} agent",
            );
            assert_eq!(record.respond_to, RespondTo::OwnerOnly);
            assert!(record.respond_to_allowlist.is_empty());
        }
    }
}
