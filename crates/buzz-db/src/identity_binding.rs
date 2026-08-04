//! Corporate identity binding persistence.
//!
//! Bindings map an issuer-qualified IdP uid to the currently authorized Nostr
//! pubkey inside one Buzz community. The active uniqueness indexes deliberately
//! model one active pubkey per `(issuer, uid)` principal and one active principal
//! per pubkey. Explicit lifecycle operations distinguish principal disablement,
//! single-key revocation, and authorized rotation; authentication never
//! silently rewrites those states.

use std::fmt;

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

use crate::error::{DbError, Result};
use buzz_core::CommunityId;

#[cfg(test)]
pub(crate) mod test_lock_schedule {
    use std::cell::Cell;
    use std::future::Future;
    use std::sync::{Mutex, OnceLock};

    use sqlx::{Postgres, Transaction};
    use tokio::sync::{mpsc, oneshot};

    tokio::task_local! {
        static ACTOR: &'static str;
        static ROW_REQUEST_REPORTED: Cell<bool>;
        static ROW_ACQUIRED_REPORTED: Cell<bool>;
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum LockPhase {
        Request,
        Acquired,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum RowLockPhase {
        Request,
        Acquired,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) struct AdvisoryLockKey {
        class_id: u32,
        object_id: u32,
    }

    impl AdvisoryLockKey {
        pub(crate) const fn class_id(self) -> u32 {
            self.class_id
        }

        pub(crate) const fn object_id(self) -> u32 {
            self.object_id
        }
    }

    pub(crate) struct LockEvent {
        actor: &'static str,
        phase: LockPhase,
        isolation: Option<String>,
        transaction_id: Option<i64>,
        backend_pid: i32,
        database_oid: u32,
        lock_keys: Vec<AdvisoryLockKey>,
        resume: oneshot::Sender<()>,
    }

    impl LockEvent {
        pub(crate) const fn actor(&self) -> &'static str {
            self.actor
        }

        pub(crate) const fn phase(&self) -> LockPhase {
            self.phase
        }

        pub(crate) fn isolation(&self) -> Option<&str> {
            self.isolation.as_deref()
        }

        pub(crate) const fn transaction_id(&self) -> Option<i64> {
            self.transaction_id
        }

        pub(crate) const fn backend_pid(&self) -> i32 {
            self.backend_pid
        }

        pub(crate) const fn database_oid(&self) -> u32 {
            self.database_oid
        }

        pub(crate) fn lock_keys(&self) -> &[AdvisoryLockKey] {
            &self.lock_keys
        }

        pub(crate) const fn coordinate_count(&self) -> usize {
            self.lock_keys.len()
        }

        pub(crate) fn resume(self) {
            let _ = self.resume.send(());
        }
    }

    fn controller() -> &'static Mutex<Option<mpsc::UnboundedSender<LockEvent>>> {
        static CONTROLLER: OnceLock<Mutex<Option<mpsc::UnboundedSender<LockEvent>>>> =
            OnceLock::new();
        CONTROLLER.get_or_init(|| Mutex::new(None))
    }

    pub(crate) struct ControllerGuard;

    impl Drop for ControllerGuard {
        fn drop(&mut self) {
            *controller().lock().expect("lock test controller") = None;
        }
    }

    pub(crate) fn install() -> (mpsc::UnboundedReceiver<LockEvent>, ControllerGuard) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut current = controller().lock().expect("lock test controller");
        assert!(
            current.is_none(),
            "only one deterministic lock controller may be active"
        );
        *current = Some(sender);
        (receiver, ControllerGuard)
    }

    pub(crate) struct RowLockEvent {
        actor: &'static str,
        phase: RowLockPhase,
        transaction_id: i64,
        backend_pid: i32,
        database_oid: u32,
        resume: oneshot::Sender<()>,
    }

    impl RowLockEvent {
        pub(crate) const fn actor(&self) -> &'static str {
            self.actor
        }

        pub(crate) const fn phase(&self) -> RowLockPhase {
            self.phase
        }

        pub(crate) const fn transaction_id(&self) -> i64 {
            self.transaction_id
        }

        pub(crate) const fn backend_pid(&self) -> i32 {
            self.backend_pid
        }

        pub(crate) const fn database_oid(&self) -> u32 {
            self.database_oid
        }

        pub(crate) fn resume(self) {
            let _ = self.resume.send(());
        }
    }

    fn row_controller() -> &'static Mutex<Option<mpsc::UnboundedSender<RowLockEvent>>> {
        static CONTROLLER: OnceLock<Mutex<Option<mpsc::UnboundedSender<RowLockEvent>>>> =
            OnceLock::new();
        CONTROLLER.get_or_init(|| Mutex::new(None))
    }

    pub(crate) struct RowControllerGuard;

    impl Drop for RowControllerGuard {
        fn drop(&mut self) {
            *row_controller().lock().expect("lock row test controller") = None;
        }
    }

    pub(crate) fn install_row() -> (mpsc::UnboundedReceiver<RowLockEvent>, RowControllerGuard) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut current = row_controller().lock().expect("lock row test controller");
        assert!(
            current.is_none(),
            "only one deterministic row-lock controller may be active"
        );
        *current = Some(sender);
        (receiver, RowControllerGuard)
    }

    pub(crate) async fn actor_scope<F>(actor: &'static str, future: F) -> F::Output
    where
        F: Future,
    {
        ACTOR
            .scope(
                actor,
                ROW_REQUEST_REPORTED.scope(
                    Cell::new(false),
                    ROW_ACQUIRED_REPORTED.scope(Cell::new(false), future),
                ),
            )
            .await
    }

    pub(super) async fn checkpoint(
        tx: &mut Transaction<'_, Postgres>,
        phase: LockPhase,
        coordinates: &[Vec<u8>],
    ) {
        let Ok(actor) = ACTOR.try_with(|actor| *actor) else {
            return;
        };
        let sender = controller().lock().expect("lock test controller").clone();
        let Some(sender) = sender else {
            return;
        };
        let (backend_pid, database_oid): (i32, i64) = sqlx::query_as(
            "SELECT pg_backend_pid(), oid::BIGINT \
             FROM pg_database WHERE datname=current_database()",
        )
        .fetch_one(&mut **tx)
        .await
        .expect("read test lock backend identity");
        let class_id: i32 = sqlx::query_scalar("SELECT hashtext('buzz_nip_fi_v1')")
            .fetch_one(&mut **tx)
            .await
            .expect("hash test lock namespace");
        let mut lock_keys = Vec::with_capacity(coordinates.len());
        for coordinate in coordinates {
            let object_id: i32 = sqlx::query_scalar("SELECT hashtext(encode($1, 'hex'))")
                .bind(coordinate.as_slice())
                .fetch_one(&mut **tx)
                .await
                .expect("hash test lock coordinate");
            lock_keys.push(AdvisoryLockKey {
                class_id: class_id as u32,
                object_id: object_id as u32,
            });
        }
        let (isolation, transaction_id) = if phase == LockPhase::Acquired {
            let isolation = sqlx::query_scalar("SHOW transaction_isolation")
                .fetch_one(&mut **tx)
                .await
                .ok();
            let transaction_id = sqlx::query_scalar("SELECT txid_current()::BIGINT")
                .fetch_one(&mut **tx)
                .await
                .ok();
            (isolation, transaction_id)
        } else {
            (None, None)
        };
        let (resume, resumed) = oneshot::channel();
        if sender
            .send(LockEvent {
                actor,
                phase,
                isolation,
                transaction_id,
                backend_pid,
                database_oid: u32::try_from(database_oid)
                    .expect("database OID fits the PostgreSQL OID type"),
                lock_keys,
                resume,
            })
            .is_ok()
        {
            let _ = resumed.await;
        }
    }

    pub(crate) async fn row_checkpoint(tx: &mut Transaction<'_, Postgres>, phase: RowLockPhase) {
        let Ok(actor) = ACTOR.try_with(|actor| *actor) else {
            return;
        };
        let should_report = match phase {
            RowLockPhase::Request => ROW_REQUEST_REPORTED
                .try_with(|reported| !reported.replace(true))
                .unwrap_or(false),
            RowLockPhase::Acquired => ROW_ACQUIRED_REPORTED
                .try_with(|reported| !reported.replace(true))
                .unwrap_or(false),
        };
        if !should_report {
            return;
        }
        let sender = row_controller()
            .lock()
            .expect("lock row test controller")
            .clone();
        let Some(sender) = sender else {
            return;
        };
        let (backend_pid, database_oid, transaction_id): (i32, i64, i64) = sqlx::query_as(
            "SELECT pg_backend_pid(), oid::BIGINT, txid_current()::BIGINT \
             FROM pg_database WHERE datname=current_database()",
        )
        .fetch_one(&mut **tx)
        .await
        .expect("read test row-lock backend identity");
        let (resume, resumed) = oneshot::channel();
        if sender
            .send(RowLockEvent {
                actor,
                phase,
                transaction_id,
                backend_pid,
                database_oid: u32::try_from(database_oid)
                    .expect("database OID fits the PostgreSQL OID type"),
                resume,
            })
            .is_ok()
        {
            let _ = resumed.await;
        }
    }
}

