//! NIP-IA identity archival commands.
//!
//! Modules:
//! - `inventory` — exhaustive relay inventory of owned agent instances
//! - `archive_op` — scoped archive / unarchive request flow
//!
//! Shared items (classifier, snapshot helpers, resolve command) live here.

pub(crate) mod inventory;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    app_state::{AppState, ArchiveScope},
    events,
    relay::{
        classify_request_error, query_relay, query_relay_at_with_keys, relay_http_base_url,
        relay_ws_url_with_override, submit_event_at_with_keys, SubmitEventResponse,
    },
};

pub use inventory::get_owned_agent_inventory;

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Read `target`'s live `kind:0` event and extract the first valid NIP-OA
/// `auth` tag plus the verified owner pubkey.
pub(crate) fn extract_oa_owner(target_kind0: &nostr::Event) -> Option<(String, [String; 4])> {
    let target_hex = target_kind0.pubkey.to_hex();
    let target_compat = nostr::PublicKey::from_hex(&target_hex).ok()?;

    for tag in target_kind0.tags.iter() {
        let slice = tag.as_slice();
        if slice.first().map(String::as_str) != Some("auth") || slice.len() != 4 {
            continue;
        }
        let json = serde_json::to_string(slice).ok()?;
        match buzz_sdk_pkg::nip_oa::verify_auth_tag(&json, &target_compat) {
            Ok(owner) => {
                let raw: [String; 4] = [
                    slice[0].clone(),
                    slice[1].clone(),
                    slice[2].clone(),
                    slice[3].clone(),
                ];
                return Some((owner.to_hex(), raw));
            }
            Err(_) => continue,
        }
    }
    None
}

pub(crate) async fn fetch_kind0(
    state: &AppState,
    pubkey: &str,
) -> Result<Option<nostr::Event>, String> {
    let events = query_relay(
        state,
        &[serde_json::json!({
            "kinds": [0u32],
            "authors": [pubkey.to_ascii_lowercase()],
            "limit": 1,
        })],
    )
    .await?;
    Ok(events.into_iter().next())
}

// ── NipIaOwnerProof classifier ────────────────────────────────────────────────

/// Result of verifying NIP-OA ownership of `target` by a candidate owner.
///
/// Condition-clause evaluation is deliberately skipped — per NIP-IA rule 6 the
/// relay verifies the condition; the client only checks structural validity and
/// signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "result")]
pub enum NipIaOwnerProof {
    /// Valid NIP-OA auth tag present, signature checks out, owner matches caller.
    Verified,
    /// Target kind:0 not found on the relay (or failed NIP-01 verification).
    MissingProfile,
    /// Kind:0 present but no `auth` tag found.
    MissingAuth,
    /// More than one `auth` tag in the kind:0 — ambiguous.
    MultipleAuthTags,
    /// Sole `auth` tag found but has wrong arity or invalid signature/format.
    InvalidAuth,
    /// Auth tag verifies but the declared owner does not match the caller.
    OwnerMismatch { declared_owner: String },
}

/// Classify the NIP-OA ownership of `target_kind0` for `candidate_owner_hex`.
///
/// Rule: count ALL tags whose first element is `"auth"` BEFORE arity check:
/// - 0 auth tags → `MissingAuth`
/// - >1 auth tags → `MultipleAuthTags`
/// - exactly 1 auth tag of wrong arity → `InvalidAuth`
/// - exactly 1 auth tag of correct arity, invalid sig → `InvalidAuth`
/// - exactly 1 auth tag, valid sig, wrong owner → `OwnerMismatch`
/// - exactly 1 auth tag, valid sig, owner matches → `Verified`
///
/// Does NOT evaluate condition clauses (relay's responsibility).
pub(crate) fn classify_nip_ia_owner_proof(
    target_kind0: &nostr::Event,
    candidate_owner_hex: &str,
) -> NipIaOwnerProof {
    let target_hex = target_kind0.pubkey.to_hex();
    let target_compat = match nostr::PublicKey::from_hex(&target_hex) {
        Ok(pk) => pk,
        Err(_) => return NipIaOwnerProof::InvalidAuth,
    };

    // Count ALL tags with first element "auth" — arity filtering comes AFTER.
    let auth_tags: Vec<&[String]> = target_kind0
        .tags
        .iter()
        .map(|t| t.as_slice())
        .filter(|s| s.first().map(String::as_str) == Some("auth"))
        .collect();

    match auth_tags.len() {
        0 => return NipIaOwnerProof::MissingAuth,
        n if n > 1 => return NipIaOwnerProof::MultipleAuthTags,
        _ => {}
    }

    let tag_slice = auth_tags[0];
    // Wrong arity → InvalidAuth (not MissingAuth).
    if tag_slice.len() != 4 {
        return NipIaOwnerProof::InvalidAuth;
    }

    let json = match serde_json::to_string(tag_slice) {
        Ok(j) => j,
        Err(_) => return NipIaOwnerProof::InvalidAuth,
    };
    match buzz_sdk_pkg::nip_oa::verify_auth_tag(&json, &target_compat) {
        Ok(owner_pk) => {
            let owner_hex = owner_pk.to_hex();
            if owner_hex.eq_ignore_ascii_case(candidate_owner_hex) {
                NipIaOwnerProof::Verified
            } else {
                NipIaOwnerProof::OwnerMismatch {
                    declared_owner: owner_hex,
                }
            }
        }
        Err(_) => NipIaOwnerProof::InvalidAuth,
    }
}

