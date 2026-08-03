//! Provider-neutral authorization decisions.
//!
//! This module defines a runtime-neutral boundary between verified identity
//! evidence and deployment-specific policy. It does not select or configure a
//! provider, construct identity evidence, or change any relay handler.

use std::{fmt, future::Future, pin::Pin, time::Duration};

use buzz_core::CommunityId;
use nostr::PublicKey;
use thiserror::Error;
use uuid::Uuid;

use crate::context::{
    AuthMethod, AuthTransport, AuthoritativeBindingEvidence, BindingVersion, FederatedPolicyStamp,
    FederatedPrincipal, ResolvedFederatedPolicy, VerifiedFederatedAssertion, VerifiedNostrProof,
};

const MAX_OPAQUE_ID_BYTES: usize = 256;
const MAX_RETRY_AFTER_SECONDS: u32 = 3_600;
/// Maximum freshness window accepted from an authorization provider.
pub const MAX_PROVIDER_FRESHNESS_SECONDS: u64 = 86_400;
/// Maximum deadline accepted for one authorization-provider call.
pub const MAX_PROVIDER_TIMEOUT: Duration = Duration::from_secs(60);

/// Portable capability evaluated by an [`AuthorizationProvider`].
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum AuthorizationCapability {
    /// Read community content.
    CommunityRead,
    /// Publish community content.
    CommunityWrite,
    /// Perform moderation operations.
    Moderate,
    /// Mint invitations.
    InviteMint,
    /// Claim an invitation before membership exists.
    InviteClaim,
    /// Read authenticated media.
    MediaRead,
    /// Upload media.
    MediaWrite,
    /// Read Git content.
    GitRead,
    /// Write Git content.
    GitWrite,
    /// Join an audio session.
    AudioJoin,
}

impl fmt::Debug for AuthorizationCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("AuthorizationCapability")
            .field(&"[redacted]")
            .finish()
    }
}

/// Non-empty, normalized set of portable capabilities.
#[derive(Clone, PartialEq, Eq)]
pub struct CapabilitySet(Vec<AuthorizationCapability>);

impl CapabilitySet {
    /// Build a non-empty set, sorting and removing duplicate capabilities.
    pub fn new(
        mut capabilities: Vec<AuthorizationCapability>,
    ) -> Result<Self, ProviderContractError> {
        capabilities.sort_unstable();
        capabilities.dedup();
        if capabilities.is_empty() {
            return Err(ProviderContractError::EmptyCapabilitySet);
        }
        Ok(Self(capabilities))
    }

    /// Normalized capabilities in stable order.
    pub fn as_slice(&self) -> &[AuthorizationCapability] {
        &self.0
    }

    fn contains_all(&self, requested: &Self) -> bool {
        requested
            .as_slice()
            .iter()
            .all(|capability| self.0.binary_search(capability).is_ok())
    }
}

impl fmt::Debug for CapabilitySet {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("CapabilitySet")
            .field(&"[redacted]")
            .finish()
    }
}

/// Opaque identifier for the server-resolved authorization profile.
///
/// Production construction is intentionally unavailable until a sealed policy
/// adapter can prove that the profile came from server-owned configuration.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct AuthorizationProfileId(String);

impl AuthorizationProfileId {
    /// Preserve a non-empty, bounded profile identifier exactly as configured.
    #[cfg(test)]
    pub(crate) fn new(value: impl Into<String>) -> Result<Self, ProviderContractError> {
        let value = value.into();
        if value.is_empty() {
            return Err(ProviderContractError::EmptyProfileId);
        }
        if value.len() > MAX_OPAQUE_ID_BYTES {
            return Err(ProviderContractError::ProfileIdTooLong);
        }
        Ok(Self(value))
    }

    /// Exact profile identifier for provider routing.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AuthorizationProfileId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("AuthorizationProfileId")
            .field(&"[redacted]")
            .finish()
    }
}

/// Opaque, equality-comparable capability-policy version returned by a provider.
///
/// This is the typed policy-change seam that later lease and invalidation code
/// can use without assuming a provider-specific numeric ordering. It is a
/// distinct namespace from [`FederatedPolicyStamp::epoch`] and must never be
/// used as enrollment-policy currency evidence.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct PolicyVersion(String);

impl PolicyVersion {
    /// Preserve a non-empty, bounded policy version without interpreting it.
    pub fn new(value: impl Into<String>) -> Result<Self, ProviderContractError> {
        let value = value.into();
        if value.is_empty() {
            return Err(ProviderContractError::EmptyPolicyVersion);
        }
        if value.len() > MAX_OPAQUE_ID_BYTES {
            return Err(ProviderContractError::PolicyVersionTooLong);
        }
        Ok(Self(value))
    }

    /// Exact opaque version bytes.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for PolicyVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("PolicyVersion")
            .field(&"[redacted]")
            .finish()
    }
}

