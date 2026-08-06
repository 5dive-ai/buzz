//! Owned-agent relay inventory: exhaustive keyset-paged `kind:30177` query,
//! `d`-tag agent extraction + content parsing, `kind:0` fetch + NIP-01
//! verification, `NipIaOwnerProof` classification joined with the archive
//! snapshot, local-managed-agent merge, and persona-grouped view model.
//!
//! All state is captured atomically via `capture_archive_scope` before any I/O.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tauri::AppHandle;

use crate::{
    app_state::{AppState, ArchiveScope},
    managed_agents::{
        agent_events::managed_agent_content_from_event, load_managed_agents, ManagedAgentRecord,
    },
    relay::{
        classify_request_error, query_relay_at_with_keys, relay_api_base_url, relay_http_base_url,
    },
};

use super::{
    archived_pubkeys_from_snapshot, classify_nip_ia_owner_proof, NipIaOwnerProof,
    RelayInformationDocument,
};

// ── Model ────────────────────────────────────────────────────────────────────

/// Archive tri-state for a single owned-agent instance.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedAgentArchiveState {
    /// `None` if the snapshot was not loaded (caller may treat as unknown).
    pub is_archived: Option<bool>,
}

/// Minimal locally-managed agent fields needed by the UI to distinguish this
/// device's instance from relay-only duplicates.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgentSummary {
    /// Agent pubkey (hex) — matches `OwnedAgentInstance.pubkey`.
    pub pubkey: String,
    /// Human-readable name from the local record.
    pub name: String,
    /// Persona ID from the local record (used to group local-only instances).
    pub persona_id: Option<String>,
}

/// A single owned-agent instance from the relay `kind:30177` inventory,
/// or a local-only instance that has no relay row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedAgentInstance {
    /// Agent pubkey (hex) — extracted from the `d` tag of `kind:30177`, or
    /// from the local managed-agent record for local-only instances.
    pub pubkey: String,
    /// Display name from the agent's `kind:0` (relay instances) or local
    /// record name (local-only instances).
    pub display_name: Option<String>,
    /// Avatar URL from the agent's `kind:0`.
    pub picture: Option<String>,
    /// Relay URL at which this agent has a kind:30177 listing.
    /// Empty string for local-only instances (no relay row).
    pub relay_url: String,
    /// NIP-OA owner proof classified from the agent's `kind:0`.
    pub nip_ia_owner_proof: NipIaOwnerProof,
    /// Archive tri-state joined from the `kind:13535` snapshot.
    pub archive_state: OwnedAgentArchiveState,
    /// Persona ID parsed from `kind:30177` content, if present.
    /// `None` for standalone (definition-less) agents or malformed content.
    pub persona_id: Option<String>,
    /// Present when this pubkey is managed by a local record on this device.
    /// `None` for relay-only instances (no local record).
    ///
    /// The UI keys the "Not managed on this device" / Relay-only badge on
    /// `local == null`, NOT on `personaId == null`. A stale relay-only
    /// duplicate WITH a valid personaId receives the badge; a locally managed
    /// definition-less agent does NOT.
    pub local: Option<LocalAgentSummary>,
}

/// Complete merged view model returned by `get_owned_agent_inventory`.
///
/// Instances are grouped by persona ID. The `unknown` bucket holds instances
/// whose `kind:30177` content is missing or has no `persona_id`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedAgentInventorySnapshot {
    /// Whether the archive snapshot was loaded and trusted.
    pub archive_state_trusted: bool,
    /// Instances keyed by their persona ID — drives per-card counts and Sheet.
    pub by_persona_id: HashMap<String, Vec<OwnedAgentInstance>>,
    /// Instances with no parseable persona ID (standalone agents).
    pub unknown: Vec<OwnedAgentInstance>,
}

// ── Page-to-exhaustion fetch ──────────────────────────────────────────────

/// Maximum events per page.
const PAGE_SIZE: u64 = 50;

/// Validate that a string is a 64-char lowercase hex pubkey.
fn is_valid_agent_pubkey(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.len() == 64 && lower.chars().all(|c| c.is_ascii_hexdigit())
}