// ── Owner-of-agent resolution ─────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct OwnerOfAgent {
    pub owner: String,
    pub is_me: bool,
}

/// Resolve `target`'s NIP-OA owner by reading its live `kind:0`.
#[tauri::command]
pub async fn resolve_oa_owner(
    target_pubkey: String,
    state: State<'_, AppState>,
) -> Result<Option<OwnerOfAgent>, String> {
    let Some(kind0) = fetch_kind0(&state, &target_pubkey).await? else {
        return Ok(None);
    };
    let Some((owner_hex, _tag)) = extract_oa_owner(&kind0) else {
        return Ok(None);
    };
    let my_pubkey = {
        let keys = state.keys.lock().map_err(|e| e.to_string())?;
        keys.public_key().to_hex()
    };
    Ok(Some(OwnerOfAgent {
        is_me: my_pubkey.eq_ignore_ascii_case(&owner_hex),
        owner: owner_hex,
    }))
}

// ── Archive kind enum ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArchiveKind {
    Archive,
    Unarchive,
}

// ── Archive / unarchive request types ────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRequest {
    pub target_pubkey: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub replaced_by: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnarchiveRequest {
    pub target_pubkey: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Submit a `kind:9035` archive request.
#[tauri::command]
pub async fn archive_identity(
    req: ArchiveRequest,
    state: State<'_, AppState>,
) -> Result<SubmitEventResponse, String> {
    let scope = state.capture_archive_scope(8)?;
    scoped_archive_operation(
        &state,
        &scope,
        ArchiveKind::Archive,
        &req.target_pubkey,
        &req.content,
        req.reason.as_deref(),
        req.replaced_by.as_deref(),
    )
    .await
}

/// Submit a `kind:9036` unarchive request.
#[tauri::command]
pub async fn unarchive_identity(
    req: UnarchiveRequest,
    state: State<'_, AppState>,
) -> Result<SubmitEventResponse, String> {
    let scope = state.capture_archive_scope(8)?;
    scoped_archive_operation(
        &state,
        &scope,
        ArchiveKind::Unarchive,
        &req.target_pubkey,
        &req.content,
        req.reason.as_deref(),
        None,
    )
    .await
}

/// Core non-Tauri implementation: fetch → classify → mint → build/sign → submit.
///
/// `maybe_` semantics:
/// - Self path: no fetch, no auth tag.
/// - `Verified`: mint a fresh empty-condition auth tag (never copy profile tag).
/// - Any other proof: no auth tag (relay picks Admin or rejects directly).
pub(crate) async fn scoped_archive_operation(
    state: &AppState,
    scope: &ArchiveScope,
    kind: ArchiveKind,
    target_pubkey: &str,
    content: &str,
    reason: Option<&str>,
    replaced_by: Option<&str>,
) -> Result<SubmitEventResponse, String> {
    let api_base_url = match &scope.relay_url_override {
        Some(url) => relay_http_base_url(url),
        None => crate::relay::relay_api_base_url(),
    };

    // Self path: no fetch, no auth tag.
    let auth_tag: Option<[String; 4]> = if scope.actor.eq_ignore_ascii_case(target_pubkey) {
        None
    } else {
        let kind0_events = query_relay_at_with_keys(
            state,
            &api_base_url,
            &[serde_json::json!({
                "kinds": [0u32],
                "authors": [target_pubkey.to_ascii_lowercase()],
                "limit": 1,
            })],
            &scope.keys,
            None,
        )
        .await?;

        match kind0_events.into_iter().next() {
            None => None,
            Some(kind0) => match classify_nip_ia_owner_proof(&kind0, &scope.actor) {
                NipIaOwnerProof::Verified => {
                    // Mint a fresh empty-condition auth tag from owner keys.
                    // Never copy the profile tag.
                    let target_compat = nostr::PublicKey::from_hex(&kind0.pubkey.to_hex())
                        .map_err(|e| format!("convert target pubkey: {e}"))?;
                    let owner_secret = scope.keys.secret_key();
                    let owner_compat = nostr::SecretKey::from_slice(owner_secret.as_secret_bytes())
                        .map_err(|e| format!("convert owner secret key: {e}"))?;
                    let owner_compat_keys = nostr::Keys::new(owner_compat);
                    let tag_json = buzz_sdk_pkg::nip_oa::compute_auth_tag(
                        &owner_compat_keys,
                        &target_compat,
                        "",
                    )
                    .map_err(|e| format!("compute_auth_tag: {e}"))?;
                    let compat_tag = buzz_sdk_pkg::nip_oa::parse_auth_tag(&tag_json)
                        .map_err(|e| format!("parse_auth_tag: {e}"))?;
                    let raw: [String; 4] = [
                        compat_tag.as_slice()[0].clone(),
                        compat_tag.as_slice()[1].clone(),
                        compat_tag.as_slice()[2].clone(),
                        compat_tag.as_slice()[3].clone(),
                    ];
                    Some(raw)
                }
                _ => None, // classifier-negative → relay picks Admin or rejects
            },
        }
    };

    let auth_ref = auth_tag.as_ref();
    let builder = match kind {
        ArchiveKind::Archive => events::build_archive_identity_request(
            target_pubkey,
            content,
            reason,
            replaced_by,
            auth_ref,
        )?,
        ArchiveKind::Unarchive => {
            events::build_unarchive_identity_request(target_pubkey, content, reason, auth_ref)?
        }
    };

    submit_event_at_with_keys(builder, state, &api_base_url, &scope.keys).await
}

// ── Archive snapshot ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ArchivedIdentitiesSnapshot {
    pub archived: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RelayInformationDocument {
    #[serde(default, rename = "self")]
    self_: Option<String>,
}

pub(crate) async fn fetch_relay_self(state: &AppState) -> Result<Option<String>, String> {
    let relay_url = relay_ws_url_with_override(state);
    let http_url = relay_http_base_url(&relay_url);
    let response = state
        .http_client
        .get(&http_url)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .map_err(|e| classify_request_error(&e))?;

    if !response.status().is_success() {
        return Ok(None);
    }
    let doc = response
        .json::<RelayInformationDocument>()
        .await
        .map_err(|_| "relay returned malformed NIP-11 document".to_string())?;

    let Some(relay_self) = doc.self_.map(|v| v.to_ascii_lowercase()) else {
        return Ok(None);
    };
    if relay_self.len() == 64 && relay_self.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(Some(relay_self))
    } else {
        Ok(None)
    }
}

