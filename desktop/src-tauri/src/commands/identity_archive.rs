//! NIP-IA identity archival commands.
//!
//! These commands let the desktop:
//!
//! - resolve a viewee's NIP-OA owner via their live `kind:0` (gates the
//!   "Archive" button when the current user is the owner-of-agent),
//! - submit `kind:9035` archive and `kind:9036` unarchive requests (consent
//!   path is selected by the relay; we just build the wire form),
//! - read the relay's `kind:13535` archive snapshot to drive UI flair,
//! - query the owner's `kind:30177` relay inventory for the Instances sheet.
//!
//! Spec: `docs/nips/NIP-IA.md`. The relay performs full authorization —
//! see §Owner-of-Agent Requests and §Relay Processing Algorithm.

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

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Read `target`'s live `kind:0` event and extract the first valid NIP-OA
/// `auth` tag plus the verified owner pubkey.
///
/// Mirrors the verification the relay will do (per spec gotcha #3: the
/// preimage subject is the *target* pubkey, not the request signer). The
/// `buzz-sdk` lives on nostr 0.36; the desktop is on 0.37, so we bridge
/// via hex round-trip exactly like `relay::build_profile_event` does.
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
            "kinds": [0],
            "authors": [pubkey.to_ascii_lowercase()],
            "limit": 1,
        })],
    )
    .await?;
    Ok(events.into_iter().next())
}

// ── NipIaOwnerProof classifier ───────────────────────────────────────────────

/// Result of verifying NIP-OA ownership of `target` by a candidate owner.
///
/// Reuses `verify_auth_tag` (syntax + Schnorr signature). Condition-clause
/// evaluation is deliberately skipped — per NIP-IA published-profile rule 6
/// the relay verifies the condition; the client only checks the structural
/// validity and signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "result")]
pub enum NipIaOwnerProof {
    /// Valid NIP-OA auth tag present, signature checks out, owner matches caller.
    Verified,
    /// Target kind:0 has no `auth` tag at all.
    // Constructed when the kind:0 fetch returns nothing; present for API completeness
    // and future callers that distinguish "no profile" from "no auth tag".
    #[allow(dead_code)]
    MissingProfile,
    /// Kind:0 present but no `auth` tag found.
    MissingAuth,
    /// More than one `auth` tag in the kind:0 — ambiguous, cannot select canonical.
    MultipleAuthTags,
    /// Auth tag present but signature or format is invalid.
    InvalidAuth,
    /// Auth tag verifies but the declared owner does not match the caller.
    OwnerMismatch { declared_owner: String },
}

/// Classify the NIP-OA ownership of `target_kind0` for `candidate_owner_hex`.
///
/// Called after a kind:0 fetch; `candidate_owner_hex` is the caller's pubkey.
/// No condition-clause evaluation — only syntax + Schnorr signature check.
pub(crate) fn classify_nip_ia_owner_proof(
    target_kind0: &nostr::Event,
    candidate_owner_hex: &str,
) -> NipIaOwnerProof {
    let target_hex = target_kind0.pubkey.to_hex();
    let target_compat = match nostr::PublicKey::from_hex(&target_hex) {
        Ok(pk) => pk,
        Err(_) => return NipIaOwnerProof::InvalidAuth,
    };

    let auth_tags: Vec<&[String]> = target_kind0
        .tags
        .iter()
        .map(|t| t.as_slice())
        .filter(|s| s.first().map(String::as_str) == Some("auth") && s.len() == 4)
        .collect();

    if auth_tags.is_empty() {
        return NipIaOwnerProof::MissingAuth;
    }
    if auth_tags.len() > 1 {
        return NipIaOwnerProof::MultipleAuthTags;
    }

    let tag_slice = auth_tags[0];
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

// ── Owner-of-agent resolution ───────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct OwnerOfAgent {
    /// Owner pubkey (hex) recovered from the viewee's verified NIP-OA `auth` tag.
    pub owner: String,
    /// True iff `owner` equals the current user's pubkey. Lets the frontend
    /// gate the "Archive" button without a second round-trip.
    pub is_me: bool,
}

