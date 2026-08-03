use nostr::Keys;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_state::AppState;
use crate::managed_agents::{
    effective_repos_dir, ensure_repos_symlink, nest_dir, restore_managed_agents_on_launch,
    try_regenerate_nest, write_persisted_repos_dir,
};
use crate::relay;

#[derive(Deserialize)]
struct RelayInfoIcon {
    #[serde(default)]
    icon: Option<String>,
}

/// Fetch a relay's workspace icon from its NIP-11 relay information document.
///
/// Works for any workspace (active or not) with a plain unauthenticated HTTP
/// GET — no WebSocket session needed. Returns `None` when the relay has no
/// icon set, is unreachable, or serves a malformed document: the rail falls
/// back to initials in all three cases.
#[tauri::command]
pub async fn fetch_workspace_icon(
    relay_url: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let http_url = relay::relay_http_base_url(&relay_url);
    let Ok(response) = state
        .http_client
        .get(&http_url)
        .header("Accept", "application/nostr+json")
        .send()
        .await
    else {
        return Ok(None);
    };
    if !response.status().is_success() {
        return Ok(None);
    }
    let doc = response
        .json::<RelayInfoIcon>()
        .await
        .unwrap_or(RelayInfoIcon { icon: None });
    Ok(doc.icon.filter(|icon| !icon.is_empty()))
}

#[derive(Serialize)]
pub struct ActiveWorkspaceInfo {
    relay_url: String,
    pubkey: String,
}

/// Returns the current active workspace info (relay URL + pubkey).
#[tauri::command]
pub fn get_active_workspace(state: State<'_, AppState>) -> Result<ActiveWorkspaceInfo, String> {
    let keys = state.keys.lock().map_err(|e| e.to_string())?;
    let relay_url = relay::relay_ws_url_with_override(&state);
    Ok(ActiveWorkspaceInfo {
        relay_url,
        pubkey: keys.public_key().to_hex(),
    })
}