/// Authority whose provider admission is requested.
#[derive(PartialEq, Eq)]
#[non_exhaustive]
pub enum AuthorizationAuthority {
    /// The authenticated actor matches the admitted principal's key attestation.
    Direct,
    /// The authenticated actor derives authority from a bound owner.
    Delegated {
        /// Cryptographically verified and actively bound owner key.
        owner_pubkey: PublicKey,
        /// Stable identifier of the active owner binding.
        binding_id: Uuid,
        /// Exact active owner-binding version used for this decision.
        binding_version: BindingVersion,
    },
}

impl fmt::Debug for AuthorizationAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("AuthorizationAuthority")
            .field(&"[redacted]")
            .finish()
    }
}

/// Redaction-safe description of how the provider request was derived.
#[derive(Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum DecisionSource {
    /// Current verified assertion for the authenticated actor.
    DirectAssertion,
    /// Current active binding for a cryptographically verified owner.
    DelegatedOwnerBinding,
}

impl fmt::Debug for DecisionSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("DecisionSource")
            .field(&"[redacted]")
            .finish()
    }
}

/// Provider request derived from server-verified identity evidence.
#[derive(PartialEq, Eq)]
pub struct AuthorizationRequest {
    authorization_domain: CommunityId,
    transport: AuthTransport,
    actor_pubkey: PublicKey,
    proof_method: AuthMethod,
    authority: AuthorizationAuthority,
    principal: FederatedPrincipal,
    federated_policy: FederatedPolicyStamp,
    profile_id: AuthorizationProfileId,
    requested_capabilities: CapabilitySet,
    correlation_id: Uuid,
    decision_source: DecisionSource,
    evidence_valid_until: Option<u64>,
}

impl AuthorizationRequest {
    /// Build a direct request from a current key-attested assertion and Nostr proof.
    ///
    /// An unattested assertion is intentionally insufficient in this phase. A
    /// future trust-on-first-use path must also consume authoritative active or
    /// atomic-enrollment binding evidence before it can produce direct authority.
    /// `now_unix_seconds` must come from the server clock.
    pub fn direct(
        proof: &VerifiedNostrProof,
        assertion: &VerifiedFederatedAssertion,
        federated_policy: &ResolvedFederatedPolicy,
        profile_id: AuthorizationProfileId,
        requested_capabilities: CapabilitySet,
        correlation_id: Uuid,
        now_unix_seconds: u64,
    ) -> Result<Self, ProviderContractError> {
        if correlation_id.is_nil() {
            return Err(ProviderContractError::InvalidCorrelationId);
        }
        validate_federated_policy(
            federated_policy,
            proof.authorization_domain(),
            correlation_id,
            now_unix_seconds,
        )?;
        if proof.verified_delegation().is_some() {
            return Err(ProviderContractError::DirectRequestHasOwner);
        }
        if proof.authorization_domain() != assertion.authorization_domain() {
            return Err(ProviderContractError::AuthorizationDomainMismatch);
        }
        if proof.authorized_transport() != assertion.authorized_transport() {
            return Err(ProviderContractError::TransportMismatch);
        }
        let Some(key_attestation) = assertion.key_attestation() else {
            return Err(ProviderContractError::MissingKeyAttestation);
        };
        if key_attestation.pubkey() != proof.actor_pubkey() {
            return Err(ProviderContractError::KeyAttestationMismatch);
        }
        if assertion
            .not_before()
            .is_some_and(|bound| bound.is_not_yet_valid_at(now_unix_seconds))
        {
            return Err(ProviderContractError::AssertionNotYetValid);
        }
        if assertion.expires_at().is_expired_at(now_unix_seconds) {
            return Err(ProviderContractError::AssertionExpired);
        }
        Ok(Self {
            authorization_domain: proof.authorization_domain(),
            transport: proof.authorized_transport(),
            actor_pubkey: proof.actor_pubkey(),
            proof_method: proof.proof_method(),
            authority: AuthorizationAuthority::Direct,
            principal: assertion.principal().clone(),
            federated_policy: federated_policy.stamp().clone(),
            profile_id,
            requested_capabilities,
            correlation_id,
            decision_source: DecisionSource::DirectAssertion,
            evidence_valid_until: Some(
                assertion
                    .expires_at()
                    .unix_seconds()
                    .min(federated_policy.stamp().effective_until()),
            ),
        })
    }

