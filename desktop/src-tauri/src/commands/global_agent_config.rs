//! Tauri commands for global agent configuration defaults.
//!
//! `get_global_agent_config` / `set_global_agent_config` — simple load/save
//! around the `global_config` module with the standard save-time validation.
//!
//! `set_global_agent_config` additionally auto-restarts any running local agent
//! whose effective env changes under the new global config — including agents
//! that were in setup-listener mode (`NotReady`) but become `Ready`, and agents
//! already running whose provider/model/env vars change.  This is the only
//! honest way to deliver new env vars to a running process — the env is baked
//! at spawn time and cannot be mutated in place.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
    app_state::AppState,
    managed_agents::{
        agent_readiness, current_instance_id, find_managed_agent_mut, known_acp_runtime,
        load_global_agent_config, record_agent_command, resolve_effective_agent_env,
        stop_managed_agent_process, sync_managed_agent_processes, validate_global_config,
        AgentReadiness, BackendKind, GlobalAgentConfig,
    },
};

/// Result returned by `set_global_agent_config`.
///
/// Carries the canonical saved config together with restart counts. Use
/// `restarted_count` for "Restarted N agent(s)." feedback and
/// `failed_restart_count` to surface partial failures ("M failed to restart").
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalAgentConfigSaveResult {
    /// The persisted global config (after strip-on-write).
    pub config: GlobalAgentConfig,
    /// Number of local agents successfully stopped and restarted.
    pub restarted_count: u32,
    /// Number of agents whose stop succeeded but respawn failed.
    pub failed_restart_count: u32,
}

/// Read the current global agent configuration.
///
/// Returns the default (empty) config if `global-agent-config.json` has not
/// been written yet.
#[tauri::command]
pub fn get_global_agent_config(app: AppHandle) -> Result<GlobalAgentConfig, String> {
    load_global_agent_config(&app)
}

