use std::collections::{BTreeMap, HashMap};

use buzz_core_pkg::private_managed_agent::Payload;

use super::{
    build_managed_agent_summary, load_personas, start_managed_agent_process,
    validate_respond_to_allowlist, validate_user_env_keys, BackendKind, ManagedAgentRecord,
    ManagedAgentSummary, RelayMeshConfig, RespondTo, DEFAULT_ACP_COMMAND,
    DEFAULT_AGENT_PARALLELISM, DEFAULT_AGENT_TURN_TIMEOUT_SECONDS,
};

#[derive(Clone)]
pub(crate) struct PrivateConfigPatch {
    pubkey: String,
    name: String,
    private_key_nsec: String,
    auth_tag: Option<String>,
    relay_url: String,
    persona_id: Option<String>,
    runtime: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    system_prompt: Option<String>,
    parallelism: u32,
    respond_to: RespondTo,
    respond_to_allowlist: Vec<String>,
    agent_command_override: Option<String>,
    agent_args: Vec<String>,
    idle_timeout_seconds: Option<u64>,
    max_turn_duration_seconds: Option<u64>,
    env_vars: BTreeMap<String, String>,
    backend: BackendKind,
    backend_agent_id: Option<String>,
    team_id: Option<String>,
    persona_name_in_team: Option<String>,
    relay_mesh: Option<RelayMeshConfig>,
    updated_at: String,
}

impl PrivateConfigPatch {
    /// Convert a payload that has already passed the codec's
    /// `validate_and_decrypt` gate. Callers must not feed unvalidated wire data.
    pub(crate) fn from_payload(payload: Payload) -> Result<Self, String> {
        let config = payload.config;
        let backend = serde_json::from_value(config.backend)
            .map_err(|error| format!("invalid private managed-agent backend: {error}"))?;
        let relay_mesh = config
            .relay_mesh
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| format!("invalid private managed-agent relay_mesh: {error}"))?;
        let respond_to = config
            .respond_to
            .as_deref()
            .map(RespondTo::parse_wire)
            .transpose()?
            .unwrap_or_default();
        let respond_to_allowlist = validate_respond_to_allowlist(&config.respond_to_allowlist)?;
        if respond_to == RespondTo::Allowlist && respond_to_allowlist.is_empty() {
            return Err("private managed-agent allowlist mode requires at least one pubkey".into());
        }
        validate_user_env_keys(&config.env_vars)?;
        let parallelism = config.parallelism.unwrap_or(DEFAULT_AGENT_PARALLELISM);
        if !(1..=32).contains(&parallelism) {
            return Err("private managed-agent parallelism must be between 1 and 32".into());
        }