    /// Build a delegated request for a cryptographically verified bound owner.
    ///
    /// This path does not require an owner assertion. The provider resolves
    /// current admission for the exact issuer-qualified bound owner.
    /// `now_unix_seconds` must come from the server clock.
    pub fn delegated(
        proof: &VerifiedNostrProof,
        owner: &AuthoritativeBindingEvidence,
        federated_policy: &ResolvedFederatedPolicy,
        profile_id: AuthorizationProfileId,
        requested_capabilities: CapabilitySet,
        correlation_id: Uuid,
        now_unix_seconds: u64,
    ) -> Result<Self, ProviderContractError> {
        if correlation_id.is_nil() {
            return Err(ProviderContractError::InvalidCorrelationId);
        }
        validate_federated_policy(
            federated_policy,
            proof.authorization_domain(),
            correlation_id,
            now_unix_seconds,
        )?;
        if proof.authorization_domain() != owner.authorization_domain() {
            return Err(ProviderContractError::AuthorizationDomainMismatch);
        }
        let Some(delegation) = proof.verified_delegation() else {
            return Err(ProviderContractError::DelegationRequired);
        };
        if delegation.owner_pubkey() != owner.bound_pubkey() {
            return Err(ProviderContractError::DelegatedOwnerMismatch);
        }
        if delegation
            .expires_at()
            .is_some_and(|bound| bound.is_expired_at(now_unix_seconds))
        {
            return Err(ProviderContractError::DelegationExpired);
        }
        if owner
            .expires_at()
            .is_some_and(|bound| bound.is_expired_at(now_unix_seconds))
        {
            return Err(ProviderContractError::BindingExpired);
        }
        let mut evidence_valid_until = federated_policy.stamp().effective_until();
        if let Some(delegation) = delegation.expires_at() {
            evidence_valid_until = evidence_valid_until.min(delegation.unix_seconds());
        }
        if let Some(binding) = owner.expires_at() {
            evidence_valid_until = evidence_valid_until.min(binding.unix_seconds());
        }
        Ok(Self {
            authorization_domain: proof.authorization_domain(),
            transport: proof.authorized_transport(),
            actor_pubkey: proof.actor_pubkey(),
            proof_method: proof.proof_method(),
            authority: AuthorizationAuthority::Delegated {
                owner_pubkey: owner.bound_pubkey(),
                binding_id: owner.binding_id(),
                binding_version: owner.binding_version(),
            },
            principal: owner.principal().clone(),
            federated_policy: federated_policy.stamp().clone(),
            profile_id,
            requested_capabilities,
            correlation_id,
            decision_source: DecisionSource::DelegatedOwnerBinding,
            evidence_valid_until: Some(evidence_valid_until),
        })
    }

    /// Server-resolved authorization domain.
    pub const fn authorization_domain(&self) -> CommunityId {
        self.authorization_domain
    }

    /// Exact protected transport authorized by the verified proof.
    pub const fn transport(&self) -> AuthTransport {
        self.transport
    }

    /// Authenticated Nostr actor.
    pub const fn actor_pubkey(&self) -> PublicKey {
        self.actor_pubkey
    }

    /// Cryptographic proof method used for the actor.
    pub const fn proof_method(&self) -> AuthMethod {
        self.proof_method
    }

    /// Direct or delegated authority whose admission is requested.
    pub const fn authority(&self) -> &AuthorizationAuthority {
        &self.authority
    }

    /// Exact issuer-qualified principal whose admission is requested.
    pub const fn principal(&self) -> &FederatedPrincipal {
        &self.principal
    }

    /// Exact authoritative enrollment-policy lineage bound to this request.
    pub const fn federated_policy(&self) -> &FederatedPolicyStamp {
        &self.federated_policy
    }

    /// Server-resolved provider profile.
    pub const fn profile_id(&self) -> &AuthorizationProfileId {
        &self.profile_id
    }

    /// Portable capabilities requested for this decision.
    pub const fn requested_capabilities(&self) -> &CapabilitySet {
        &self.requested_capabilities
    }

    /// Correlation identifier for this request.
    pub const fn correlation_id(&self) -> Uuid {
        self.correlation_id
    }

    /// Verified source from which this request was derived.
    pub const fn decision_source(&self) -> DecisionSource {
        self.decision_source
    }

    /// Earliest validity bound supplied by verified assertion, owner-binding,
    /// delegation, or authoritative enrollment-policy evidence.
    pub const fn evidence_valid_until(&self) -> Option<u64> {
        self.evidence_valid_until
    }
}

impl fmt::Debug for AuthorizationRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthorizationRequest")
            .field("authorization_domain", &"[redacted]")
            .field("transport", &"[redacted]")
            .field("actor_pubkey", &"[redacted]")
            .field("proof_method", &"[redacted]")
            .field("authority", &"[redacted]")
            .field("principal", &"[redacted]")
            .field("federated_policy", &"[redacted]")
            .field("profile_id", &"[redacted]")
            .field("requested_capabilities", &"[redacted]")
            .field("correlation_id", &"[redacted]")
            .field("decision_source", &"[redacted]")
            .field("evidence_valid_until", &"[redacted]")
            .finish()
    }
}

/// Provider-produced allowed capability data before crate-owned validation.
#[derive(PartialEq, Eq)]
pub struct ProviderAllow {
    authorization_domain: CommunityId,
    principal: FederatedPrincipal,
    profile_id: AuthorizationProfileId,
    capabilities: CapabilitySet,
    policy_version: PolicyVersion,
    issued_at: u64,
    fresh_until: u64,
}