/// Validate and persist a new global agent configuration, then auto-restart
/// any running local agent whose effective env changes under the new config
/// (including setup-listener agents whose readiness flips to `Ready`).
///
/// Strips empty env values before writing (empty = "inherit" semantics), then
/// applies standard validation: POSIX key shape, reserved-key reject,
/// derived-provider-model-key reject, NUL/size caps.
///
/// Restart is best-effort: per-agent errors are logged to stderr and persisted
/// to `last_error` but do not fail the command.  Returns the saved config and
/// the count of agents successfully restarted.
#[tauri::command]
pub async fn set_global_agent_config(
    config: GlobalAgentConfig,
    app: AppHandle,
) -> Result<GlobalAgentConfigSaveResult, String> {
    use tauri::Manager;

    // Capture the active scope at command entry. All definition I/O targets
    // the captured scope's definitions_dir throughout both phases so a concurrent
    // workspace switch cannot split the config write (Phase 1) from the agent
    // restart (Phase 2) across two different scopes.
    let captured_scope = {
        let state = app.state::<AppState>();
        state
            .capture_active_scope()
            .ok_or("set_global_agent_config: no active workspace scope")?
    };
    let definitions_dir = captured_scope.definitions_dir.clone();

    // ── Phase 1: disk write (sync, spawn_blocking) ────────────────────────
    //
    // Validate, snapshot old config, write new config, collect pre-filter
    // candidate pubkeys (local backend + recorded PID + old NotReady + new
    // Ready).  The candidate list is a hint — eligibility is re-checked under
    // lock in Phase 2 after sync_managed_agent_processes.
    let app_for_write = app.clone();
    let definitions_dir_for_phase1 = definitions_dir.clone();
    let captured_scope_for_phase1 = captured_scope.clone();
    let phase1 = tokio::task::spawn_blocking(move || {
        validate_global_config(&config)?;

        let old_global = crate::managed_agents::global_config::load_global_agent_config_at(
            &definitions_dir_for_phase1,
        )
        .unwrap_or_default();

        // Validate generation before writing so a concurrent switch after the
        // command was dispatched doesn't clobber a newly activated scope's config.
        {
            use tauri::Manager;
            let state = app_for_write.state::<AppState>();
            let _store = state
                .managed_agents_store_lock
                .lock()
                .map_err(|e| e.to_string())?;
            crate::managed_agents::scope::validate_scope_generation(&captured_scope_for_phase1)
                .map_err(|e| format!("set_global_agent_config: {e}"))?;
            crate::managed_agents::global_config::save_global_agent_config_at(
                &definitions_dir_for_phase1,
                &config,
            )?;
        }

        // Re-read from disk so the returned value reflects the strip-on-write pass.
        let new_global = crate::managed_agents::global_config::load_global_agent_config_at(
            &definitions_dir_for_phase1,
        )?;

        // Pre-filter: identify agents that look eligible before taking any locks.
        // This is a hint only; definitive eligibility check happens under lock
        // in Phase 2.
        let (candidates, personas_snapshot) = collect_restart_candidates_at(
            &app_for_write,
            &definitions_dir_for_phase1,
            &old_global,
            &new_global,
        );

        Ok::<_, String>((new_global, old_global, candidates, personas_snapshot))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))??;
    let (new_global, old_global, candidates, personas_snapshot) = phase1;

    // ── Phase 2: async restart (outside spawn_blocking) ──────────────────
    //
    // For each candidate: stop under the lock (re-verifying eligibility after
    // sync_managed_agent_processes), then start via start_local_agent_with_preflight
    // — the same path as a manual restart.  This ensures owner_hex is computed
    // and passed (NIP-OA auth_tag fallback), the persona is re-snapshotted, and
    // last_error is persisted on failure.
    //
    // Uses the same captured `definitions_dir` as Phase 1 so a concurrent
    // workspace switch cannot split config-write from agent-restart across scopes.
    // Generation is re-validated under lock before each stop.
    //
    // Errors are non-fatal; the caller always receives the saved config.
    // failed_restart_count surfaces stops that succeeded but respawn failed.
    let mut restarted_count: u32 = 0;
    let mut failed_restart_count: u32 = 0;
    if !candidates.is_empty() {
        for pubkey in &candidates {
            let outcome = restart_local_agent_on_config_change(
                &app,
                pubkey,
                &old_global,
                &new_global,
                &personas_snapshot,
                &captured_scope,
                &definitions_dir,
            )
            .await;
            match outcome {
                RestartOutcome::Restarted => restarted_count += 1,
                RestartOutcome::FailedAfterStop => failed_restart_count += 1,
                RestartOutcome::Skipped => {}
            }
        }
    }

    Ok(GlobalAgentConfigSaveResult {
        config: new_global,
        restarted_count,
        failed_restart_count,
    })
}

/// Outcome of a single per-agent restart attempt in Phase 2.
#[derive(Debug)]
enum RestartOutcome {
    /// Stop succeeded and the agent re-launched with the new config.
    Restarted,
    /// Stop succeeded but the subsequent spawn failed.
    FailedAfterStop,
    /// Eligibility check failed under lock — agent skipped without touching it.
    Skipped,
}

/// Error returned by [`restart_under_captured_epoch`].
#[derive(Debug)]
enum EpochError {
    /// Eligibility check failed before the stop; the agent was not touched.
    Skipped(String),
    /// Stop succeeded but the subsequent spawn failed.
    FailedAfterStop(String),
}