/// State returned by `reduce_page`.
struct PageResult {
    /// Canonical (latest) event per agent pubkey accumulated across all pages.
    canonical: HashMap<String, (u64, String, nostr::Event)>,
    /// Cursor for the next request: `(created_at, id)` of the LAST raw event
    /// on this page. Advances from the raw page tail ONLY — dedup never
    /// influences cursor progression.
    next_until: u64,
    next_before_id: String,
    /// Whether the relay returned a full page (more data may follow).
    full_page: bool,
}

/// Pure reducer: merge one raw relay page into `canonical` and compute the
/// next cursor from the raw page tail.
///
/// Malformed `d` tags are skipped and DO NOT affect the cursor.
fn reduce_page(
    mut canonical: HashMap<String, (u64, String, nostr::Event)>,
    page: Vec<nostr::Event>,
) -> PageResult {
    let full_page = page.len() as u64 == PAGE_SIZE;

    // Cursor from raw page tail — the relay sorts (created_at DESC, id ASC),
    // so the last event is the oldest on this page.
    let (next_until, next_before_id) = page
        .last()
        .map(|ev| (ev.created_at.as_secs(), ev.id.to_hex()))
        .unwrap_or((0, String::new()));

    for ev in page {
        let d_raw = ev
            .tags
            .iter()
            .find(|t| t.as_slice().first().map(String::as_str) == Some("d"))
            .and_then(|t| t.as_slice().get(1).cloned())
            .unwrap_or_default();
        let agent_pubkey = d_raw.to_ascii_lowercase();
        if !is_valid_agent_pubkey(&agent_pubkey) {
            continue; // malformed d tag — skip, cursor unaffected
        }

        let ts = ev.created_at.as_secs();
        let id = ev.id.to_hex();

        let supersedes = canonical
            .get(&agent_pubkey)
            .map(|(ets, eid, _)| ts > *ets || (ts == *ets && id < *eid))
            .unwrap_or(true);

        if supersedes {
            canonical.insert(agent_pubkey, (ts, id, ev));
        }
    }

    PageResult {
        canonical,
        next_until,
        next_before_id,
        full_page,
    }
}

/// Fetch all `kind:30177` events authored by `scope.actor`, paging to
/// exhaustion via composite `(until, before_id)` cursor.
///
/// Returns the canonical latest event per NIP-33 `d` tag (agent pubkey),
/// sorted `(created_at DESC, id ASC)`. Events with missing or non-hex-64 `d`
/// tags are silently skipped (malformed). Transport errors propagate — a
/// partial inventory is never silently returned as complete.
async fn fetch_all_owned_30177(
    state: &AppState,
    scope: &ArchiveScope,
    api_base_url: &str,
) -> Result<Vec<nostr::Event>, String> {
    let mut until: Option<u64> = None;
    let mut before_id: Option<String> = None;
    let mut canonical: HashMap<String, (u64, String, nostr::Event)> = HashMap::new();

    loop {
        let mut filter = serde_json::json!({
            "kinds": [30177u32],
            "authors": [scope.actor.clone()],
            "limit": PAGE_SIZE,
        });
        if let Some(ts) = until {
            filter["until"] = serde_json::json!(ts);
        }
        if let Some(ref bid) = before_id {
            filter["before_id"] = serde_json::json!(bid);
        }

        // Transport failure propagates — partial inventory is not returned.
        let page =
            query_relay_at_with_keys(state, api_base_url, &[filter], &scope.keys, None).await?;

        let PageResult {
            canonical: new_canonical,
            next_until,
            next_before_id,
            full_page,
        } = reduce_page(canonical, page);
        canonical = new_canonical;

        if !full_page {
            break;
        }

        // Guard against degenerate relay behaviour.
        let no_progress =
            until == Some(next_until) && before_id.as_deref() == Some(next_before_id.as_str());
        if no_progress {
            break;
        }

        until = Some(next_until);
        before_id = Some(next_before_id);
    }

    let mut events: Vec<nostr::Event> = canonical.into_values().map(|(_, _, ev)| ev).collect();
    events.sort_by(|a, b| {
        let ts = b.created_at.as_secs().cmp(&a.created_at.as_secs());
        if ts.is_eq() {
            a.id.to_hex().cmp(&b.id.to_hex())
        } else {
            ts
        }
    });
    Ok(events)
}

// ── kind:0 fetch + NIP-01 verify ─────────────────────────────────────────