impl ProviderAllow {
    /// Build a provider allow result with mandatory policy and freshness data.
    pub fn new(
        authorization_domain: CommunityId,
        principal: FederatedPrincipal,
        profile_id: AuthorizationProfileId,
        capabilities: CapabilitySet,
        policy_version: PolicyVersion,
        issued_at: u64,
        fresh_until: u64,
    ) -> Result<Self, ProviderContractError> {
        if issued_at == 0 {
            return Err(ProviderContractError::InvalidIssuedAt);
        }
        if fresh_until <= issued_at {
            return Err(ProviderContractError::InvalidFreshnessBound);
        }
        if fresh_until - issued_at > MAX_PROVIDER_FRESHNESS_SECONDS {
            return Err(ProviderContractError::FreshnessWindowTooLong);
        }
        Ok(Self {
            authorization_domain,
            principal,
            profile_id,
            capabilities,
            policy_version,
            issued_at,
            fresh_until,
        })
    }
}

impl fmt::Debug for ProviderAllow {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderAllow")
            .field("authorization_domain", &"[redacted]")
            .field("principal", &"[redacted]")
            .field("profile_id", &"[redacted]")
            .field("capabilities", &"[redacted]")
            .field("policy_version", &"[redacted]")
            .field("issued_at", &"[redacted]")
            .field("fresh_until", &"[redacted]")
            .finish()
    }
}

/// Stable reason for a denied provider authorization.
#[derive(Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum AuthorizationDenialReason {
    /// The configured provider denied the request.
    ProviderDenied,
    /// The provider response named another authorization domain.
    AuthorizationDomainMismatch,
    /// The provider response named another principal.
    PrincipalMismatch,
    /// The provider response named another authorization profile.
    AuthorizationProfileMismatch,
    /// The provider response omitted a requested capability.
    MissingCapability,
    /// The provider response was already stale.
    StaleDecision,
    /// The provider response was issued in the future.
    FutureDecision,
    /// Verified identity evidence expired before the decision became effective.
    IdentityEvidenceExpired,
    /// The bound federated enrollment policy was not current after provider I/O.
    FederatedPolicyNotCurrent,
}

impl AuthorizationDenialReason {
    /// Stable provider-neutral audit and metric code.
    pub const fn code(self) -> &'static str {
        match self {
            Self::ProviderDenied => "authorization_provider_deny_001",
            Self::AuthorizationDomainMismatch => "authorization_provider_deny_002",
            Self::PrincipalMismatch => "authorization_provider_deny_003",
            Self::MissingCapability => "authorization_provider_deny_004",
            Self::StaleDecision => "authorization_provider_deny_005",
            Self::FutureDecision => "authorization_provider_deny_006",
            Self::IdentityEvidenceExpired => "authorization_provider_deny_007",
            Self::AuthorizationProfileMismatch => "authorization_provider_deny_008",
            Self::FederatedPolicyNotCurrent => "authorization_provider_deny_009",
        }
    }
}

impl fmt::Debug for AuthorizationDenialReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("AuthorizationDenialReason")
            .field(&"[redacted]")
            .finish()
    }
}

/// Provider-neutral denial returned to an authorization caller.
#[derive(PartialEq, Eq)]
pub struct AuthorizationDenial {
    reason: AuthorizationDenialReason,
}

impl AuthorizationDenial {
    /// Build a denial with a stable provider-neutral reason.
    pub const fn new(reason: AuthorizationDenialReason) -> Self {
        Self { reason }
    }

    /// Stable reason for the denial.
    pub const fn reason(&self) -> AuthorizationDenialReason {
        self.reason
    }
}

impl fmt::Debug for AuthorizationDenial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthorizationDenial")
            .field("reason", &"[redacted]")
            .finish()
    }
}

/// Stable provider-unavailability reason.
#[derive(Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProviderUnavailableReason {
    /// The provider is temporarily unavailable.
    TemporarilyUnavailable,
    /// The provider call exceeded its bounded deadline.
    Timeout,
    /// A provider dependency is unavailable.
    DependencyUnavailable,
}

impl ProviderUnavailableReason {
    /// Stable provider-neutral audit and metric code.
    pub const fn code(self) -> &'static str {
        match self {
            Self::TemporarilyUnavailable => "authorization_provider_unavailable_001",
            Self::Timeout => "authorization_provider_unavailable_002",
            Self::DependencyUnavailable => "authorization_provider_unavailable_003",
        }
    }
}

impl fmt::Debug for ProviderUnavailableReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProviderUnavailableReason")
            .field(&"[redacted]")
            .finish()
    }
}

/// Bounded provider retry hint in seconds.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct RetryAfter(u32);

impl RetryAfter {
    /// Build a non-zero retry hint no greater than one hour.
    pub const fn new(seconds: u32) -> Result<Self, ProviderContractError> {
        if seconds == 0 || seconds > MAX_RETRY_AFTER_SECONDS {
            return Err(ProviderContractError::InvalidRetryAfter);
        }
        Ok(Self(seconds))
    }

    /// Retry hint in seconds.
    pub const fn seconds(self) -> u32 {
        self.0
    }
}

impl fmt::Debug for RetryAfter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("RetryAfter")
            .field(&"[redacted]")
            .finish()
    }
}

/// Explicit finite deadline for one provider call.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ProviderTimeout(Duration);

impl ProviderTimeout {
    /// Build a provider-call deadline no greater than one minute.
    pub fn new(duration: Duration) -> Result<Self, ProviderContractError> {
        if duration.is_zero() || duration > MAX_PROVIDER_TIMEOUT {
            return Err(ProviderContractError::InvalidProviderTimeout);
        }
        Ok(Self(duration))
    }

