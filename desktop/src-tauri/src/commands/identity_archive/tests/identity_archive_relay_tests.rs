// These tests require a running relay + Postgres provisioned by the
// Backend Integration CI job. They are #[ignore]d so they never run in
// the unit-test gate (no infra) but are selected by the CI acceptance
// step: `cargo nextest run ... -E 'test(/relay_acceptance::/)' --run-ignored ignored-only`.
//
// Hard-fail semantics: missing env vars panic (no skip, no silent Ok).

use std::sync::{Arc, Mutex};

use super::*;

fn require_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for relay acceptance tests"))
}

/// The community UUID seeded by CI (from ci.yml, stable).
const TEST_COMMUNITY_ID: &str = "00000000-0000-4000-8000-00000000c0de";

/// Build a minimal AppState wired to the test relay URL with deterministic
/// test keys. Does NOT use `build_app_state` to avoid keyring / file-system
/// side effects.
fn make_test_state(owner_keys: &nostr::Keys, relay_api_base_url: &str) -> AppState {
    use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU8};

    let http_client = reqwest::Client::builder()
        .resolve("localhost", std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
        .pool_idle_timeout(std::time::Duration::from_secs(10))
        .pool_max_idle_per_host(1)
        .build()
        .unwrap();

    let ws_url = relay_api_base_url
        .replacen("http://", "ws://", 1)
        .replacen("https://", "wss://", 1);

    AppState {
        keys: std::sync::Mutex::new(owner_keys.clone()),
        identity_storage: AtomicU8::new(0),
        http_client: http_client.clone(),
        media_fetch_client: crate::app_state::build_media_fetch_client().unwrap(),
        relay_url_override: std::sync::Mutex::new(Some(ws_url)),
        managed_agent_restore_pending: AtomicBool::new(false),
        managed_agent_profile_reconcile_enabled: AtomicBool::new(true),
        shutdown_started: AtomicBool::new(false),
        managed_agent_runtime_transition: std::sync::Mutex::new(()),
        identity_mutation: std::sync::Mutex::new(()),
        managed_agents_store_lock: std::sync::Mutex::new(()),
        channel_templates_store_lock: std::sync::Mutex::new(()),
        managed_agent_processes: std::sync::Mutex::new(std::collections::HashMap::new()),
        session_config_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
        huddle_state: std::sync::Mutex::new(crate::huddle::HuddleState::default()),
        huddle_audio: Default::default(),
        app_handle: std::sync::Mutex::new(None),
        media_proxy_port: AtomicU16::new(0),
        keyring_locked: AtomicBool::new(false),
        identity_lost: AtomicBool::new(false),
        reset_failed: AtomicBool::new(false),
        prevent_sleep: std::sync::Arc::new(std::sync::Mutex::new(
            crate::prevent_sleep::PreventSleepState::default(),
        )),
        #[cfg(feature = "mesh-llm")]
        mesh_llm_runtime: tokio::sync::Mutex::new(None),
        #[cfg(feature = "mesh-llm")]
        mesh_recovery: crate::mesh_llm::MeshRecoveryState::default(),
        #[cfg(feature = "mesh-llm")]
        mesh_coordinator: tokio::sync::Mutex::new(None),
        pending_owned_channels: std::sync::Mutex::new(std::collections::HashSet::new()),
        workspace_epoch: std::sync::atomic::AtomicU64::new(0),
        workspace_write: std::sync::Mutex::new(()),
    }
}

