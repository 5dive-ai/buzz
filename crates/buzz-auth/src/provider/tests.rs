use std::{
    future::pending,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use nostr::Keys;

use super::*;
use crate::context::{
    AssertionExpiry, AssertionNotBefore, AssertionTransport, AuthTransport, BindingSource,
    BindingVersion, DelegationExpiry, VerifiedKeyAttestation, VerifiedTransportDelegation,
};

const NOW: u64 = 100;

fn domain(value: u128) -> CommunityId {
    CommunityId::from_uuid(Uuid::from_u128(value))
}

fn principal() -> FederatedPrincipal {
    FederatedPrincipal::new("https://idp.example", "subject-123")
        .expect("synthetic principal is valid")
}

fn profile() -> AuthorizationProfileId {
    AuthorizationProfileId::new("profile-1").expect("synthetic profile is valid")
}

fn policy_version(value: &str) -> PolicyVersion {
    PolicyVersion::new(value).expect("synthetic policy version is valid")
}

fn provider_timeout() -> ProviderTimeout {
    ProviderTimeout::new(Duration::from_secs(1)).expect("synthetic timeout is finite")
}

fn capabilities(values: &[AuthorizationCapability]) -> CapabilitySet {
    CapabilitySet::new(values.to_vec()).expect("synthetic capabilities are non-empty")
}

fn direct_request_with_expiry(
    actor: &Keys,
    expiry: u64,
    requested: CapabilitySet,
) -> AuthorizationRequest {
    let proof = VerifiedNostrProof::new(
        domain(1),
        AuthTransport::RelayWebSocket,
        actor.public_key(),
        AuthMethod::Nip42,
        None,
    )
    .expect("synthetic proof is valid");
    let assertion = VerifiedFederatedAssertion::new(
        domain(1),
        AuthTransport::RelayWebSocket,
        principal(),
        Some(VerifiedKeyAttestation::new(actor.public_key())),
        AssertionTransport::TrustedProxy,
        None,
        AssertionExpiry::new(expiry).expect("synthetic assertion expiry is valid"),
    );
    AuthorizationRequest::direct(
        &proof,
        &assertion,
        profile(),
        requested,
        Uuid::from_u128(20),
        NOW,
    )
    .expect("synthetic direct request is valid")
}

fn direct_request(actor: &Keys) -> AuthorizationRequest {
    direct_request_with_expiry(
        actor,
        200,
        capabilities(&[AuthorizationCapability::CommunityRead]),
    )
}

fn existing_binding(owner: &Keys) -> VersionedBindingRef {
    existing_binding_in(1, owner)
}

fn existing_binding_in(domain_value: u128, owner: &Keys) -> VersionedBindingRef {
    VersionedBindingRef::new_existing_active_for_test(
        domain(domain_value),
        Uuid::from_u128(10),
        principal(),
        owner.public_key(),
        BindingVersion::INITIAL,
        BindingSource::Provisioned,
    )
    .expect("synthetic binding is valid")
}

fn delegated_request(actor: &Keys, owner: &Keys, expiry: u64) -> AuthorizationRequest {
    let delegation = VerifiedTransportDelegation::new_unrestricted(
        owner.public_key(),
        actor.public_key(),
        Some(DelegationExpiry::new(expiry).expect("synthetic delegation expiry is valid")),
    )
    .expect("synthetic delegation is valid");
    let proof = VerifiedNostrProof::new(
        domain(1),
        AuthTransport::RelayWebSocket,
        actor.public_key(),
        AuthMethod::Nip42,
        Some(delegation),
    )
    .expect("synthetic delegated proof is valid");
    AuthorizationRequest::delegated(
        &proof,
        &existing_binding(owner),
        profile(),
        capabilities(&[AuthorizationCapability::CommunityRead]),
        Uuid::from_u128(20),
        NOW,
    )
    .expect("synthetic delegated request is valid")
}

fn allow_for(
    request: &AuthorizationRequest,
    granted: CapabilitySet,
    version: &str,
    issued_at: u64,
    fresh_until: u64,
) -> ProviderDecision {
    ProviderDecision::Allow(
        ProviderAllow::new(
            request.authorization_domain(),
            request.principal().clone(),
            request.profile_id().clone(),
            granted,
            policy_version(version),
            issued_at,
            fresh_until,
        )
        .expect("synthetic provider allow is structurally valid"),
    )
}

struct FakeProvider {
    decision: Mutex<Option<ProviderDecision>>,
}

impl FakeProvider {
    fn returning(decision: ProviderDecision) -> Self {
        Self {
            decision: Mutex::new(Some(decision)),
        }
    }
}

impl AuthorizationProvider for FakeProvider {
    fn authorize<'a>(
        &'a self,
        _request: &'a AuthorizationRequest,
    ) -> AuthorizationProviderFuture<'a> {
        Box::pin(async move {
            self.decision
                .lock()
                .expect("synthetic provider mutex is not poisoned")
                .take()
                .expect("synthetic provider is called exactly once")
        })
    }
}

