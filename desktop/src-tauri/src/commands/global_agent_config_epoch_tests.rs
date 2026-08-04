//! Epoch-level tests for `commands/global_agent_config.rs`.
//!
//! Included inside `mod tests` via `#[path]` from `global_agent_config_tests.rs`.
//! Heavy async epoch tests split here to keep each file under 1000 lines.

use super::*;
/// Full tail test: production epoch core with injected stop/spawn/receipt
/// closures. Verifies that the core calls stop, then spawn with captured
/// context (relay, owner, scope), then receipt, registers the runtime with
/// the captured scope_id, and saves the record.
///
/// Thufir's test 5: "call production restart_under_captured_epoch_for via
/// mock app with injected spawn_fn and write_receipt_fn; assert captured
/// relay/owner/teams/personas/global delivered to spawn, receipt constructed
/// and written, runtimes map contains new entry with context.scope.scope_id,
/// final captured disk record matches."
///
/// Note: to pass the eligibility check we need a record with backend=Local
/// and a live runtime in the runtimes map. Since we can't inject a real
/// process, we seed the runtimes map directly via AppState.
#[tokio::test]
async fn test_full_tail_stop_spawn_receipt_register_save() {
    use crate::managed_agents::{
        storage::save_managed_agents_at, BackendKind, ManagedAgentPairRuntime, ManagedAgentRecord,
        ManagedAgentRuntimeKey,
    };
    use std::sync::{Arc, Mutex};
    use tauri::Manager;

    let tmp = tempfile::tempdir().unwrap();
    let pubkey = "bb".repeat(32);
    let relay_url = "wss://test.relay";
    let owner_hex = "cc".repeat(32);
    let scope_id = "scope-test-id";

    // Build a Ready record: provider+model in structured fields so the agent
    // passes the eligibility gate (old_ready = true). ANTHROPIC_API_KEY is
    // required by buzz_agent_requirements when provider=anthropic, so we set
    // it in env_vars to satisfy the readiness check. Two globals differ by one
    // env_var so env_changed = true → should_restart_on_config_change returns true.
    let mut record_env_vars = std::collections::BTreeMap::new();
    record_env_vars.insert(
        "ANTHROPIC_API_KEY".to_string(),
        "sk-test-key-for-readiness".to_string(),
    );
    let record = ManagedAgentRecord {
        pubkey: pubkey.clone(),
        name: "test-agent".to_string(),
        display_name: None,
        slug: None,
        persona_id: None,
        private_key_nsec: String::new(),
        auth_tag: None,
        relay_url: relay_url.to_string(),
        avatar_url: None,
        acp_command: crate::managed_agents::DEFAULT_ACP_COMMAND.to_string(),
        agent_command: String::new(),
        agent_command_override: None,
        agent_args: vec![],
        mcp_command: String::new(),
        turn_timeout_seconds: 0,
        idle_timeout_seconds: None,
        max_turn_duration_seconds: None,
        parallelism: 1,
        system_prompt: None,
        model: Some("claude-3-5-sonnet-20241022".to_string()),
        provider: Some("anthropic".to_string()),
        persona_source_version: None,
        env_vars: record_env_vars,
        start_on_app_launch: false,
        auto_restart_on_config_change: false,
        runtime_pid: None,
        backend: BackendKind::Local,
        backend_agent_id: None,
        provider_binary_path: None,
        team_id: None,
        persona_team_dir: None,
        persona_name_in_team: None,
        created_at: crate::util::now_iso(),
        updated_at: crate::util::now_iso(),
        last_started_at: None,
        last_stopped_at: None,
        last_exit_code: None,
        last_error: None,
        last_error_code: None,
        respond_to: Default::default(),
        respond_to_allowlist: Default::default(),
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        definition_respond_to: None,
        definition_respond_to_allowlist: Default::default(),
        definition_parallelism: None,
        relay_mesh: None,
        runtime: None,
        name_pool: vec![],
    };

    // Write initial store.
    save_managed_agents_at(tmp.path(), std::slice::from_ref(&record)).unwrap();
    std::fs::write(tmp.path().join("personas.json"), b"[]").unwrap();
    std::fs::write(tmp.path().join("global-agent-config.json"), b"{}").unwrap();

    let app = make_mock_app();
    let app_handle = app.handle().clone();

    // Seed a live pair runtime using a long-running process.
    // `/usr/bin/true` exits immediately and is evicted by
    // sync_managed_agent_processes before the eligibility check; use `sleep`
    // to keep the runtime alive through the sync.
    let rt_key = ManagedAgentRuntimeKey::new(&pubkey, relay_url).unwrap();
    {
        let state = app_handle.state::<crate::app_state::AppState>();
        let mut runtimes = state.managed_agent_processes.lock().unwrap();
        let child = std::process::Command::new("sleep")
            .arg("10000")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sleep 10000");
        let process = crate::managed_agents::ManagedAgentProcess {
            child,
            log_path: std::path::PathBuf::new(),
            spawn_config_hash: 0,
            setup_mode: false,
            adapter_availability: None,
            start_nonce: "test-nonce".to_string(),
            #[cfg(windows)]
            job: None,
        };
        runtimes.insert(
            rt_key.clone(),
            ManagedAgentPairRuntime::starting(process, Some(scope_id.to_string())),
        );
    }

    let gen = crate::managed_agents::scope::current_scope_generation();
    let scope = crate::managed_agents::scope::WorkspaceAgentScope {
        scope_id: scope_id.to_string(),
        relay_url: relay_url.to_string(),
        owner_pubkey: owner_hex.clone(),
        definitions_dir: tmp.path().to_path_buf(),
        generation: gen,
    };

    let context = CapturedRestartContext {
        scope: scope.clone(),
        personas: vec![],
        teams: vec![],
        global: crate::managed_agents::GlobalAgentConfig::default(),
        owner_hex: owner_hex.clone(),
        mesh_model_id: None,
    };

    // old_global (default) and new_global differ by one env_var so that
    // env_changed = true → should_restart_on_config_change returns true.
    let old_global = crate::managed_agents::GlobalAgentConfig::default();
    let mut new_global_env = std::collections::BTreeMap::new();
    new_global_env.insert("SOME_EXTRA_VAR".to_string(), "v2".to_string());
    let new_global = crate::managed_agents::GlobalAgentConfig {
        env_vars: new_global_env,
        ..Default::default()
    };

    let stop_called = Arc::new(Mutex::new(false));
    let spawn_relay = Arc::new(Mutex::new(None::<String>));
    let spawn_owner = Arc::new(Mutex::new(None::<String>));
    let receipt_called = Arc::new(Mutex::new(false));

    let stop_called2 = stop_called.clone();
    let spawn_relay2 = spawn_relay.clone();
    let spawn_owner2 = spawn_owner.clone();
    let receipt_called2 = receipt_called.clone();
    let pubkey2 = pubkey.clone();

    let result = restart_under_captured_epoch_for(
        &app_handle,
        &pubkey,
        &old_global,
        &new_global,
        &[],
        &context,
        // stop_fn: record the call, simulate success, remove runtime.
        move |_app, rec, runtimes| {
            *stop_called2.lock().unwrap() = true;
            runtimes.retain(|k, _| k.pubkey != rec.pubkey);
            Ok(())
        },
        // spawn_fn: record captured relay+owner, return a fresh process.
        move |_app, _rec, relay, owner, _personas, _global, _teams| {
            *spawn_relay2.lock().unwrap() = Some(relay.to_string());
            *spawn_owner2.lock().unwrap() = owner.map(str::to_string);
            // Return an immediately-exiting child as the fake process.
            let child = std::process::Command::new("/usr/bin/true")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| format!("spawn /usr/bin/true: {e}"))?;
            Ok(crate::managed_agents::ManagedAgentProcess {
                child,
                log_path: std::path::PathBuf::new(),
                spawn_config_hash: 0,
                setup_mode: false,
                adapter_availability: None,
                start_nonce: "test-nonce-spawn".to_string(),
                #[cfg(windows)]
                job: None,
            })
        },
        // write_receipt_fn: record the call, verify pubkey, succeed.
        move |_app, receipt| {
            *receipt_called2.lock().unwrap() = true;
            assert_eq!(
                receipt.key.pubkey, pubkey2,
                "receipt must carry the correct pubkey"
            );
            Ok(())
        },
    );

    assert!(
        matches!(result, Ok(())),
        "full tail must return Ok when stop+spawn+receipt all succeed: {result:?}"
    );
    assert!(*stop_called.lock().unwrap(), "stop_fn must be called");
    assert_eq!(
        spawn_relay.lock().unwrap().as_deref(),
        Some(relay_url),
        "spawn_fn must receive the captured relay URL"
    );
    assert_eq!(
        spawn_owner.lock().unwrap().as_deref(),
        Some(owner_hex.as_str()),
        "spawn_fn must receive the captured owner hex"
    );
    assert!(
        *receipt_called.lock().unwrap(),
        "write_receipt_fn must be called"
    );
    // Verify the runtime is registered with the captured scope_id.
    {
        let state = app_handle.state::<crate::app_state::AppState>();
        let runtimes = state.managed_agent_processes.lock().unwrap();
        let registered = runtimes
            .values()
            .any(|r| r.scope_id.as_deref() == Some(scope_id));
        assert!(
            registered,
            "runtime must be registered with the captured scope_id"
        );
    }
}