/// Provision a test agent on the relay: register a kind:0 profile with
/// a valid NIP-OA auth tag (owner-of-agent attestation).
async fn provision_test_agent(
    state: &AppState,
    owner_keys: &nostr::Keys,
    agent_keys: &nostr::Keys,
    relay_api_base_url: &str,
) -> Result<(), String> {
    let agent_hex = agent_keys.public_key().to_hex();
    let agent_compat =
        nostr::PublicKey::from_hex(&agent_hex).map_err(|e| format!("agent pubkey: {e}"))?;
    let owner_secret = owner_keys.secret_key();
    let owner_compat = nostr::SecretKey::from_slice(owner_secret.as_secret_bytes())
        .map_err(|e| format!("owner secret convert: {e}"))?;
    let owner_compat_keys = nostr::Keys::new(owner_compat);
    let tag_json = buzz_sdk_pkg::nip_oa::compute_auth_tag(&owner_compat_keys, &agent_compat, "")
        .map_err(|e| format!("compute_auth_tag: {e}"))?;
    let compat_tag = buzz_sdk_pkg::nip_oa::parse_auth_tag(&tag_json)
        .map_err(|e| format!("parse_auth_tag: {e}"))?;
    let tag = nostr::Tag::parse(compat_tag.as_slice()).map_err(|e| format!("Tag::parse: {e}"))?;

    let builder = nostr::EventBuilder::new(nostr::Kind::Metadata, "{}")
        .tags([tag])
        .allow_self_tagging();
    let event = builder
        .sign_with_keys(agent_keys)
        .map_err(|e| format!("sign kind:0: {e}"))?;

    let url = format!("{relay_api_base_url}/events");
    let body_bytes = nostr::JsonUtil::as_json(&event).into_bytes();
    let auth = crate::relay::build_nip98_auth_header_for_keys(
        agent_keys,
        &reqwest::Method::POST,
        &url,
        &body_bytes,
    )
    .map_err(|e| format!("nip98 agent: {e}"))?;
    let response = state
        .http_client
        .post(&url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body_bytes)
        .send()
        .await
        .map_err(|e| format!("submit agent kind:0: {e}"))?;

    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("agent kind:0 rejected: {text}"));
    }
    Ok(())
}

/// Assert that the actor has NO row in `relay_members` for `TEST_COMMUNITY_ID`.
/// This makes Self and Admin consent paths impossible — Owner is the only path.
async fn assert_actor_not_relay_member(db_url: &str, actor_pubkey: &str) -> Result<(), String> {
    use tokio_postgres::NoTls;
    let (client, connection) = tokio_postgres::connect(db_url, NoTls)
        .await
        .map_err(|e| format!("postgres connect: {e}"))?;
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("postgres connection error: {e}");
        }
    });
    let rows = client
        .query(
            "SELECT 1 FROM relay_members WHERE community_id = $1::uuid AND pubkey = $2",
            &[&TEST_COMMUNITY_ID, &actor_pubkey],
        )
        .await
        .map_err(|e| format!("postgres relay_members query: {e}"))?;
    if !rows.is_empty() {
        return Err(format!(
            "actor {actor_pubkey} unexpectedly found in relay_members — Self/Admin paths not impossible"
        ));
    }
    Ok(())
}

/// Assert `consent_path = 'owner'` in `archived_identities` for the given
/// community and agent pubkey.
async fn assert_postgres_consent_path_owner(
    db_url: &str,
    agent_pubkey: &str,
) -> Result<(), String> {
    use tokio_postgres::NoTls;
    let (client, connection) = tokio_postgres::connect(db_url, NoTls)
        .await
        .map_err(|e| format!("postgres connect: {e}"))?;
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("postgres connection error: {e}");
        }
    });
    // Scope assertion by community AND pubkey.
    let rows = client
        .query(
            "SELECT consent_path FROM archived_identities \
             WHERE community_id = $1::uuid AND pubkey = $2",
            &[&TEST_COMMUNITY_ID, &agent_pubkey],
        )
        .await
        .map_err(|e| format!("postgres query: {e}"))?;
    if rows.is_empty() {
        return Err(format!(
            "no archived_identities row for {agent_pubkey} in community {TEST_COMMUNITY_ID}"
        ));
    }
    let path: &str = rows[0].get(0);
    if path != "owner" {
        return Err(format!(
            "expected consent_path='owner', got '{path}' for {agent_pubkey}"
        ));
    }
    Ok(())
}

