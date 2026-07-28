//! `mint_agent_card` / `save_agent_card` Tauri commands — Agent Trading Cards.
//!
//! Mints a collectible trading-card PNG for an agent via one OpenAI Responses
//! API call (designer model + native `image_generation` tool), then embeds the
//! agent's `buzz_agent_snapshot` manifest through the existing snapshot
//! encoder so the card IS an importable `.agent.png`.
//!
//! Boundary rules (agreed with Wren, buzz-agent-trading-cards thread):
//! - Snapshot construction/injection reuses `agent_snapshot.rs` — cards
//!   inherit manifest-v1 behavior, exclusions, and size checks. No card-only
//!   wire format exists.
//! - Memory exclusion is structural: the manifest is built with
//!   `MemoryLevel::None`; the encoder itself rejects `none` + entries.
//! - The 10 MiB `.agent.png` ceiling is enforced on the FINAL bytes (after
//!   resize + chunk injection) via `validate_snapshot_encode_size`.
//! - Round-trip verification decodes the final bytes and compares the logical
//!   manifest before anything is returned to the frontend.
//! - The API key is resolved through the same env layering the agent runtime
//!   uses (global config < persona < agent record) and never leaves Rust.
//!   It is never logged.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::{AppHandle, State};

use super::super::export_util::save_bytes_with_dialog;
use super::snapshot::{resolve_from_lists, validate_snapshot_encode_size};
use crate::{
    app_state::AppState,
    managed_agents::{
        agent_snapshot::{
            build_snapshot, decode_avatar_data_url, decode_snapshot_png, encode_snapshot_png,
            extract_chunk_payload_png, MemoryLevel,
        },
        agent_snapshot_envelope::{
            decrypt_envelope, encode_locked_snapshot_png, parse_chunk_payload, ChunkPayload,
        },
        load_agent_definitions, load_global_agent_config, load_managed_agents, load_personas,
    },
};

/// The Buzz card frame template — Tyler's gold-honeycomb base. Generation
/// input only: it never participates in the snapshot manifest, PNG chunk,
/// import decoder, or attachment validation. Embedded at compile time for
/// deterministic packaging (see `card_template_decodes` test).
const CARD_TEMPLATE_PNG: &[u8] = include_bytes!("../../../assets/card_template.png");

/// Designer model driving copy + art direction.
const DESIGNER_MODEL: &str = "gpt-5.6-sol";
/// Image model invoked natively via the Responses `image_generation` tool.
const IMAGE_MODEL: &str = "gpt-image-2";
/// Final card width in pixels (2:3 portrait → 1500x2250).
const CARD_WIDTH: u32 = 1500;
/// Upper bound for a fetched avatar (pre-resize input to the model).
const MAX_AVATAR_FETCH_BYTES: usize = 10 * 1024 * 1024;
/// One mint is a single long API call (~2–3 minutes observed).
const MINT_TIMEOUT_SECS: u64 = 600;

/// Error prefix the frontend matches to route the user to provider settings
/// instead of showing a raw failure.
pub(crate) const NO_KEY_ERROR_PREFIX: &str = "NO_OPENAI_KEY:";

/// Wire shape returned by `mint_agent_card`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MintedCard {
    /// Final `.agent.png` bytes (chunk-injected, round-trip verified),
    /// base64-encoded for the IPC boundary.
    pub card_png_base64: String,
    /// Suggested filename, e.g. `eva.agent.png`.
    pub file_name: String,
    /// Designer commentary emitted alongside the image (may be empty).
    pub designer_notes: String,
    /// True when the embedded snapshot is NIP-44-encrypted to the
    /// (owner, agent) pair — only their nsecs can import this card.
    pub locked: bool,
}

// ── Key resolution ────────────────────────────────────────────────────────────