/// Binding source when the IdP JWT carries the pubkey claim.
pub const SOURCE_JWT_NPUB: &str = "jwt_npub";
/// Binding source when the relay falls back to the stored uid/pubkey binding.
pub const SOURCE_DB_BINDING: &str = "db_binding";

/// Server-resolved first-enrollment policy for one authorization domain.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EnrollmentMode {
    /// Require verified issuer evidence that attests the proven key.
    AttestedKey,
    /// Require an out-of-band provisioned binding.
    Provisioned,
    /// Allow trust on first use.
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

/// Provider-neutral persisted binding provenance.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BindingProvenance {
    /// Verified issuer evidence attested the key.
    AttestedKey,
    /// The binding was provisioned out of band.
    Provisioned,
    /// The binding was established by trust on first use.
    Tofu,
}

impl BindingProvenance {
    /// Stable persistence label.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AttestedKey => "attested_key",
            Self::Provisioned => "provisioned",
            Self::Tofu => "tofu",
        }
    }

    pub(crate) fn legacy_source(self) -> &'static str {
        match self {
            Self::AttestedKey => SOURCE_JWT_NPUB,
            Self::Provisioned | Self::Tofu => SOURCE_DB_BINDING,
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        match value {
            "attested_key" => Ok(Self::AttestedKey),
            "provisioned" => Ok(Self::Provisioned),
            "tofu" => Ok(Self::Tofu),
            _ => Err(DbError::InvalidData(
                "identity binding has invalid provenance".to_string(),
            )),
        }
    }
}

impl fmt::Debug for BindingProvenance {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("BindingProvenance")
            .field(&"[redacted]")
            .finish()
    }
}

/// Explicit persisted binding lifecycle state.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BindingState {
    /// The binding currently carries authority.
    Active,
    /// The binding was retired without an atomic replacement.
    Revoked,
    /// The binding was atomically replaced.
    Rotated,
}

impl BindingState {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "active" => Ok(Self::Active),
            "revoked" => Ok(Self::Revoked),
            "rotated" => Ok(Self::Rotated),
            _ => Err(DbError::InvalidData(
                "identity binding has invalid lifecycle state".to_string(),
            )),
        }
    }
}

impl fmt::Debug for BindingState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("BindingState")
            .field(&"[redacted]")
            .finish()
    }
}

/// Stable evidence returned by authoritative binding resolution.
#[derive(Clone, PartialEq, Eq)]
pub struct BindingEvidence {
    /// Stable non-nil binding identifier.
    pub binding_id: Uuid,
    /// Positive authorization-relevant binding version.
    pub binding_version: u64,
    /// Persisted binding provenance.
    pub provenance: BindingProvenance,
}

impl fmt::Debug for BindingEvidence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BindingEvidence")
            .field("binding_id", &"[redacted]")
            .field("binding_version", &"[redacted]")
            .field("provenance", &"[redacted]")
            .finish()
    }
}

/// Stable denial from ordinary binding resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingDenial {
    /// Another active principal or key owns the requested coordinate.
    Conflict,
    /// A lifecycle selector or migration quarantine denies authority.
    Revoked,
    /// The domain requires an out-of-band binding.
    BindingRequired,
    /// Attested enrollment lacked a verified matching key claim.
    KeyAttestationRequired,
}

/// Result of resolving a binding during ordinary authorization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveBindingResult {
    /// A new authoritative binding was atomically enrolled.
    Enrolled(BindingEvidence),
    /// The exact authoritative binding already existed.
    Existing(BindingEvidence),
    /// Resolution denied without authority mutation.
    Denied(BindingDenial),
}

/// Typed input to ordinary binding resolution.
#[derive(Clone, Copy)]
pub struct ResolveBindingInput<'a> {
    /// Exact validated issuer bytes represented as UTF-8.
    pub issuer: &'a str,
    /// Exact validated subject bytes represented as UTF-8.
    pub subject: &'a str,
    /// Proven 32-byte Nostr public key.
    pub pubkey: &'a [u8],
    /// Private display metadata.
    pub display_name: Option<&'a str>,
    /// Server-resolved enrollment mode.
    pub enrollment_mode: EnrollmentMode,
    /// Whether verified identity evidence attested `pubkey`.
    pub key_attested: bool,
}

impl fmt::Debug for ResolveBindingInput<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolveBindingInput")
            .field("issuer", &"[redacted]")
            .field("subject", &"[redacted]")
            .field("pubkey", &"[redacted]")
            .field("display_name", &"[redacted]")
            .field("enrollment_mode", &"[redacted]")
            .field("key_attested", &"[redacted]")
            .finish()
    }
}