struct PendingProvider {
    calls: Arc<AtomicUsize>,
    dropped: Arc<AtomicBool>,
}

struct CancellationMarker(Arc<AtomicBool>);

impl Drop for CancellationMarker {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl AuthorizationProvider for PendingProvider {
    fn authorize<'a>(
        &'a self,
        _request: &'a AuthorizationRequest,
    ) -> AuthorizationProviderFuture<'a> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let marker = CancellationMarker(Arc::clone(&self.dropped));
        Box::pin(async move {
            let _marker = marker;
            pending().await
        })
    }
}

#[tokio::test]
async fn current_allow_returns_request_scoped_snapshot() {
    let actor = Keys::generate();
    let request = direct_request(&actor);
    let provider = FakeProvider::returning(allow_for(
        &request,
        capabilities(&[
            AuthorizationCapability::CommunityRead,
            AuthorizationCapability::CommunityWrite,
        ]),
        "version-a",
        90,
        180,
    ));

    let AuthorizationOutcome::Allow(snapshot) =
        resolve_authorization(&provider, &request, NOW, provider_timeout()).await
    else {
        panic!("current provider policy must allow");
    };

    assert_eq!(snapshot.authorization_domain(), domain(1));
    assert_eq!(snapshot.actor_pubkey(), actor.public_key());
    assert_eq!(snapshot.owner_pubkey(), None);
    assert_eq!(snapshot.proof_method(), AuthMethod::Nip42);
    assert_eq!(snapshot.principal(), request.principal());
    assert_eq!(snapshot.profile_id(), request.profile_id());
    assert_eq!(
        snapshot.capabilities().as_slice(),
        &[AuthorizationCapability::CommunityRead]
    );
    assert_eq!(snapshot.policy_version().as_str(), "version-a");
    assert_eq!(snapshot.issued_at(), 90);
    assert_eq!(snapshot.fresh_until(), 180);
    assert_eq!(snapshot.effective_until(), 180);
    assert_eq!(snapshot.decision_source(), DecisionSource::DirectAssertion);
    assert_eq!(snapshot.correlation_id(), request.correlation_id());
    assert_eq!(snapshot.reason(), ProviderAllowReason::CurrentPolicy);
}

#[tokio::test]
async fn explicit_denial_is_preserved() {
    let actor = Keys::generate();
    let request = direct_request(&actor);
    let provider = FakeProvider::returning(ProviderDecision::Deny(AuthorizationDenial::new(
        AuthorizationDenialReason::ProviderDenied,
    )));

    let AuthorizationOutcome::Deny(denial) =
        resolve_authorization(&provider, &request, NOW, provider_timeout()).await
    else {
        panic!("provider denial must fail closed");
    };
    assert_eq!(denial.reason(), AuthorizationDenialReason::ProviderDenied);
}