        Ok(Self {
            pubkey: payload.agent_pubkey,
            name: config.name,
            private_key_nsec: payload.identity.private_key_nsec,
            auth_tag: payload.identity.auth_tag,
            relay_url: config.relay_url,
            persona_id: config.persona_id,
            runtime: config.runtime,
            model: config.model,
            provider: config.provider,
            system_prompt: config.system_prompt,
            parallelism,
            respond_to,
            respond_to_allowlist,
            agent_command_override: config.agent_command_override,
            agent_args: config.agent_args,
            idle_timeout_seconds: config.idle_timeout_seconds,
            max_turn_duration_seconds: config.max_turn_duration_seconds,
            env_vars: config.env_vars,
            backend,
            backend_agent_id: config.backend_agent_id,
            team_id: config.team_id,
            persona_name_in_team: config.persona_name_in_team,
            relay_mesh,
            updated_at: payload.updated_at,
        })
    }

    fn apply(&self, record: &mut ManagedAgentRecord) {
        record.pubkey.clone_from(&self.pubkey);
        record.name.clone_from(&self.name);
        record.private_key_nsec.clone_from(&self.private_key_nsec);
        record.auth_tag.clone_from(&self.auth_tag);
        record.relay_url.clone_from(&self.relay_url);
        record.persona_id.clone_from(&self.persona_id);
        record.runtime.clone_from(&self.runtime);
        record.model.clone_from(&self.model);
        record.provider.clone_from(&self.provider);
        record.system_prompt.clone_from(&self.system_prompt);
        record.parallelism = self.parallelism;
        record.respond_to = self.respond_to;
        record
            .respond_to_allowlist
            .clone_from(&self.respond_to_allowlist);
        record
            .agent_command_override
            .clone_from(&self.agent_command_override);
        record.agent_args.clone_from(&self.agent_args);
        record.idle_timeout_seconds = self.idle_timeout_seconds;
        record.max_turn_duration_seconds = self.max_turn_duration_seconds;
        record.env_vars.clone_from(&self.env_vars);
        record.backend.clone_from(&self.backend);
        record.backend_agent_id.clone_from(&self.backend_agent_id);
        record.team_id.clone_from(&self.team_id);
        record
            .persona_name_in_team
            .clone_from(&self.persona_name_in_team);
        record.relay_mesh.clone_from(&self.relay_mesh);
        record.updated_at.clone_from(&self.updated_at);
    }

    fn fresh_record(&self) -> ManagedAgentRecord {
        let mut record = ManagedAgentRecord {
            pubkey: String::new(),
            name: String::new(),
            persona_id: None,
            team_id: None,
            private_key_nsec: String::new(),
            auth_tag: None,
            relay_url: String::new(),
            avatar_url: None,
            acp_command: DEFAULT_ACP_COMMAND.into(),
            agent_command: String::new(),
            agent_command_override: None,
            agent_args: vec![],
            mcp_command: String::new(),
            turn_timeout_seconds: DEFAULT_AGENT_TURN_TIMEOUT_SECONDS,
            idle_timeout_seconds: None,
            max_turn_duration_seconds: None,
            parallelism: DEFAULT_AGENT_PARALLELISM,
            system_prompt: None,
            model: None,
            provider: None,
            persona_source_version: None,
            env_vars: BTreeMap::new(),
            start_on_app_launch: false,
            auto_restart_on_config_change: true,
            runtime_pid: None,
            backend: BackendKind::Local,
            backend_agent_id: None,
            provider_binary_path: None,
            persona_team_dir: None,
            persona_name_in_team: None,
            created_at: self.updated_at.clone(),
            updated_at: self.updated_at.clone(),
            last_started_at: None,
            last_stopped_at: None,
            last_exit_code: None,
            last_error: None,
            last_error_code: None,
            respond_to: RespondTo::default(),
            respond_to_allowlist: vec![],
            display_name: None,
            slug: None,
            runtime: None,
            name_pool: vec![],
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            definition_respond_to: None,
            definition_respond_to_allowlist: vec![],
            definition_parallelism: None,
            relay_mesh: None,
        };
        self.apply(&mut record);
        record
    }
}

#[derive(Default)]
pub(crate) struct PrivateConfigOverlay(HashMap<String, PrivateConfigPatch>);

impl PrivateConfigOverlay {
    #[cfg(test)]
    pub(crate) fn insert(&mut self, payload: Payload) -> Result<(), String> {
        let patch = PrivateConfigPatch::from_payload(payload)?;
        self.0.insert(patch.pubkey.clone(), patch);
        Ok(())
    }

    pub(crate) fn insert_patch(&mut self, patch: PrivateConfigPatch) {
        self.0.insert(patch.pubkey.clone(), patch);
    }

    pub(crate) fn clear(&mut self) {
        self.0.clear();
    }

    pub(crate) fn remove(&mut self, pubkey: &str) {
        self.0.remove(pubkey);
    }

    pub(crate) fn contains(&self, pubkey: &str) -> bool {
        self.0.contains_key(pubkey)
    }

    pub(crate) fn resolved_record(
        &self,
        pubkey: &str,
        local: &[ManagedAgentRecord],
    ) -> Option<ManagedAgentRecord> {
        let patch = self.0.get(pubkey)?;
        let mut record = local
            .iter()
            .find(|record| record.pubkey == pubkey)
            .cloned()
            .unwrap_or_else(|| patch.fresh_record());
        patch.apply(&mut record);
        Some(record)
    }

    pub(crate) fn resolved_records(&self, local: &[ManagedAgentRecord]) -> Vec<ManagedAgentRecord> {
        let mut resolved = local.to_vec();
        for record in &mut resolved {
            if let Some(patch) = self.0.get(&record.pubkey) {
                patch.apply(record);
            }
        }
        let mut relay_only: Vec<_> = self
            .0
            .values()
            .filter(|patch| !local.iter().any(|record| record.pubkey == patch.pubkey))
            .map(PrivateConfigPatch::fresh_record)
            .collect();
        relay_only.sort_by(|left, right| left.pubkey.cmp(&right.pubkey));
        resolved.extend(relay_only);
        resolved
    }
}

