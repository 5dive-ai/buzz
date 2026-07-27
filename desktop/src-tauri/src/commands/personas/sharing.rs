use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    managed_agents::{
        load_personas,
        retention::{mark_synced, open_retention_db},
        AgentDefinition,
    },
};

use super::pending::{prepare_persona_publication, PreparedPersonaPublication};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PersonaSharePublicationStatus {
    Published,
    Queued,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPersonaSharedResult {
    pub persona: AgentDefinition,
    pub publication_status: PersonaSharePublicationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_message: Option<String>,
}

#[tauri::command]
pub async fn set_persona_shared(
    id: String,
    shared: bool,
    app: AppHandle,
) -> Result<SetPersonaSharedResult, String> {
    let prepared = tokio::task::spawn_blocking({
        let app = app.clone();
        move || {
            let state = app.state::<AppState>();
            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;
            let personas = load_personas(&app)?;
            let persona = personas
                .iter()
                .find(|record| record.id == id)
                .ok_or_else(|| format!("agent {id} not found"))?;

            if persona.is_builtin {
                return Err("Built-in agents cannot be shared to the catalog.".to_string());
            }

            // Strict path: unlike ordinary definition saves, an enqueue failure
            // for this privacy-sensitive toggle must reach the command/UI.
            prepare_persona_publication(&app, &state, persona, Some(shared))
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))??;

    let state = app.state::<AppState>();
    publish_prepared_persona(&state, prepared).await
}

async fn publish_prepared_persona(
    state: &AppState,
    prepared: PreparedPersonaPublication,
) -> Result<SetPersonaSharedResult, String> {
    let api_base_url = crate::relay::relay_http_base_url(&prepared.scope.relay_url);
    let publish_result = crate::relay::submit_signed_event_at_with_keys(
        &prepared.event,
        state,
        &api_base_url,
        &prepared.scope.owner_keys,
    )
    .await;

    match publish_result {
        Ok(_) => {
            let conn = open_retention_db(&prepared.scope.db_path)?;
            mark_synced(
                &conn,
                prepared.retained.kind,
                &prepared.retained.pubkey,
                &prepared.retained.d_tag,
                prepared.retained.created_at,
                &prepared.retained.content,
            )?;
            Ok(SetPersonaSharedResult {
                persona: prepared.persona,
                publication_status: PersonaSharePublicationStatus::Published,
                relay_message: None,
            })
        }
        Err(error) => Ok(SetPersonaSharedResult {
            persona: prepared.persona,
            publication_status: PersonaSharePublicationStatus::Queued,
            relay_message: Some(error),
        }),
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;
    use crate::{
        app_state::build_app_state,
        commands::personas::pending::prepare_persona_publication_at,
        managed_agents::{
            retention::{get_retained_event, open_retention_db, RetentionScope},
            AgentDefinition,
        },
    };
    use std::collections::BTreeMap;

    fn persona() -> AgentDefinition {
        AgentDefinition {
            id: "catalog-reviewer".to_string(),
            display_name: "Catalog Reviewer".to_string(),
            avatar_url: None,
            system_prompt: "Review the catalog.".to_string(),
            runtime: None,
            model: None,
            provider: None,
            name_pool: Vec::new(),
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            env_vars: BTreeMap::new(),
            respond_to: None,
            respond_to_allowlist: Vec::new(),
            parallelism: None,
            created_at: "2026-07-27T00:00:00Z".to_string(),
            updated_at: "2026-07-27T00:00:00Z".to_string(),
        }
    }

    async fn spawn_relay(accepted: bool) -> String {
        use axum::{routing::post, Router};

        let app = Router::new().route(
            "/events",
            post(move |body: String| async move {
                let event: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                serde_json::json!({
                    "event_id": event.get("id").and_then(serde_json::Value::as_str).unwrap_or(""),
                    "accepted": accepted,
                    "message": if accepted { "" } else { "policy rejection" }
                })
                .to_string()
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        format!("http://{addr}")
    }

    fn prepared(
        db_path: &std::path::Path,
        relay_url: String,
        keys: nostr::Keys,
    ) -> PreparedPersonaPublication {
        let (event, retained, persona) =
            prepare_persona_publication_at(db_path, &keys, &persona(), Some(true)).unwrap();
        PreparedPersonaPublication {
            scope: RetentionScope {
                db_path: db_path.to_path_buf(),
                relay_url,
                owner_keys: keys,
            },
            event,
            retained,
            persona,
        }
    }

    #[tokio::test]
    async fn relay_rejection_stays_durably_queued() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("retention.db");
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let prepared = prepared(&db_path, spawn_relay(false).await, keys);
        let state = build_app_state();

        let result = publish_prepared_persona(&state, prepared).await.unwrap();

        assert_eq!(
            result.publication_status,
            PersonaSharePublicationStatus::Queued
        );
        assert!(result
            .relay_message
            .as_deref()
            .is_some_and(|message| message.contains("relay rejected event")));
        assert!(
            get_retained_event(
                &open_retention_db(&db_path).unwrap(),
                buzz_core_pkg::kind::KIND_PERSONA,
                &owner,
                "catalog-reviewer"
            )
            .unwrap()
            .unwrap()
            .pending_sync
        );
    }

    #[tokio::test]
    async fn unavailable_relay_stays_durably_queued() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("retention.db");
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let prepared = prepared(&db_path, relay_url, keys);
        let state = build_app_state();

        let result = publish_prepared_persona(&state, prepared).await.unwrap();

        assert_eq!(
            result.publication_status,
            PersonaSharePublicationStatus::Queued
        );
        assert!(result
            .relay_message
            .as_deref()
            .is_some_and(|message| message.starts_with("relay unreachable:")));
        assert!(
            get_retained_event(
                &open_retention_db(&db_path).unwrap(),
                buzz_core_pkg::kind::KIND_PERSONA,
                &owner,
                "catalog-reviewer"
            )
            .unwrap()
            .unwrap()
            .pending_sync
        );
    }

    #[tokio::test]
    async fn relay_acceptance_marks_the_scoped_head_synced() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("retention.db");
        let keys = nostr::Keys::generate();
        let owner = keys.public_key().to_hex();
        let prepared = prepared(&db_path, spawn_relay(true).await, keys);
        let state = build_app_state();

        let result = publish_prepared_persona(&state, prepared).await.unwrap();

        assert_eq!(
            result.publication_status,
            PersonaSharePublicationStatus::Published
        );
        assert!(
            !get_retained_event(
                &open_retention_db(&db_path).unwrap(),
                buzz_core_pkg::kind::KIND_PERSONA,
                &owner,
                "catalog-reviewer"
            )
            .unwrap()
            .unwrap()
            .pending_sync
        );
    }
}