#[tokio::test]
async fn provider_unavailability_never_falls_back_to_allow() {
    let actor = Keys::generate();
    let request = direct_request(&actor);
    let retry_after = RetryAfter::new(30).expect("synthetic retry hint is bounded");
    let provider =
        FakeProvider::returning(ProviderDecision::Unavailable(ProviderUnavailable::new(
            ProviderUnavailableReason::TemporarilyUnavailable,
            Some(retry_after),
        )));

    let AuthorizationOutcome::Unavailable(unavailable) =
        resolve_authorization(&provider, &request, NOW, provider_timeout()).await
    else {
        panic!("provider unavailability must remain fail closed");
    };
    assert_eq!(
        unavailable.reason(),
        ProviderUnavailableReason::TemporarilyUnavailable
    );
    assert_eq!(unavailable.retry_after(), Some(retry_after));
}

#[tokio::test]
async fn provider_call_deadline_returns_timeout_unavailability() {
    let actor = Keys::generate();
    let request = direct_request(&actor);
    let calls = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicBool::new(false));
    let provider = PendingProvider {
        calls: Arc::clone(&calls),
        dropped: Arc::clone(&dropped),
    };
    let timeout =
        ProviderTimeout::new(Duration::from_millis(1)).expect("synthetic timeout is finite");

    let AuthorizationOutcome::Unavailable(unavailable) =
        resolve_authorization(&provider, &request, NOW, timeout).await
    else {
        panic!("provider timeout must remain fail closed");
    };
    assert_eq!(unavailable.reason(), ProviderUnavailableReason::Timeout);
    assert_eq!(unavailable.retry_after(), None);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn stale_and_future_provider_decisions_deny() {
    let actor = Keys::generate();
    let request = direct_request(&actor);
    let stale = FakeProvider::returning(allow_for(
        &request,
        request.requested_capabilities().clone(),
        "version-a",
        80,
        90,
    ));
    let AuthorizationOutcome::Deny(stale_denial) =
        resolve_authorization(&stale, &request, NOW, provider_timeout()).await
    else {
        panic!("stale decision must deny");
    };
    assert_eq!(
        stale_denial.reason(),
        AuthorizationDenialReason::StaleDecision
    );

    let future = FakeProvider::returning(allow_for(
        &request,
        request.requested_capabilities().clone(),
        "version-a",
        110,
        180,
    ));
    let AuthorizationOutcome::Deny(future_denial) =
        resolve_authorization(&future, &request, NOW, provider_timeout()).await
    else {
        panic!("future decision must deny");
    };
    assert_eq!(
        future_denial.reason(),
        AuthorizationDenialReason::FutureDecision
    );
}

#[tokio::test]
async fn domain_principal_and_capability_mismatches_deny() {
    let actor = Keys::generate();
    let request = direct_request(&actor);

    let wrong_domain = FakeProvider::returning(ProviderDecision::Allow(
        ProviderAllow::new(
            domain(2),
            request.principal().clone(),
            request.profile_id().clone(),
            request.requested_capabilities().clone(),
            policy_version("version-a"),
            90,
            180,
        )
        .expect("synthetic provider allow is structurally valid"),
    ));
    let AuthorizationOutcome::Deny(denial) =
        resolve_authorization(&wrong_domain, &request, NOW, provider_timeout()).await
    else {
        panic!("cross-domain decision must deny");
    };
    assert_eq!(
        denial.reason(),
        AuthorizationDenialReason::AuthorizationDomainMismatch
    );

    let wrong_principal = FakeProvider::returning(ProviderDecision::Allow(
        ProviderAllow::new(
            domain(1),
            FederatedPrincipal::new("https://idp.example", "other-subject")
                .expect("synthetic principal is valid"),
            request.profile_id().clone(),
            request.requested_capabilities().clone(),
            policy_version("version-a"),
            90,
            180,
        )
        .expect("synthetic provider allow is structurally valid"),
    ));
    let AuthorizationOutcome::Deny(denial) =
        resolve_authorization(&wrong_principal, &request, NOW, provider_timeout()).await
    else {
        panic!("principal mismatch must deny");
    };
    assert_eq!(
        denial.reason(),
        AuthorizationDenialReason::PrincipalMismatch
    );

    let wrong_profile = FakeProvider::returning(ProviderDecision::Allow(
        ProviderAllow::new(
            domain(1),
            request.principal().clone(),
            AuthorizationProfileId::new("other-profile").expect("synthetic profile is valid"),
            request.requested_capabilities().clone(),
            policy_version("version-a"),
            90,
            180,
        )
        .expect("synthetic provider allow is structurally valid"),
    ));
    let AuthorizationOutcome::Deny(denial) =
        resolve_authorization(&wrong_profile, &request, NOW, provider_timeout()).await
    else {
        panic!("profile mismatch must deny");
    };
    assert_eq!(
        denial.reason(),
        AuthorizationDenialReason::AuthorizationProfileMismatch
    );

    let missing_capability = FakeProvider::returning(allow_for(
        &request,
        capabilities(&[AuthorizationCapability::CommunityWrite]),
        "version-a",
        90,
        180,
    ));
    let AuthorizationOutcome::Deny(denial) =
        resolve_authorization(&missing_capability, &request, NOW, provider_timeout()).await
    else {
        panic!("missing capability must deny");
    };
    assert_eq!(
        denial.reason(),
        AuthorizationDenialReason::MissingCapability
    );
}