/// Active corporate identity binding row.
#[derive(Clone, PartialEq, Eq)]
pub struct IdentityBinding {
    /// Stable non-nil binding identifier.
    pub binding_id: Uuid,
    /// Validated identity-provider issuer.
    pub issuer: String,
    /// Corporate IdP subject or configured stable uid claim.
    pub uid: String,
    /// Bound Nostr pubkey bytes.
    pub pubkey: Vec<u8>,
    /// Positive authorization-relevant version.
    pub binding_version: u64,
    /// Explicit lifecycle state.
    pub binding_state: BindingState,
    /// Provider-neutral provenance.
    pub binding_provenance: BindingProvenance,
    /// Human-readable display claim captured from the latest accepted JWT.
    pub display_name: Option<String>,
    /// Source that established or last strengthened the active binding.
    pub source: String,
    /// When the binding was first created.
    pub created_at: DateTime<Utc>,
    /// When the binding row was last updated.
    pub updated_at: DateTime<Utc>,
    /// When the binding was last seen during authentication.
    pub last_seen_at: DateTime<Utc>,
}

impl fmt::Debug for IdentityBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IdentityBinding")
            .field("binding_id", &"[redacted]")
            .field("issuer", &"[redacted]")
            .field("uid", &"[redacted]")
            .field("pubkey", &"[redacted]")
            .field("binding_version", &"[redacted]")
            .field("binding_state", &"[redacted]")
            .field("binding_provenance", &"[redacted]")
            .field("display_name", &"[redacted]")
            .field("source", &"[redacted]")
            .field("timestamps", &"[redacted]")
            .finish()
    }
}

/// Existing active binding that conflicts with a requested binding.
#[derive(Clone, PartialEq, Eq)]
pub struct IdentityBindingConflict {
    /// Existing active issuer.
    pub issuer: String,
    /// Existing active uid.
    pub uid: String,
    /// Existing active pubkey bytes.
    pub pubkey: Vec<u8>,
    /// Existing active binding source.
    pub source: String,
}

impl fmt::Debug for IdentityBindingConflict {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IdentityBindingConflict")
            .field("issuer", &"[redacted]")
            .field("uid", &"[redacted]")
            .field("pubkey", &"[redacted]")
            .field("source", &"[redacted]")
            .finish()
    }
}

/// Outcome of creating or validating a corporate identity binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindIdentityResult {
    /// A new active binding was created.
    Created,
    /// The requested binding matched an existing active binding.
    Matched,
    /// Another active binding already owns the uid or pubkey.
    Conflict(IdentityBindingConflict),
    /// The requested uid/pubkey pair was previously revoked.
    Revoked,
}

/// Corporate identity data staged for an atomic admission transaction.
#[derive(Clone, Copy)]
pub struct IdentityBindingInput<'a> {
    /// Validated identity-provider issuer.
    pub issuer: &'a str,
    /// Stable issuer-qualified principal identifier.
    pub uid: &'a str,
    /// Authenticated Nostr pubkey bytes.
    pub pubkey: &'a [u8],
    /// Private display attribute retained in the binding table.
    pub display_name: Option<&'a str>,
    /// Binding source (`jwt_npub` or `db_binding`).
    pub source: &'a str,
}

impl fmt::Debug for IdentityBindingInput<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IdentityBindingInput")
            .field("issuer", &"[redacted]")
            .field("uid", &"[redacted]")
            .field("pubkey", &"[redacted]")
            .field("display_name", &"[redacted]")
            .field("source", &"[redacted]")
            .finish()
    }
}

fn validate_inputs(issuer: &str, uid: &str, pubkey: &[u8], source: &str) -> Result<()> {
    if issuer.is_empty() {
        return Err(DbError::InvalidData(
            "identity binding issuer must not be empty".to_string(),
        ));
    }
    if uid.is_empty() {
        return Err(DbError::InvalidData(
            "identity binding uid must not be empty".to_string(),
        ));
    }
    validate_pubkey(pubkey)?;
    if !matches!(source, SOURCE_JWT_NPUB | SOURCE_DB_BINDING) {
        return Err(DbError::InvalidData(format!(
            "invalid identity binding source: {source}"
        )));
    }
    Ok(())
}