/// Pure layering: global env < persona env < agent record env, then the
/// process environment as a development fallback. Returns the first
/// non-empty `OPENAI_API_KEY`.
pub(crate) fn resolve_openai_key_from_layers(
    global_env: &std::collections::BTreeMap<String, String>,
    persona_env: &std::collections::BTreeMap<String, String>,
    record_env: &std::collections::BTreeMap<String, String>,
    process_key: Option<String>,
) -> Option<String> {
    for layer in [record_env, persona_env, global_env] {
        if let Some(v) = layer.get("OPENAI_API_KEY") {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    process_key.filter(|k| !k.trim().is_empty())
}

// ── Prompt construction ───────────────────────────────────────────────────────

/// Build the designer instructions. Pure so tests can pin the contract:
/// style-match-the-avatar is DEFAULT behavior, user style notes are additive.
pub(crate) fn build_card_instructions(
    agent_name: &str,
    persona_notes: &str,
    style_notes: &str,
) -> String {
    let extra_style = if style_notes.trim().is_empty() {
        String::new()
    } else {
        format!("\nAdditional art direction from the owner: {style_notes}\n")
    };
    format!(
        r#"You are designing one premium collectible trading card for the Buzz agent "{agent_name}".

Input image 1 is the official Buzz card frame template (gold honeycomb border, dark interior, name banner top, hex badge top-right, text box lower third). Input image 2 is the agent's avatar — study its exact art style: medium, pixel grid if any, palette, shading, background motifs.

Persona notes for the card copy:
{persona_notes}
{extra_style}
First, write professional trading-card copy at Magic: The Gathering editorial quality:
- a type line (e.g. "Legendary Agent — Team Lead"),
- ONE keyworded ability: short bolded ability name + one sentence of crisp rules text written like real MTG rules (present tense, precise, no fluff),
- ONE italic flavor-text line, evocative and short, the kind that gets quoted.
Keep total text-box copy under 220 characters so it renders cleanly.

Then generate the finished card with the image tool, exactly 1024x1536 portrait:
- The frame must follow input image 1 faithfully: same gold honeycomb border, same layout, honey drip detail.
- The art window must match input image 2's art style EXACTLY — same medium, same pixel density if pixel art, same palette, same background honeycomb-lattice sky. It must look like the same artist drew a larger scene: the character in a confident pose, conjuring glowing golden hexagons.
- Name banner: "{agent_name}" plus the type line beneath it in smaller type.
- Text box: the ability name in bold, rules text in regular, then the flavor line in italics, cleanly typeset like a real MTG card — professional kerning, no misspellings, hyphenate nothing.
- Top-right hex badge: one small emblem of your choice, no text.
Render all text with perfect fidelity."#
    )
}

/// Encode raw image bytes as a `data:image/png;base64,` URL, downscaling to
/// `max_dim` on the longest edge so request payloads stay small.
fn image_data_url(bytes: &[u8], max_dim: u32) -> Result<String, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("Failed to decode image: {e}"))?;
    let img = if img.width().max(img.height()) > max_dim {
        img.resize(max_dim, max_dim, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode image: {e}"))?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(&png)))
}

// ── Response parsing ──────────────────────────────────────────────────────────

/// Extract the generated image (base64) and any designer text from a
/// Responses API payload. Pure for testability.
pub(crate) fn extract_card_output(resp: &serde_json::Value) -> Result<(String, String), String> {
    let output = resp
        .get("output")
        .and_then(|o| o.as_array())
        .ok_or_else(|| "Responses payload has no output array".to_string())?;

    let mut image_b64 = None;
    let mut notes = Vec::new();
    for item in output {
        match item.get("type").and_then(|t| t.as_str()) {
            Some("image_generation_call") => {
                if let Some(result) = item.get("result").and_then(|r| r.as_str()) {
                    image_b64 = Some(result.to_string());
                }
            }
            Some("message") => {
                if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
                    for c in content {
                        if c.get("type").and_then(|t| t.as_str()) == Some("output_text") {
                            if let Some(text) = c.get("text").and_then(|t| t.as_str()) {
                                notes.push(text.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let image_b64 = image_b64.ok_or_else(|| {
        let types: Vec<&str> = output
            .iter()
            .filter_map(|i| i.get("type").and_then(|t| t.as_str()))
            .collect();
        format!("No image in Responses output (item types: {types:?})")
    })?;
    Ok((image_b64, notes.join("\n")))
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Mint a trading card for the agent identified by `id` (instance pubkey,
/// instance slug, or definition slug — same resolution as snapshot export).
///
/// When `lock` is true the embedded manifest is NIP-44-encrypted to the
/// (owner, agent) pair per the locked-envelope contract — this requires a
/// linked agent instance (the second key endpoint); bare definitions cannot
/// be locked.
///
/// Returns the final, chunk-injected, round-trip-verified `.agent.png` bytes.
/// Reroll = call again; the command holds no session state.
#[tauri::command]
pub async fn mint_agent_card(
    id: String,
    style_notes: Option<String>,
    lock: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MintedCard, String> {
    let lock = lock.unwrap_or(false);
    // ── Resolve the record + API key under lock ──────────────────────────────
    let (record, is_definition, api_key) = {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;

        let instances = load_managed_agents(&app)?;
        let definitions = load_agent_definitions(&app)?;
        let (record, is_definition) =
            resolve_from_lists(&id, &instances, &definitions).map(|(r, d)| (r.clone(), d))?;

        let global = load_global_agent_config(&app).unwrap_or_default();
        let personas = load_personas(&app).unwrap_or_default();
        let persona_env = record
            .persona_id
            .as_deref()
            .and_then(|pid| personas.iter().find(|p| p.id == pid))
            .map(|p| p.env_vars.clone())
            .unwrap_or_default();

        let api_key = resolve_openai_key_from_layers(
            &global.env_vars,
            &persona_env,
            &record.env_vars,
            std::env::var("OPENAI_API_KEY").ok(),
        )
        .ok_or_else(|| {
            format!(
                "{NO_KEY_ERROR_PREFIX} No OPENAI_API_KEY found. Add one in the agent's \
                 environment variables or global agent settings to mint cards."
            )
        })?;

        (record, is_definition, api_key)
    };

    // ── Locking needs its two exact key endpoints up front, BEFORE the
    //    API spend: the owner identity secret and the agent instance pubkey.
    let lock_keys = if lock {
        if is_definition {
            return Err(
                "Locked cards need a linked agent instance — this persona has never been \
                 started, so there is no agent key to lock to."
                    .to_string(),
            );
        }
        let owner_keys = state.signing_keys()?;
        let agent_pubkey = nostr::PublicKey::from_hex(&record.pubkey)
            .map_err(|e| format!("Agent record has an invalid pubkey: {e}"))?;
        if owner_keys.public_key() == agent_pubkey {
            return Err("Cannot lock a card to itself: owner and agent keys match.".to_string());
        }
        Some((owner_keys, agent_pubkey))
    } else {
        None
    };

    let display_name = record
        .display_name
        .clone()
        .unwrap_or_else(|| record.name.clone());

    // ── Resolve avatar bytes (data URL, else fetch) ──────────────────────────
    let avatar_bytes = match record.avatar_url.as_deref() {
        Some(url) if url.starts_with("data:") => decode_avatar_data_url(url)
            .ok_or_else(|| "Agent avatar data URL could not be decoded.".to_string())?,
        Some(url) if url.starts_with("http://") || url.starts_with("https://") => {
            fetch_avatar(url).await?
        }
        _ => {
            return Err(
                "Agent has no avatar image. Set an avatar before minting a card.".to_string(),
            )
        }
    };

    // ── Build the manifest now (memory NONE, structural) so a broken agent
    //    fails before we spend minutes on the API call. ───────────────────────
    let manifest_avatar = decode_avatar_data_url(record.avatar_url.as_deref().unwrap_or(""));
    let snapshot = build_snapshot(
        &record,
        MemoryLevel::None,
        Vec::new(),
        manifest_avatar.as_deref(),
    );

    // ── One Responses API call ───────────────────────────────────────────────
    // For locked mints, prove the manifest fits the NIP-44 plaintext cap
    // BEFORE spending minutes on the API call (same fail-early rule as the
    // memory guard above).
    if lock_keys.is_some() {
        let json_len =
            crate::managed_agents::agent_snapshot::encode_snapshot_json(&snapshot)?.len();
        if json_len > buzz_core_pkg::engram::NIP44_PLAINTEXT_MAX {
            return Err(format!(
                "Agent manifest is too large to lock ({json_len} bytes; the encrypted \
                 format caps at {}). Reduce the avatar size or mint an unlocked card.",
                buzz_core_pkg::engram::NIP44_PLAINTEXT_MAX
            ));
        }
    }
    let instructions = build_card_instructions(
        &display_name,
        snapshot.definition.system_prompt.as_deref().unwrap_or(""),
        style_notes.as_deref().unwrap_or(""),
    );
    let body = serde_json::json!({
        "model": DESIGNER_MODEL,
        "reasoning": {"effort": "high"},
        "instructions": "You are a senior TCG card designer and MTG rules editor.",
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": instructions},
                {"type": "input_image", "image_url": image_data_url(CARD_TEMPLATE_PNG, 1024)?},
                {"type": "input_image", "image_url": image_data_url(&avatar_bytes, 1024)?},
            ],
        }],
        "tools": [{
            "type": "image_generation",
            "model": IMAGE_MODEL,
            "quality": "high",
            "size": "1024x1536",
            "output_format": "png",
        }],
        "tool_choice": "required",
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(MINT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let resp = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Card mint request failed: {e}"))?;

    let status = resp.status();
    let payload: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Card mint response was not JSON: {e}"))?;
    if !status.is_success() {
        // Never echo the request (it embeds nothing secret, but keep the
        // failure surface small); the OpenAI error body is safe to surface.
        let detail = payload
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("unknown error");
        return Err(format!("Card mint failed (HTTP {status}): {detail}"));
    }

    let (image_b64, designer_notes) = extract_card_output(&payload)?;
    let raw_card = STANDARD
        .decode(image_b64.as_bytes())
        .map_err(|e| format!("Generated image was not valid base64: {e}"))?;

    // ── Resize to 1500-wide, inject chunk via the existing encoder ──────────
    let card_img = image::load_from_memory(&raw_card)
        .map_err(|e| format!("Generated image could not be decoded: {e}"))?;
    let scale = CARD_WIDTH as f64 / card_img.width() as f64;
    let card_img = card_img.resize(
        CARD_WIDTH,
        (card_img.height() as f64 * scale).round() as u32,
        image::imageops::FilterType::Lanczos3,
    );
    let mut card_png = Vec::new();
    card_img
        .write_to(
            &mut std::io::Cursor::new(&mut card_png),
            image::ImageFormat::Png,
        )
        .map_err(|e| format!("Failed to encode card PNG: {e}"))?;

    let final_bytes = match &lock_keys {
        None => encode_snapshot_png(&snapshot, Some(&card_png))
            .map_err(|e| format!("Failed to embed agent snapshot in card: {e}"))?,
        Some((owner_keys, agent_pubkey)) => {
            encode_locked_snapshot_png(&snapshot, owner_keys, agent_pubkey, Some(&card_png))
                .map_err(|e| format!("Failed to embed locked agent snapshot in card: {e}"))?
        }
    };

    // ── Verify: size ceiling + round-trip on the FINAL bytes ────────────────
    // Locked cards: extract the actual chunk, parse the envelope, decrypt
    // with the owner key, then compare the logical manifest (ciphertext is
    // nondeterministic — never compare bytes).
    validate_snapshot_encode_size(final_bytes.len(), true)?;
    let decoded = match &lock_keys {
        None => decode_snapshot_png(&final_bytes)
            .map_err(|e| format!("Card failed round-trip verification: {e}"))?,
        Some((owner_keys, _)) => {
            let payload = extract_chunk_payload_png(&final_bytes)
                .map_err(|e| format!("Card failed round-trip verification: {e}"))?;
            match parse_chunk_payload(&payload)
                .map_err(|e| format!("Card failed round-trip verification: {e}"))?
            {
                ChunkPayload::Locked(envelope) => {
                    decrypt_envelope(&envelope, owner_keys.secret_key())
                        .map_err(|e| format!("Card failed round-trip verification: {e}"))?
                }
                ChunkPayload::Plain(_) => {
                    return Err(
                        "Card round-trip verification failed: expected a locked envelope."
                            .to_string(),
                    )
                }
            }
        }
    };
    if decoded != snapshot {
        return Err("Card round-trip verification failed: manifest mismatch.".to_string());
    }

    let slug = crate::util::slugify(&display_name, "agent", 50);
    Ok(MintedCard {
        card_png_base64: STANDARD.encode(&final_bytes),
        file_name: format!("{slug}.agent.png"),
        designer_notes,
        locked: lock_keys.is_some(),
    })
}

/// Fetch an avatar over HTTP with a hard size cap.
///
/// The cap bounds network and memory, not just the final buffer: the
/// Content-Length header is checked before any body bytes are read, and the
/// body is streamed with a running count so a missing or dishonest header
/// still cannot exceed the cap (same contract as `media_download.rs`).
async fn fetch_avatar(url: &str) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch agent avatar: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Avatar fetch failed: HTTP {}", resp.status()));
    }

    if let Some(content_length) = resp.content_length() {
        if content_length > MAX_AVATAR_FETCH_BYTES as u64 {
            return Err("Agent avatar is too large to use as card input.".to_string());
        }
    }

    let mut bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read avatar bytes: {e}"))?;
        append_within_avatar_cap(&mut bytes, &chunk)?;
    }
    Ok(bytes)
}

/// Append a body chunk to the avatar buffer, rejecting before the append if
/// the total would cross `MAX_AVATAR_FETCH_BYTES`. Split out so the cap
/// boundary is unit-testable without an HTTP server.
fn append_within_avatar_cap(buf: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if buf.len() + chunk.len() > MAX_AVATAR_FETCH_BYTES {
        return Err("Agent avatar is too large to use as card input.".to_string());
    }
    buf.extend_from_slice(chunk);
    Ok(())
}

/// Save previously minted card bytes to disk via the OS save dialog.
///
/// Re-validates the bytes (chunk parses as a plain manifest or a
/// structurally valid locked envelope, size within the import ceiling) so a
/// corrupted preview can never be written as a `.agent.png`. No decryption
/// happens here — the mint already round-trip-verified with the real key.
#[tauri::command]
pub async fn save_agent_card(
    card_png_base64: String,
    file_name: String,
    app: AppHandle,
) -> Result<bool, String> {
    let bytes = STANDARD
        .decode(card_png_base64.as_bytes())
        .map_err(|e| format!("Card bytes were not valid base64: {e}"))?;
    validate_snapshot_encode_size(bytes.len(), true)?;
    let payload = extract_chunk_payload_png(&bytes)
        .map_err(|e| format!("Refusing to save: card failed snapshot validation: {e}"))?;
    parse_chunk_payload(&payload)
        .map_err(|e| format!("Refusing to save: card failed snapshot validation: {e}"))?;

    let safe_name = if file_name.ends_with(".agent.png") && !file_name.contains(['/', '\\']) {
        file_name
    } else {
        "card.agent.png".to_string()
    };
    save_bytes_with_dialog(&app, &safe_name, "Agent card", &["png"], &bytes).await
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn card_template_decodes_with_expected_shape() {
        // The embedded template is generation input only, but a corrupt or
        // accidentally swapped asset should fail the build's test gate, not a
        // user's first mint.
        let img = image::load_from_memory(CARD_TEMPLATE_PNG).expect("template must decode");
        // 2:3-ish portrait frame.
        assert!(img.height() > img.width(), "template must be portrait");
        assert!(img.width() >= 512, "template unexpectedly small");
    }

    #[test]
    fn key_resolution_layering_record_wins() {
        let mut global = BTreeMap::new();
        global.insert("OPENAI_API_KEY".to_string(), "global".to_string());
        let mut persona = BTreeMap::new();
        persona.insert("OPENAI_API_KEY".to_string(), "persona".to_string());
        let mut record = BTreeMap::new();
        record.insert("OPENAI_API_KEY".to_string(), "record".to_string());

        assert_eq!(
            resolve_openai_key_from_layers(&global, &persona, &record, None).as_deref(),
            Some("record")
        );
        record.clear();
        assert_eq!(
            resolve_openai_key_from_layers(&global, &persona, &record, None).as_deref(),
            Some("persona")
        );
        persona.clear();
        assert_eq!(
            resolve_openai_key_from_layers(&global, &persona, &record, None).as_deref(),
            Some("global")
        );
        global.clear();
        assert_eq!(
            resolve_openai_key_from_layers(&global, &persona, &record, Some("process".to_string()))
                .as_deref(),
            Some("process")
        );
        assert!(resolve_openai_key_from_layers(&global, &persona, &record, None).is_none());
    }

    #[test]
    fn key_resolution_skips_blank_values() {
        let mut record = BTreeMap::new();
        record.insert("OPENAI_API_KEY".to_string(), "   ".to_string());
        let mut persona = BTreeMap::new();
        persona.insert("OPENAI_API_KEY".to_string(), "persona".to_string());
        assert_eq!(
            resolve_openai_key_from_layers(&BTreeMap::new(), &persona, &record, None).as_deref(),
            Some("persona")
        );
    }

    #[test]
    fn instructions_pin_style_match_default_and_additive_notes() {
        let base = build_card_instructions("Eva", "leads the team", "");
        assert!(base.contains("match input image 2's art style EXACTLY"));
        assert!(base.contains("\"Eva\""));
        assert!(!base.contains("Additional art direction"));

        let styled = build_card_instructions("Eva", "leads the team", "make it stormy");
        assert!(styled.contains("Additional art direction from the owner: make it stormy"));
        // Style notes are additive — the default style anchor must survive.
        assert!(styled.contains("match input image 2's art style EXACTLY"));
    }

    #[test]
    fn extract_card_output_happy_path_and_missing_image() {
        let ok = serde_json::json!({
            "output": [
                {"type": "reasoning"},
                {"type": "image_generation_call", "result": "aW1n"},
                {"type": "message", "content": [
                    {"type": "output_text", "text": "notes here"}
                ]}
            ]
        });
        let (img, notes) = extract_card_output(&ok).unwrap();
        assert_eq!(img, "aW1n");
        assert_eq!(notes, "notes here");

        let missing = serde_json::json!({"output": [{"type": "message", "content": []}]});
        let err = extract_card_output(&missing).unwrap_err();
        assert!(err.contains("No image"), "{err}");

        let no_output = serde_json::json!({});
        assert!(extract_card_output(&no_output).is_err());
    }

    #[test]
    fn avatar_cap_rejects_before_appending_crossing_chunk() {
        // The streaming accumulator must reject a chunk that would cross the
        // cap BEFORE buffering it — this is what bounds memory when
        // Content-Length is missing or dishonest.
        let mut buf = vec![0u8; MAX_AVATAR_FETCH_BYTES - 1];
        assert!(append_within_avatar_cap(&mut buf, &[0u8]).is_ok());
        assert_eq!(buf.len(), MAX_AVATAR_FETCH_BYTES);
        // Exactly at the cap: one more byte must fail and not grow the buffer.
        assert!(append_within_avatar_cap(&mut buf, &[0u8]).is_err());
        assert_eq!(buf.len(), MAX_AVATAR_FETCH_BYTES);

        // A single oversized chunk is rejected outright.
        let mut fresh = Vec::new();
        let oversized = vec![0u8; MAX_AVATAR_FETCH_BYTES + 1];
        assert!(append_within_avatar_cap(&mut fresh, &oversized).is_err());
        assert!(fresh.is_empty());
    }

    #[test]
    fn save_rejects_plain_png_without_snapshot_chunk() {
        // A plain PNG (no buzz_agent_snapshot chunk) must not be saveable as
        // a card. Exercise the same validation the command runs.
        let img = image::DynamicImage::new_rgba8(4, 4);
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        assert!(decode_snapshot_png(&png).is_err());
    }
}