#[tokio::test]
async fn assertion_expiry_bounds_provider_freshness() {
    let actor = Keys::generate();
    let request = direct_request_with_expiry(
        &actor,
        120,
        capabilities(&[AuthorizationCapability::CommunityRead]),
    );
    let provider = FakeProvider::returning(allow_for(
        &request,
        request.requested_capabilities().clone(),
        "version-a",
        90,
        180,
    ));

    let AuthorizationOutcome::Allow(snapshot) =
        resolve_authorization(&provider, &request, NOW, provider_timeout()).await
    else {
        panic!("current bounded policy must allow");
    };
    assert_eq!(snapshot.fresh_until(), 180);
    assert_eq!(snapshot.effective_until(), 120);
}

#[tokio::test]
async fn delegated_owner_admission_does_not_require_owner_assertion() {
    let actor = Keys::generate();
    let owner = Keys::generate();
    let request = delegated_request(&actor, &owner, 140);
    assert!(matches!(
        request.authority(),
        AuthorizationAuthority::Delegated { owner_pubkey }
            if *owner_pubkey == owner.public_key()
    ));
    assert_eq!(
        request.decision_source(),
        DecisionSource::DelegatedOwnerBinding
    );

    let provider = FakeProvider::returning(allow_for(
        &request,
        request.requested_capabilities().clone(),
        "version-a",
        90,
        180,
    ));
    let AuthorizationOutcome::Allow(snapshot) =
        resolve_authorization(&provider, &request, NOW, provider_timeout()).await
    else {
        panic!("current owner admission must allow delegated authority");
    };
    assert_eq!(snapshot.effective_until(), 140);
    assert_eq!(snapshot.actor_pubkey(), actor.public_key());
    assert_eq!(snapshot.owner_pubkey(), Some(owner.public_key()));
}

#[tokio::test]
async fn policy_versions_detect_equality_and_change_without_ordering() {
    let actor = Keys::generate();
    let request_a = direct_request(&actor);
    let provider_a = FakeProvider::returning(allow_for(
        &request_a,
        request_a.requested_capabilities().clone(),
        "opaque-a",
        90,
        180,
    ));
    let AuthorizationOutcome::Allow(snapshot_a) =
        resolve_authorization(&provider_a, &request_a, NOW, provider_timeout()).await
    else {
        panic!("current provider policy must allow");
    };

    let request_b = direct_request(&actor);
    let provider_b = FakeProvider::returning(allow_for(
        &request_b,
        request_b.requested_capabilities().clone(),
        "opaque-b",
        90,
        180,
    ));
    let AuthorizationOutcome::Allow(snapshot_b) =
        resolve_authorization(&provider_b, &request_b, NOW, provider_timeout()).await
    else {
        panic!("current provider policy must allow");
    };

    assert_ne!(snapshot_a.policy_version(), snapshot_b.policy_version());
    assert_eq!(snapshot_a.policy_version(), &policy_version("opaque-a"));
}