fn validate_pubkey(pubkey: &[u8]) -> Result<()> {
    if pubkey.len() != 32 {
        return Err(DbError::InvalidData(
            "identity binding pubkey must be 32 bytes".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_membership_identity_key(
    member_pubkey_hex: &str,
    identity: Option<&IdentityBindingInput<'_>>,
) -> Result<()> {
    let Some(identity) = identity else {
        return Ok(());
    };
    let member_pubkey = hex::decode(member_pubkey_hex)
        .map_err(|_| DbError::InvalidData("membership pubkey must be 32-byte hex".to_string()))?;
    if member_pubkey.len() != 32 || member_pubkey.as_slice() != identity.pubkey {
        return Err(DbError::InvalidData(
            "membership pubkey does not match staged identity key".to_string(),
        ));
    }
    Ok(())
}

fn row_to_binding(row: sqlx::postgres::PgRow) -> Result<IdentityBinding> {
    let binding_id: Uuid = row.try_get("binding_id")?;
    let binding_version: i64 = row.try_get("binding_version")?;
    if binding_id.is_nil() || binding_version <= 0 {
        return Err(DbError::InvalidData(
            "identity binding has invalid stable evidence".to_string(),
        ));
    }
    Ok(IdentityBinding {
        binding_id,
        issuer: row.try_get("issuer")?,
        uid: row.try_get("uid")?,
        pubkey: row.try_get("pubkey")?,
        binding_version: u64::try_from(binding_version).map_err(|_| {
            DbError::InvalidData("identity binding version is out of range".to_string())
        })?,
        binding_state: BindingState::parse(row.try_get("binding_state")?)?,
        binding_provenance: BindingProvenance::parse(row.try_get("binding_provenance")?)?,
        display_name: row.try_get("display_name")?,
        source: row.try_get("source")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        last_seen_at: row.try_get("last_seen_at")?,
    })
}

async fn active_by_principal_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    issuer: &str,
    uid: &str,
) -> Result<Option<IdentityBinding>> {
    let row = sqlx::query(
        r#"
        SELECT binding_id, issuer, uid, pubkey, binding_version, binding_state,
               binding_provenance, display_name, source, created_at, updated_at, last_seen_at
        FROM identity_bindings
        WHERE community_id = $1 AND issuer = $2 AND uid = $3 AND revoked_at IS NULL
        FOR UPDATE
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(issuer)
    .bind(uid)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(row_to_binding).transpose()
}

async fn active_by_pubkey_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    pubkey: &[u8],
) -> Result<Option<IdentityBinding>> {
    let row = sqlx::query(
        r#"
        SELECT binding_id, issuer, uid, pubkey, binding_version, binding_state,
               binding_provenance, display_name, source, created_at, updated_at, last_seen_at
        FROM identity_bindings
        WHERE community_id = $1 AND pubkey = $2 AND revoked_at IS NULL
        FOR UPDATE
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(pubkey)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(row_to_binding).transpose()
}

async fn principal_disabled_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    issuer: &str,
    uid: &str,
) -> Result<bool> {
    let row = sqlx::query(
        r#"
        SELECT 1 FROM identity_principals
        WHERE community_id = $1 AND issuer = $2 AND uid = $3
          AND disabled_at IS NOT NULL
        UNION ALL
        SELECT 1 FROM identity_bindings legacy
        WHERE legacy.community_id = $1 AND legacy.issuer = $2 AND legacy.uid = $3
          AND legacy.revoked_at IS NOT NULL AND legacy.revocation_scope = 'principal'
          AND NOT EXISTS (
              SELECT 1 FROM identity_principals current
              WHERE current.community_id = legacy.community_id
                AND current.issuer = legacy.issuer
                AND current.uid = legacy.uid
          )
        LIMIT 1
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(issuer)
    .bind(uid)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.is_some())
}

async fn key_revoked_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    pubkey: &[u8],
) -> Result<bool> {
    let row = sqlx::query(
        r#"
        SELECT 1 FROM identity_revoked_keys
        WHERE community_id = $1 AND pubkey = $2
        LIMIT 1
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(pubkey)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.is_some())
}

async fn principal_requires_rotation_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    issuer: &str,
    uid: &str,
) -> Result<bool> {
    let row = sqlx::query(
        r#"
        SELECT 1
        FROM identity_pending_replacements
        WHERE community_id = $1
          AND issuer = $2
          AND subject = $3
          AND cleared_at IS NULL
        LIMIT 1
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(issuer)
    .bind(uid)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.is_some())
}

async fn retired_pair_exists_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    issuer: &str,
    subject: &str,
    pubkey: &[u8],
) -> Result<bool> {
    Ok(sqlx::query(
        "SELECT 1 FROM identity_retired_pairs \
         WHERE community_id=$1 AND issuer=$2 AND subject=$3 AND pubkey=$4 \
         UNION ALL \
         SELECT 1 FROM identity_bindings \
         WHERE community_id=$1 AND issuer=$2 AND uid=$3 AND pubkey=$4 \
           AND revoked_at IS NOT NULL \
         LIMIT 1",
    )
    .bind(community_id.as_uuid())
    .bind(issuer)
    .bind(subject)
    .bind(pubkey)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

async fn migration_denied_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    issuer: &str,
    subject: &str,
) -> Result<bool> {
    Ok(sqlx::query(
        "SELECT 1 FROM identity_migration_denials \
         WHERE community_id=$1 AND issuer=$2 AND subject=$3",
    )
    .bind(community_id.as_uuid())
    .bind(issuer)
    .bind(subject)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

async fn migration_key_denied_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    pubkey: &[u8],
) -> Result<bool> {
    Ok(sqlx::query(
        "SELECT 1 FROM identity_migration_denied_keys \
         WHERE community_id=$1 AND pubkey=$2",
    )
    .bind(community_id.as_uuid())
    .bind(pubkey)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

fn conflict_from(binding: IdentityBinding) -> IdentityBindingConflict {
    IdentityBindingConflict {
        issuer: binding.issuer,
        uid: binding.uid,
        pubkey: binding.pubkey,
        source: binding.source,
    }
}

const IDENTITY_LOCK_ENCODING_VERSION: u8 = 1;

fn identity_lock_coordinate(kind: u8, community_id: CommunityId, parts: &[&[u8]]) -> Vec<u8> {
    let mut coordinate =
        Vec::with_capacity(2 + 16 + parts.iter().map(|part| 8 + part.len()).sum::<usize>());
    coordinate.push(IDENTITY_LOCK_ENCODING_VERSION);
    coordinate.push(kind);
    coordinate.extend_from_slice(community_id.as_uuid().as_bytes());
    for part in parts {
        let length = part.len() as u64;
        coordinate.extend_from_slice(&length.to_be_bytes());
        coordinate.extend_from_slice(part);
    }
    coordinate
}

pub(crate) fn principal_lock_coordinate(
    community_id: CommunityId,
    issuer: &str,
    subject: &str,
) -> Vec<u8> {
    identity_lock_coordinate(1, community_id, &[issuer.as_bytes(), subject.as_bytes()])
}

pub(crate) fn key_lock_coordinate(community_id: CommunityId, pubkey: &[u8]) -> Vec<u8> {
    identity_lock_coordinate(2, community_id, &[pubkey])
}

pub(crate) fn binding_lock_coordinate(community_id: CommunityId, binding_id: Uuid) -> Vec<u8> {
    identity_lock_coordinate(3, community_id, &[binding_id.as_bytes()])
}

pub(crate) fn operation_lock_coordinate(community_id: CommunityId, operation_id: Uuid) -> Vec<u8> {
    identity_lock_coordinate(4, community_id, &[operation_id.as_bytes()])
}

pub(crate) async fn lock_identity_coordinates_tx(
    tx: &mut Transaction<'_, Postgres>,
    mut coordinates: Vec<Vec<u8>>,
) -> Result<()> {
    coordinates.sort();
    coordinates.dedup();
    #[cfg(test)]
    test_lock_schedule::checkpoint(tx, test_lock_schedule::LockPhase::Request, &coordinates).await;
    for coordinate in &coordinates {
        sqlx::query(
            "SELECT pg_advisory_xact_lock(\
                hashtext('buzz_nip_fi_v1'), hashtext(encode($1, 'hex'))\
            )",
        )
        .bind(coordinate.as_slice())
        .execute(&mut **tx)
        .await?;
    }
    #[cfg(test)]
    test_lock_schedule::checkpoint(tx, test_lock_schedule::LockPhase::Acquired, &coordinates).await;
    Ok(())
}

async fn lock_identity_keys_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    issuer: &str,
    uid: &str,
    pubkey: &[u8],
) -> Result<()> {
    lock_identity_coordinates_tx(
        tx,
        vec![
            principal_lock_coordinate(community_id, issuer, uid),
            key_lock_coordinate(community_id, pubkey),
        ],
    )
    .await
}

/// Create or validate an active corporate identity binding.
///
/// This is a fail-closed auth-time operation:
/// - same issuer + uid + pubkey updates display/last_seen and succeeds;
/// - same issuer + uid with a different pubkey conflicts;
/// - same pubkey with a different issuer-qualified principal conflicts;
/// - principal disablement and unresolved key revocation reject every key;
/// - a previously revoked issuer/uid/pubkey tuple remains revoked;
/// - no active row creates a new binding.
pub async fn bind_or_validate_identity(
    pool: &PgPool,
    community_id: CommunityId,
    issuer: &str,
    uid: &str,
    pubkey: &[u8],
    display_name: Option<&str>,
    source: &str,
) -> Result<BindIdentityResult> {
    let mut tx = pool.begin().await?;
    let result = bind_or_validate_identity_tx(
        &mut tx,
        community_id,
        &IdentityBindingInput {
            issuer,
            uid,
            pubkey,
            display_name,
            source,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(result)
}

/// Create or validate a binding inside a caller-owned admission transaction.
pub(crate) async fn bind_or_validate_identity_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    identity: &IdentityBindingInput<'_>,
) -> Result<BindIdentityResult> {
    let IdentityBindingInput {
        issuer,
        uid,
        pubkey,
        display_name,
        source,
    } = *identity;
    validate_inputs(issuer, uid, pubkey, source)?;
    let (enrollment_mode, key_attested) = match source {
        SOURCE_JWT_NPUB => (EnrollmentMode::AttestedKey, true),
        SOURCE_DB_BINDING => (EnrollmentMode::Tofu, false),
        _ => {
            return Err(DbError::InvalidData(
                "identity binding has invalid legacy source".to_string(),
            ))
        }
    };
    let result = resolve_identity_binding_tx(
        tx,
        community_id,
        &ResolveBindingInput {
            issuer,
            subject: uid,
            pubkey,
            display_name,
            enrollment_mode,
            key_attested,
        },
    )
    .await?;
    Ok(match result {
        ResolveBindingResult::Enrolled(_) => BindIdentityResult::Created,
        ResolveBindingResult::Existing(_) => BindIdentityResult::Matched,
        ResolveBindingResult::Denied(BindingDenial::Conflict) => {
            let conflict = active_by_principal_tx(tx, community_id, issuer, uid)
                .await?
                .or(active_by_pubkey_tx(tx, community_id, pubkey).await?)
                .ok_or_else(|| {
                    DbError::InvalidData(
                        "identity binding conflict disappeared inside transaction".to_string(),
                    )
                })?;
            BindIdentityResult::Conflict(conflict_from(conflict))
        }
        ResolveBindingResult::Denied(
            BindingDenial::Revoked
            | BindingDenial::BindingRequired
            | BindingDenial::KeyAttestationRequired,
        ) => BindIdentityResult::Revoked,
    })
}

/// Resolve an exact issuer/subject/key binding under server-owned enrollment policy.
pub async fn resolve_identity_binding(
    pool: &PgPool,
    community_id: CommunityId,
    input: &ResolveBindingInput<'_>,
) -> Result<ResolveBindingResult> {
    let mut tx = pool.begin().await?;
    let result = resolve_identity_binding_tx(&mut tx, community_id, input).await?;
    tx.commit().await?;
    Ok(result)
}

async fn resolve_identity_binding_tx(
    tx: &mut Transaction<'_, Postgres>,
    community_id: CommunityId,
    input: &ResolveBindingInput<'_>,
) -> Result<ResolveBindingResult> {
    validate_inputs(input.issuer, input.subject, input.pubkey, SOURCE_DB_BINDING)?;
    sqlx::query("SET LOCAL lock_timeout = '3s'")
        .execute(&mut **tx)
        .await?;
    lock_identity_keys_tx(tx, community_id, input.issuer, input.subject, input.pubkey).await?;

    let denied = migration_denied_tx(tx, community_id, input.issuer, input.subject).await?
        || migration_key_denied_tx(tx, community_id, input.pubkey).await?
        || principal_disabled_tx(tx, community_id, input.issuer, input.subject).await?
        || key_revoked_tx(tx, community_id, input.pubkey).await?
        || principal_requires_rotation_tx(tx, community_id, input.issuer, input.subject).await?
        || retired_pair_exists_tx(tx, community_id, input.issuer, input.subject, input.pubkey)
            .await?;
    if denied {
        return Ok(ResolveBindingResult::Denied(BindingDenial::Revoked));
    }

    let active_principal =
        active_by_principal_tx(tx, community_id, input.issuer, input.subject).await?;
    if active_principal
        .as_ref()
        .is_some_and(|binding| binding.pubkey != input.pubkey)
    {
        return Ok(ResolveBindingResult::Denied(BindingDenial::Conflict));
    }
    let active_key = active_by_pubkey_tx(tx, community_id, input.pubkey).await?;
    if active_key
        .as_ref()
        .is_some_and(|binding| binding.issuer != input.issuer || binding.uid != input.subject)
    {
        return Ok(ResolveBindingResult::Denied(BindingDenial::Conflict));
    }

    if let Some(binding) = active_principal {
        let strengthen =
            binding.binding_provenance == BindingProvenance::Tofu && input.key_attested;
        let version = binding
            .binding_version
            .checked_add(u64::from(strengthen))
            .ok_or_else(|| {
                DbError::InvalidData("identity binding version exhausted".to_string())
            })?;
        sqlx::query(
            r#"
            UPDATE identity_bindings
            SET display_name=$5,
                source=CASE WHEN $6 THEN 'jwt_npub' ELSE source END,
                binding_provenance=CASE WHEN $6 THEN 'attested_key' ELSE binding_provenance END,
                binding_version=CASE WHEN $6 THEN binding_version + 1 ELSE binding_version END,
                updated_at=NOW(), last_seen_at=NOW()
            WHERE community_id=$1 AND issuer=$2 AND uid=$3 AND pubkey=$4
              AND revoked_at IS NULL
            "#,
        )
        .bind(community_id.as_uuid())
        .bind(input.issuer)
        .bind(input.subject)
        .bind(input.pubkey)
        .bind(input.display_name)
        .bind(strengthen)
        .execute(&mut **tx)
        .await?;
        if strengthen {
            sqlx::query(
                r#"
                INSERT INTO identity_binding_history
                    (community_id, binding_id, binding_version, issuer, subject,
                     pubkey, binding_state, binding_provenance, transition_kind, reason)
                VALUES ($1, $2, $3, $4, $5, $6, 'active', 'attested_key',
                        'provenance_strengthened', 'verified key attestation')
                "#,
            )
            .bind(community_id.as_uuid())
            .bind(binding.binding_id)
            .bind(i64::try_from(version).map_err(|_| {
                DbError::InvalidData("identity binding version is out of range".to_string())
            })?)
            .bind(input.issuer)
            .bind(input.subject)
            .bind(input.pubkey)
            .execute(&mut **tx)
            .await?;
        }
        return Ok(ResolveBindingResult::Existing(BindingEvidence {
            binding_id: binding.binding_id,
            binding_version: version,
            provenance: if strengthen {
                BindingProvenance::AttestedKey
            } else {
                binding.binding_provenance
            },
        }));
    }

    let provenance = match input.enrollment_mode {
        EnrollmentMode::AttestedKey if !input.key_attested => {
            return Ok(ResolveBindingResult::Denied(
                BindingDenial::KeyAttestationRequired,
            ))
        }
        EnrollmentMode::AttestedKey => BindingProvenance::AttestedKey,
        EnrollmentMode::Provisioned => {
            return Ok(ResolveBindingResult::Denied(BindingDenial::BindingRequired))
        }
        EnrollmentMode::Tofu if input.key_attested => BindingProvenance::AttestedKey,
        EnrollmentMode::Tofu => BindingProvenance::Tofu,
    };
    let next_version: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(binding_version), 0) + 1 FROM identity_bindings \
         WHERE community_id=$1 AND issuer=$2 AND uid=$3",
    )
    .bind(community_id.as_uuid())
    .bind(input.issuer)
    .bind(input.subject)
    .fetch_one(&mut **tx)
    .await?;
    if next_version <= 0 {
        return Err(DbError::InvalidData(
            "identity binding version exhausted".to_string(),
        ));
    }
    let binding_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO identity_bindings
            (community_id, issuer, uid, pubkey, display_name, source, binding_id,
             binding_version, binding_state, binding_provenance)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(input.issuer)
    .bind(input.subject)
    .bind(input.pubkey)
    .bind(input.display_name)
    .bind(provenance.legacy_source())
    .bind(binding_id)
    .bind(next_version)
    .bind(provenance.as_str())
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO identity_binding_history
            (community_id, binding_id, binding_version, issuer, subject, pubkey,
             binding_state, binding_provenance, transition_kind, reason)
        VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, 'enroll', 'first enrollment')
        "#,
    )
    .bind(community_id.as_uuid())
    .bind(binding_id)
    .bind(next_version)
    .bind(input.issuer)
    .bind(input.subject)
    .bind(input.pubkey)
    .bind(provenance.as_str())
    .execute(&mut **tx)
    .await?;
    Ok(ResolveBindingResult::Enrolled(BindingEvidence {
        binding_id,
        binding_version: u64::try_from(next_version).map_err(|_| {
            DbError::InvalidData("identity binding version is out of range".to_string())
        })?,
        provenance,
    }))
}

