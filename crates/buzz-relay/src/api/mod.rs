//! HTTP API — media, git, NIP-05, and the Nostr HTTP bridge.

pub mod admin;
pub mod bridge;
pub mod events;
pub mod git;
pub mod invites;
pub mod managed_agents;
pub mod media;
pub mod mesh_demo;
pub mod nip05;
pub mod operator;

// Re-export imeta helpers used by ingest pipeline.
pub use crate::handlers::imeta::{validate_imeta_tags, verify_imeta_blobs};

use axum::{http::StatusCode, response::Json};

/// Standard error envelope.
pub(crate) fn api_error(status: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": msg })))
}

pub(crate) fn internal_error(msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    tracing::error!("Internal error: {msg}");
    api_error(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
}

#[allow(dead_code)]
pub(crate) fn not_found(msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    api_error(StatusCode::NOT_FOUND, msg)
}

/// Relay membership enforcement — single gate for all authenticated entry points.
///
/// Moved here from the deleted `relay_members` module. Called by `media.rs`, `bridge.rs`,
/// `git/transport.rs`, and `audio/handler.rs`.
pub mod relay_members {
    use axum::{http::StatusCode, response::Json};
    use buzz_core::{tenant::CommunityId, TenantContext};
    use tracing::{debug, info};

    use crate::state::AppState;

    /// Transport-neutral outcome of a relay-membership check.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum MembershipDecision {
        /// Relay membership enforcement is disabled.
        OpenRelay,
        /// Caller is directly present in `relay_members`. A verified owner is
        /// retained for revocation rechecks and durable owner materialization;
        /// it did not grant this membership.
        Member(Option<nostr::PublicKey>),
        /// Caller is admitted through a NIP-OA owner that is a relay member.
        ViaOwner(nostr::PublicKey),
        /// Caller is not admitted.
        Denied,
    }

    fn verified_nip_oa_owner(
        pubkey_bytes: &[u8],
        auth_tag_header: Option<&str>,
    ) -> Option<nostr::PublicKey> {
        let tag_json = auth_tag_header?;
        let agent_pubkey = nostr::PublicKey::from_slice(pubkey_bytes).ok()?;
        match buzz_sdk::nip_oa::verify_auth_tag(tag_json, &agent_pubkey) {
            Ok(owner) => Some(owner),
            Err(e) => {
                info!(agent = %agent_pubkey.to_hex(), "NIP-OA auth tag invalid: {e}");
                None
            }
        }
    }

    fn open_relay_decision(verified_owner: Option<nostr::PublicKey>) -> MembershipDecision {
        verified_owner
            .map(MembershipDecision::ViaOwner)
            .unwrap_or(MembershipDecision::OpenRelay)
    }

    /// Check relay membership without committing to an HTTP response shape.
    ///
    /// `community` is the server-resolved tenant of the request; membership is
    /// scoped to it so admitting a pubkey to community A never admits it to B.
    pub async fn check_relay_membership(
        state: &AppState,
        community: CommunityId,
        pubkey_bytes: &[u8],
        auth_tag_header: Option<&str>,
    ) -> Result<MembershipDecision, String> {
        let pubkey_hex = hex::encode(pubkey_bytes);
        // Verify owner evidence independently of whether NIP-OA may grant
        // closed-relay membership. A direct member can still be a managed
        // agent, and its proven owner is required to enforce a PMA tombstone.
        let verified_owner = verified_nip_oa_owner(pubkey_bytes, auth_tag_header);
        let revoked = state
            .db
            .managed_agent_participation_is_revoked(
                community,
                pubkey_bytes,
                verified_owner
                    .as_ref()
                    .map(|owner| owner.as_bytes().as_slice()),
            )
            .await
            .map_err(|e| format!("managed-agent participation check failed: {e}"))?;
        if revoked {
            return Ok(MembershipDecision::Denied);
        }

        if !state.config.require_relay_membership {
            return Ok(open_relay_decision(verified_owner));
        }

        let is_member = state
            .db
            .is_relay_member(community, &pubkey_hex)
            .await
            .map_err(|e| format!("relay membership check failed: {e}"))?;
        if is_member {
            return Ok(MembershipDecision::Member(verified_owner));
        }

        if state.config.allow_nip_oa_auth {
            if let Some(owner_pubkey) = verified_owner {
                let owner_hex = owner_pubkey.to_hex();
                let owner_is_member = state
                    .db
                    .is_relay_member(community, &owner_hex)
                    .await
                    .map_err(|e| format!("relay membership check (owner) failed: {e}"))?;
                if owner_is_member {
                    debug!(
                        agent = %pubkey_hex,
                        owner = %owner_hex,
                        "NIP-OA membership granted via owner"
                    );
                    return Ok(MembershipDecision::ViaOwner(owner_pubkey));
                }
            }
        }

        Ok(MembershipDecision::Denied)
    }

    /// Enforce relay membership for a pubkey, with NIP-OA agent delegation fallback.
    ///
    /// Returns `Ok(Some(owner_pubkey))` whenever the caller supplies verified
    /// NIP-OA owner evidence, including when the caller is itself a direct
    /// member. The feature flag controls only whether that evidence can grant
    /// admission to a non-member on a closed relay.
    ///
    /// On open relays (`require_relay_membership = false`), owner evidence is
    /// likewise returned unconditionally for durable backfill.
    ///
    /// Returns `Ok(None)` only when no valid NIP-OA tag is present.
    pub async fn enforce_relay_membership(
        state: &AppState,
        community: CommunityId,
        pubkey_bytes: &[u8],
        auth_tag_header: Option<&str>,
    ) -> Result<Option<nostr::PublicKey>, (StatusCode, Json<serde_json::Value>)> {
        match check_relay_membership(state, community, pubkey_bytes, auth_tag_header).await {
            Ok(MembershipDecision::OpenRelay) => Ok(None),
            Ok(MembershipDecision::Member(owner)) => Ok(owner),
            Ok(MembershipDecision::ViaOwner(owner)) => Ok(Some(owner)),
            Ok(MembershipDecision::Denied) => Err((
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "relay_membership_required",
                    "message": "You must be a relay member to access this relay"
                })),
            )),
            Err(e) => {
                tracing::error!("relay membership check errored: {e}");
                Err(super::internal_error(&e))
            }
        }
    }

    /// Extract NIP-OA owner from an auth tag without membership enforcement.
    ///
    /// Used on open relays (`require_relay_membership = false`) to opportunistically
    /// extract the owner pubkey for agent→owner backfill. The NIP-OA signature is
    /// cryptographically self-proving, so no feature flag is needed — if the tag
    /// verifies, the owner relationship is authentic. Returns `None` if the tag
    /// is absent or invalid.
    pub fn extract_nip_oa_owner(
        pubkey_bytes: &[u8],
        auth_tag_header: Option<&str>,
    ) -> Option<nostr::PublicKey> {
        let tag_json = auth_tag_header?;
        let agent_pubkey = nostr::PublicKey::from_slice(pubkey_bytes).ok()?;
        match buzz_sdk::nip_oa::verify_auth_tag(tag_json, &agent_pubkey) {
            Ok(owner) => Some(owner),
            Err(e) => {
                info!("extract_nip_oa_owner: invalid auth tag: {e}");
                None
            }
        }
    }

    /// Persist a cryptographically verified NIP-OA agent→owner relationship.
    ///
    /// Both principals are ensured first because `agent_owner_pubkey` has a
    /// community-scoped foreign key. The mapping is first-write-wins; an
    /// existing mapping is accepted only when it names the same owner.
    pub async fn materialize_nip_oa_owner(
        state: &AppState,
        tenant: &TenantContext,
        agent: &nostr::PublicKey,
        owner: &nostr::PublicKey,
    ) -> bool {
        for (role, pubkey) in [("agent", agent), ("owner", owner)] {
            match state
                .db
                .ensure_user(tenant.community(), pubkey.as_bytes())
                .await
            {
                Ok(true) => {
                    metrics::counter!(
                        "buzz_users_created_total",
                        "community" => tenant.host().to_owned()
                    )
                    .increment(1);
                }
                Ok(false) => {}
                Err(e) => {
                    tracing::warn!(%role, error = %e, "ensure_user failed during NIP-OA backfill");
                    return false;
                }
            }
        }

        let materialized = match state
            .db
            .set_agent_owner(tenant.community(), agent.as_bytes(), owner.as_bytes())
            .await
        {
            Ok(true) => true,
            Ok(false) => state
                .db
                .is_agent_owner(tenant.community(), agent.as_bytes(), owner.as_bytes())
                .await
                .unwrap_or(false),
            Err(e) => {
                tracing::warn!(error = %e, "failed to backfill agent_owner_pubkey");
                false
            }
        };

        if materialized {
            state
                .author_type_cache
                .insert((tenant.community(), agent.to_bytes().to_vec()), true);
            state.observer_owner_cache.insert(
                (
                    tenant.community(),
                    agent.to_bytes().to_vec(),
                    owner.to_bytes().to_vec(),
                ),
                true,
            );
        }
        materialized
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use buzz_sdk::nip_oa::compute_auth_tag;
        use nostr::Keys;

        #[test]
        fn owner_evidence_is_verified_independently_of_membership_grant_policy() {
            let owner = Keys::generate();
            let agent = Keys::generate();
            let tag = compute_auth_tag(&owner, &agent.public_key(), "").unwrap();
            assert_eq!(
                verified_nip_oa_owner(agent.public_key().as_bytes(), Some(&tag)),
                Some(owner.public_key())
            );
            assert_eq!(
                verified_nip_oa_owner(agent.public_key().as_bytes(), Some("invalid")),
                None
            );
        }

        #[test]
        fn open_relay_extracts_owner_regardless_of_closed_relay_feature_flag() {
            let owner = Keys::generate().public_key();
            assert_eq!(
                open_relay_decision(Some(owner)),
                MembershipDecision::ViaOwner(owner)
            );
            assert_eq!(open_relay_decision(None), MembershipDecision::OpenRelay);
        }

        /// Valid NIP-OA auth tag → returns Some(owner_pubkey).
        #[test]
        fn valid_nip_oa_returns_owner() {
            let owner_keys = Keys::generate();
            let agent_keys = Keys::generate();
            let agent_pubkey = agent_keys.public_key();

            let tag_json = compute_auth_tag(&owner_keys, &agent_pubkey, "")
                .expect("compute_auth_tag must succeed");

            let result = extract_nip_oa_owner(&agent_pubkey.to_bytes(), Some(&tag_json));

            assert_eq!(result, Some(owner_keys.public_key()));
        }

        /// No auth tag → returns None.
        #[test]
        fn no_auth_tag_returns_none() {
            let agent_keys = Keys::generate();
            let agent_pubkey = agent_keys.public_key();

            let result = extract_nip_oa_owner(&agent_pubkey.to_bytes(), None);

            assert_eq!(result, None);
        }

        /// Invalid auth tag → returns None.
        #[test]
        fn invalid_auth_tag_returns_none() {
            let agent_keys = Keys::generate();
            let agent_pubkey = agent_keys.public_key();

            let result = extract_nip_oa_owner(&agent_pubkey.to_bytes(), Some("not valid json"));

            assert_eq!(result, None);
        }
    }
}