#[test]
fn provider_contract_rejects_malformed_values() {
    assert_eq!(
        CapabilitySet::new(Vec::new()),
        Err(ProviderContractError::EmptyCapabilitySet)
    );
    assert_eq!(
        AuthorizationProfileId::new(""),
        Err(ProviderContractError::EmptyProfileId)
    );
    assert_eq!(
        AuthorizationProfileId::new("x".repeat(MAX_OPAQUE_ID_BYTES + 1)),
        Err(ProviderContractError::ProfileIdTooLong)
    );
    assert_eq!(
        PolicyVersion::new(""),
        Err(ProviderContractError::EmptyPolicyVersion)
    );
    assert_eq!(
        RetryAfter::new(0),
        Err(ProviderContractError::InvalidRetryAfter)
    );
    assert_eq!(
        RetryAfter::new(MAX_RETRY_AFTER_SECONDS + 1),
        Err(ProviderContractError::InvalidRetryAfter)
    );
    assert_eq!(
        ProviderTimeout::new(Duration::ZERO),
        Err(ProviderContractError::InvalidProviderTimeout)
    );
    assert_eq!(
        ProviderTimeout::new(MAX_PROVIDER_TIMEOUT + Duration::from_nanos(1)),
        Err(ProviderContractError::InvalidProviderTimeout)
    );
    assert_eq!(
        ProviderAllow::new(
            domain(1),
            principal(),
            profile(),
            capabilities(&[AuthorizationCapability::CommunityRead]),
            policy_version("version-a"),
            0,
            180,
        ),
        Err(ProviderContractError::InvalidIssuedAt)
    );
    assert_eq!(
        ProviderAllow::new(
            domain(1),
            principal(),
            profile(),
            capabilities(&[AuthorizationCapability::CommunityRead]),
            policy_version("version-a"),
            100,
            100,
        ),
        Err(ProviderContractError::InvalidFreshnessBound)
    );
    assert_eq!(
        ProviderAllow::new(
            domain(1),
            principal(),
            profile(),
            capabilities(&[AuthorizationCapability::CommunityRead]),
            policy_version("version-a"),
            100,
            100 + MAX_PROVIDER_FRESHNESS_SECONDS + 1,
        ),
        Err(ProviderContractError::FreshnessWindowTooLong)
    );
}

#[test]
fn request_construction_rechecks_verified_bounds_and_relationships() {
    let actor = Keys::generate();
    let proof = VerifiedNostrProof::new(
        domain(1),
        AuthTransport::RelayWebSocket,
        actor.public_key(),
        AuthMethod::Nip42,
        None,
    )
    .expect("synthetic proof is valid");
    let expired = VerifiedFederatedAssertion::new(
        domain(1),
        AuthTransport::RelayWebSocket,
        principal(),
        Some(VerifiedKeyAttestation::new(actor.public_key())),
        AssertionTransport::TrustedProxy,
        None,
        AssertionExpiry::new(NOW).expect("synthetic expiry is valid"),
    );
    assert_eq!(
        AuthorizationRequest::direct(
            &proof,
            &expired,
            profile(),
            capabilities(&[AuthorizationCapability::CommunityRead]),
            Uuid::nil(),
            NOW,
        ),
        Err(ProviderContractError::InvalidCorrelationId)
    );
    assert_eq!(
        AuthorizationRequest::direct(
            &proof,
            &expired,
            profile(),
            capabilities(&[AuthorizationCapability::CommunityRead]),
            Uuid::from_u128(20),
            NOW,
        ),
        Err(ProviderContractError::AssertionExpired)
    );

    let future = VerifiedFederatedAssertion::new(
        domain(1),
        AuthTransport::RelayWebSocket,
        principal(),
        Some(VerifiedKeyAttestation::new(actor.public_key())),
        AssertionTransport::TrustedProxy,
        Some(AssertionNotBefore::new(NOW + 1)),
        AssertionExpiry::new(NOW + 20).expect("synthetic expiry is valid"),
    );
    assert_eq!(
        AuthorizationRequest::direct(
            &proof,
            &future,
            profile(),
            capabilities(&[AuthorizationCapability::CommunityRead]),
            Uuid::from_u128(20),
            NOW,
        ),
        Err(ProviderContractError::AssertionNotYetValid)
    );
}