    /// Configured provider-call deadline.
    pub const fn duration(self) -> Duration {
        self.0
    }
}

impl fmt::Debug for ProviderTimeout {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProviderTimeout")
            .field(&"[redacted]")
            .finish()
    }
}

/// Trusted server time used to validate a provider result.
///
/// The resolver samples this source exactly once for an allowed decision. A
/// source must return current Unix time without reusing a value captured before
/// provider I/O, and must not block the async executor. Returning `None` fails
/// closed as dependency unavailability.
pub trait AuthorizationClock: Send + Sync {
    /// Current trusted Unix time, or `None` when it cannot be obtained.
    fn now_unix_seconds(&self) -> Option<u64>;
}

/// Fail-closed provider unavailability.
#[derive(PartialEq, Eq)]
pub struct ProviderUnavailable {
    reason: ProviderUnavailableReason,
    retry_after: Option<RetryAfter>,
}

impl ProviderUnavailable {
    /// Build an unavailable result with optional bounded retry metadata.
    pub const fn new(reason: ProviderUnavailableReason, retry_after: Option<RetryAfter>) -> Self {
        Self {
            reason,
            retry_after,
        }
    }

    /// Stable reason for unavailability.
    pub const fn reason(&self) -> ProviderUnavailableReason {
        self.reason
    }

    /// Optional bounded retry hint.
    pub const fn retry_after(&self) -> Option<RetryAfter> {
        self.retry_after
    }
}

impl fmt::Debug for ProviderUnavailable {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderUnavailable")
            .field("reason", &"[redacted]")
            .field("retry_after", &"[redacted]")
            .finish()
    }
}

/// Raw decision returned by an [`AuthorizationProvider`].
#[derive(PartialEq, Eq)]
#[non_exhaustive]
pub enum ProviderDecision {
    /// Provider policy allowed a capability set.
    Allow(ProviderAllow),
    /// Provider policy denied the request.
    Deny(AuthorizationDenial),
    /// Provider policy could not be evaluated.
    Unavailable(ProviderUnavailable),
}

impl fmt::Debug for ProviderDecision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProviderDecision")
            .field(&"[redacted]")
            .finish()
    }
}

/// Boxed provider future used to keep [`AuthorizationProvider`] object-safe.
pub type AuthorizationProviderFuture<'a> =
    Pin<Box<dyn Future<Output = ProviderDecision> + Send + 'a>>;

/// Object-safe, asynchronous, provider-neutral authorization policy.
pub trait AuthorizationProvider: Send + Sync {
    /// Evaluate one request without mutating identity or community state.
    ///
    /// Implementations must yield while waiting for I/O and must not block the
    /// async executor. The returned future must be cancellation-safe: the
    /// caller drops it on timeout, so dropping at any await point must release
    /// resources through RAII and must not leave shared state partially
    /// updated. Provider evaluation is read-only; cache updates, if any, must
    /// become visible atomically. The deadline bounds future polling and cannot
    /// preempt blocking synchronous work inside this method.
    fn authorize<'a>(
        &'a self,
        request: &'a AuthorizationRequest,
    ) -> AuthorizationProviderFuture<'a>;
}

/// Stable reason for a validated allowed decision.
#[derive(Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProviderAllowReason {
    /// Current provider policy granted the exact requested capabilities.
    CurrentPolicy,
}

impl ProviderAllowReason {
    /// Stable provider-neutral audit and metric code.
    pub const fn code(self) -> &'static str {
        match self {
            Self::CurrentPolicy => "authorization_provider_allow_001",
        }
    }
}

impl fmt::Debug for ProviderAllowReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("ProviderAllowReason")
            .field(&"[redacted]")
            .finish()
    }
}

/// Validated, request-scoped capability snapshot.
///
/// This type has no public constructor, default, or deserialization path. Only
/// [`resolve_authorization`] can create it after checking the provider response.
/// The move-only snapshot is the private finalizer evidence for a later phase;
/// callers may inspect its bounded metadata but cannot recreate trusted state.
#[derive(PartialEq, Eq)]
pub struct CapabilitySnapshot {
    authorization_domain: CommunityId,
    transport: AuthTransport,
    actor_pubkey: PublicKey,
    owner_pubkey: Option<PublicKey>,
    binding_id: Option<Uuid>,
    binding_version: Option<BindingVersion>,
    proof_method: AuthMethod,
    principal: FederatedPrincipal,
    federated_policy: FederatedPolicyStamp,
    profile_id: AuthorizationProfileId,
    capabilities: CapabilitySet,
    policy_version: PolicyVersion,
    issued_at: u64,
    fresh_until: u64,
    effective_until: u64,
    decision_source: DecisionSource,
    correlation_id: Uuid,
    reason: ProviderAllowReason,
}

impl CapabilitySnapshot {
    /// Authorization domain for this decision.
    pub const fn authorization_domain(&self) -> CommunityId {
        self.authorization_domain
    }