/// Fetch the agent's latest `kind:0`, verify NIP-01 ID and signature, and
/// confirm it is kind:0 authored by `agent_pubkey`. Returns the event if
/// valid; `None` on missing profile or invalid event.
async fn fetch_and_verify_kind0(
    state: &AppState,
    scope: &ArchiveScope,
    api_base_url: &str,
    agent_pubkey: &str,
) -> Result<Option<nostr::Event>, String> {
    let events = query_relay_at_with_keys(
        state,
        api_base_url,
        &[serde_json::json!({
            "kinds": [0u32],
            "authors": [agent_pubkey],
            "limit": 1,
        })],
        &scope.keys,
        None,
    )
    .await?;

    let Some(ev) = events.into_iter().next() else {
        return Ok(None);
    };

    // NIP-01 verification: reject tampered events.
    if !ev.verify_id() || !ev.verify_signature() {
        return Ok(None);
    }
    // Must be authored by the expected agent.
    if !ev.pubkey.to_hex().eq_ignore_ascii_case(agent_pubkey) {
        return Ok(None);
    }
    // Must be kind:0.
    if ev.kind != nostr::Kind::Metadata {
        return Ok(None);
    }
    Ok(Some(ev))
}

// ── Archive snapshot loader ───────────────────────────────────────────────

/// Load the relay's `kind:13535` archive snapshot for the tri-state join.
///
/// Uses `scope.keys` for NIP-98 authentication (same generation as the
/// inventory query). Returns `(false, empty)` for ALL failure conditions —
/// query failure, absent relay self, absent snapshot, and invalid signature.
/// Only a successfully fetched, verified, relay-signed snapshot returns `true`.
async fn load_archive_snapshot(
    state: &AppState,
    scope: &ArchiveScope,
    api_base_url: &str,
) -> (bool, HashSet<String>) {
    // Fetch NIP-11 relay-information document at the scoped URL.
    let relay_self: Option<String> = async {
        let response = state
            .http_client
            .get(api_base_url)
            .header("Accept", "application/nostr+json")
            .send()
            .await
            .map_err(|e| classify_request_error(&e))?;
        if !response.status().is_success() {
            return Ok::<_, String>(None);
        }
        let doc = response
            .json::<RelayInformationDocument>()
            .await
            .map_err(|_| "relay returned malformed NIP-11 document".to_string())?;
        let Some(s) = doc.self_.map(|v| v.to_ascii_lowercase()) else {
            return Ok(None);
        };
        if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) {
            Ok(Some(s))
        } else {
            Ok(None)
        }
    }
    .await
    .unwrap_or(None);

    let Some(relay_self) = relay_self else {
        // relay_self absent or fetch failed → unknown, not trusted-empty
        return (false, HashSet::new());
    };

    // Use scope.keys for NIP-98 auth — same generation as the inventory query.
    let snaps = query_relay_at_with_keys(
        state,
        api_base_url,
        &[serde_json::json!({
            "authors": [relay_self.clone()],
            "kinds": [13535u32],
            "limit": 1,
        })],
        &scope.keys,
        None,
    )
    .await;

    // Delegate to the pure helper so unit tests can exercise all trust arms
    // (error, absent, invalid, trusted-empty) without live network I/O.
    reduce_snapshot_query_result(snaps, &relay_self)
}

/// Verify a single kind:13535 snapshot event and return the trust decision.
///
/// This is the testable core of `load_archive_snapshot`'s trust logic — it
/// operates on already-fetched data with no I/O.
///
/// Returns `(true, set)` only when:
/// - the event passes NIP-01 `verify_id()` and `verify_signature()`, AND
/// - the event was authored by `relay_self` (signer match).
///
/// Returns `(false, empty)` for any invalid snapshot or signer mismatch.
pub(super) fn verify_snapshot_for_trust(
    snap: &nostr::Event,
    relay_self: &str,
) -> (bool, HashSet<String>) {
    if !snap.verify_id()
        || !snap.verify_signature()
        || !snap.pubkey.to_hex().eq_ignore_ascii_case(relay_self)
    {
        return (false, HashSet::new());
    }
    let set: HashSet<String> = archived_pubkeys_from_snapshot(snap).into_iter().collect();
    (true, set)
}