pub(crate) fn archived_pubkeys_from_snapshot(snapshot: &nostr::Event) -> Vec<String> {
    snapshot
        .tags
        .iter()
        .filter_map(|t| {
            let slice = t.as_slice();
            if slice.first().map(String::as_str) == Some("p") && slice.len() >= 2 {
                let pk = slice[1].to_ascii_lowercase();
                if pk.len() == 64 && pk.chars().all(|c| c.is_ascii_hexdigit()) {
                    return Some(pk);
                }
            }
            None
        })
        .collect()
}

#[tauri::command]
pub async fn get_relay_self(state: State<'_, AppState>) -> Result<Option<String>, String> {
    fetch_relay_self(&state).await
}

#[tauri::command]
pub async fn list_archived_identities(
    state: State<'_, AppState>,
) -> Result<ArchivedIdentitiesSnapshot, String> {
    let Some(relay_self) = fetch_relay_self(&state).await? else {
        return Ok(ArchivedIdentitiesSnapshot { archived: vec![] });
    };
    let events = query_relay(
        &state,
        &[serde_json::json!({
            "authors": [relay_self.clone()],
            "kinds": [13535u32],
            "limit": 1,
        })],
    )
    .await?;
    let Some(snapshot) = events.into_iter().next() else {
        return Ok(ArchivedIdentitiesSnapshot { archived: vec![] });
    };
    if !snapshot.verify_id() || !snapshot.verify_signature() {
        return Ok(ArchivedIdentitiesSnapshot { archived: vec![] });
    }
    if !snapshot.pubkey.to_hex().eq_ignore_ascii_case(&relay_self) {
        return Ok(ArchivedIdentitiesSnapshot { archived: vec![] });
    }
    Ok(ArchivedIdentitiesSnapshot {
        archived: archived_pubkeys_from_snapshot(&snapshot),
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn kind0_with_auth(agent: &Keys, owner: &Keys) -> nostr::Event {
        let agent_hex = agent.public_key().to_hex();
        let agent_compat = nostr::PublicKey::from_hex(&agent_hex).unwrap();
        let owner_compat_secret =
            nostr::SecretKey::from_slice(owner.secret_key().as_secret_bytes()).unwrap();
        let owner_compat_keys = nostr::Keys::new(owner_compat_secret);
        let tag_json =
            buzz_sdk_pkg::nip_oa::compute_auth_tag(&owner_compat_keys, &agent_compat, "")
                .expect("compute_auth_tag");
        let compat_tag = buzz_sdk_pkg::nip_oa::parse_auth_tag(&tag_json).unwrap();
        let tag = Tag::parse(compat_tag.as_slice()).unwrap();
        EventBuilder::new(Kind::Metadata, "{}")
            .tags([tag])
            .sign_with_keys(agent)
            .unwrap()
    }

    #[test]
    fn extract_oa_owner_returns_owner_for_valid_tag() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let kind0 = kind0_with_auth(&agent, &owner);
        let (recovered, raw) = extract_oa_owner(&kind0).expect("auth tag should verify");
        assert_eq!(recovered, owner.public_key().to_hex());
        assert_eq!(raw[0], "auth");
        assert_eq!(raw[2], "");
        assert_eq!(raw[3].len(), 128);
    }

    #[test]
    fn extract_oa_owner_ignores_kind0_without_auth_tag() {
        let agent = Keys::generate();
        let kind0 = EventBuilder::new(Kind::Metadata, "{}")
            .sign_with_keys(&agent)
            .unwrap();
        assert!(extract_oa_owner(&kind0).is_none());
    }

    #[test]
    fn archived_pubkeys_from_snapshot_accepts_only_valid_p_tags() {
        let relay = Keys::generate();
        let valid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let uppercase = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
        let snapshot = EventBuilder::new(Kind::Custom(13535), "")
            .tags([
                Tag::parse(["-"]).unwrap(),
                Tag::parse(["p", valid]).unwrap(),
                Tag::parse(["p", uppercase]).unwrap(),
                Tag::parse(["p", "not-hex"]).unwrap(),
            ])
            .sign_with_keys(&relay)
            .unwrap();
        let expected = vec![valid.to_string(), uppercase.to_ascii_lowercase()];
        assert_eq!(archived_pubkeys_from_snapshot(&snapshot), expected);
    }

    #[test]
    fn relay_information_document_reads_nip11_self_field() {
        let doc: RelayInformationDocument = serde_json::from_str(
            r#"{"name":"test relay","self":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
        ).expect("NIP-11 document");
        assert_eq!(
            doc.self_.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        );
    }

    #[test]
    fn extract_oa_owner_matches_nip_ia_test_vector() {
        const AGENT_HEX: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
        const OWNER_HEX: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        const CONDITIONS: &str = "kind=1&created_at<1713957000";
        const SIG: &str = "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369";
        let agent_secret = nostr::SecretKey::from_hex(
            "0000000000000000000000000000000000000000000000000000000000000002",
        )
        .unwrap();
        let agent_keys = nostr::Keys::new(agent_secret);
        assert_eq!(agent_keys.public_key().to_hex(), AGENT_HEX);
        let auth_tag = nostr::Tag::parse(["auth", OWNER_HEX, CONDITIONS, SIG]).unwrap();
        let kind0 = EventBuilder::new(Kind::Metadata, "{}")
            .tags([auth_tag])
            .sign_with_keys(&agent_keys)
            .unwrap();
        let (owner, raw) = extract_oa_owner(&kind0).expect("spec vector should verify");
        assert_eq!(owner, OWNER_HEX);
        assert_eq!(raw[1], OWNER_HEX);
        assert_eq!(raw[2], CONDITIONS);
        assert_eq!(raw[3], SIG);
    }

    #[test]
    fn archive_request_deserializes_camel_case_payload() {
        let req: ArchiveRequest = serde_json::from_str(
            r#"{"targetPubkey":"abc","content":"bye","reason":"bot-rebuilt","replacedBy":"def"}"#,
        )
        .expect("camelCase archive payload must deserialize");
        assert_eq!(req.target_pubkey, "abc");
        assert_eq!(req.content, "bye");
        assert_eq!(req.reason.as_deref(), Some("bot-rebuilt"));
        assert_eq!(req.replaced_by.as_deref(), Some("def"));

        let minimal: UnarchiveRequest =
            serde_json::from_str(r#"{"targetPubkey":"abc"}"#).expect("minimal payload");
        assert_eq!(minimal.target_pubkey, "abc");
        assert_eq!(minimal.content, "");
        assert!(minimal.reason.is_none());
    }

    // ── NipIaOwnerProof classifier tests ──────────────────────────────────────

    #[test]
    fn classifier_verified_for_valid_owner() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let kind0 = kind0_with_auth(&agent, &owner);
        assert_eq!(
            classify_nip_ia_owner_proof(&kind0, &owner.public_key().to_hex()),
            NipIaOwnerProof::Verified
        );
    }

    #[test]
    fn classifier_owner_mismatch_when_wrong_caller() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let wrong = Keys::generate();
        let kind0 = kind0_with_auth(&agent, &owner);
        match classify_nip_ia_owner_proof(&kind0, &wrong.public_key().to_hex()) {
            NipIaOwnerProof::OwnerMismatch { declared_owner } => {
                assert_eq!(declared_owner, owner.public_key().to_hex());
            }
            other => panic!("expected OwnerMismatch, got {other:?}"),
        }
    }

    #[test]
    fn classifier_missing_auth_for_kind0_without_tag() {
        let agent = Keys::generate();
        let kind0 = EventBuilder::new(Kind::Metadata, "{}")
            .sign_with_keys(&agent)
            .unwrap();
        let owner = Keys::generate();
        assert_eq!(
            classify_nip_ia_owner_proof(&kind0, &owner.public_key().to_hex()),
            NipIaOwnerProof::MissingAuth
        );
    }

    #[test]
    fn classifier_multiple_auth_tags() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let kind0_one = kind0_with_auth(&agent, &owner);
        let auth_tag = kind0_one
            .tags
            .iter()
            .find(|t| t.as_slice().first().map(String::as_str) == Some("auth"))
            .cloned()
            .unwrap();
        let kind0_two = EventBuilder::new(Kind::Metadata, "{}")
            .tags([auth_tag.clone(), auth_tag])
            .sign_with_keys(&agent)
            .unwrap();
        assert_eq!(
            classify_nip_ia_owner_proof(&kind0_two, &owner.public_key().to_hex()),
            NipIaOwnerProof::MultipleAuthTags
        );
    }

    #[test]
    fn classifier_invalid_auth_for_bad_signature() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let bad_sig = "0".repeat(128);
        let auth_tag = Tag::parse(["auth", &owner.public_key().to_hex(), "", &bad_sig]).unwrap();
        let kind0 = EventBuilder::new(Kind::Metadata, "{}")
            .tags([auth_tag])
            .sign_with_keys(&agent)
            .unwrap();
        assert_eq!(
            classify_nip_ia_owner_proof(&kind0, &owner.public_key().to_hex()),
            NipIaOwnerProof::InvalidAuth
        );
    }

    /// Finding 6: a wrong-arity auth tag (3 elements instead of 4) must yield
    /// `InvalidAuth`, not `MissingAuth`. We count it as "present" (1 auth tag
    /// found) but it fails the arity check.
    #[test]
    fn classifier_wrong_arity_tag_yields_invalid_auth_not_missing() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        // Auth tag with only 3 elements — wrong arity.
        let short_tag = Tag::parse(["auth", &owner.public_key().to_hex(), ""]).unwrap();
        let kind0 = EventBuilder::new(Kind::Metadata, "{}")
            .tags([short_tag])
            .sign_with_keys(&agent)
            .unwrap();
        assert_eq!(
            classify_nip_ia_owner_proof(&kind0, &owner.public_key().to_hex()),
            NipIaOwnerProof::InvalidAuth
        );
    }

    /// Finding 6: one malformed (wrong-arity) auth tag plus one valid auth tag
    /// must yield `MultipleAuthTags`, not `Verified`. Both are counted before
    /// arity filtering.
    #[test]
    fn classifier_malformed_plus_valid_tag_yields_multiple_auth_tags() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let valid_kind0 = kind0_with_auth(&agent, &owner);
        let valid_tag = valid_kind0
            .tags
            .iter()
            .find(|t| t.as_slice().first().map(String::as_str) == Some("auth"))
            .cloned()
            .unwrap();
        // A 3-element "auth" tag (wrong arity) — still counts as an auth tag.
        let short_tag = Tag::parse(["auth", &owner.public_key().to_hex(), ""]).unwrap();
        let kind0 = EventBuilder::new(Kind::Metadata, "{}")
            .tags([short_tag, valid_tag])
            .sign_with_keys(&agent)
            .unwrap();
        assert_eq!(
            classify_nip_ia_owner_proof(&kind0, &owner.public_key().to_hex()),
            NipIaOwnerProof::MultipleAuthTags
        );
    }

    #[test]
    fn classifier_verified_for_valid_tag_with_kind1_condition() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let agent_hex = agent.public_key().to_hex();
        let agent_compat = nostr::PublicKey::from_hex(&agent_hex).unwrap();
        let owner_compat_secret =
            nostr::SecretKey::from_slice(owner.secret_key().as_secret_bytes()).unwrap();
        let owner_compat_keys = nostr::Keys::new(owner_compat_secret);
        let tag_json =
            buzz_sdk_pkg::nip_oa::compute_auth_tag(&owner_compat_keys, &agent_compat, "kind=1")
                .expect("compute_auth_tag with kind=1");
        let compat_tag = buzz_sdk_pkg::nip_oa::parse_auth_tag(&tag_json).unwrap();
        let tag = Tag::parse(compat_tag.as_slice()).unwrap();
        let kind0 = EventBuilder::new(Kind::Metadata, "{}")
            .tags([tag])
            .sign_with_keys(&agent)
            .unwrap();
        assert_eq!(
            classify_nip_ia_owner_proof(&kind0, &owner.public_key().to_hex()),
            NipIaOwnerProof::Verified
        );
    }

    #[test]
    fn classifier_verified_for_expired_bound_profile() {
        let owner = Keys::generate();
        let agent = Keys::generate();
        let agent_hex = agent.public_key().to_hex();
        let agent_compat = nostr::PublicKey::from_hex(&agent_hex).unwrap();
        let owner_compat_secret =
            nostr::SecretKey::from_slice(owner.secret_key().as_secret_bytes()).unwrap();
        let owner_compat_keys = nostr::Keys::new(owner_compat_secret);
        let past = "created_at<1000000000";
        let tag_json =
            buzz_sdk_pkg::nip_oa::compute_auth_tag(&owner_compat_keys, &agent_compat, past)
                .expect("compute_auth_tag with past condition");
        let compat_tag = buzz_sdk_pkg::nip_oa::parse_auth_tag(&tag_json).unwrap();
        let tag = Tag::parse(compat_tag.as_slice()).unwrap();
        let kind0 = EventBuilder::new(Kind::Metadata, "{}")
            .tags([tag])
            .sign_with_keys(&agent)
            .unwrap();
        assert_eq!(
            classify_nip_ia_owner_proof(&kind0, &owner.public_key().to_hex()),
            NipIaOwnerProof::Verified
        );
    }

    // ── Relay acceptance gate (ignored, requires live relay + Postgres) ────────
    #[cfg(test)]
    #[path = "identity_archive_relay_tests.rs"]
    mod relay_acceptance;
}