/// Collect pubkeys of local agents that should be restarted after a global
/// config change, together with the personas snapshot used for the scan.
///
/// Scoped variant used by Phase 1 of `set_global_agent_config`: reads from the
/// captured `definitions_dir` rather than the live active scope so a concurrent
/// workspace switch cannot redirect the scan to a different scope's records.
///
/// Pre-lock hint — eligibility is re-verified under lock in Phase 2. The personas
/// snapshot is threaded to `restart_local_agent_on_config_change` so it is not
/// reloaded per agent.
///
/// An agent is a candidate when it is a local backend with a recorded PID, and
/// either:
/// - its readiness transitions `NotReady → Ready` (was blocked on missing
///   provider/model key, now unblocked), OR
/// - it was already `Ready`, its process is currently alive, and its effective
///   env changed (provider, model, or env var update that needs a restart to
///   take effect, since env is baked at spawn time).
fn collect_restart_candidates_at(
    app: &AppHandle,
    definitions_dir: &std::path::Path,
    old_global: &GlobalAgentConfig,
    new_global: &GlobalAgentConfig,
) -> (Vec<String>, Vec<crate::managed_agents::AgentDefinition>) {
    let records = match crate::managed_agents::storage::load_managed_agents_at(definitions_dir) {
        Ok(r) => r,
        Err(e) => {
            eprintln!(
                "buzz-desktop: set_global_agent_config: failed to load agents for restart scan: {e}"
            );
            return (Vec::new(), Vec::new());
        }
    };
    let all_personas = match crate::managed_agents::load_personas_at(definitions_dir) {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "buzz-desktop: set_global_agent_config: failed to load personas for restart scan: {e}"
            );
            return (Vec::new(), Vec::new());
        }
    };
    use tauri::Manager;
    let state = app.state::<AppState>();
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .unwrap_or_else(|error| error.into_inner());

    let candidates = records
        .iter()
        .filter(|record| {
            if record.backend != BackendKind::Local {
                return false;
            }
            let has_live_runtime = runtimes.iter_mut().any(|(key, runtime)| {
                key.pubkey.eq_ignore_ascii_case(&record.pubkey)
                    && runtime.child.try_wait().ok().flatten().is_none()
            });
            if !has_live_runtime {
                return false;
            }
            let effective_cmd = record_agent_command(record, &all_personas);
            let runtime_meta = known_acp_runtime(&effective_cmd);
            let old_effective =
                resolve_effective_agent_env(record, &all_personas, runtime_meta, old_global);
            let new_effective =
                resolve_effective_agent_env(record, &all_personas, runtime_meta, new_global);
            let old_ready = matches!(agent_readiness(&old_effective), AgentReadiness::Ready);
            let new_ready = matches!(agent_readiness(&new_effective), AgentReadiness::Ready);
            // For a Ready+running agent: the process must be alive now and the
            // process-env map must differ.  The alive check avoids queuing a
            // restart for a process that already exited between the pre-filter
            // scan and Phase 2.  NotReady→Ready bypasses the alive check
            // because Phase 2 will stop-then-start unconditionally.
            let env_changed = old_ready && old_effective.env != new_effective.env;

            should_restart_on_config_change(old_ready, new_ready, env_changed)
        })
        .map(|r| r.pubkey.clone())
        .collect();

    (candidates, all_personas)
}

/// Restart a local agent whose effective env changed under the new global config.
///
/// Drives the entire stop→spawn sequence through one
/// [`restart_under_captured_epoch`] call so no concurrent workspace switch can
/// land between the stop and the spawn.  Returns [`RestartOutcome::FailedAfterStop`]
/// when the stop succeeded but the spawn failed; [`RestartOutcome::Skipped`] when
/// eligibility was lost before the stop.
async fn restart_local_agent_on_config_change(
    app: &AppHandle,
    pubkey: &str,
    old_global: &GlobalAgentConfig,
    new_global: &GlobalAgentConfig,
    personas_snapshot: &[crate::managed_agents::AgentDefinition],
    captured_scope: &crate::managed_agents::scope::WorkspaceAgentScope,
    definitions_dir: &std::path::Path,
) -> RestartOutcome {
    let app_owned = app.clone();
    let pubkey_owned = pubkey.to_string();
    let old_global_owned = old_global.clone();
    let new_global_owned = new_global.clone();
    let personas_owned = personas_snapshot.to_vec();
    let captured_scope_owned = captured_scope.clone();
    let definitions_dir_owned = definitions_dir.to_path_buf();

    // Entire stop+spawn in one spawn_blocking call under one transition+store epoch.
    let result = tokio::task::spawn_blocking(move || {
        restart_under_captured_epoch(
            &app_owned,
            &pubkey_owned,
            &old_global_owned,
            &new_global_owned,
            &personas_owned,
            &captured_scope_owned,
            &definitions_dir_owned,
        )
    })
    .await;

    match result {
        Ok(Ok(())) => {
            eprintln!(
                "buzz-desktop: set_global_agent_config: restarted agent {pubkey} with updated config"
            );
            RestartOutcome::Restarted
        }
        Ok(Err(EpochError::Skipped(e))) => {
            eprintln!("buzz-desktop: set_global_agent_config: skipping restart of {pubkey}: {e}");
            RestartOutcome::Skipped
        }
        Ok(Err(EpochError::FailedAfterStop(e))) => {
            eprintln!(
                "buzz-desktop: set_global_agent_config: failed to start {pubkey} after stop: {e}"
            );
            // persist_last_error acquires the store lock itself — never call
            // it while the epoch lock is held (restart_under_captured_epoch
            // releases all locks before returning Err).
            if let Err(save_err) = persist_last_error(app, pubkey, &e, captured_scope) {
                eprintln!(
                    "buzz-desktop: set_global_agent_config: failed to persist last_error for {pubkey}: {save_err}"
                );
            }
            RestartOutcome::FailedAfterStop
        }
        Err(e) => {
            eprintln!(
                "buzz-desktop: set_global_agent_config: spawn_blocking panicked for {pubkey}: {e}"
            );
            RestartOutcome::Skipped
        }
    }
}