#[test]
fn request_construction_rejects_mismatched_verified_evidence() {
    let actor = Keys::generate();
    let owner = Keys::generate();
    let other = Keys::generate();
    let proof = VerifiedNostrProof::new(
        domain(1),
        AuthTransport::RelayWebSocket,
        actor.public_key(),
        AuthMethod::Nip42,
        None,
    )
    .expect("synthetic proof is valid");

    let assertion_in_domain =
        |domain_value, transport, attested_pubkey: Option<nostr::PublicKey>| {
            VerifiedFederatedAssertion::new(
                domain(domain_value),
                transport,
                principal(),
                attested_pubkey.map(VerifiedKeyAttestation::new),
                AssertionTransport::TrustedProxy,
                None,
                AssertionExpiry::new(NOW + 20).expect("synthetic expiry is valid"),
            )
        };
    let request = |proof: &VerifiedNostrProof, assertion: &VerifiedFederatedAssertion| {
        AuthorizationRequest::direct(
            proof,
            assertion,
            profile(),
            capabilities(&[AuthorizationCapability::CommunityRead]),
            Uuid::from_u128(20),
            NOW,
        )
    };

    assert_eq!(
        request(
            &proof,
            &assertion_in_domain(2, AuthTransport::RelayWebSocket, None),
        ),
        Err(ProviderContractError::AuthorizationDomainMismatch)
    );
    assert_eq!(
        request(
            &proof,
            &assertion_in_domain(1, AuthTransport::HttpBridge, None),
        ),
        Err(ProviderContractError::TransportMismatch)
    );
    assert_eq!(
        request(
            &proof,
            &assertion_in_domain(1, AuthTransport::RelayWebSocket, Some(other.public_key()),),
        ),
        Err(ProviderContractError::KeyAttestationMismatch)
    );
    assert_eq!(
        request(
            &proof,
            &assertion_in_domain(1, AuthTransport::RelayWebSocket, None),
        ),
        Err(ProviderContractError::MissingKeyAttestation)
    );

    let delegation = VerifiedTransportDelegation::new_unrestricted(
        owner.public_key(),
        actor.public_key(),
        Some(DelegationExpiry::new(NOW + 20).expect("synthetic expiry is valid")),
    )
    .expect("synthetic delegation is valid");
    let delegated_proof = VerifiedNostrProof::new(
        domain(1),
        AuthTransport::RelayWebSocket,
        actor.public_key(),
        AuthMethod::Nip42,
        Some(delegation),
    )
    .expect("synthetic proof is valid");
    assert_eq!(
        request(
            &delegated_proof,
            &assertion_in_domain(1, AuthTransport::RelayWebSocket, None),
        ),
        Err(ProviderContractError::DirectRequestHasOwner)
    );

    let delegated_request_from = |proof: &VerifiedNostrProof, binding: &VersionedBindingRef| {
        AuthorizationRequest::delegated(
            proof,
            binding,
            profile(),
            capabilities(&[AuthorizationCapability::CommunityRead]),
            Uuid::from_u128(20),
            NOW,
        )
    };
    assert_eq!(
        AuthorizationRequest::delegated(
            &delegated_proof,
            &existing_binding(&owner),
            profile(),
            capabilities(&[AuthorizationCapability::CommunityRead]),
            Uuid::nil(),
            NOW,
        ),
        Err(ProviderContractError::InvalidCorrelationId)
    );
    assert_eq!(
        delegated_request_from(&proof, &existing_binding(&owner)),
        Err(ProviderContractError::DelegationRequired)
    );
    assert_eq!(
        delegated_request_from(&delegated_proof, &existing_binding(&other)),
        Err(ProviderContractError::DelegatedOwnerMismatch)
    );
    assert_eq!(
        delegated_request_from(&delegated_proof, &existing_binding_in(2, &owner)),
        Err(ProviderContractError::AuthorizationDomainMismatch)
    );

    let expired_delegation = VerifiedTransportDelegation::new_unrestricted(
        owner.public_key(),
        actor.public_key(),
        Some(DelegationExpiry::new(NOW).expect("synthetic expiry is valid")),
    )
    .expect("synthetic delegation is valid");
    let expired_proof = VerifiedNostrProof::new(
        domain(1),
        AuthTransport::RelayWebSocket,
        actor.public_key(),
        AuthMethod::Nip42,
        Some(expired_delegation),
    )
    .expect("synthetic proof is valid");
    assert_eq!(
        delegated_request_from(&expired_proof, &existing_binding(&owner)),
        Err(ProviderContractError::DelegationExpired)
    );
}