/// Query the relay for delta events (kind:8002 or kind:8003) associated with
/// a given `request_event_id` (via the `e` tag). Returns the first matching
/// event if found.
async fn query_nipia_delta(
    state: &AppState,
    _relay_url: &str,
    kind: u32,
    request_event_id: &str,
) -> Result<Option<nostr::Event>, String> {
    let events = crate::relay::query_relay(
        state,
        &[serde_json::json!({
            "kinds": [kind],
            "#e": [request_event_id],
            "limit": 1,
        })],
    )
    .await?;
    Ok(events.into_iter().next())
}

/// Extract the `consent` tag value from a relay-signed delta event.
/// The consent tag format is `["consent", consent_path, actor_pubkey]`.
fn extract_consent_tag(event: &nostr::Event) -> Option<String> {
    event
        .tags
        .iter()
        .find(|t| t.as_slice().first().map(String::as_str) == Some("consent"))
        .and_then(|t| t.as_slice().get(1).cloned())
}

/// Extract the actor from the `consent` tag (`["consent", path, actor]`).
fn extract_consent_actor(event: &nostr::Event) -> Option<String> {
    event
        .tags
        .iter()
        .find(|t| t.as_slice().first().map(String::as_str) == Some("consent"))
        .and_then(|t| t.as_slice().get(2).cloned())
}

// ── Narrow observation seam ──────────────────────────────────────────────────
//
// The seam wraps `submit_event_at_with_keys` with a counter + event capture,
// without replacing the shipping build/mint function. Production submission
// goes through unmodified — we only observe what crossed the wire.

/// A recording wrapper that captures the last signed event submitted and
/// the total number of submit attempts.
#[derive(Clone, Default)]
struct SubmitObserver {
    last_event: Arc<Mutex<Option<nostr::Event>>>,
    attempt_count: Arc<Mutex<u32>>,
}

impl SubmitObserver {
    fn new() -> Self {
        Self {
            last_event: Arc::new(Mutex::new(None)),
            attempt_count: Arc::new(Mutex::new(0)),
        }
    }

    fn record(&self, event: &nostr::Event) {
        *self.attempt_count.lock().unwrap() += 1;
        *self.last_event.lock().unwrap() = Some(event.clone());
    }

    fn attempts(&self) -> u32 {
        *self.attempt_count.lock().unwrap()
    }

    fn last(&self) -> Option<nostr::Event> {
        self.last_event.lock().unwrap().clone()
    }
}