/// Return the active binding for `pubkey`, if one exists.
pub async fn get_active_identity_binding_by_pubkey(
    pool: &PgPool,
    community_id: CommunityId,
    pubkey: &[u8],
) -> Result<Option<IdentityBinding>> {
    validate_pubkey(pubkey)?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '3s'")
        .execute(&mut *tx)
        .await?;
    lock_identity_coordinates_tx(&mut tx, vec![key_lock_coordinate(community_id, pubkey)]).await?;
    let binding = active_by_pubkey_tx(&mut tx, community_id, pubkey).await?;
    if let Some(binding) = binding.as_ref() {
        let denied = migration_key_denied_tx(&mut tx, community_id, pubkey).await?
            || migration_denied_tx(&mut tx, community_id, &binding.issuer, &binding.uid).await?
            || principal_disabled_tx(&mut tx, community_id, &binding.issuer, &binding.uid).await?
            || key_revoked_tx(&mut tx, community_id, pubkey).await?
            || principal_requires_rotation_tx(&mut tx, community_id, &binding.issuer, &binding.uid)
                .await?
            || retired_pair_exists_tx(&mut tx, community_id, &binding.issuer, &binding.uid, pubkey)
                .await?;
        if denied {
            return Err(DbError::InvalidData(
                "active identity binding conflicts with lifecycle state".to_string(),
            ));
        }
    }
    tx.commit().await?;
    Ok(binding)
}