#[tokio::test]
async fn request_decision_snapshot_and_errors_are_redaction_safe() {
    let actor = Keys::generate();
    let request = direct_request(&actor);
    assert_eq!(
        format!("{request:?}"),
        concat!(
            "AuthorizationRequest { authorization_domain: \"[redacted]\", ",
            "actor_pubkey: \"[redacted]\", proof_method: \"[redacted]\", ",
            "authority: \"[redacted]\", principal: \"[redacted]\", ",
            "profile_id: \"[redacted]\", requested_capabilities: \"[redacted]\", ",
            "correlation_id: \"[redacted]\", decision_source: \"[redacted]\", ",
            "evidence_valid_until: \"[redacted]\" }"
        )
    );

    let allow = ProviderAllow::new(
        request.authorization_domain(),
        request.principal().clone(),
        request.profile_id().clone(),
        request.requested_capabilities().clone(),
        policy_version("private-policy-version"),
        90,
        180,
    )
    .expect("synthetic provider allow is structurally valid");
    assert_eq!(
        format!("{allow:?}"),
        concat!(
            "ProviderAllow { authorization_domain: \"[redacted]\", ",
            "principal: \"[redacted]\", profile_id: \"[redacted]\", ",
            "capabilities: \"[redacted]\", policy_version: \"[redacted]\", ",
            "issued_at: \"[redacted]\", fresh_until: \"[redacted]\" }"
        )
    );
    let decision = ProviderDecision::Allow(allow);
    assert_eq!(format!("{decision:?}"), "ProviderDecision(\"[redacted]\")");
    let provider = FakeProvider::returning(decision);
    let outcome = resolve_authorization(&provider, &request, NOW, provider_timeout()).await;
    assert_eq!(
        format!("{outcome:?}"),
        "AuthorizationOutcome(\"[redacted]\")"
    );
    let AuthorizationOutcome::Allow(snapshot) = outcome else {
        panic!("current provider policy must allow");
    };
    assert_eq!(
        format!("{snapshot:?}"),
        concat!(
            "CapabilitySnapshot { authorization_domain: \"[redacted]\", ",
            "actor_pubkey: \"[redacted]\", owner_pubkey: \"[redacted]\", ",
            "proof_method: \"[redacted]\", principal: \"[redacted]\", ",
            "profile_id: \"[redacted]\", capabilities: \"[redacted]\", ",
            "policy_version: \"[redacted]\", issued_at: \"[redacted]\", ",
            "fresh_until: \"[redacted]\", effective_until: \"[redacted]\", ",
            "decision_source: \"[redacted]\", correlation_id: \"[redacted]\", ",
            "reason: \"[redacted]\" }"
        )
    );

    let denial = AuthorizationDenial::new(AuthorizationDenialReason::ProviderDenied);
    assert_eq!(
        format!("{denial:?}"),
        "AuthorizationDenial { reason: \"[redacted]\" }"
    );
    let unavailable = ProviderUnavailable::new(
        ProviderUnavailableReason::DependencyUnavailable,
        Some(RetryAfter::new(30).expect("synthetic retry hint is bounded")),
    );
    assert_eq!(
        format!("{unavailable:?}"),
        concat!(
            "ProviderUnavailable { reason: \"[redacted]\", ",
            "retry_after: \"[redacted]\" }"
        )
    );
    assert_eq!(
        format!("{:?}", provider_timeout()),
        "ProviderTimeout(\"[redacted]\")"
    );
    assert_eq!(
        format!("{:?}", request.profile_id()),
        "AuthorizationProfileId(\"[redacted]\")"
    );
    assert_eq!(
        format!("{:?}", snapshot.policy_version()),
        "PolicyVersion(\"[redacted]\")"
    );
    assert_eq!(
        format!("{:?}", snapshot.capabilities()),
        "CapabilitySet(\"[redacted]\")"
    );

    for error in [
        ProviderContractError::EmptyCapabilitySet,
        ProviderContractError::EmptyProfileId,
        ProviderContractError::EmptyPolicyVersion,
        ProviderContractError::AuthorizationDomainMismatch,
        ProviderContractError::DelegatedOwnerMismatch,
    ] {
        let rendered = error.to_string();
        assert!(!rendered.contains("idp.example"));
        assert!(!rendered.contains("subject-123"));
        assert!(!rendered.contains("private-policy-version"));
    }
}