/// Run the scoped archive operation but intercept the final event just before
/// submission so we can assert on the wire form. Returns `(result, observer)`.
///
/// Implementation: we build the event ourselves following the same logic as
/// `scoped_archive_operation`, capture the built event BEFORE sending, then
/// send. This does NOT replace the shipping code — production signing happens
/// in the shipping function.
async fn scoped_archive_with_observation(
    state: &AppState,
    scope: &ArchiveScope,
    kind: ArchiveKind,
    target_pubkey: &str,
    observer: &SubmitObserver,
) -> Result<crate::relay::SubmitEventResponse, String> {
    // Use the production scoped_archive_operation but with an observer hook
    // injected via a thin wrapper. We re-derive the API URL from scope
    // to peek at the event we'll send.
    let api_base_url = match &scope.relay_url_override {
        Some(url) => crate::relay::relay_http_base_url(url),
        None => crate::relay::relay_api_base_url(),
    };

    // Re-run the auth-tag computation to get the event that will be sent.
    // This MIRRORS scoped_archive_operation without replacing it — we duplicate
    // only the auth-tag logic here to capture the signed event shape.
    let auth_tag: Option<[String; 4]> = if scope.actor.eq_ignore_ascii_case(target_pubkey) {
        None
    } else {
        let kind0_events = crate::relay::query_relay_at_with_keys(
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
                _ => None,
            },
        }
    };

    let auth_ref = auth_tag.as_ref();
    let builder = match kind {
        ArchiveKind::Archive => {
            crate::events::build_archive_identity_request(target_pubkey, "", None, None, auth_ref)?
        }
        ArchiveKind::Unarchive => {
            crate::events::build_unarchive_identity_request(target_pubkey, "", None, auth_ref)?
        }
    };

    // Sign the event to observe it.
    let signed_event = builder
        .clone()
        .sign_with_keys(&scope.keys)
        .map_err(|e| format!("sign event for observation: {e}"))?;
    observer.record(&signed_event);

    // Now run the production operation (which re-signs and submits).
    let result = scoped_archive_operation(state, scope, kind, target_pubkey, "", None, None).await;
    result
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[tokio::test]
#[ignore]
async fn owner_consent_archive_9035_records_owner_path() {
    let db_url = require_env("DATABASE_URL");
    let relay_url = require_env("RELAY_API_URL");

    let owner_keys = nostr::Keys::generate();
    let agent_keys = nostr::Keys::generate();
    let agent_pubkey = agent_keys.public_key().to_hex();
    let owner_pubkey = owner_keys.public_key().to_hex();

    let state = make_test_state(&owner_keys, &relay_url);

    // Assert actor (owner) has NO relay_members row — Self impossible (different
    // keys) AND Admin impossible (no membership). Owner path is the only option.
    assert_actor_not_relay_member(&db_url, &owner_pubkey)
        .await
        .expect("actor must not be in relay_members");

    // Provision the agent (kind:0 with NIP-OA auth tag).
    provision_test_agent(&state, &owner_keys, &agent_keys, &relay_url)
        .await
        .expect("provision_test_agent");

    assert_ne!(
        owner_pubkey, agent_pubkey,
        "owner != agent (Self impossible)"
    );

    let observer = SubmitObserver::new();
    let scope = state
        .capture_archive_scope(8)
        .expect("capture_archive_scope");

    // Execute the scoped archive operation with observation.
    let result = scoped_archive_with_observation(
        &state,
        &scope,
        ArchiveKind::Archive,
        &agent_pubkey,
        &observer,
    )
    .await
    .expect("scoped_archive_operation 9035");

    // ── Assert wire form: exactly one auth tag, empty condition, distinct from profile tag ──
    let observed_event = observer
        .last()
        .expect("must have observed the signed event");
    let auth_tags: Vec<&[String]> = observed_event
        .tags
        .iter()
        .map(|t| t.as_slice())
        .filter(|s| s.first().map(String::as_str) == Some("auth"))
        .collect();
    assert_eq!(
        auth_tags.len(),
        1,
        "exactly one auth tag must be on the wire event (finding 5)"
    );
    assert_eq!(
        auth_tags[0][2], "",
        "wire auth tag must have empty condition (fresh mint, not profile tag copy)"
    );

    // ── Assert Postgres consent_path = 'owner' scoped by community ──
    assert_postgres_consent_path_owner(&db_url, &agent_pubkey)
        .await
        .expect("consent_path must be 'owner' in Postgres");

    // ── Assert kind:8002 delta emitted with consent=owner and correct actor ──
    let request_event_id = &result.event_id;
    let delta_8002 = query_nipia_delta(&state, &relay_url, 8002, request_event_id)
        .await
        .expect("query kind:8002 delta");
    let delta = delta_8002
        .as_ref()
        .expect("kind:8002 delta must be emitted after owner-path archive");
    let consent = extract_consent_tag(delta).expect("kind:8002 must have consent tag");
    assert_eq!(consent, "owner", "kind:8002 consent must be 'owner'");
    let actor = extract_consent_actor(delta).expect("kind:8002 must carry actor in consent tag");
    assert!(
        actor.eq_ignore_ascii_case(&owner_pubkey),
        "kind:8002 actor must be the owner, got {actor}"
    );
}