/// One atomic stop→spawn epoch for a single agent restart.
///
/// Acquires `managed_agent_runtime_transition` and `managed_agents_store_lock`
/// once, validates the captured generation, stops the process, and immediately
/// spawns the replacement — all while both locks are held.  No live wrapper is
/// called past the stop: records, personas, global config, owner hex, and scope
/// ID all derive from `captured_scope`.
///
/// Called from inside `spawn_blocking` — no `.await` points, standard mutexes only.
fn restart_under_captured_epoch<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pubkey: &str,
    old_global: &GlobalAgentConfig,
    new_global: &GlobalAgentConfig,
    personas_snapshot: &[crate::managed_agents::AgentDefinition],
    captured_scope: &crate::managed_agents::scope::WorkspaceAgentScope,
    definitions_dir: &std::path::Path,
) -> Result<(), EpochError> {
    use crate::managed_agents::{
        managed_agent_runtime_keys,
        storage::{load_managed_agents_at, save_managed_agents_at},
        ManagedAgentPairRuntime, ManagedAgentRuntimeKey,
    };
    use tauri::Manager;

    let state = app.state::<AppState>();

    // Hold transition from stop through spawn — no concurrent start can enter.
    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|e| EpochError::Skipped(format!("transition lock poisoned: {e}")))?;

    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| EpochError::Skipped(format!("store lock poisoned: {e}")))?;

    // Validate captured generation before touching any state.
    crate::managed_agents::scope::validate_scope_generation(captured_scope)
        .map_err(|e| EpochError::Skipped(format!("stale scope: {e}")))?;

    let mut records = load_managed_agents_at(definitions_dir)
        .map_err(|e| EpochError::Skipped(format!("load records: {e}")))?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| EpochError::Skipped(format!("runtimes lock poisoned: {e}")))?;

    let (sync_changed, _) =
        sync_managed_agent_processes(&mut records, &mut runtimes, &current_instance_id(app));
    if sync_changed {
        save_managed_agents_at(definitions_dir, &records)
            .map_err(|e| EpochError::Skipped(format!("save after sync: {e}")))?;
    }

    // Re-check eligibility under both locks.
    let record = records
        .iter()
        .find(|r| r.pubkey == pubkey)
        .ok_or_else(|| EpochError::Skipped(format!("agent {pubkey} not found")))?;
    if record.backend != BackendKind::Local {
        return Err(EpochError::Skipped(format!(
            "agent {pubkey} is not a local agent"
        )));
    }
    let runtime_keys = managed_agent_runtime_keys(&runtimes, pubkey);
    if runtime_keys.is_empty() {
        return Err(EpochError::Skipped(format!(
            "agent {pubkey} has no live pair runtime after sync"
        )));
    }
    let relay_urls: Vec<String> = runtime_keys.iter().map(|k| k.relay_url.clone()).collect();

    let effective_cmd = record_agent_command(record, personas_snapshot);
    let runtime_meta = known_acp_runtime(&effective_cmd);
    let old_effective =
        resolve_effective_agent_env(record, personas_snapshot, runtime_meta, old_global);
    let new_effective =
        resolve_effective_agent_env(record, personas_snapshot, runtime_meta, new_global);
    let old_ready = matches!(agent_readiness(&old_effective), AgentReadiness::Ready);
    let new_ready = matches!(agent_readiness(&new_effective), AgentReadiness::Ready);
    let env_changed = old_ready && old_effective.env != new_effective.env;
    if !should_restart_on_config_change(old_ready, new_ready, env_changed) {
        return Err(EpochError::Skipped(format!(
            "agent {pubkey} restart condition no longer valid under lock"
        )));
    }

    // Stop and save captured.
    let record_mut = find_managed_agent_mut(&mut records, pubkey)
        .map_err(|e| EpochError::Skipped(format!("find record: {e}")))?;
    stop_managed_agent_process(app, record_mut, &mut runtimes)
        .map_err(|e| EpochError::FailedAfterStop(format!("stop failed: {e}")))?;
    save_managed_agents_at(definitions_dir, &records)
        .map_err(|e| EpochError::FailedAfterStop(format!("save after stop: {e}")))?;

    // Load personas and global config from the captured dir — no live wrapper past here.
    let personas_at = crate::managed_agents::load_personas_at(definitions_dir).unwrap_or_default();
    let global_at =
        crate::managed_agents::global_config::load_global_agent_config_at(definitions_dir)
            .unwrap_or_default();

    // Reload records with the updated last_stopped_at.
    let mut records = load_managed_agents_at(definitions_dir)
        .map_err(|e| EpochError::FailedAfterStop(format!("reload records after stop: {e}")))?;

    // Captured owner and scope from the captured scope — not from live state.
    let owner_hex = &captured_scope.owner_pubkey;
    let scope_id = captured_scope.scope_id.clone();
    let mut spawn_errors: Vec<String> = Vec::new();

    for relay_url in &relay_urls {
        let key = match ManagedAgentRuntimeKey::new(pubkey, relay_url) {
            Ok(k) => k,
            Err(e) => {
                spawn_errors.push(format!("{relay_url}: key error: {e}"));
                continue;
            }
        };

        // Apply persona snapshot before spawning (same as interactive start path).
        if let Ok(record_mut) = find_managed_agent_mut(&mut records, pubkey) {
            if let Some(persona_id) = record_mut.persona_id.clone() {
                if let Some(persona) = personas_at.iter().find(|p| p.id == persona_id) {
                    crate::managed_agents::persona_events::apply_persona_snapshot(
                        record_mut, persona,
                    );
                    record_mut.updated_at = crate::util::now_iso();
                }
            }
        }

        // Spawn using captured personas/global config and captured owner.
        let spawn_record = match records.iter().find(|r| r.pubkey == pubkey).cloned() {
            Some(r) => r,
            None => {
                spawn_errors.push(format!("{relay_url}: record disappeared before spawn"));
                continue;
            }
        };
        let spawn_result = crate::managed_agents::spawn_agent_child_at(
            app,
            &spawn_record,
            relay_url,
            true,
            Some(owner_hex.as_str()),
            &personas_at,
            &global_at,
        );
        let mut process = match spawn_result {
            Ok(p) => p,
            Err(e) => {
                spawn_errors.push(format!("{relay_url}: spawn: {e}"));
                continue;
            }
        };

        let now = crate::util::now_iso();
        let receipt = crate::managed_agents::ManagedAgentRuntimeReceipt {
            key: key.clone(),
            pid: process.child.id(),
            desktop_instance_id: current_instance_id(app),
            started_at: now.clone(),
        };
        if let Err(e) = crate::managed_agents::write_agent_runtime_receipt(app, &receipt) {
            let _ = crate::managed_agents::terminate_process(process.child.id());
            let _ = process.child.wait();
            spawn_errors.push(format!("{relay_url}: receipt: {e}"));
            continue;
        }

        if let Ok(record_mut) = find_managed_agent_mut(&mut records, pubkey) {
            record_mut.runtime_pid = None;
            record_mut.updated_at = now.clone();
            record_mut.last_started_at = Some(now);
            record_mut.last_stopped_at = None;
            record_mut.last_error = None;
        }
        runtimes.insert(
            key.clone(),
            ManagedAgentPairRuntime::starting(process, Some(scope_id.clone())),
        );
    }

    save_managed_agents_at(definitions_dir, &records)
        .map_err(|e| EpochError::FailedAfterStop(format!("save after spawn: {e}")))?;

    // Drop runtimes lock before retention (retention uses its own DB mutex).
    drop(runtimes);

    // Retain the agent event under the captured retention scope while transition
    // + store are still held so no interleave can corrupt the pending row.
    if let Some(saved_record) = records.iter().find(|r| r.pubkey == pubkey) {
        // Get owner keys from current state and verify they still match the
        // captured scope. If the scope has since changed, skip retention
        // (best-effort: the record was already saved to captured dir above).
        let owner_keys_result = state.signing_keys();
        let scope_result = owner_keys_result
            .ok()
            .filter(|k| {
                k.public_key()
                    .to_hex()
                    .eq_ignore_ascii_case(&captured_scope.owner_pubkey)
            })
            .map(|keys| {
                crate::managed_agents::retention::retention_scope_from_captured(
                    captured_scope,
                    keys,
                )
            });
        match scope_result {
            Some(Ok(scope)) => {
                use crate::managed_agents::{
                    reconcile::retain_agent_record, retention::open_retention_db,
                };
                if let Ok(conn) = open_retention_db(&scope.db_path) {
                    let _ = retain_agent_record(&conn, &scope.owner_keys, saved_record);
                }
            }
            Some(Err(e)) => {
                eprintln!(
                    "buzz-desktop: set_global_agent_config: retention scope error for {pubkey}: {e}"
                );
            }
            None => {
                // Keys unavailable or scope switched — skip retention (best-effort).
            }
        }
    }

    if spawn_errors.is_empty() {
        Ok(())
    } else {
        Err(EpochError::FailedAfterStop(spawn_errors.join("; ")))
    }
}