#[test]
fn provider_trait_is_object_safe_and_codes_are_unique() {
    let provider: Arc<dyn AuthorizationProvider> =
        Arc::new(FakeProvider::returning(ProviderDecision::Deny(
            AuthorizationDenial::new(AuthorizationDenialReason::ProviderDenied),
        )));
    assert!(Arc::strong_count(&provider) == 1);

    let mut codes = vec![
        ProviderAllowReason::CurrentPolicy.code(),
        AuthorizationDenialReason::ProviderDenied.code(),
        AuthorizationDenialReason::AuthorizationDomainMismatch.code(),
        AuthorizationDenialReason::PrincipalMismatch.code(),
        AuthorizationDenialReason::AuthorizationProfileMismatch.code(),
        AuthorizationDenialReason::MissingCapability.code(),
        AuthorizationDenialReason::StaleDecision.code(),
        AuthorizationDenialReason::FutureDecision.code(),
        AuthorizationDenialReason::IdentityEvidenceExpired.code(),
        ProviderUnavailableReason::TemporarilyUnavailable.code(),
        ProviderUnavailableReason::Timeout.code(),
        ProviderUnavailableReason::DependencyUnavailable.code(),
    ];
    codes.sort_unstable();
    codes.dedup();
    assert_eq!(codes.len(), 12);

    let contract_errors = [
        ProviderContractError::EmptyCapabilitySet,
        ProviderContractError::EmptyProfileId,
        ProviderContractError::ProfileIdTooLong,
        ProviderContractError::EmptyPolicyVersion,
        ProviderContractError::PolicyVersionTooLong,
        ProviderContractError::InvalidIssuedAt,
        ProviderContractError::InvalidFreshnessBound,
        ProviderContractError::FreshnessWindowTooLong,
        ProviderContractError::InvalidRetryAfter,
        ProviderContractError::InvalidProviderTimeout,
        ProviderContractError::InvalidCorrelationId,
        ProviderContractError::DirectRequestHasOwner,
        ProviderContractError::AuthorizationDomainMismatch,
        ProviderContractError::TransportMismatch,
        ProviderContractError::AssertionNotYetValid,
        ProviderContractError::AssertionExpired,
        ProviderContractError::KeyAttestationMismatch,
        ProviderContractError::MissingKeyAttestation,
        ProviderContractError::DelegationRequired,
        ProviderContractError::DelegatedOwnerMismatch,
        ProviderContractError::DelegationExpired,
    ];
    let mut contract_codes = contract_errors
        .iter()
        .copied()
        .map(ProviderContractError::code)
        .collect::<Vec<_>>();
    contract_codes.sort_unstable();
    contract_codes.dedup();
    assert_eq!(contract_codes.len(), contract_errors.len());
}