    /// Exact protected transport for which this snapshot was resolved.
    pub const fn transport(&self) -> AuthTransport {
        self.transport
    }

    /// Exact authenticated Nostr actor for this decision.
    pub const fn actor_pubkey(&self) -> PublicKey {
        self.actor_pubkey
    }

    /// Exact verified owner for delegated authority, when present.
    pub const fn owner_pubkey(&self) -> Option<PublicKey> {
        self.owner_pubkey
    }

    /// Stable active binding identifier for delegated authority.
    pub const fn binding_id(&self) -> Option<Uuid> {
        self.binding_id
    }

    /// Exact active binding version for delegated authority.
    ///
    /// This is not a lease: later consumers must compare it with current
    /// authoritative binding state before reusing a cached snapshot.
    pub const fn binding_version(&self) -> Option<BindingVersion> {
        self.binding_version
    }

    /// Cryptographic proof method for the authenticated actor.
    pub const fn proof_method(&self) -> AuthMethod {
        self.proof_method
    }

    /// Exact admitted issuer-qualified principal.
    pub const fn principal(&self) -> &FederatedPrincipal {
        &self.principal
    }

    /// Exact authoritative enrollment-policy lineage bound to this decision.
    pub const fn federated_policy(&self) -> &FederatedPolicyStamp {
        &self.federated_policy
    }

    /// Whether a freshly resolved O3 policy is exactly the policy used here.
    ///
    /// O3 must additionally compare this stamp with current authoritative state
    /// and use its epoch as an atomic enrollment precondition.
    pub fn is_bound_to_federated_policy(&self, policy: &ResolvedFederatedPolicy) -> bool {
        self.federated_policy == *policy.stamp()
    }

    /// Server-resolved authorization profile for this decision.
    pub const fn profile_id(&self) -> &AuthorizationProfileId {
        &self.profile_id
    }

    /// Exact request-scoped portable capabilities.
    pub const fn capabilities(&self) -> &CapabilitySet {
        &self.capabilities
    }

    /// Opaque provider policy version.
    pub const fn policy_version(&self) -> &PolicyVersion {
        &self.policy_version
    }

    /// Provider decision issue time in Unix seconds.
    pub const fn issued_at(&self) -> u64 {
        self.issued_at
    }

    /// Provider freshness bound in Unix seconds.
    pub const fn fresh_until(&self) -> u64 {
        self.fresh_until
    }

    /// Earliest effective bound across provider and identity evidence.
    pub const fn effective_until(&self) -> u64 {
        self.effective_until
    }

    /// Verified request source for this snapshot.
    pub const fn decision_source(&self) -> DecisionSource {
        self.decision_source
    }

    /// Correlation identifier binding the snapshot to its request.
    pub const fn correlation_id(&self) -> Uuid {
        self.correlation_id
    }

    /// Stable reason for this allowed decision.
    pub const fn reason(&self) -> ProviderAllowReason {
        self.reason
    }
}

impl fmt::Debug for CapabilitySnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapabilitySnapshot")
            .field("authorization_domain", &"[redacted]")
            .field("transport", &"[redacted]")
            .field("actor_pubkey", &"[redacted]")
            .field("owner_pubkey", &"[redacted]")
            .field("binding_id", &"[redacted]")
            .field("binding_version", &"[redacted]")
            .field("proof_method", &"[redacted]")
            .field("principal", &"[redacted]")
            .field("federated_policy", &"[redacted]")
            .field("profile_id", &"[redacted]")
            .field("capabilities", &"[redacted]")
            .field("policy_version", &"[redacted]")
            .field("issued_at", &"[redacted]")
            .field("fresh_until", &"[redacted]")
            .field("effective_until", &"[redacted]")
            .field("decision_source", &"[redacted]")
            .field("correlation_id", &"[redacted]")
            .field("reason", &"[redacted]")
            .finish()
    }
}

/// Fail-closed result of validating a provider decision.
#[derive(PartialEq, Eq)]
#[non_exhaustive]
pub enum AuthorizationOutcome {
    /// Provider policy allowed the exact requested capabilities.
    Allow(Box<CapabilitySnapshot>),
    /// Provider policy or response validation denied authorization.
    Deny(AuthorizationDenial),
    /// Provider policy could not be evaluated; callers must not fall back.
    Unavailable(ProviderUnavailable),
}

impl fmt::Debug for AuthorizationOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("AuthorizationOutcome")
            .field(&"[redacted]")
            .finish()
    }
}