/// Persist a `last_error` on the agent record under a freshly acquired store lock.
///
/// Best-effort: called only after a failed restart to surface a diagnosable
/// stopped state in the UI.  Takes `captured_scope`, validates generation under
/// the acquired lock so a stale write doesn't silently target the old scope.
///
/// MUST NOT be called while `managed_agents_store_lock` is already held — this
/// function acquires the lock itself and fails closed on poison.
fn persist_last_error(
    app: &AppHandle,
    pubkey: &str,
    error: &str,
    captured_scope: &crate::managed_agents::scope::WorkspaceAgentScope,
) -> Result<(), String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| format!("persist_last_error: store lock poisoned — fail closed: {e}"))?;
    crate::managed_agents::scope::validate_scope_generation(captured_scope)
        .map_err(|e| format!("persist_last_error: stale scope, skipping write: {e}"))?;
    let definitions_dir = &captured_scope.definitions_dir;
    let mut records = crate::managed_agents::storage::load_managed_agents_at(definitions_dir)?;
    let record = find_managed_agent_mut(&mut records, pubkey)?;
    record.last_error = Some(error.to_string());
    record.updated_at = crate::util::now_iso();
    crate::managed_agents::storage::save_managed_agents_at(definitions_dir, &records)
}

/// Pure predicate: should an agent be restarted given resolved readiness and
/// effective-env snapshots?
///
/// Extracted so the restart decision logic can be unit-tested without an
/// `AppHandle` or `EffectiveAgentEnv`.  Both `collect_restart_candidates` and
/// the under-lock eligibility check in `restart_local_agent_on_config_change`
/// delegate to this predicate.
///
/// Conditions:
/// - `NotReady → Ready`: blocked on missing key, now unblocked.
/// - `Ready + env changed`: running with stale env; env is baked at spawn time.
///   Also covers `Ready → NotReady` when the env changed (key removed).
///
/// **Readiness invariant (T,F,F):** For `buzz-agent` and `goose`, readiness is
/// derived purely from `EffectiveAgentEnv` — it cannot flip without an env delta.
/// For `claude`/`codex`, `cli_login_requirements` queries runtime auth state
/// (e.g. `claude auth status`), so readiness CAN flip Ready→NotReady without
/// an env change. In that case combo (T,F,F) evaluates to `false` — the running
/// agent is NOT restarted. This is intentional: the env is unchanged, and a
/// restart would not repair the missing auth token. If the binary disappears,
/// the process would already be dead and the PID alive-check in the candidate
/// scan would have excluded it.
fn should_restart_on_config_change(old_ready: bool, new_ready: bool, env_changed: bool) -> bool {
    (!old_ready && new_ready) || (old_ready && env_changed)
}