/// Disable an issuer-qualified principal and revoke its active key.
///
/// A principal disablement is durable: normal authentication with any new key
/// returns [`BindIdentityResult::Revoked`]. Re-enablement requires a separate,
/// explicit operator lifecycle operation rather than first-use enrollment.
pub async fn revoke_identity_principal(
    pool: &PgPool,
    community_id: CommunityId,
    issuer: &str,
    uid: &str,
    revoked_by: Option<&[u8]>,
    reason: &str,
) -> Result<bool> {
    crate::identity_lifecycle::disable_identity_principal(
        pool,
        community_id,
        crate::identity_lifecycle::LifecycleContext {
            operation_id: Uuid::new_v4(),
            actor: revoked_by,
            reason,
        },
        crate::identity_lifecycle::IdentityPrincipal {
            issuer,
            subject: uid,
        },
    )
    .await?;
    Ok(true)
}

/// Revoke one active key without disabling the issuer-qualified principal.
/// A replacement key must still be installed through [`rotate_identity_binding`].
pub async fn revoke_identity_key(
    pool: &PgPool,
    community_id: CommunityId,
    pubkey: &[u8],
    revoked_by: Option<&[u8]>,
    reason: &str,
) -> Result<bool> {
    crate::identity_lifecycle::revoke_identity_key(
        pool,
        community_id,
        crate::identity_lifecycle::LifecycleContext {
            operation_id: Uuid::new_v4(),
            actor: revoked_by,
            reason,
        },
        pubkey,
    )
    .await?;
    Ok(true)
}