/// Validate a candidate `repos_dir` without mutating the filesystem.
///
/// The Add/Edit workspace dialogs call this on submit to block Save on a bad
/// path, so a typo never reaches `apply_workspace`. Reuses the same
/// `validate_repos_dir` the boot/apply path uses — one source of truth for
/// "what's a valid repos dir". An empty/whitespace value clears the override
/// and is valid. `Err` carries the human-readable reason for inline display.
#[tauri::command]
pub async fn validate_repos_dir(dir: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let trimmed = dir.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        let nest = nest_dir().ok_or("cannot resolve home directory for nest")?;
        crate::managed_agents::validate_repos_dir(&nest, trimmed).map(|_| ())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Apply a workspace's configuration to the backend session.
///
/// Called by the frontend on app init (after reload) to configure the
/// Tauri backend with the selected workspace's relay URL, keys, and repos
/// directory.
///
/// Returns `WorkspaceApplyResult`:
/// - `applied: true` → new scope committed; post-commit failures surface as
///   `degraded` entries (informational — workspace IS active).
/// - `applied: false` → drain failed; old scope still active; `degraded`
///   names what could not be stopped or restored by compensation.
///
/// A bad `repos_dir` is non-fatal: relay/keys always apply (the relay is the
/// active workspace's own choice — orthogonal to the filesystem repos dir),
/// the bad value is NOT persisted (so the next boot starts clean), the
/// `REPOS` symlink is skipped (REPOS stays a real dir), a `repos-dir-error`
/// event surfaces the reason. The dialogs already block a bad path at Save
/// (`validate_repos_dir`); this fallback only catches a value that went bad
/// after save (deleted dir, unmounted volume).
#[tauri::command]
pub async fn apply_workspace(
    relay_url: String,
    nsec: Option<String>,
    repos_dir: Option<String>,
    agent_managed_profiles: Option<bool>,
    app: AppHandle,
) -> Result<crate::managed_agents::scope::WorkspaceApplyResult, String> {
    use crate::managed_agents::scope::WorkspaceApplyResult;

    // ── Layer 1: async serialization lock ────────────────────────────────────
    // workspace_transition serializes apply_workspace and live identity import
    // so scope transitions are never concurrent. We acquire via a clone so the
    // borrow does not prevent moving `app` into spawn_blocking below.
    let lock_app = app.clone();
    let lock_state = lock_app.state::<AppState>();
    let _transition_guard = lock_state.workspace_transition.lock().await;

    // ── Layer 1 async: drain the Mesh client if it belongs to another relay ──
    // Serve-mode runtimes stay pinned (machine-level, unaffected by workspace
    // switches). Client-mode runtimes bound to a different relay are drained
    // here, in the async layer, before entering spawn_blocking (which cannot
    // await). Non-fatal: a drain failure is logged and the switch proceeds.
    #[cfg(feature = "mesh-llm")]
    {
        if let Err(error) =
            crate::commands::mesh_llm::scope_impl::drain_mesh_client_if_stale(&app, &relay_url)
                .await
        {
            eprintln!("buzz-desktop: Mesh client drain before workspace switch failed: {error}");
        }
    }

    let restore_app = app.clone();
    let blocking_result: Result<WorkspaceApplyResult, String> =
        tokio::task::spawn_blocking(move || {
            let state = app.state::<AppState>();

            // ── Validate before mutating ──────────────────────────────────────
            let parsed_keys = match nsec.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(nsec_trimmed) => {
                    Some(Keys::parse(nsec_trimmed).map_err(|e| format!("invalid nsec: {e}"))?)
                }
                None => None,
            };

            // Decide the effective repos_dir from the candidate. A bad path does NOT
            // reject — it is treated as if no override were set: relay/keys still
            // apply, the bad value is not persisted, and a `repos-dir-error` surfaces
            // the reason.
            let nest = nest_dir();
            let effective_repos_dir = match nest.as_deref() {
                Some(nest) => match effective_repos_dir(nest, repos_dir.as_deref()) {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = app.emit("repos-dir-error", error);
                        None
                    }
                },
                None => None,
            };

            // ── Prepare: derive target scope and run staged initialization ────
            // Reversible prepare stage: the old scope remains active throughout.
            let base_dir = crate::managed_agents::managed_agents_base_dir(&app).unwrap_or_default();
            let effective_owner_pubkey = match &parsed_keys {
                Some(keys) => keys.public_key().to_hex(),
                None => state
                    .keys
                    .lock()
                    .map_err(|e| e.to_string())?
                    .public_key()
                    .to_hex(),
            };
            let target_scope_id =
                crate::managed_agents::scope::derive_scope_id(&relay_url, &effective_owner_pubkey);
            let scope_dir =
                crate::managed_agents::scope::scoped_definitions_dir(&base_dir, &target_scope_id);
            crate::managed_agents::scope_init::ensure_scope_ready(
                &target_scope_id,
                &scope_dir,
                &base_dir,
            )?;

            // ── Persona snapshot backfill (still in prepare stage) ────────────
            // Run before commit so auto-start agents in the newly-ready scope
            // have valid persona snapshots available at the first restore pass.
            // Best-effort: a failure is logged but does not block the transition.
            if let Err(e) = crate::managed_agents::backfill_persona_snapshots_at(
                &scope_dir,
                &state,
            ) {
                eprintln!("buzz-desktop: persona-snapshot backfill failed during prepare: {e}");
            }

            // ── Legacy retention migration (still in prepare stage) ───────────
            // Migrate legacy retained events into this scope's retention DB BEFORE
            // committing the scope as active. Both the retention and definition
            // stores must be migrated together so event-sync sees consistent data.
            // Best-effort: a failure is logged and does not block the transition.
            {
                let effective_owner_pubkey_for_retention = match &parsed_keys {
                    Some(keys) => keys.public_key().to_hex(),
                    None => state
                        .keys
                        .lock()
                        .map_err(|e| e.to_string())?
                        .public_key()
                        .to_hex(),
                };
                let retention_db_path = crate::managed_agents::retention::scoped_retention_db_path(
                    &base_dir,
                    &relay_url,
                    &effective_owner_pubkey_for_retention,
                );
                if let Some(parent) = retention_db_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                match crate::managed_agents::retention::migrate_legacy_retention_db(
                    &base_dir,
                    &retention_db_path,
                    &effective_owner_pubkey_for_retention,
                ) {
                    Ok(0) => {}
                    Ok(copied) => eprintln!(
                        "buzz-desktop: adopted {copied} legacy retained event(s) into this community"
                    ),
                    Err(error) => eprintln!(
                        "buzz-desktop: legacy retention migration failed during prepare: {error}"
                    ),
                }
            }

            // ── Layer 2: drain + commit under one continuous lock ─────────────
            // `managed_agent_runtime_transition` is held from journal creation
            // through the end of the commit swap so no start/reconcile can insert
            // a new runtime into the gap between drain and scope publication.
            //
            // All fallible guards (relay_url_override, keys, active_agent_scope)
            // are acquired BEFORE any field is mutated so a poison or other lock
            // failure cannot leave us half-committed with old processes drained.
            let rt_transition = state
                .managed_agent_runtime_transition
                .lock()
                .map_err(|e| e.to_string())?;

            // Build the journal and drain under the held transition lock.
            let (stopped_entries, _remaining, drain_error) =
                crate::managed_agents::drain_scope_runtimes(&app, &state);

            if let Some(drain_err) = drain_error {
                // Drain failed — compensate by restarting what we stopped.
                // The rt_transition lock stays held during compensation so the
                // runtime map is still protected.
                let comp_err = crate::managed_agents::compensate_drain(&app, &stopped_entries);
                drop(rt_transition);
                let degraded_msg = match comp_err {
                    Some(comp) => {
                        format!("drain failed ({drain_err}); compensation also failed: {comp}")
                    }
                    None => format!("drain failed ({drain_err}); old runtimes restored"),
                };
                return Ok(WorkspaceApplyResult::drain_failed(degraded_msg));
            }

            // Acquire all fallible commit guards BEFORE mutating any field.
            // If any guard fails, compensation runs and no field has changed.
            let mut override_guard = match state.relay_url_override.lock() {
                Ok(g) => g,
                Err(e) => {
                    let comp_err = crate::managed_agents::compensate_drain(&app, &stopped_entries);
                    drop(rt_transition);
                    let msg = format!(
                        "commit failed (relay lock poisoned: {e}){}",
                        comp_err
                            .map_or_else(String::new, |c| format!("; compensation failed: {c}"))
                    );
                    return Ok(WorkspaceApplyResult::drain_failed(msg));
                }
            };
            let mut keys_guard = match state.keys.lock() {
                Ok(g) => g,
                Err(e) => {
                    let comp_err = crate::managed_agents::compensate_drain(&app, &stopped_entries);
                    drop(override_guard);
                    drop(rt_transition);
                    let msg = format!(
                        "commit failed (keys lock poisoned: {e}){}",
                        comp_err
                            .map_or_else(String::new, |c| format!("; compensation failed: {c}"))
                    );
                    return Ok(WorkspaceApplyResult::drain_failed(msg));
                }
            };
            let mut scope_guard = match state.active_agent_scope.lock() {
                Ok(g) => g,
                Err(e) => {
                    let comp_err = crate::managed_agents::compensate_drain(&app, &stopped_entries);
                    drop(keys_guard);
                    drop(override_guard);
                    drop(rt_transition);
                    let msg = format!(
                        "commit failed (scope lock poisoned: {e}){}",
                        comp_err
                            .map_or_else(String::new, |c| format!("; compensation failed: {c}"))
                    );
                    return Ok(WorkspaceApplyResult::drain_failed(msg));
                }
            };

            // ── Infallible commit: all guards held, no .await, no I/O ─────────
            *override_guard = Some(relay_url.clone());
            drop(override_guard);
            crate::relay_admission::reset_gate_for_workspace_change();

            if let Some(new_keys) = parsed_keys {
                *keys_guard = new_keys;
            }
            let owner_pubkey = keys_guard.public_key().to_hex();
            drop(keys_guard);

            state
                .managed_agent_profile_reconcile_enabled
                .store(!agent_managed_profiles.unwrap_or(false), Ordering::Release);

            let generation = crate::managed_agents::scope::next_scope_generation();
            let scope = crate::managed_agents::scope::WorkspaceAgentScope::new(
                relay_url,
                owner_pubkey,
                &base_dir,
                generation,
            );
            *scope_guard = Some(scope);
            drop(scope_guard);
            drop(rt_transition);

            // ── Filesystem side-effects (non-fatal) ───────────────────────────
            if let Some(nest) = nest.as_deref() {
                if let Err(error) = write_persisted_repos_dir(nest, effective_repos_dir.as_deref())
                {
                    eprintln!("buzz-desktop: persist repos dir failed: {error}");
                }
                if let Err(error) = ensure_repos_symlink(nest, effective_repos_dir.as_deref()) {
                    eprintln!("buzz-desktop: repos dir setup failed: {error}");
                    let _ = app.emit("repos-dir-error", error);
                }
            }

            Ok::<WorkspaceApplyResult, String>(WorkspaceApplyResult::success())
        })
        .await
        .map_err(|e| format!("spawn_blocking failed: {e}"))?;

    // If blocking returned a drain-failed result, surface it now.
    let apply_result = blocking_result?;
    if !apply_result.applied {
        return Ok(apply_result);
    }

    // ── Post-commit (non-rollback) ────────────────────────────────────────────
    // The workspace HAS switched. Post-commit failures surface as degradation
    // on the applied result — we never pretend the old scope survived.
    let mut degraded: Vec<String> = Vec::new();

    // Nest context reflects the active scope's agents.md — regenerate now that
    // the scope is committed. Best-effort; agents run fine with a stale AGENTS.md.
    if let Err(error) = try_regenerate_nest(&restore_app) {
        degraded.push(format!("nest context regeneration failed: {error}"));
    }

    let state = restore_app.state::<AppState>();
    match crate::managed_agents::retention::active_retention_scope(&restore_app, &state) {
        Ok(scope) => {
            if let Some(agent_scope) = state.capture_active_scope() {
                if let Err(error) = crate::event_sync::spawn_event_sync(
                    restore_app.clone(),
                    scope.owner_keys,
                    scope.db_path,
                    agent_scope.definitions_dir,
                ) {
                    degraded.push(format!("event-sync dispatch failed: {error}"));
                }
            } else {
                degraded.push(
                    "active agent scope unavailable after workspace apply — event sync skipped"
                        .to_string(),
                );
            }
        }
        Err(error) => {
            degraded.push(format!(
                "scoped event-sync unavailable after workspace apply: {error}"
            ));
        }
    }

    // Per-transition restore: always restore the new scope's auto-start agents
    // (replaces the launch-only `managed_agent_restore_pending.swap` one-shot).
    // Fire-and-forget spawn so the command returns promptly; failures are logged.
    #[cfg(feature = "mesh-llm")]
    {
        let app = restore_app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            // Restore mesh sharing first so a slow stopped-status request cannot
            // overwrite a newly restored serving status.
            if let Err(error) = crate::commands::mesh_llm::restore_mesh_sharing(&app, &state).await
            {
                eprintln!("buzz-desktop: failed to restore Share Compute: {error}");
            }
            crate::mesh_llm::publish_current_status_once(&app, "workspace apply").await;
            if let Err(error) =
                restore_managed_agents_on_launch(&app, &state.shutdown_started).await
            {
                eprintln!("buzz-desktop: failed to restore managed agents: {error}");
            }
        });
    }

    #[cfg(not(feature = "mesh-llm"))]
    {
        let app = restore_app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            if let Err(error) =
                restore_managed_agents_on_launch(&app, &state.shutdown_started).await
            {
                eprintln!("buzz-desktop: failed to restore managed agents: {error}");
            }
        });
    }

    if degraded.is_empty() {
        Ok(WorkspaceApplyResult::success())
    } else {
        Ok(degraded
            .into_iter()
            .fold(WorkspaceApplyResult::success(), |r, msg| {
                r.with_degradation(msg)
            }))
    }
}