/// Resolve `target`'s NIP-OA owner by reading its live `kind:0` and verifying
/// the embedded `auth` tag. Returns `None` if the target has no kind:0, no
/// `auth` tag, or the tag fails verification.
///
/// This is what gates the owner-path archive button: the frontend calls this,
/// and if `is_me == true`, shows the button.
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

// ── Archive kind enum ────────────────────────────────────────────────────────

/// Discriminant for the scoped archive operation — which NIP-IA request kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArchiveKind {
    Archive,   // kind:9035
    Unarchive, // kind:9036
}

// ── Archive / unarchive requests ────────────────────────────────────────────

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

/// Submit a `kind:9035` archive request to the relay. Consent path is selected
/// by the relay — we just attach the owner-of-agent `auth` tag when the live
/// `kind:0` proves we own the target, so the relay can choose the `owner`
/// path. Self and admin paths require no auth tag.
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

/// Submit a `kind:9036` unarchive request to the relay.
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
/// Consumes only the immutable `scope` — no `AppState` guard is held across
/// any await. Parameterized for both 9035 and 9036 so both directions inherit
/// identical scope and credential guarantees.
///
/// Owner-proof semantics (`maybe_` rule):
/// - Self path: no fetch, no auth tag.
/// - `NipIaOwnerProof::Verified`: mint a fresh empty-condition auth tag from
///   owner keys. Never copies the profile tag.
/// - Any other classifier result: no auth tag, NOT a local error — the relay
///   picks Admin or rejects; relay rejection is surfaced directly without retry
///   or consent-path reinterpretation.
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

    // Self path: no fetch, no auth tag (spec §Self Requests).
    let auth_tag: Option<[String; 4]> = if scope.actor.eq_ignore_ascii_case(target_pubkey) {
        None
    } else {
        // Fetch target's live kind:0 using owner keys for NIP-98 auth.
        let kind0_events = query_relay_at_with_keys(
            state,
            &api_base_url,
            &[serde_json::json!({
                "kinds": [0],
                "authors": [target_pubkey.to_ascii_lowercase()],
                "limit": 1,
            })],
            &scope.keys,
            None,
        )
        .await?;

        match kind0_events.into_iter().next() {
            None => None, // No kind:0 → classifier-negative → no auth tag
            Some(kind0) => {
                match classify_nip_ia_owner_proof(&kind0, &scope.actor) {
                    NipIaOwnerProof::Verified => {
                        // Mint a fresh empty-condition auth tag from owner keys.
                        // Never copy the profile tag — the fresh tag passes the
                        // relay's request-time checks while the profile attestation
                        // is verified without evaluating its condition clauses.
                        let target_compat = nostr::PublicKey::from_hex(&kind0.pubkey.to_hex())
                            .map_err(|e| format!("convert target pubkey: {e}"))?;
                        let owner_secret = scope.keys.secret_key();
                        let owner_compat =
                            nostr::SecretKey::from_slice(owner_secret.as_secret_bytes())
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
                    // Classifier-negative → maybe_ semantics: no auth tag,
                    // not a local error. Relay picks Admin or rejects.
                    _ => None,
                }
            }
        }
    };

    // Build the event builder with the (possibly-None) auth tag.
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

    // Sign with scope keys and submit using explicit keys/URL — no AppState
    // guard held across this await.
    submit_event_at_with_keys(builder, state, &api_base_url, &scope.keys).await
}

// ── Archive snapshot ────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ArchivedIdentitiesSnapshot {
    /// Lowercase hex pubkeys present in the latest relay-signed `kind:13535`.
    pub archived: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RelayInformationDocument {
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

    let Some(relay_self) = doc.self_.map(|value| value.to_ascii_lowercase()) else {
        return Ok(None);
    };

    if relay_self.len() == 64 && relay_self.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(Some(relay_self))
    } else {
        Ok(None)
    }
}