/// Resolve and validate one provider authorization decision.
///
/// Unavailability is preserved as a fail-closed outcome. This function never
/// falls back to Nostr-only authorization or applies an implicit grace period.
/// `clock` must be the server's trusted time source. After provider I/O
/// completes, an allowed decision is checked against exactly one fresh sample.
/// Provider freshness and all effective evidence bounds use that same value;
/// callers must not precompute and pass a decision-start timestamp.
pub async fn resolve_authorization(
    provider: &dyn AuthorizationProvider,
    request: &AuthorizationRequest,
    clock: &dyn AuthorizationClock,
    timeout: ProviderTimeout,
) -> AuthorizationOutcome {
    let decision = match tokio::time::timeout(timeout.duration(), provider.authorize(request)).await
    {
        Ok(decision) => decision,
        Err(_) => {
            return AuthorizationOutcome::Unavailable(ProviderUnavailable::new(
                ProviderUnavailableReason::Timeout,
                None,
            ));
        }
    };
    let allow = match decision {
        ProviderDecision::Allow(allow) => allow,
        ProviderDecision::Deny(denial) => return AuthorizationOutcome::Deny(denial),
        ProviderDecision::Unavailable(unavailable) => {
            return AuthorizationOutcome::Unavailable(unavailable);
        }
    };
    let Some(now_unix_seconds) = clock.now_unix_seconds() else {
        return AuthorizationOutcome::Unavailable(ProviderUnavailable::new(
            ProviderUnavailableReason::DependencyUnavailable,
            None,
        ));
    };

    if request
        .federated_policy
        .is_not_yet_effective_at(now_unix_seconds)
        || request.federated_policy.is_expired_at(now_unix_seconds)
    {
        return deny(AuthorizationDenialReason::FederatedPolicyNotCurrent);
    }

    if allow.authorization_domain != request.authorization_domain {
        return deny(AuthorizationDenialReason::AuthorizationDomainMismatch);
    }
    if allow.principal != request.principal {
        return deny(AuthorizationDenialReason::PrincipalMismatch);
    }
    if allow.profile_id != request.profile_id {
        return deny(AuthorizationDenialReason::AuthorizationProfileMismatch);
    }
    if allow.issued_at > now_unix_seconds {
        return deny(AuthorizationDenialReason::FutureDecision);
    }
    if allow.fresh_until <= now_unix_seconds {
        return deny(AuthorizationDenialReason::StaleDecision);
    }
    if !allow
        .capabilities
        .contains_all(&request.requested_capabilities)
    {
        return deny(AuthorizationDenialReason::MissingCapability);
    }

    let effective_until = request
        .evidence_valid_until
        .map_or(allow.fresh_until, |bound| bound.min(allow.fresh_until));
    if effective_until <= now_unix_seconds {
        return deny(AuthorizationDenialReason::IdentityEvidenceExpired);
    }

    AuthorizationOutcome::Allow(Box::new(CapabilitySnapshot {
        authorization_domain: allow.authorization_domain,
        transport: request.transport,
        actor_pubkey: request.actor_pubkey,
        owner_pubkey: match &request.authority {
            AuthorizationAuthority::Direct => None,
            AuthorizationAuthority::Delegated { owner_pubkey, .. } => Some(*owner_pubkey),
        },
        binding_id: match &request.authority {
            AuthorizationAuthority::Direct => None,
            AuthorizationAuthority::Delegated { binding_id, .. } => Some(*binding_id),
        },
        binding_version: match &request.authority {
            AuthorizationAuthority::Direct => None,
            AuthorizationAuthority::Delegated {
                binding_version, ..
            } => Some(*binding_version),
        },
        proof_method: request.proof_method,
        principal: allow.principal,
        federated_policy: request.federated_policy.clone(),
        profile_id: allow.profile_id,
        capabilities: request.requested_capabilities.clone(),
        policy_version: allow.policy_version,
        issued_at: allow.issued_at,
        fresh_until: allow.fresh_until,
        effective_until,
        decision_source: request.decision_source,
        correlation_id: request.correlation_id,
        reason: ProviderAllowReason::CurrentPolicy,
    }))
}

const fn deny(reason: AuthorizationDenialReason) -> AuthorizationOutcome {
    AuthorizationOutcome::Deny(AuthorizationDenial::new(reason))
}