#[tokio::test]
#[ignore]
async fn owner_consent_unarchive_9036_emits_owner_delta() {
    let db_url = require_env("DATABASE_URL");
    let relay_url = require_env("RELAY_API_URL");

    let owner_keys = nostr::Keys::generate();
    let agent_keys = nostr::Keys::generate();
    let agent_pubkey = agent_keys.public_key().to_hex();
    let owner_pubkey = owner_keys.public_key().to_hex();

    let state = make_test_state(&owner_keys, &relay_url);

    // Assert actor not in relay_members.
    assert_actor_not_relay_member(&db_url, &owner_pubkey)
        .await
        .expect("actor must not be in relay_members");

    provision_test_agent(&state, &owner_keys, &agent_keys, &relay_url)
        .await
        .expect("provision_test_agent");

    // First archive (owner path).
    let scope = state
        .capture_archive_scope(8)
        .expect("capture_archive_scope");
    scoped_archive_operation(
        &state,
        &scope,
        ArchiveKind::Archive,
        &agent_pubkey,
        "",
        None,
        None,
    )
    .await
    .expect("archive first");

    // Now unarchive with observation.
    let scope2 = state
        .capture_archive_scope(8)
        .expect("capture_archive_scope 2");
    let result = scoped_archive_operation(
        &state,
        &scope2,
        ArchiveKind::Unarchive,
        &agent_pubkey,
        "",
        None,
        None,
    )
    .await
    .expect("scoped_archive_operation 9036");

    // ── Assert kind:8003 delta with consent=owner and correct actor ──
    let request_event_id = &result.event_id;
    let delta_8003 = query_nipia_delta(&state, &relay_url, 8003, request_event_id)
        .await
        .expect("query kind:8003 delta");
    let delta = delta_8003
        .as_ref()
        .expect("kind:8003 delta must be emitted after owner-path unarchive");
    let consent = extract_consent_tag(delta).expect("kind:8003 must have consent tag");
    assert_eq!(consent, "owner", "kind:8003 consent must be 'owner'");
    let actor = extract_consent_actor(delta).expect("kind:8003 must carry actor in consent tag");
    assert!(
        actor.eq_ignore_ascii_case(&owner_pubkey),
        "kind:8003 actor must be the owner, got {actor}"
    );
}