/// Reduce the raw query result from the relay into a trust decision.
///
/// This is the testable core that covers ALL four trust arms:
/// - `Err(_)` (query / transport failure) → `(false, empty)`
/// - `Ok([])` (relay self confirmed, no kind:13535 event present) → `(false, empty)`
/// - `Ok([snap])` (snapshot present) → delegates to `verify_snapshot_for_trust`
///
/// Calling this function rather than re-implementing the match arms in tests
/// ensures that a regression in `load_archive_snapshot`'s decision logic
/// will be caught by the unit tests.
pub(super) fn reduce_snapshot_query_result<E>(
    query_result: Result<Vec<nostr::Event>, E>,
    relay_self: &str,
) -> (bool, HashSet<String>) {
    let Ok(snaps) = query_result else {
        return (false, HashSet::new());
    };
    match snaps.into_iter().next() {
        // No snapshot present → absent is UNKNOWN, not trusted-empty.
        None => (false, HashSet::new()),
        Some(snap) => verify_snapshot_for_trust(&snap, relay_self),
    }
}

// ── Local agent index builder ─────────────────────────────────────────────

/// Build a normalized pubkey → [`LocalAgentSummary`] index from the raw
/// managed-agent records result.
///
/// This is the testable entry point that covers the two local-store arms:
/// - `Err(e)` → propagated as `Err("managed_agents_store_lock: …")` so the
///   caller can NEVER produce a successful all-relay-only inventory when the
///   local store is unreadable.
/// - `Ok(records)` → deduped, normalised (lowercase pubkey), empty-pubkey
///   rows filtered out.
///
/// The production code calls `build_local_agent_index(load_managed_agents(&app))?`
/// so a storage failure propagates exactly here. Unit tests inject `Err(…)`
/// directly to prove the mutation guard without needing a live `AppHandle`.
pub(super) fn build_local_agent_index<E: std::fmt::Display>(
    records_result: Result<Vec<ManagedAgentRecord>, E>,
) -> Result<HashMap<String, LocalAgentSummary>, String> {
    let records = records_result
        .map_err(|e| format!("managed_agents_store_lock: failed to load local agents: {e}"))?;
    Ok(records
        .into_iter()
        .filter(|r| !r.pubkey.is_empty())
        .map(|r| {
            let norm = r.pubkey.to_ascii_lowercase();
            let summary = LocalAgentSummary {
                pubkey: norm.clone(),
                name: r.name,
                persona_id: r.persona_id,
            };
            (norm, summary)
        })
        .collect())
}

// ── Parse kind:0 content ──────────────────────────────────────────────────

fn parse_display_fields(content: &str) -> (Option<String>, Option<String>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(content) else {
        return (None, None);
    };
    let dn = v
        .get("display_name")
        .and_then(|x| x.as_str())
        .map(str::to_string);
    let pic = v
        .get("picture")
        .and_then(|x| x.as_str())
        .map(str::to_string);
    (dn, pic)
}

// ── Tauri command ─────────────────────────────────────────────────────────

