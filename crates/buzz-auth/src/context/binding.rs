use std::fmt;

use buzz_core::CommunityId;
use nostr::PublicKey;
use uuid::Uuid;

use super::{AuthContextError, AuthorizationReason, FederatedPrincipal};

/// Policy used when no active binding exists for either principal or key.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EnrollmentMode {
    /// First use requires an assertion that attests the proven Nostr key.
    AttestedKey,
    /// Bindings must be created by an out-of-band administrative process.
    Provisioned,
    /// First use may bind the proven key without an asserted key claim.
    Tofu,
}

impl fmt::Debug for EnrollmentMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("EnrollmentMode")
            .field(&"[redacted]")
            .finish()
    }
}

/// Federated-identity requirement resolved for one authorization domain.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FederatedIdentityRequirement {
    /// Federated identity is not required for this domain.
    NotRequired,
    /// Federated identity is required under the supplied enrollment policy.
    Required(EnrollmentMode),
}

impl fmt::Debug for FederatedIdentityRequirement {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("FederatedIdentityRequirement")
            .field(&"[redacted]")
            .finish()
    }
}

/// Server-resolved federated-identity policy for an authorization decision.
///
/// Raw request data cannot construct this value. A policy adapter must resolve
/// the authorization domain's configuration before producing it. The evidence
/// is intentionally move-only and has no default or deserialization path.
#[derive(PartialEq, Eq)]
pub struct ResolvedFederatedPolicy {
    authorization_domain: CommunityId,
    requirement: FederatedIdentityRequirement,
}

impl fmt::Debug for ResolvedFederatedPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedFederatedPolicy")
            .field("authorization_domain", &"[redacted]")
            .field("requirement", &"[redacted]")
            .finish()
    }
}

impl ResolvedFederatedPolicy {
    #[cfg(test)]
    pub(crate) const fn not_required(authorization_domain: CommunityId) -> Self {
        Self {
            authorization_domain,
            requirement: FederatedIdentityRequirement::NotRequired,
        }
    }

    #[cfg(test)]
    pub(crate) const fn required(
        authorization_domain: CommunityId,
        enrollment_mode: EnrollmentMode,
    ) -> Self {
        Self {
            authorization_domain,
            requirement: FederatedIdentityRequirement::Required(enrollment_mode),
        }
    }

    /// Authorization domain whose configuration was resolved.
    pub const fn authorization_domain(&self) -> CommunityId {
        self.authorization_domain
    }

    /// Resolved federated-identity requirement.
    pub const fn requirement(&self) -> FederatedIdentityRequirement {
        self.requirement
    }
}

/// Provenance recorded when a binding is created.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BindingSource {
    /// The identity provider attested the proven Nostr key.
    AttestedKey,
    /// An operator provisioned the binding out of band.
    Provisioned,
    /// The binding was established by trust on first use.
    Tofu,
}

impl fmt::Debug for BindingSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("BindingSource")
            .field(&"[redacted]")
            .finish()
    }
}

/// Monotonically increasing version of an identity-to-key binding.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BindingVersion(u64);

impl fmt::Debug for BindingVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("BindingVersion")
            .field(&"[redacted]")
            .finish()
    }
}

impl BindingVersion {
    /// Initial version assigned to a newly created binding.
    pub const INITIAL: Self = Self(1);

    /// Build a non-zero binding version.
    pub const fn new(value: u64) -> Result<Self, AuthContextError> {
        if value == 0 {
            return Err(AuthContextError::InvalidBindingVersion);
        }
        Ok(Self(value))
    }

    /// Numeric binding version.
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Optional authoritative expiry of a lifecycle-active identity binding.
///
/// Expiry makes the binding ineligible for authorization but does not remove it
/// from lifecycle state or turn it into retirement or revocation evidence.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BindingExpiry(u64);

impl fmt::Debug for BindingExpiry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("BindingExpiry")
            .field(&"[redacted]")
            .finish()
    }
}

impl BindingExpiry {
    /// Build a non-zero binding expiry.
    pub const fn new(unix_seconds: u64) -> Result<Self, AuthContextError> {
        if unix_seconds == 0 {
            return Err(AuthContextError::InvalidBindingExpiry);
        }
        Ok(Self(unix_seconds))
    }

    /// Expiry as seconds since the Unix epoch.
    pub const fn unix_seconds(self) -> u64 {
        self.0
    }

    /// Returns `true` when the binding is no longer authorization-eligible.
    pub const fn is_expired_at(self, now_unix_seconds: u64) -> bool {
        self.0 <= now_unix_seconds
    }
}