#[cfg(test)]
mod tests {
    use super::{restart_under_captured_epoch, should_restart_on_config_change, EpochError};

    /// Running agent (Ready) whose effective env changed → restart candidate.
    #[test]
    fn env_changed_running_agent_is_candidate() {
        // old_ready=true, new_ready=true, env_changed=true
        assert!(
            should_restart_on_config_change(true, true, true),
            "running agent with changed env must be restarted"
        );
    }

    /// Running agent (Ready) whose effective env did NOT change → not a candidate.
    #[test]
    fn unchanged_running_agent_is_not_candidate() {
        // old_ready=true, new_ready=true, env_changed=false
        assert!(
            !should_restart_on_config_change(true, true, false),
            "running agent with identical env must NOT be restarted"
        );
    }

    /// NotReady → Ready transition is admitted regardless of env diff.
    #[test]
    fn not_ready_to_ready_is_candidate() {
        // old_ready=false, new_ready=true, env_changed=false (env_changed irrelevant)
        assert!(
            should_restart_on_config_change(false, true, false),
            "NotReady → Ready must be a restart candidate"
        );
    }

    /// Ready → NotReady (config became invalid, env changed) is admitted so the
    /// agent restarts into setup-listener mode via the normal spawn path.
    #[test]
    fn ready_to_not_ready_env_changed_is_candidate() {
        // old_ready=true (had key), new_ready=false (key removed), env_changed=true
        assert!(
            should_restart_on_config_change(true, false, true),
            "Ready → NotReady with env change must be a restart candidate"
        );
    }