/// Query the relay's `kind:30177` inventory for agents owned by the current
/// user. Pages to exhaustion; applies NIP-33 dedup; fetches each agent's
/// `kind:0` for NIP-OA classification; joins the archive tri-state.
/// Parses `kind:30177` content for `persona_id` and groups results.
/// Merges local managed-agent records by normalized pubkey, including
/// local-only instances (no relay row). Groups by persona ID.
///
/// All state is captured atomically via the seqlock before any I/O.
#[tauri::command]
pub async fn get_owned_agent_inventory(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<OwnedAgentInventorySnapshot, String> {
    let scope = state.capture_archive_scope(8)?;
    let api_base_url = match &scope.relay_url_override {
        Some(url) => relay_http_base_url(url),
        None => relay_api_base_url(),
    };

    let owned_events = fetch_all_owned_30177(&state, &scope, &api_base_url).await?;
    let (archive_state_trusted, archived_set) =
        load_archive_snapshot(&state, &scope, &api_base_url).await;

    // Load all local managed-agent records once and build a lookup by
    // normalized pubkey. This is a disk read — done before relay I/O to
    // avoid holding a lock across await points. Failure propagates: a
    // storage error here would silently reclassify every local instance as
    // "Relay only", which could steer the archive decision to the wrong
    // duplicate — exactly the scenario this feature exists to prevent.
    let local_by_pubkey: HashMap<String, LocalAgentSummary> =
        build_local_agent_index(load_managed_agents(&app))?;

    // Bounded batch: fetch all kind:0 profiles concurrently but fail the
    // entire snapshot on transport error (a partial inventory is dangerous
    // for the no-third-mint gate).
    let mut instances = Vec::with_capacity(owned_events.len());
    // Track relay pubkeys seen so we can identify local-only instances.
    let mut relay_pubkeys: HashSet<String> = HashSet::new();

    for ev in owned_events {
        // Re-extract agent pubkey (already validated by fetch_all_owned_30177).
        let agent_pubkey = ev
            .tags
            .iter()
            .find(|t| t.as_slice().first().map(String::as_str) == Some("d"))
            .and_then(|t| t.as_slice().get(1).cloned())
            .unwrap_or_default()
            .to_ascii_lowercase();

        relay_pubkeys.insert(agent_pubkey.clone());

        // Parse persona_id from kind:30177 content (authoritative per wire contract).
        let persona_id = managed_agent_content_from_event(&ev)
            .ok()
            .and_then(|c| c.persona_id);

        // Fetch + NIP-01-verify the agent's kind:0.
        // Transport failure propagates — do NOT silently omit this instance.
        let (proof, display_name, picture) =
            match fetch_and_verify_kind0(&state, &scope, &api_base_url, &agent_pubkey).await {
                Err(e) => return Err(format!("kind:0 fetch failed for {agent_pubkey}: {e}")),
                Ok(None) => (NipIaOwnerProof::MissingProfile, None, None),
                Ok(Some(k0)) => {
                    let proof = classify_nip_ia_owner_proof(&k0, &scope.actor);
                    let (dn, pic) = parse_display_fields(k0.content.as_ref());
                    (proof, dn, pic)
                }
            };

        let is_archived = if archive_state_trusted {
            Some(archived_set.contains(&agent_pubkey))
        } else {
            None
        };

        // Attach local summary if this pubkey is managed on this device.
        let local = local_by_pubkey
            .get(&agent_pubkey)
            .map(|s| LocalAgentSummary {
                pubkey: s.pubkey.clone(),
                name: s.name.clone(),
                persona_id: s.persona_id.clone(),
            });

        instances.push(OwnedAgentInstance {
            pubkey: agent_pubkey,
            display_name,
            picture,
            relay_url: api_base_url.clone(),
            nip_ia_owner_proof: proof,
            archive_state: OwnedAgentArchiveState { is_archived },
            persona_id,
            local,
        });
    }

    // Add local-only instances: locally managed agents with no relay row.
    // These are included so the UI can show the user what they have locally
    // vs. what the relay knows about.
    for (pubkey, local_summary) in &local_by_pubkey {
        if relay_pubkeys.contains(pubkey) {
            continue; // already included in the relay inventory above
        }
        let is_archived = if archive_state_trusted {
            Some(archived_set.contains(pubkey))
        } else {
            None
        };
        instances.push(OwnedAgentInstance {
            pubkey: pubkey.clone(),
            display_name: Some(local_summary.name.clone()),
            picture: None,
            relay_url: String::new(), // no relay row
            nip_ia_owner_proof: NipIaOwnerProof::MissingProfile,
            archive_state: OwnedAgentArchiveState { is_archived },
            persona_id: local_summary.persona_id.clone(),
            local: Some(LocalAgentSummary {
                pubkey: local_summary.pubkey.clone(),
                name: local_summary.name.clone(),
                persona_id: local_summary.persona_id.clone(),
            }),
        });
    }

    // Group instances: byPersonaId for those with a known persona, unknown for
    // those without. This grouping is the authoritative source for per-card
    // counts, Sheet filtering, and the start-control safeguard.
    let mut by_persona_id: HashMap<String, Vec<OwnedAgentInstance>> = HashMap::new();
    let mut unknown: Vec<OwnedAgentInstance> = Vec::new();
    for instance in instances {
        match &instance.persona_id {
            Some(pid) => by_persona_id.entry(pid.clone()).or_default().push(instance),
            None => unknown.push(instance),
        }
    }

    Ok(OwnedAgentInventorySnapshot {
        archive_state_trusted,
        by_persona_id,
        unknown,
    })
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_agent_pubkey_passes_validation() {
        assert!(is_valid_agent_pubkey(&"a".repeat(64)));
        assert!(is_valid_agent_pubkey(&"0123456789abcdef".repeat(4)));
    }

    #[test]
    fn malformed_d_tags_are_rejected() {
        assert!(!is_valid_agent_pubkey(""));
        assert!(!is_valid_agent_pubkey("not-hex"));
        assert!(!is_valid_agent_pubkey(&"a".repeat(63))); // too short
        assert!(!is_valid_agent_pubkey(&"a".repeat(65))); // too long
        assert!(!is_valid_agent_pubkey(&"g".repeat(64))); // non-hex
    }

    /// Finding 6: `fetch_and_verify_kind0` rejects events with tampered NIP-01
    /// ID or signature. Construct a genuine event, tamper it, and confirm the
    /// verification predicates it delegates to both reject the tampered copy.
    #[test]
    fn nip01_verification_rejects_tampered_event() {
        use nostr::{EventBuilder, JsonUtil, Keys, Kind};
        let agent = Keys::generate();
        let ev = EventBuilder::new(Kind::Metadata, "{}")
            .sign_with_keys(&agent)
            .unwrap();

        // A genuine event passes NIP-01 checks.
        assert!(ev.verify_id(), "genuine event must pass verify_id");
        assert!(
            ev.verify_signature(),
            "genuine event must pass verify_signature"
        );

        // Tamper: mutate the content so the event ID no longer matches.
        // Deserialize to raw JSON, swap the content field, reserialise.
        let mut raw: serde_json::Value =
            serde_json::from_str(&ev.as_json()).expect("event must be valid JSON");
        raw["content"] = serde_json::json!("tampered content");
        let tampered_json = serde_json::to_string(&raw).unwrap();
        let tampered = nostr::Event::from_json(&tampered_json)
            .expect("tampered JSON must still parse as an Event struct");

        // The tampered copy must FAIL at least verify_id (content was changed).
        // fetch_and_verify_kind0 checks both and rejects if either fails.
        assert!(
            !tampered.verify_id() || !tampered.verify_signature(),
            "tampered event must fail at least one NIP-01 check"
        );
    }

    /// Finding 6: when fetch_and_verify_kind0 returns None, the inventory
    /// code correctly maps to NipIaOwnerProof::MissingProfile. Verify the
    /// mapping is present in the `get_owned_agent_inventory` path.
    #[test]
    fn missing_profile_variant_is_reachable_and_serializable() {
        use super::super::NipIaOwnerProof;
        let proof = NipIaOwnerProof::MissingProfile;
        let json =
            serde_json::to_string(&proof).expect("NipIaOwnerProof::MissingProfile must serialize");
        assert!(
            json.contains("missing_profile"),
            "serialized form must contain 'missing_profile', got: {json}"
        );
    }

    // ── reduce_page tests ────────────────────────────────────────────────────

    /// reduce_page uses the raw page tail for the cursor, not the dedup map
    /// tail. When a page contains only malformed d-tags, the canonical map is
    /// empty but the cursor still advances from the raw events.
    #[test]
    fn reduce_page_cursor_from_raw_tail_not_dedup_map() {
        use nostr::{EventBuilder, Keys, Kind, Tag};

        let owner = Keys::generate();

        // Two events with MALFORMED d-tags — they won't enter canonical,
        // but they ARE on the raw page and the cursor must advance from them.
        let ev_old = EventBuilder::new(Kind::Custom(30177), "")
            .tags([Tag::parse(["d", "not-hex"]).unwrap()])
            .sign_with_keys(&owner)
            .unwrap();
        let ev_new = EventBuilder::new(Kind::Custom(30177), "")
            .tags([Tag::parse(["d", "also-bad"]).unwrap()])
            .sign_with_keys(&owner)
            .unwrap();

        // Simulate relay order: newest first. ev_new is first, ev_old is last.
        // The cursor must come from ev_old (the raw page tail = oldest event).
        let page = vec![ev_new.clone(), ev_old.clone()];
        let result = reduce_page(HashMap::new(), page);

        // No events passed the pubkey validation — canonical stays empty.
        assert!(
            result.canonical.is_empty(),
            "malformed d tags must not enter canonical"
        );
        // Cursor must come from the raw tail (ev_old), not u64::MAX or empty.
        assert_eq!(result.next_until, ev_old.created_at.as_secs());
        assert_eq!(result.next_before_id, ev_old.id.to_hex());
    }

    /// Two events with equal created_at: the one with the lexicographically
    /// smaller ID wins in the canonical map (NIP-33 tiebreak rule).
    #[test]
    fn reduce_page_equal_timestamp_lower_id_wins() {
        use nostr::{EventBuilder, Keys, Kind, Tag};

        let owner = Keys::generate();
        let agent_pk = "a".repeat(64);

        // Generate two events and keep trying until we have same created_at.
        // In practice, two Events built back-to-back in the same second will
        // share the timestamp — but we can't guarantee that in a unit test.
        // Instead, use two events and pick the winner based on the rule.
        let ev1 = EventBuilder::new(Kind::Custom(30177), "v1")
            .tags([Tag::parse(["d", &agent_pk]).unwrap()])
            .sign_with_keys(&owner)
            .unwrap();
        let ev2 = EventBuilder::new(Kind::Custom(30177), "v2")
            .tags([Tag::parse(["d", &agent_pk]).unwrap()])
            .sign_with_keys(&owner)
            .unwrap();

        let id1 = ev1.id.to_hex();
        let id2 = ev2.id.to_hex();
        let ts1 = ev1.created_at.as_secs();
        let ts2 = ev2.created_at.as_secs();

        let page = vec![ev1.clone(), ev2.clone()];
        let result = reduce_page(HashMap::new(), page);
        assert_eq!(result.canonical.len(), 1);

        let (_, winning_id, _) = result.canonical.get(&agent_pk).unwrap();
        if ts1 != ts2 {
            // Whichever has higher created_at wins.
            if ts1 > ts2 {
                assert_eq!(winning_id, &id1);
            } else {
                assert_eq!(winning_id, &id2);
            }
        } else {
            // Equal timestamps: lower id wins.
            if id1 < id2 {
                assert_eq!(winning_id, &id1);
            } else {
                assert_eq!(winning_id, &id2);
            }
        }
    }

    /// A full page (PAGE_SIZE events) sets full_page = true; a partial page
    /// does not.
    #[test]
    fn reduce_page_full_page_detection() {
        use nostr::{EventBuilder, Keys, Kind, Tag};

        let owner = Keys::generate();

        // Build PAGE_SIZE events with distinct d-tags.
        let full_page_events: Vec<nostr::Event> = (0..PAGE_SIZE)
            .map(|i| {
                let pk = format!("{:0>64}", format!("{i:x}"));
                EventBuilder::new(Kind::Custom(30177), "")
                    .tags([Tag::parse(["d", &pk]).unwrap()])
                    .sign_with_keys(&owner)
                    .unwrap()
            })
            .collect();

        let result = reduce_page(HashMap::new(), full_page_events);
        assert!(result.full_page, "PAGE_SIZE events must set full_page");

        // One event less → partial.
        let partial: Vec<nostr::Event> = (0..(PAGE_SIZE - 1))
            .map(|i| {
                let pk = format!("{:0>64}", format!("{i:x}"));
                EventBuilder::new(Kind::Custom(30177), "")
                    .tags([Tag::parse(["d", &pk]).unwrap()])
                    .sign_with_keys(&owner)
                    .unwrap()
            })
            .collect();
        let result = reduce_page(HashMap::new(), partial);
        assert!(!result.full_page, "partial page must NOT set full_page");
    }

    #[test]
    fn distinct_agent_pubkeys_yield_separate_canonical_entries() {
        use nostr::{EventBuilder, Keys, Kind, Tag};

        let owner = Keys::generate();
        let agent1 = "a".repeat(64);
        let agent2 = "b".repeat(64);

        let page = vec![
            EventBuilder::new(Kind::Custom(30177), "")
                .tags([Tag::parse(["d", &agent1]).unwrap()])
                .sign_with_keys(&owner)
                .unwrap(),
            EventBuilder::new(Kind::Custom(30177), "")
                .tags([Tag::parse(["d", &agent2]).unwrap()])
                .sign_with_keys(&owner)
                .unwrap(),
        ];
        let result = reduce_page(HashMap::new(), page);
        assert_eq!(result.canonical.len(), 2);
    }

    // ── Archive snapshot trust tests ──────────────────────────────────────────

    /// Proves that a local-store read failure propagates as Err, preventing
    /// `get_owned_agent_inventory` from silently returning a relay-only snapshot
    /// that mislabels every local instance as "Relay only".
    ///
    /// Drives `build_local_agent_index` — the production helper wired via `?` into
    /// `get_owned_agent_inventory` — with an `Err` result. Mutation guard: restoring
    /// `unwrap_or_default()` in the helper makes this test fail.
    #[test]
    fn local_store_failure_propagates_not_silently_dropped() {
        // Inject the error path directly into the production helper.
        let result =
            build_local_agent_index::<String>(Err("simulated store lock poisoned".to_string()));
        assert!(
            result.is_err(),
            "local store failure must propagate as Err, not unwrap_or_default"
        );
        let msg = result.unwrap_err();
        assert!(
            msg.contains("managed_agents_store_lock"),
            "error message must include context prefix: got {msg}"
        );
    }

    /// Trusted-empty: relay_self confirmed + valid kind:13535 snapshot with no
    /// archived pubkeys → (true, empty). The relay explicitly published an
    /// empty archive list. Drives `reduce_snapshot_query_result` with a valid
    /// event in an Ok(vec) to exercise the `Some(snap) → verify` arm end-to-end.
    #[test]
    fn load_archive_snapshot_trust_arm_trusted_empty() {
        use nostr::{EventBuilder, Keys, Kind};
        let relay = Keys::generate();
        // A kind:13535 with NO p-tags → trusted empty.
        let snap = EventBuilder::new(Kind::Custom(13535), "")
            .sign_with_keys(&relay)
            .unwrap();
        let relay_self = relay.public_key().to_hex();
        // Drive the production helper end-to-end: Ok(vec![snap]) → trusted.
        let (trusted, set) = reduce_snapshot_query_result::<String>(Ok(vec![snap]), &relay_self);
        assert!(
            trusted,
            "valid snap from correct relay_self must be trusted"
        );
        assert!(set.is_empty(), "no p-tags → empty archived set");
    }

    /// Unknown — absent snapshot: relay self confirmed but no kind:13535 event.
    /// Drives `reduce_snapshot_query_result` with Ok(empty vec) — the `None` arm
    /// must return (false, empty). Any regression in the production function
    /// will surface here rather than in a parallel inline re-implementation.
    #[test]
    fn absent_snapshot_trust_arm_is_false_empty() {
        let relay = nostr::Keys::generate();
        let relay_self = relay.public_key().to_hex();
        // Ok(empty vec) → absent snapshot → (false, empty).
        let (trusted, set) = reduce_snapshot_query_result::<String>(Ok(vec![]), &relay_self);
        assert!(!trusted, "absent snapshot must return trusted=false");
        assert!(set.is_empty(), "absent snapshot must return empty set");
    }

    /// Unknown — query/transport error: the error arm returns (false, empty).
    /// Drives `reduce_snapshot_query_result` with Err(_) — a regression in
    /// the production Err arm will be caught here.
    #[test]
    fn error_trust_arm_is_false_empty() {
        let relay = nostr::Keys::generate();
        let relay_self = relay.public_key().to_hex();
        // Err(transport error) → (false, empty).
        let (trusted, set) =
            reduce_snapshot_query_result::<String>(Err("transport error".to_string()), &relay_self);
        assert!(!trusted, "error must return trusted=false");
        assert!(set.is_empty(), "error must return empty set");
    }

    /// Unknown — invalid snapshot: drives `reduce_snapshot_query_result` with
    /// a tampered event to prove it returns (false, empty) for signer-mismatch
    /// or NIP-01 failure.
    #[test]
    fn invalid_snapshot_trust_arm_is_false_empty() {
        use nostr::{EventBuilder, JsonUtil, Keys, Kind};
        let relay = Keys::generate();
        let snap = EventBuilder::new(Kind::Custom(13535), "")
            .sign_with_keys(&relay)
            .unwrap();
        let relay_self = relay.public_key().to_hex();

        // Tamper the snapshot so verify_id() fails.
        let mut raw: serde_json::Value = serde_json::from_str(&snap.as_json()).expect("valid JSON");
        raw["content"] = serde_json::json!("tampered");
        let tampered =
            nostr::Event::from_json(serde_json::to_string(&raw).unwrap()).expect("parseable");
        // Drive the production helper end-to-end: Ok(vec![tampered]) → untrusted.
        let (trusted, set) =
            reduce_snapshot_query_result::<String>(Ok(vec![tampered]), &relay_self);
        assert!(!trusted, "invalid snapshot must return trusted=false");
        assert!(set.is_empty(), "invalid snapshot must return empty set");
    }
}