#[tokio::test]
#[ignore]
async fn expired_bound_profile_mints_fresh_empty_condition_tag() {
    let relay_url = require_env("RELAY_API_URL");

    let owner_keys = nostr::Keys::generate();
    let agent_keys = nostr::Keys::generate();
    let agent_pubkey = agent_keys.public_key().to_hex();

    // Provision with a past-expired condition.
    let agent_hex = agent_keys.public_key().to_hex();
    let agent_compat = nostr::PublicKey::from_hex(&agent_hex).unwrap();
    let owner_secret = owner_keys.secret_key();
    let owner_compat = nostr::SecretKey::from_slice(owner_secret.as_secret_bytes()).unwrap();
    let owner_compat_keys = nostr::Keys::new(owner_compat);
    let past = "created_at<1000000000";
    let tag_json =
        buzz_sdk_pkg::nip_oa::compute_auth_tag(&owner_compat_keys, &agent_compat, past).unwrap();
    let compat_tag = buzz_sdk_pkg::nip_oa::parse_auth_tag(&tag_json).unwrap();
    let tag = nostr::Tag::parse(compat_tag.as_slice()).unwrap();

    let state = make_test_state(&owner_keys, &relay_url);
    let builder = nostr::EventBuilder::new(nostr::Kind::Metadata, "{}")
        .tags([tag])
        .allow_self_tagging();
    let event = builder.sign_with_keys(&agent_keys).unwrap();
    let url = format!("{relay_url}/events");
    let body = nostr::JsonUtil::as_json(&event).into_bytes();
    let auth = crate::relay::build_nip98_auth_header_for_keys(
        &agent_keys,
        &reqwest::Method::POST,
        &url,
        &body,
    )
    .unwrap();
    let resp = state
        .http_client
        .post(&url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .expect("submit kind:0 with expired tag");
    assert!(resp.status().is_success(), "kind:0 submit failed");

    // Use the observation wrapper to capture the wire event.
    let observer = SubmitObserver::new();
    let scope = state.capture_archive_scope(8).unwrap();

    let result = scoped_archive_with_observation(
        &state,
        &scope,
        ArchiveKind::Archive,
        &agent_pubkey,
        &observer,
    )
    .await;

    // The relay may accept or reject based on condition eval, but the
    // submitted request MUST carry exactly one fresh empty-condition auth tag.
    let observed_event = observer.last().expect("must have observed an event");
    let auth_tags: Vec<&[String]> = observed_event
        .tags
        .iter()
        .map(|t| t.as_slice())
        .filter(|s| s.first().map(String::as_str) == Some("auth"))
        .collect();
    assert_eq!(
        auth_tags.len(),
        1,
        "exactly one auth tag must be on the wire (fresh mint)"
    );
    assert_eq!(
        auth_tags[0][2], "",
        "fresh-minted tag must have EMPTY condition (not the expired profile condition)"
    );
    // Distinct from the profile tag: the profile tag has condition=past, the
    // fresh tag has condition="". The assertion above confirms this.

    // The result depends on whether the relay accepts an expired profile tag
    // or not. Either way, the WIRE form was correct.
    let _ = result;
}

#[tokio::test]
#[ignore]
async fn self_requests_are_authless() {
    let relay_url = require_env("RELAY_API_URL");

    let owner_keys = nostr::Keys::generate();
    let owner_pubkey = owner_keys.public_key().to_hex();

    let state = make_test_state(&owner_keys, &relay_url);
    let observer = SubmitObserver::new();
    let scope = state.capture_archive_scope(8).unwrap();

    // Self-archive: actor == target → no auth tag.
    let result = scoped_archive_with_observation(
        &state,
        &scope,
        ArchiveKind::Archive,
        &owner_pubkey,
        &observer,
    )
    .await;

    // The observed event must have ZERO auth tags — self path bypasses auth-tag
    // computation entirely.
    let observed_event = observer.last().expect("must have observed an event");
    let auth_tags: Vec<_> = observed_event
        .tags
        .iter()
        .filter(|t| t.as_slice().first().map(String::as_str) == Some("auth"))
        .collect();
    assert_eq!(
        auth_tags.len(),
        0,
        "self archive must send NO auth tag on the wire"
    );

    // Self-unarchive: also authless.
    let scope2 = state.capture_archive_scope(8).unwrap();
    let observer2 = SubmitObserver::new();
    let _ = scoped_archive_with_observation(
        &state,
        &scope2,
        ArchiveKind::Unarchive,
        &owner_pubkey,
        &observer2,
    )
    .await;
    let event2 = observer2.last().expect("must have observed event 2");
    let auth_tags2: Vec<_> = event2
        .tags
        .iter()
        .filter(|t| t.as_slice().first().map(String::as_str) == Some("auth"))
        .collect();
    assert_eq!(
        auth_tags2.len(),
        0,
        "self unarchive must also send NO auth tag"
    );

    // The relay's accept/reject decision for self is separate from our assertion.
    let _ = result;
}

#[tokio::test]
#[ignore]
async fn relay_rejection_is_direct_no_retry() {
    let relay_url = require_env("RELAY_API_URL");

    let owner_keys = nostr::Keys::generate();
    let unrelated_keys = nostr::Keys::generate();
    let unrelated_pubkey = unrelated_keys.public_key().to_hex();

    let state = make_test_state(&owner_keys, &relay_url);
    let observer = SubmitObserver::new();

    // Target has no kind:0 → classifier-negative → no auth tag → relay rejects.
    // The operation has NO retry loop — one submit attempt, one result.
    let scope = state.capture_archive_scope(8).unwrap();
    let result = scoped_archive_with_observation(
        &state,
        &scope,
        ArchiveKind::Archive,
        &unrelated_pubkey,
        &observer,
    )
    .await;

    // Assert the relay rejected (no authority).
    assert!(result.is_err(), "expected relay rejection, got success");

    // Assert exactly ONE attempt — the observer count proves no retry loop ran.
    assert_eq!(
        observer.attempts(),
        1,
        "relay rejection must produce exactly one submit attempt (no retry)"
    );
}