pub(crate) fn start_relay_only_agent(
    app: &tauri::AppHandle,
    state: &crate::app_state::AppState,
    pubkey: &str,
    owner_hex: &str,
    local_records: &[ManagedAgentRecord],
) -> Result<ManagedAgentSummary, String> {
    let mut record = state
        .private_managed_agent_overlay
        .lock()
        .map_err(|error| error.to_string())?
        .resolved_record(pubkey, local_records)
        .ok_or_else(|| format!("agent {pubkey} not found"))?;
    if local_records.iter().all(|local| local.pubkey != pubkey) {
        record.persona_id = None;
    }
    if record.backend != BackendKind::Local {
        return Err("relay-only provider agents cannot be started on this device".into());
    }
    let personas = load_personas(app).unwrap_or_default();
    super::try_record_agent_command(&record, &personas)
        .map_err(|error| super::user_facing_harness_error(&error))?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;
    start_managed_agent_process(app, &mut record, &mut runtimes, Some(owner_hex))?;
    build_managed_agent_summary(
        app,
        &record,
        &runtimes,
        &personas,
        &super::load_global_agent_config(app).unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core_pkg::private_managed_agent::{
        Payload, PrivateConfig, PrivateIdentity, FORMAT, VERSION,
    };
    use serde_json::{json, Map};

    fn payload(pubkey: &str, name: &str) -> Payload {
        Payload {
            format: FORMAT.into(),
            version: VERSION,
            agent_pubkey: pubkey.into(),
            owner_pubkey: "11".repeat(32),
            generation: 1,
            previous_event_id: None,
            updated_at: "2026-08-06T00:00:00Z".into(),
            identity: PrivateIdentity {
                private_key_nsec: "nsec-test".into(),
                auth_tag: None,
            },
            config: PrivateConfig {
                relay_url: "wss://relay.example".into(),
                name: name.into(),
                persona_id: None,
                runtime: Some("goose".into()),
                model: Some("m".into()),
                provider: None,
                system_prompt: Some("relay prompt".into()),
                parallelism: None,
                respond_to: None,
                respond_to_allowlist: vec![],
                agent_command_override: None,
                agent_args: vec![],
                idle_timeout_seconds: None,
                max_turn_duration_seconds: None,
                env_vars: BTreeMap::new(),
                backend: json!({"type":"local"}),
                backend_agent_id: None,
                team_id: None,
                persona_name_in_team: None,
                relay_mesh: None,
                extra: Map::new(),
            },
            extensions: BTreeMap::new(),
            extra: Map::new(),
        }
    }

    #[test]
    fn resolves_overlay_and_relay_only_without_mutating_local() {
        let mut overlay = PrivateConfigOverlay::default();
        overlay.insert(payload("aa", "relay local")).unwrap();
        overlay.insert(payload("bb", "relay only")).unwrap();
        let mut local = overlay.0["aa"].fresh_record();
        local.name = "disk".into();
        local.system_prompt = Some("disk prompt".into());
        let original = local.clone();

        let resolved = overlay.resolved_records(std::slice::from_ref(&local));
        assert_eq!(resolved.len(), 2);
        assert_eq!(resolved[0].name, "relay local");
        assert_eq!(resolved[0].system_prompt.as_deref(), Some("relay prompt"));
        assert_eq!(resolved[1].pubkey, "bb");
        assert!(!resolved[1].start_on_app_launch);
        assert_eq!(local, original);
    }

    #[test]
    fn rejected_patch_preserves_cached_value_and_clear_drops_scope() {
        let mut overlay = PrivateConfigOverlay::default();
        overlay.insert(payload("aa", "valid")).unwrap();
        let mut invalid = payload("aa", "invalid");
        invalid.config.backend = json!({"type":"provider"});
        assert!(overlay.insert(invalid).is_err());
        assert_eq!(overlay.resolved_records(&[])[0].name, "valid");
        overlay.clear();
        assert!(overlay.resolved_records(&[]).is_empty());
    }

    #[test]
    fn unresolved_harness_has_named_refusal() {
        let mut patch = PrivateConfigPatch::from_payload(payload("aa", "agent")).unwrap();
        patch.runtime = Some("missing-custom-harness".into());
        let record = patch.fresh_record();
        let error = crate::managed_agents::try_record_agent_command(&record, &[]).unwrap_err();
        assert_eq!(
            crate::managed_agents::dangling_harness_id(&error),
            Some("missing-custom-harness")
        );
    }
}