    /// Both NotReady, env unchanged → not a candidate (nothing to restart).
    #[test]
    fn both_not_ready_unchanged_is_not_candidate() {
        // old_ready=false, new_ready=false, env_changed=false
        assert!(
            !should_restart_on_config_change(false, false, false),
            "both NotReady with no env change must NOT be a candidate"
        );
    }

    /// NotReady + env changed but new still NotReady → not a candidate.
    #[test]
    fn not_ready_env_changed_still_not_ready_is_not_candidate() {
        // Changed one unrelated env var but still missing the required key.
        // old_ready=false, new_ready=false, env_changed=true
        assert!(
            !should_restart_on_config_change(false, false, true),
            "NotReady→NotReady (env changed but still broken) must NOT be a candidate"
        );
    }

    /// NotReady → Ready AND env also changed → still a restart candidate.
    ///
    /// Guards against a future `&& !env_changed` regression on the
    /// NotReady→Ready branch: env_changed is irrelevant when readiness
    /// unblocks — the agent must restart regardless of whether env also differed.
    #[test]
    fn not_ready_to_ready_with_env_change_is_candidate() {
        // old_ready=false, new_ready=true, env_changed=true
        assert!(
            should_restart_on_config_change(false, true, true),
            "NotReady → Ready (with env change) must be a restart candidate"
        );
    }