fn archived_pubkeys_from_snapshot(snapshot: &nostr::Event) -> Vec<String> {
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

/// Read the active relay's NIP-11 `self` pubkey (its own signing key, hex).
///
/// A public, unauthenticated document read reused by the moderation UI to tell
/// whether a DM peer is the relay identity (a moderation DM). Fails open: an
/// unreachable relay, a document without `self`, or a malformed value all
/// return `None`, and callers must treat that as "not the relay" — the disable
/// is an affordance, not enforcement, so a false negative is the safe failure.
#[tauri::command]
pub async fn get_relay_self(state: State<'_, AppState>) -> Result<Option<String>, String> {
    fetch_relay_self(&state).await
}

/// Read the relay's latest valid `kind:13535` archive snapshot. The frontend
/// caches this and tests membership client-side to drive the "Archived" flair.
///
/// Per NIP-IA §Client Behavior and §Snapshot and Delta Consistency, only a
/// snapshot signed by the relay identity advertised in NIP-11 `self` can affect
/// archive state. If the relay has no stable `self`, fail open with an empty
/// snapshot rather than trusting unauthenticated relay-authoritative state.
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
            "kinds": [13535],
            "limit": 1,
        })],
    )
    .await?;

    let Some(snapshot) = events.into_iter().next() else {
        return Ok(ArchivedIdentitiesSnapshot { archived: vec![] });
    };

    // Defense-in-depth: the filter should already restrict author, but the
    // client must still reject malformed or wrongly signed relay state.
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

// ── Owned-agent relay inventory ──────────────────────────────────────────────

/// Archive state of a single agent instance as known from the relay snapshot
/// and local records. `None` means the snapshot was not yet loaded (UI should
/// defer the tri-state badge).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedAgentArchiveState {
    /// Whether the relay's `kind:13535` snapshot lists this pubkey as archived.
    /// `None` if the snapshot was not loaded (caller may treat as unknown).
    pub is_archived: Option<bool>,
}

/// A single owned-agent instance from the relay inventory.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedAgentInstance {
    /// Agent pubkey (hex).
    pub pubkey: String,
    /// Display name from kind:0.
    pub display_name: Option<String>,
    /// Avatar URL from kind:0.
    pub picture: Option<String>,
    /// Relay URL at which this agent has a kind:30177 listing.
    pub relay_url: String,
    /// Archive tri-state.
    pub archive_state: OwnedAgentArchiveState,
}

/// Snapshot returned by `get_owned_agent_inventory`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedAgentInventorySnapshot {
    /// Whether the archive snapshot was loaded and trusted (relay has a valid
    /// `self` and the snapshot verified). When `false`, `archive_state` on
    /// each instance will carry `is_archived: None`.
    pub archive_state_trusted: bool,
    pub instances: Vec<OwnedAgentInstance>,
}