/// Stable reference to one active identity-to-key binding.
///
/// This reference is identity evidence. It is not an authorization lease and
/// does not by itself provide live-revocation
/// enforcement. Its optional authoritative expiry is a finalization and later
/// lease bound; expiry does not synthesize lifecycle state. An
/// authoritative binding adapter constructs this move-only value after checking
/// active lifecycle state; it has no default or deserialization path.
/// Production construction is intentionally unavailable in this phase. A
/// future crate-owned, sealed finalizer must require a durable non-nil ID, a
/// positive version, authoritative active-state evidence, and a typed database
/// result distinguishing a binding that already existed from one atomically
/// enrolled during this decision. Transport callers must never select that
/// lifecycle result. Pending, revoked, newly proposed, and synthetic records
/// must not cross that gate.
#[derive(PartialEq, Eq)]
pub struct VersionedBindingRef {
    authorization_domain: CommunityId,
    binding_id: Uuid,
    principal: FederatedPrincipal,
    bound_pubkey: PublicKey,
    binding_version: BindingVersion,
    expires_at: Option<BindingExpiry>,
    source: BindingSource,
    resolution_reason: AuthorizationReason,
}

impl fmt::Debug for VersionedBindingRef {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VersionedBindingRef")
            .field("authorization_domain", &"[redacted]")
            .field("binding_id", &"[redacted]")
            .field("principal", &self.principal)
            .field("bound_pubkey", &"[redacted]")
            .field("binding_version", &"[redacted]")
            .field("expires_at", &"[redacted]")
            .field("source", &"[redacted]")
            .field("resolution_reason", &"[redacted]")
            .finish()
    }
}

impl VersionedBindingRef {
    /// Build a reference to a binding authoritatively resolved as already active.
    #[cfg(test)]
    pub(crate) fn new_existing_active_for_test(
        authorization_domain: CommunityId,
        binding_id: Uuid,
        principal: FederatedPrincipal,
        bound_pubkey: PublicKey,
        binding_version: BindingVersion,
        expires_at: Option<BindingExpiry>,
        source: BindingSource,
    ) -> Result<Self, AuthContextError> {
        if binding_id.is_nil() {
            return Err(AuthContextError::InvalidBindingId);
        }
        Ok(Self {
            authorization_domain,
            binding_id,
            principal,
            bound_pubkey,
            binding_version,
            expires_at,
            source,
            resolution_reason: AuthorizationReason::ExistingBinding,
        })
    }

    /// Build a reference to a binding atomically enrolled in this decision.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new_enrolled_active_for_test(
        authorization_domain: CommunityId,
        binding_id: Uuid,
        principal: FederatedPrincipal,
        bound_pubkey: PublicKey,
        binding_version: BindingVersion,
        expires_at: Option<BindingExpiry>,
        source: BindingSource,
        reason: AuthorizationReason,
    ) -> Result<Self, AuthContextError> {
        if binding_id.is_nil() {
            return Err(AuthContextError::InvalidBindingId);
        }
        if !matches!(
            reason,
            AuthorizationReason::EnrolledAttestedKey | AuthorizationReason::EnrolledTofu
        ) {
            return Err(AuthContextError::InvalidAuthorizationReason);
        }
        Ok(Self {
            authorization_domain,
            binding_id,
            principal,
            bound_pubkey,
            binding_version,
            expires_at,
            source,
            resolution_reason: reason,
        })
    }

    /// Server-resolved authorization domain that owns the binding.
    pub const fn authorization_domain(&self) -> CommunityId {
        self.authorization_domain
    }

    /// Stable binding identifier.
    pub const fn binding_id(&self) -> Uuid {
        self.binding_id
    }

    /// Issuer-qualified principal represented by the binding.
    pub const fn principal(&self) -> &FederatedPrincipal {
        &self.principal
    }

    /// Nostr key owned by the binding.
    pub const fn bound_pubkey(&self) -> PublicKey {
        self.bound_pubkey
    }

    /// Current binding version.
    pub const fn binding_version(&self) -> BindingVersion {
        self.binding_version
    }

    /// Optional authoritative temporal bound for authorization eligibility.
    pub const fn expires_at(&self) -> Option<BindingExpiry> {
        self.expires_at
    }

    /// Provenance of the active binding.
    pub const fn source(&self) -> BindingSource {
        self.source
    }

    /// Stable reason proven by the authoritative binding lifecycle result.
    pub(super) const fn authorization_reason(&self) -> AuthorizationReason {
        self.resolution_reason
    }
}