    // ── restart_under_captured_epoch: generation guard ────────────────────────
    //
    // These tests call `restart_under_captured_epoch` directly — the production
    // stop→spawn primitive — using a `tauri::test::mock_app()` runtime so the
    // AppHandle is real. No live process is running, so the restart is skipped
    // at the eligibility check. The generation tests drive the path that matters:
    // does the captured-generation guard prevent a stale-scope restart?

    fn make_test_scope(
        definitions_dir: &std::path::Path,
    ) -> crate::managed_agents::scope::WorkspaceAgentScope {
        let gen = crate::managed_agents::scope::current_scope_generation();
        crate::managed_agents::scope::WorkspaceAgentScope {
            scope_id: "test-scope".to_string(),
            relay_url: "wss://relay.example".to_string(),
            owner_pubkey: "aa".repeat(32),
            definitions_dir: definitions_dir.to_path_buf(),
            generation: gen,
        }
    }

    /// `restart_under_captured_epoch` with a fresh scope and an empty store
    /// (no live pair runtime) → `EpochError::Skipped` after the agent-not-found
    /// or no-live-runtime check. The generation guard passes, proving the path
    /// proceeds to the eligibility check rather than aborting at the stale check.
    ///
    /// This is the stop-to-spawn production path: transition lock acquired,
    /// store lock acquired, generation validated — all before any state change.
    #[test]
    fn test_restart_under_captured_epoch_fresh_scope_no_runtime_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        // Write an empty managed-agents.json so load_managed_agents_at returns Ok([]).
        std::fs::write(tmp.path().join("managed-agents.json"), b"[]").unwrap();

        let app = tauri::test::mock_builder()
            .manage(crate::app_state::build_app_state())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("failed to build mock app");
        let app_handle = app.handle().clone();
        let captured_scope = make_test_scope(tmp.path());

        let result = restart_under_captured_epoch(
            &app_handle,
            &"aa".repeat(32),
            &crate::managed_agents::GlobalAgentConfig::default(),
            &crate::managed_agents::GlobalAgentConfig::default(),
            &[],
            &captured_scope,
            tmp.path(),
        );

        // No live runtime → Skipped before any state change.
        assert!(
            matches!(result, Err(EpochError::Skipped(_))),
            "no live pair runtime must produce Skipped, not FailedAfterStop or Ok: {result:?}"
        );
        // Verify the skip message describes the agent-not-found or no-runtime reason.
        if let Err(EpochError::Skipped(msg)) = result {
            let is_expected = msg.contains("not found") || msg.contains("no live pair runtime");
            assert!(
                is_expected,
                "Skipped reason must be agent-not-found or no-live-runtime: {msg}"
            );
        }
    }

    /// `restart_under_captured_epoch` with a STALE scope → `EpochError::Skipped`
    /// at the generation validation step, before touching any agent state.
    ///
    /// This is the switch-between-stop-and-spawn test: simulates the race where
    /// a workspace switch advances the generation between when the scope was
    /// captured and when `restart_under_captured_epoch` runs. The generation
    /// guard must abort before stopping — no agent is touched.
    #[test]
    fn test_restart_under_captured_epoch_stale_scope_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("managed-agents.json"), b"[]").unwrap();

        let app = tauri::test::mock_builder()
            .manage(crate::app_state::build_app_state())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("failed to build mock app");
        let app_handle = app.handle().clone();

        // Capture the scope at the current generation, then advance to make it stale.
        let stale_scope = make_test_scope(tmp.path());
        crate::managed_agents::scope::next_scope_generation();

        let result = restart_under_captured_epoch(
            &app_handle,
            &"aa".repeat(32),
            &crate::managed_agents::GlobalAgentConfig::default(),
            &crate::managed_agents::GlobalAgentConfig::default(),
            &[],
            &stale_scope,
            tmp.path(),
        );

        // Stale generation → Skipped at the generation-validation step.
        assert!(
            matches!(result, Err(EpochError::Skipped(_))),
            "stale scope must produce Skipped: {result:?}"
        );
        if let Err(EpochError::Skipped(msg)) = result {
            assert!(
                msg.contains("stale scope") || msg.contains("generation"),
                "Skipped reason must mention stale scope or generation mismatch: {msg}"
            );
        }
    }
}