/// Query the relay's `kind:30177` inventory for agents owned by the current
/// user, applying NIP-33 dedup (latest per `d` tag), NIP-OA reciprocal
/// verification, and an archive-state join from the `kind:13535` snapshot.
///
/// `cursor` is an optional last-seen `created_at` timestamp for keyset
/// pagination (oldest-first within a page). `page_size` defaults to 50.
#[tauri::command]
pub async fn get_owned_agent_inventory(
    cursor: Option<u64>,
    page_size: Option<u64>,
    state: State<'_, AppState>,
) -> Result<OwnedAgentInventorySnapshot, String> {
    let limit = page_size.unwrap_or(50).min(200);

    let my_pubkey = {
        let keys = state.keys.lock().map_err(|e| e.to_string())?;
        keys.public_key().to_hex()
    };
    let relay_url = relay_ws_url_with_override(&state);
    let api_base_url = relay_http_base_url(&relay_url);

    // Fetch kind:30177 events authored by the owner.
    let mut filter = serde_json::json!({
        "kinds": [30177],
        "authors": [my_pubkey.clone()],
        "limit": limit,
    });
    if let Some(ts) = cursor {
        filter["until"] = serde_json::json!(ts);
    }

    let raw_events = query_relay(&state, &[filter]).await?;

    // NIP-33 dedup: keep latest event per `d` tag.
    let mut deduped: std::collections::HashMap<String, nostr::Event> =
        std::collections::HashMap::new();
    for ev in raw_events {
        let d = ev
            .tags
            .iter()
            .find(|t| t.as_slice().first().map(String::as_str) == Some("d"))
            .and_then(|t| t.as_slice().get(1).cloned())
            .unwrap_or_default();
        let entry = deduped.entry(d).or_insert_with(|| ev.clone());
        if ev.created_at > entry.created_at {
            *entry = ev;
        }
    }

    // Try to load the archive snapshot for the tri-state join.
    let (archive_state_trusted, archived_set) = match fetch_relay_self(&state).await? {
        None => (false, std::collections::HashSet::new()),
        Some(relay_self) => {
            let snap_events = query_relay(
                &state,
                &[serde_json::json!({
                    "authors": [relay_self.clone()],
                    "kinds": [13535],
                    "limit": 1,
                })],
            )
            .await
            .unwrap_or_default();
            match snap_events.into_iter().next() {
                None => (true, std::collections::HashSet::new()),
                Some(snap) => {
                    if !snap.verify_id()
                        || !snap.verify_signature()
                        || !snap.pubkey.to_hex().eq_ignore_ascii_case(&relay_self)
                    {
                        (false, std::collections::HashSet::new())
                    } else {
                        let set: std::collections::HashSet<String> =
                            archived_pubkeys_from_snapshot(&snap).into_iter().collect();
                        (true, set)
                    }
                }
            }
        }
    };

    // Build instances with NIP-OA reciprocal verification.
    let mut instances = Vec::new();
    for (_d, ev) in deduped {
        // Each kind:30177 event's pubkey is the agent pubkey. Verify the
        // NIP-OA auth tag: only include if verified owner == my_pubkey.
        let proof = classify_nip_ia_owner_proof(&ev, &my_pubkey);
        // We only list agents we can verify ownership of; skip unverifiable.
        match proof {
            NipIaOwnerProof::Verified => {}
            // MissingAuth is common for agents without an auth tag (non-OA
            // agents). We still list them — the relay already scoped by
            // author:my_pubkey so this is still the owner's inventory.
            NipIaOwnerProof::MissingAuth => {}
            _ => continue,
        }

        let agent_pubkey = ev.pubkey.to_hex();

        // Parse display_name and picture from the kind:30177 content field.
        let (display_name, picture) =
            if let Ok(content) = serde_json::from_str::<serde_json::Value>(&ev.content) {
                (
                    content
                        .get("display_name")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    content
                        .get("picture")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                )
            } else {
                (None, None)
            };

        let is_archived = if archive_state_trusted {
            Some(archived_set.contains(&agent_pubkey.to_ascii_lowercase()))
        } else {
            None
        };

        instances.push(OwnedAgentInstance {
            pubkey: agent_pubkey,
            display_name,
            picture,
            relay_url: api_base_url.clone(),
            archive_state: OwnedAgentArchiveState { is_archived },
        });
    }

    // Sort by pubkey for stable ordering.
    instances.sort_by(|a, b| a.pubkey.cmp(&b.pubkey));

    Ok(OwnedAgentInventorySnapshot {
        archive_state_trusted,
        instances,
    })
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    /// Build a fake `kind:0` with a valid NIP-OA auth tag for a fresh owner.
    fn kind0_with_auth(agent: &Keys, owner: &Keys) -> nostr::Event {
        // Compute auth tag via buzz-sdk (nostr 0.36) and bridge.
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
        assert_eq!(raw[1], owner.public_key().to_hex());
        // conditions empty by construction
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
        )
        .expect("NIP-11 document");

        assert_eq!(
            doc.self_.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        );
    }

    /// Spec test-vector regression for gotcha #3: the NIP-OA preimage subject
    /// is the *target/agent* pubkey, not the request signer. The vectors in
    /// `docs/nips/NIP-IA.md` §Test Vectors fix concrete values; verifying the
    /// vector's `auth` tag under the vector's agent pubkey MUST yield the
    /// vector's owner pubkey. If our `extract_oa_owner` ever stops using the
    /// agent pubkey as the preimage subject, this test fails loudly.
    #[test]
    fn extract_oa_owner_matches_nip_ia_test_vector() {
        // From docs/nips/NIP-IA.md §Test Vectors → "NIP-OA auth tag".
        const AGENT_HEX: &str = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
        const OWNER_HEX: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        const CONDITIONS: &str = "kind=1&created_at<1713957000";
        const SIG: &str = "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369";

        // We don't have the agent's secret key (it's `0x...02` in the spec, but
        // we don't need to re-sign a kind:0 — we just need a kind:0 whose
        // `pubkey` is AGENT_HEX and whose tags carry this auth tag). Sign with
        // a *different* agent and then construct an unsigned-event-shaped
        // struct ourselves. nostr 0.37 doesn't easily allow forging `pubkey`
        // mismatched with the signing key, so we build via the public
        // constructor that requires a key — and for THIS test, the kind:0
        // signature is not checked (we only call extract_oa_owner which reads
        // the event's pubkey field and the auth tag bytes).
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

    /// Regression: the frontend sends the request payload in camelCase
    /// (`targetPubkey`, `replacedBy`); these structs MUST deserialize it.
    /// Without `#[serde(rename_all = "camelCase")]` the archive/unarchive
    /// commands fail to deserialize at runtime — a failure the e2e mock hides
    /// because it returns before parsing the payload. Red-if-broken guard.
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

        // Minimal payload (only the required field) still deserializes.
        let minimal: UnarchiveRequest =
            serde_json::from_str(r#"{"targetPubkey":"abc"}"#).expect("minimal payload");
        assert_eq!(minimal.target_pubkey, "abc");
        assert_eq!(minimal.content, "");
        assert!(minimal.reason.is_none());
    }

    // ── NipIaOwnerProof classifier tests ─────────────────────────────────────

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
        let wrong_caller = Keys::generate();
        let kind0 = kind0_with_auth(&agent, &owner);
        let result = classify_nip_ia_owner_proof(&kind0, &wrong_caller.public_key().to_hex());
        match result {
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
        // Extract the auth tag from the first kind0 and add a second copy.
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
        // Craft an auth tag with a corrupted (all-zeros) signature.
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

    #[test]
    fn classifier_verified_for_valid_tag_with_kind1_condition() {
        // A tag with condition clauses is still `Verified` — we do NOT evaluate
        // conditions (NIP-IA published-profile rule 6: relay verifies them).
        let owner = Keys::generate();
        let agent = Keys::generate();
        let agent_hex = agent.public_key().to_hex();
        let agent_compat = nostr::PublicKey::from_hex(&agent_hex).unwrap();
        let owner_compat_secret =
            nostr::SecretKey::from_slice(owner.secret_key().as_secret_bytes()).unwrap();
        let owner_compat_keys = nostr::Keys::new(owner_compat_secret);
        // Compute with a non-empty condition string.
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
        // An expired-bound tag is structurally valid (Verified by the classifier)
        // so Archive is offered; the relay will reject if it evaluates the
        // condition clause — but that is the relay's job.
        let owner = Keys::generate();
        let agent = Keys::generate();
        let agent_hex = agent.public_key().to_hex();
        let agent_compat = nostr::PublicKey::from_hex(&agent_hex).unwrap();
        let owner_compat_secret =
            nostr::SecretKey::from_slice(owner.secret_key().as_secret_bytes()).unwrap();
        let owner_compat_keys = nostr::Keys::new(owner_compat_secret);
        let past = "created_at<1000000000"; // far in the past — already expired
        let tag_json =
            buzz_sdk_pkg::nip_oa::compute_auth_tag(&owner_compat_keys, &agent_compat, past)
                .expect("compute_auth_tag with past condition");
        let compat_tag = buzz_sdk_pkg::nip_oa::parse_auth_tag(&tag_json).unwrap();
        let tag = Tag::parse(compat_tag.as_slice()).unwrap();
        let kind0 = EventBuilder::new(Kind::Metadata, "{}")
            .tags([tag])
            .sign_with_keys(&agent)
            .unwrap();
        // Still Verified (structural + sig ok; expired condition is relay's concern).
        assert_eq!(
            classify_nip_ia_owner_proof(&kind0, &owner.public_key().to_hex()),
            NipIaOwnerProof::Verified
        );
    }

    // ── Relay acceptance gate (ignored, requires live relay + Postgres) ───────

    #[cfg(test)]
    #[path = "identity_archive_relay_tests.rs"]
    mod relay_acceptance;
}
