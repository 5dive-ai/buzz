use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    managed_agents::{load_personas, save_personas, AgentDefinition},
    util::now_iso,
};

use super::retain_persona_pending;

#[tauri::command]
pub async fn set_persona_shared(
    id: String,
    shared: bool,
    app: AppHandle,
) -> Result<AgentDefinition, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let mut personas = load_personas(&app)?;
        let persona = personas
            .iter_mut()
            .find(|record| record.id == id)
            .ok_or_else(|| format!("agent {id} not found"))?;

        if persona.is_builtin {
            return Err("Built-in agents cannot be shared to the catalog.".to_string());
        }
        if persona.shared == shared {
            return Ok(persona.clone());
        }

        persona.shared = shared;
        persona.updated_at = now_iso();

        let updated = persona.clone();
        save_personas(&app, &personas)?;
        retain_persona_pending(&app, &state, &updated);
        Ok(updated)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}