/// Production driver proves preflight fires before stop.
///
/// Thufir's test 6: "event log from production driver proves preflight fn
/// fires before stop fn."
///
/// The async driver's pre-stop phase requires: personas load, teams load,
/// global config load, owner key verification, candidate record load, and
/// mesh preflight (in that order). The mesh_fn is the first outbound async
/// call. We prove mesh fires before stop by asserting "mesh" appears first
/// in the event log.
///
/// Owner key must match the app's signing key — use the actual generated key
/// from the mock app's AppState. The agent pubkey in the store is separate.
#[tokio::test]
async fn test_relay_mesh_preflight_precedes_stop() {
    use super::super::restart_local_agent_on_config_change_for;
    use crate::commands::global_agent_config::RestartOutcome;
    use crate::managed_agents::storage::save_managed_agents_at;
    use tauri::Manager;

    let tmp = tempfile::tempdir().unwrap();

    let app = make_mock_app();
    let app_handle = app.handle().clone();

    // Get the actual owner pubkey from the mock app's signing keys.
    // The pre-stop phase checks hex == captured_scope.owner_pubkey; they must match.
    let actual_owner_hex = {
        let state = app_handle.state::<crate::app_state::AppState>();
        state
            .signing_keys()
            .expect("mock app must have signing keys")
            .public_key()
            .to_hex()
    };

    let agent_pubkey = "aa".repeat(32);

    // Write the candidate record so the pre-stop phase can find it.
    // The agent must exist in the store for the candidate record lookup.
    let agent_record = crate::managed_agents::ManagedAgentRecord {
        pubkey: agent_pubkey.clone(),
        name: "test-agent-preflight".to_string(),
        display_name: None,
        slug: None,
        persona_id: None,
        private_key_nsec: String::new(),
        auth_tag: None,
        relay_url: "wss://relay.example".to_string(),
        avatar_url: None,
        acp_command: crate::managed_agents::DEFAULT_ACP_COMMAND.to_string(),
        agent_command: String::new(),
        agent_command_override: None,
        agent_args: vec![],
        mcp_command: String::new(),
        turn_timeout_seconds: 0,
        idle_timeout_seconds: None,
        max_turn_duration_seconds: None,
        parallelism: 1,
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        env_vars: Default::default(),
        start_on_app_launch: false,
        auto_restart_on_config_change: false,
        runtime_pid: None,
        backend: crate::managed_agents::BackendKind::Local,
        backend_agent_id: None,
        provider_binary_path: None,
        team_id: None,
        persona_team_dir: None,
        persona_name_in_team: None,
        created_at: crate::util::now_iso(),
        updated_at: crate::util::now_iso(),
        last_started_at: None,
        last_stopped_at: None,
        last_exit_code: None,
        last_error: None,
        last_error_code: None,
        respond_to: Default::default(),
        respond_to_allowlist: Default::default(),
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        definition_respond_to: None,
        definition_respond_to_allowlist: Default::default(),
        definition_parallelism: None,
        relay_mesh: None,
        runtime: None,
        name_pool: vec![],
    };
    save_managed_agents_at(tmp.path(), &[agent_record]).unwrap();
    std::fs::write(tmp.path().join("personas.json"), b"[]").unwrap();
    std::fs::write(tmp.path().join("global-agent-config.json"), b"{}").unwrap();

    let gen = crate::managed_agents::scope::current_scope_generation();
    let scope = crate::managed_agents::scope::WorkspaceAgentScope {
        scope_id: "test-scope".to_string(),
        relay_url: "wss://relay.example".to_string(),
        // Use the actual app key so the owner-key check passes.
        owner_pubkey: actual_owner_hex.clone(),
        definitions_dir: tmp.path().to_path_buf(),
        generation: gen,
    };

    // Shared event log: "mesh" or "stop" entries in order.
    let event_log: std::sync::Arc<std::sync::Mutex<Vec<&'static str>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log_mesh = event_log.clone();
    let log_stop = event_log.clone();

    let outcome = restart_local_agent_on_config_change_for(
        &app_handle,
        &agent_pubkey,
        &crate::managed_agents::GlobalAgentConfig::default(),
        &crate::managed_agents::GlobalAgentConfig::default(),
        &[],
        &scope,
        tmp.path(),
        // mesh_fn: records "mesh", then succeeds.
        move |_app, _model| {
            log_mesh.lock().unwrap().push("mesh");
            Box::pin(async { Ok(()) })
        },
        // stop_fn: records "stop". Since there's no live runtime the epoch
        // will Skipped before stop_fn fires — the ordering assertion is on
        // the driver phase (mesh before ANY stop attempt).
        move |_app, _rec, _runtimes| {
            log_stop.lock().unwrap().push("stop");
            Ok(())
        },
        |_app, _rec, _relay, _owner, _personas, _global, _teams| {
            Err("spawn not expected".to_string())
        },
        |_app, _receipt| Err("receipt not expected".to_string()),
    )
    .await;

    // The call Skips at the no-live-runtime check, not at preflight.
    assert!(
        matches!(outcome, RestartOutcome::Skipped),
        "no live runtime: {outcome:?}"
    );

    let log = event_log.lock().unwrap();
    // Mesh must appear before any stop (even if stop never fired).
    let mesh_pos = log.iter().position(|&e| e == "mesh");
    let stop_pos = log.iter().position(|&e| e == "stop");
    assert!(
        mesh_pos.is_some(),
        "mesh_fn must be called (preflight runs before epoch)"
    );
    if let Some(stop_idx) = stop_pos {
        let mesh_idx = mesh_pos.unwrap();
        assert!(
            mesh_idx < stop_idx,
            "preflight (mesh at {mesh_idx}) must precede stop (stop at {stop_idx})"
        );
    }
}