/// Atomically retire an active key and install an operator-authorized replacement.
#[allow(clippy::too_many_arguments)]
pub async fn rotate_identity_binding(
    pool: &PgPool,
    community_id: CommunityId,
    issuer: &str,
    uid: &str,
    old_pubkey: &[u8],
    new_pubkey: &[u8],
    display_name: Option<&str>,
    source: &str,
    rotated_by: Option<&[u8]>,
    reason: &str,
) -> Result<()> {
    validate_inputs(issuer, uid, old_pubkey, source)?;
    let provenance = match source {
        SOURCE_JWT_NPUB => BindingProvenance::AttestedKey,
        SOURCE_DB_BINDING => BindingProvenance::Provisioned,
        _ => {
            return Err(DbError::InvalidData(
                "identity rotation has invalid legacy source".to_string(),
            ))
        }
    };
    let replacement = crate::identity_lifecycle::VerifiedReplacementKey::after_verified_proof(
        new_pubkey,
        display_name,
        provenance,
        None,
    )?;
    let principal = crate::identity_lifecycle::IdentityPrincipal {
        issuer,
        subject: uid,
    };
    let context = crate::identity_lifecycle::LifecycleContext {
        operation_id: Uuid::new_v4(),
        actor: rotated_by,
        reason,
    };
    if let Some(expected) =
        crate::identity_lifecycle::get_pending_lineage(pool, community_id, principal).await?
    {
        if expected.retired_pubkey != old_pubkey {
            return Err(DbError::InvalidData(
                "identity rotation source does not match pending lineage".to_string(),
            ));
        }
        crate::identity_lifecycle::recover_identity_binding(
            pool,
            community_id,
            context,
            principal,
            &expected,
            replacement,
        )
        .await?;
    } else {
        crate::identity_lifecycle::rotate_identity_binding(
            pool,
            community_id,
            context,
            principal,
            old_pubkey,
            replacement,
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;
    use uuid::Uuid;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz";
    const TEST_ISSUER: &str = "https://idp.example";

    async fn setup_pool() -> PgPool {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned());
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect to test DB");
        crate::migration::run_migrations(&pool)
            .await
            .expect("run migrations");
        pool
    }

    async fn make_community(pool: &PgPool) -> CommunityId {
        let id = Uuid::new_v4();
        let host = format!("identity-binding-test-{}.example", id.simple());
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(id)
            .bind(host)
            .execute(pool)
            .await
            .expect("insert test community");
        CommunityId::from_uuid(id)
    }

    fn random_pubkey() -> Vec<u8> {
        Keys::generate().public_key().to_bytes().to_vec()
    }

    #[test]
    fn identity_lock_coordinates_are_typed_length_prefixed_and_domain_scoped() {
        let first_domain = CommunityId::from_uuid(Uuid::from_u128(1));
        let second_domain = CommunityId::from_uuid(Uuid::from_u128(2));
        let principal_ab_c = principal_lock_coordinate(first_domain, "ab", "c");
        let principal_a_bc = principal_lock_coordinate(first_domain, "a", "bc");

        assert_ne!(
            principal_ab_c, principal_a_bc,
            "lengths must be unambiguous"
        );
        assert_ne!(
            principal_ab_c,
            principal_lock_coordinate(second_domain, "ab", "c"),
            "domains must not share lock coordinates"
        );
        assert_ne!(
            principal_ab_c,
            key_lock_coordinate(first_domain, &[0_u8; 32]),
            "coordinate kinds must be disjoint"
        );
    }

    #[test]
    fn identity_debug_formatting_redacts_private_coordinates() {
        let input = IdentityBindingInput {
            issuer: "private-issuer",
            uid: "private-subject",
            pubkey: &[42_u8; 32],
            display_name: Some("private-display"),
            source: SOURCE_JWT_NPUB,
        };
        let formatted = format!("{input:?}");

        assert!(formatted.contains("[redacted]"));
        for secret in ["private-issuer", "private-subject", "private-display"] {
            assert!(!formatted.contains(secret));
        }
    }

    #[test]
    fn staged_identity_key_must_match_membership_key() {
        let identity_key = [7_u8; 32];
        let other_key = [8_u8; 32];
        let identity = IdentityBindingInput {
            issuer: TEST_ISSUER,
            uid: "user-1",
            pubkey: &identity_key,
            display_name: None,
            source: SOURCE_JWT_NPUB,
        };

        validate_membership_identity_key(&hex::encode(identity_key), Some(&identity))
            .expect("matching key");
        assert!(
            validate_membership_identity_key(&hex::encode(other_key), Some(&identity)).is_err()
        );
        assert!(validate_membership_identity_key("not-hex", Some(&identity)).is_err());
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn bind_identity_creates_then_matches_idempotently() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let pubkey = random_pubkey();

        let created = bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "user-1",
            &pubkey,
            Some("first@example.com"),
            SOURCE_DB_BINDING,
        )
        .await
        .expect("create binding");
        assert_eq!(created, BindIdentityResult::Created);

        let matched = bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "user-1",
            &pubkey,
            Some("second@example.com"),
            SOURCE_JWT_NPUB,
        )
        .await
        .expect("match existing binding");
        assert_eq!(matched, BindIdentityResult::Matched);

        let binding = get_active_identity_binding_by_pubkey(&pool, community, &pubkey)
            .await
            .expect("lookup binding")
            .expect("binding exists");
        assert_eq!(binding.uid, "user-1");
        assert_eq!(binding.issuer, TEST_ISSUER);
        assert_eq!(binding.display_name.as_deref(), Some("second@example.com"));
        assert_eq!(binding.source, SOURCE_JWT_NPUB);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn bind_identity_rejects_uid_conflict() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let original_pubkey = random_pubkey();
        let conflicting_pubkey = random_pubkey();

        bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "user-1",
            &original_pubkey,
            Some("user@example.com"),
            SOURCE_DB_BINDING,
        )
        .await
        .expect("create binding");

        let result = bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "user-1",
            &conflicting_pubkey,
            Some("user@example.com"),
            SOURCE_DB_BINDING,
        )
        .await
        .expect("uid conflict is a binding result");

        assert_eq!(
            result,
            BindIdentityResult::Conflict(IdentityBindingConflict {
                issuer: TEST_ISSUER.to_string(),
                uid: "user-1".to_string(),
                pubkey: original_pubkey,
                source: SOURCE_DB_BINDING.to_string(),
            })
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn bind_identity_rejects_pubkey_conflict() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let pubkey = random_pubkey();

        bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "user-1",
            &pubkey,
            Some("user@example.com"),
            SOURCE_DB_BINDING,
        )
        .await
        .expect("create binding");

        let result = bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "user-2",
            &pubkey,
            Some("other@example.com"),
            SOURCE_JWT_NPUB,
        )
        .await
        .expect("pubkey conflict is a binding result");

        assert_eq!(
            result,
            BindIdentityResult::Conflict(IdentityBindingConflict {
                issuer: TEST_ISSUER.to_string(),
                uid: "user-1".to_string(),
                pubkey,
                source: SOURCE_DB_BINDING.to_string(),
            })
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn bind_identity_does_not_downgrade_jwt_npub_source() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let pubkey = random_pubkey();

        bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "user-1",
            &pubkey,
            Some("user@example.com"),
            SOURCE_JWT_NPUB,
        )
        .await
        .expect("create strong binding");

        let matched = bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "user-1",
            &pubkey,
            Some("user@example.com"),
            SOURCE_DB_BINDING,
        )
        .await
        .expect("match existing binding");
        assert_eq!(matched, BindIdentityResult::Matched);

        let binding = get_active_identity_binding_by_pubkey(&pool, community, &pubkey)
            .await
            .expect("lookup binding")
            .expect("binding exists");
        assert_eq!(binding.source, SOURCE_JWT_NPUB);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn bind_identity_does_not_recreate_revoked_pair() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let pubkey = random_pubkey();

        bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "user-1",
            &pubkey,
            Some("user@example.com"),
            SOURCE_JWT_NPUB,
        )
        .await
        .expect("create binding");

        sqlx::query(
            r#"
            UPDATE identity_bindings
            SET revoked_at = NOW(), revoked_reason = 'test revocation'
            WHERE community_id = $1 AND issuer = $2 AND uid = $3 AND pubkey = $4
            "#,
        )
        .bind(community.as_uuid())
        .bind(TEST_ISSUER)
        .bind("user-1")
        .bind(&pubkey)
        .execute(&pool)
        .await
        .expect("revoke binding");

        let result = bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "user-1",
            &pubkey,
            Some("user@example.com"),
            SOURCE_JWT_NPUB,
        )
        .await
        .expect("revoked pair is a binding result");

        assert_eq!(result, BindIdentityResult::Revoked);
        assert!(
            get_active_identity_binding_by_pubkey(&pool, community, &pubkey)
                .await
                .expect("lookup binding")
                .is_none()
        );

        let replacement = random_pubkey();
        let replacement_result = bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "user-1",
            &replacement,
            Some("user@example.com"),
            SOURCE_JWT_NPUB,
        )
        .await
        .expect("principal revocation is a binding result");
        assert_eq!(replacement_result, BindIdentityResult::Revoked);
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn authorized_rotation_retires_old_key_and_installs_replacement() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let old_pubkey = random_pubkey();
        let new_pubkey = random_pubkey();
        bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "rotating-user",
            &old_pubkey,
            Some("user@example.com"),
            SOURCE_JWT_NPUB,
        )
        .await
        .expect("create binding");

        rotate_identity_binding(
            &pool,
            community,
            TEST_ISSUER,
            "rotating-user",
            &old_pubkey,
            &new_pubkey,
            Some("user@example.com"),
            SOURCE_JWT_NPUB,
            None,
            "device replacement",
        )
        .await
        .expect("authorized rotation");

        assert!(
            get_active_identity_binding_by_pubkey(&pool, community, &old_pubkey)
                .await
                .expect("old lookup")
                .is_none()
        );
        assert_eq!(
            get_active_identity_binding_by_pubkey(&pool, community, &new_pubkey)
                .await
                .expect("new lookup")
                .expect("replacement active")
                .uid,
            "rotating-user"
        );
        assert_eq!(
            bind_or_validate_identity(
                &pool,
                community,
                TEST_ISSUER,
                "rotating-user",
                &old_pubkey,
                Some("user@example.com"),
                SOURCE_JWT_NPUB,
            )
            .await
            .expect("old key result"),
            BindIdentityResult::Revoked
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn key_revocation_requires_explicit_rotation_for_replacement() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let old_pubkey = random_pubkey();
        let new_pubkey = random_pubkey();
        bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "key-revoked-user",
            &old_pubkey,
            None,
            SOURCE_DB_BINDING,
        )
        .await
        .expect("create binding");
        assert!(
            revoke_identity_key(&pool, community, &old_pubkey, None, "lost device",)
                .await
                .expect("revoke key")
        );

        assert_eq!(
            bind_or_validate_identity(
                &pool,
                community,
                TEST_ISSUER,
                "key-revoked-user",
                &new_pubkey,
                None,
                SOURCE_DB_BINDING,
            )
            .await
            .expect("automatic replacement result"),
            BindIdentityResult::Revoked
        );

        rotate_identity_binding(
            &pool,
            community,
            TEST_ISSUER,
            "key-revoked-user",
            &old_pubkey,
            &new_pubkey,
            None,
            SOURCE_DB_BINDING,
            None,
            "approved replacement",
        )
        .await
        .expect("explicit rotation after key revocation");
        assert!(
            get_active_identity_binding_by_pubkey(&pool, community, &new_pubkey)
                .await
                .expect("replacement lookup")
                .is_some()
        );
        let retired = sqlx::query(
            "SELECT revoked_reason, revocation_scope, rotation_reason, rotated_to_pubkey \
             FROM identity_bindings \
             WHERE community_id = $1 AND issuer = $2 AND uid = $3 AND pubkey = $4",
        )
        .bind(community.as_uuid())
        .bind(TEST_ISSUER)
        .bind("key-revoked-user")
        .bind(&old_pubkey)
        .fetch_one(&pool)
        .await
        .expect("retired binding provenance");
        assert_eq!(
            retired.try_get::<String, _>("revoked_reason").unwrap(),
            "lost device"
        );
        assert_eq!(
            retired.try_get::<String, _>("revocation_scope").unwrap(),
            "key"
        );
        assert_eq!(
            retired.try_get::<String, _>("rotation_reason").unwrap(),
            "approved replacement"
        );
        assert_eq!(
            retired.try_get::<Vec<u8>, _>("rotated_to_pubkey").unwrap(),
            new_pubkey
        );
        let tombstone_reason: String = sqlx::query_scalar(
            "SELECT reason FROM identity_revoked_keys WHERE community_id = $1 AND pubkey = $2",
        )
        .bind(community.as_uuid())
        .bind(&old_pubkey)
        .fetch_one(&pool)
        .await
        .expect("key tombstone provenance");
        assert_eq!(tombstone_reason, "lost device");
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn principal_can_be_disabled_before_first_enrollment() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        assert!(revoke_identity_principal(
            &pool,
            community,
            TEST_ISSUER,
            "never-enrolled",
            None,
            "employment ended",
        )
        .await
        .expect("persist principal tombstone"));
        assert_eq!(
            bind_or_validate_identity(
                &pool,
                community,
                TEST_ISSUER,
                "never-enrolled",
                &random_pubkey(),
                None,
                SOURCE_DB_BINDING,
            )
            .await
            .expect("disabled principal result"),
            BindIdentityResult::Revoked
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn revoked_key_cannot_rebind_to_another_principal() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let pubkey = random_pubkey();
        bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "first-principal",
            &pubkey,
            None,
            SOURCE_DB_BINDING,
        )
        .await
        .expect("create binding");
        revoke_identity_key(&pool, community, &pubkey, None, "compromised key")
            .await
            .expect("revoke key");

        assert_eq!(
            bind_or_validate_identity(
                &pool,
                community,
                TEST_ISSUER,
                "different-principal",
                &pubkey,
                None,
                SOURCE_DB_BINDING,
            )
            .await
            .expect("revoked key result"),
            BindIdentityResult::Revoked
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn legacy_revoked_key_history_blocks_cross_principal_rebind() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let pubkey = random_pubkey();
        bind_or_validate_identity(
            &pool,
            community,
            TEST_ISSUER,
            "legacy-principal",
            &pubkey,
            None,
            SOURCE_DB_BINDING,
        )
        .await
        .expect("create binding");
        sqlx::query(
            "UPDATE identity_bindings SET revoked_at = NOW(), revoked_reason = 'legacy revoke' \
             WHERE community_id = $1 AND issuer = $2 AND uid = $3 AND pubkey = $4",
        )
        .bind(community.as_uuid())
        .bind(TEST_ISSUER)
        .bind("legacy-principal")
        .bind(&pubkey)
        .execute(&pool)
        .await
        .expect("simulate pre-lifecycle revocation");
        sqlx::query(
            "INSERT INTO identity_revoked_keys (community_id, pubkey, reason) \
             VALUES ($1,$2,'legacy revoke')",
        )
        .bind(community.as_uuid())
        .bind(&pubkey)
        .execute(&pool)
        .await
        .expect("simulate legacy key tombstone projection");

        assert_eq!(
            bind_or_validate_identity(
                &pool,
                community,
                "https://other-idp.example",
                "different-principal",
                &pubkey,
                None,
                SOURCE_DB_BINDING,
            )
            .await
            .expect("legacy key tombstone result"),
            BindIdentityResult::Revoked
        );
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn bind_identity_qualifies_same_uid_by_issuer() {
        let pool = setup_pool().await;
        let community = make_community(&pool).await;
        let first_pubkey = random_pubkey();
        let second_pubkey = random_pubkey();

        let first = bind_or_validate_identity(
            &pool,
            community,
            "https://issuer-a.example",
            "shared-subject",
            &first_pubkey,
            Some("first@example.com"),
            SOURCE_DB_BINDING,
        )
        .await
        .expect("create first issuer binding");
        let second = bind_or_validate_identity(
            &pool,
            community,
            "https://issuer-b.example",
            "shared-subject",
            &second_pubkey,
            Some("second@example.com"),
            SOURCE_DB_BINDING,
        )
        .await
        .expect("create second issuer binding");

        assert_eq!(first, BindIdentityResult::Created);
        assert_eq!(second, BindIdentityResult::Created);
        assert_eq!(
            get_active_identity_binding_by_pubkey(&pool, community, &second_pubkey)
                .await
                .expect("lookup second binding")
                .expect("second binding exists")
                .issuer,
            "https://issuer-b.example"
        );
    }
}