/// Invalid provider request or response construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum ProviderContractError {
    /// A capability set was empty.
    #[error("authorization capability set must not be empty")]
    EmptyCapabilitySet,
    /// The authorization profile identifier was empty.
    #[error("authorization profile identifier must not be empty")]
    EmptyProfileId,
    /// The authorization profile identifier exceeded its size bound.
    #[error("authorization profile identifier exceeds the size bound")]
    ProfileIdTooLong,
    /// The policy version was empty.
    #[error("authorization policy version must not be empty")]
    EmptyPolicyVersion,
    /// The policy version exceeded its size bound.
    #[error("authorization policy version exceeds the size bound")]
    PolicyVersionTooLong,
    /// Provider decision issue time was zero.
    #[error("provider decision issue time must be greater than zero")]
    InvalidIssuedAt,
    /// Provider freshness did not follow issue time.
    #[error("provider freshness bound must follow its issue time")]
    InvalidFreshnessBound,
    /// Provider freshness exceeded the public maximum window.
    #[error("provider freshness window exceeds its public bound")]
    FreshnessWindowTooLong,
    /// Retry metadata was zero or exceeded its public bound.
    #[error("provider retry hint is outside its public bound")]
    InvalidRetryAfter,
    /// Provider call deadline was zero or exceeded its public bound.
    #[error("provider call deadline is outside its public bound")]
    InvalidProviderTimeout,
    /// Correlation identifier was nil.
    #[error("provider request correlation identifier must not be nil")]
    InvalidCorrelationId,
    /// Direct evidence contained delegated authority.
    #[error("direct provider request cannot contain a delegated owner")]
    DirectRequestHasOwner,
    /// Verified evidence belonged to different authorization domains.
    #[error("provider request evidence does not share an authorization domain")]
    AuthorizationDomainMismatch,
    /// Verified assertion and Nostr proof authorized different transports.
    #[error("provider request evidence does not share an authorization transport")]
    TransportMismatch,
    /// Assertion was not yet valid at server time.
    #[error("provider request assertion is not yet valid")]
    AssertionNotYetValid,
    /// Assertion was expired at server time.
    #[error("provider request assertion has expired")]
    AssertionExpired,
    /// Assertion key attestation named another actor.
    #[error("provider request key attestation does not match the Nostr actor")]
    KeyAttestationMismatch,
    /// Direct assertion omitted a key attestation.
    #[error("direct provider request requires key attestation")]
    MissingKeyAttestation,
    /// Delegated request lacked verified delegation.
    #[error("delegated provider request requires verified delegation")]
    DelegationRequired,
    /// Delegated request named another bound owner.
    #[error("delegated provider request does not match the bound owner")]
    DelegatedOwnerMismatch,
    /// Delegation was expired at server time.
    #[error("delegated provider request has expired")]
    DelegationExpired,
    /// Owner binding was expired at server time.
    #[error("delegated provider request owner binding has expired")]
    BindingExpired,
    /// Enrollment policy belonged to another authorization domain.
    #[error("provider request enrollment policy does not match the authorization domain")]
    FederatedPolicyDomainMismatch,
    /// Enrollment policy belonged to another correlated decision.
    #[error("provider request enrollment policy does not match the correlation identifier")]
    FederatedPolicyCorrelationMismatch,
    /// Enrollment policy was not yet effective at server time.
    #[error("provider request enrollment policy is not yet effective")]
    FederatedPolicyNotYetEffective,
    /// Enrollment policy was expired at server time.
    #[error("provider request enrollment policy has expired")]
    FederatedPolicyExpired,
}

impl ProviderContractError {
    /// Stable provider-neutral audit and metric code.
    pub const fn code(self) -> &'static str {
        match self {
            Self::EmptyCapabilitySet => "authorization_provider_contract_001",
            Self::EmptyProfileId => "authorization_provider_contract_002",
            Self::ProfileIdTooLong => "authorization_provider_contract_003",
            Self::EmptyPolicyVersion => "authorization_provider_contract_004",
            Self::PolicyVersionTooLong => "authorization_provider_contract_005",
            Self::InvalidIssuedAt => "authorization_provider_contract_006",
            Self::InvalidFreshnessBound => "authorization_provider_contract_007",
            Self::InvalidRetryAfter => "authorization_provider_contract_008",
            Self::DirectRequestHasOwner => "authorization_provider_contract_009",
            Self::AuthorizationDomainMismatch => "authorization_provider_contract_010",
            Self::TransportMismatch => "authorization_provider_contract_011",
            Self::AssertionNotYetValid => "authorization_provider_contract_012",
            Self::AssertionExpired => "authorization_provider_contract_013",
            Self::KeyAttestationMismatch => "authorization_provider_contract_014",
            Self::DelegationRequired => "authorization_provider_contract_015",
            Self::DelegatedOwnerMismatch => "authorization_provider_contract_016",
            Self::DelegationExpired => "authorization_provider_contract_017",
            Self::InvalidProviderTimeout => "authorization_provider_contract_018",
            Self::InvalidCorrelationId => "authorization_provider_contract_019",
            Self::MissingKeyAttestation => "authorization_provider_contract_020",
            Self::FreshnessWindowTooLong => "authorization_provider_contract_021",
            Self::BindingExpired => "authorization_provider_contract_022",
            Self::FederatedPolicyDomainMismatch => "authorization_provider_contract_023",
            Self::FederatedPolicyCorrelationMismatch => "authorization_provider_contract_024",
            Self::FederatedPolicyNotYetEffective => "authorization_provider_contract_025",
            Self::FederatedPolicyExpired => "authorization_provider_contract_026",
        }
    }
}

fn validate_federated_policy(
    policy: &ResolvedFederatedPolicy,
    authorization_domain: CommunityId,
    correlation_id: Uuid,
    now_unix_seconds: u64,
) -> Result<(), ProviderContractError> {
    if policy.authorization_domain() != authorization_domain {
        return Err(ProviderContractError::FederatedPolicyDomainMismatch);
    }
    if policy.stamp().correlation_id() != correlation_id {
        return Err(ProviderContractError::FederatedPolicyCorrelationMismatch);
    }
    if policy.stamp().is_not_yet_effective_at(now_unix_seconds) {
        return Err(ProviderContractError::FederatedPolicyNotYetEffective);
    }
    if policy.stamp().is_expired_at(now_unix_seconds) {
        return Err(ProviderContractError::FederatedPolicyExpired);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
