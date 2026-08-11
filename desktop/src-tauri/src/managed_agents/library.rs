//! Cross-workspace agent library — device-local, unscoped metadata (§2).
//!
//! `library.json` (`<agents-base>/library.json`, `0o600`, never published) is
//! the single source of truth for shared agent definitions, their per-scope
//! projections, and the crash-safe identity bindings that carry one npub across
//! a same-owner's workspaces. This module is the Phase-1 data model and its
//! quarantine-preserving IO; the operations that mutate it (share, edit,
//! materialize, delete, deploy) land in Phases 2-5. The scope-local journals
//! that must share a *workspace's* failure domain rather than the library's
//! (P9-I1) live in the [`journals`] submodule.
//!
//! Fault model (§2.1):
//! - Absent file = a valid empty library (version 1, no entries).
//! - Whole-document syntax failure → preserved as `library.json.invalid`
//!   (copy, not rename — the `storage.rs` loud-failure discipline) and NO
//!   library or scoped mutation proceeds; workspaces keep running from their
//!   scoped caches.
//! - Unknown/forward `version` → read-only fail: no library or scoped mutation.
//! - A single malformed, semantically invalid, or identity-colliding entry is
//!   quarantined (kept raw, surfaced as a degradation, never merged, never a
//!   winner) while its healthy siblings stay fully usable, and every healthy
//!   rewrite preserves the quarantined entry value-equivalently (P2-I2).
//!
//! Items are `pub(crate)` for the Phase 2-5 callers; suppress the dead-code
//! lint until those land (matches `team_snapshot.rs`).
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use nostr::PublicKey;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::storage::{atomic_write_json_restricted, backup_invalid_store};
use super::types::ManagedAgentRecord;

pub(crate) mod journals;

/// The only `library.json` schema version v1 understands. A document whose
/// `version` differs is a forward format: read-only fail, never migrated.
pub(crate) const SUPPORTED_LIBRARY_VERSION: u32 = 1;

/// Resolve the unscoped `library.json` path under the agents base directory.
/// The library is a peer of `scopes/`, never inside a scope — it is device
/// metadata shared across every workspace (§2, layout).
pub(crate) fn library_path(base_dir: &Path) -> PathBuf {
    base_dir.join("library.json")
}

// ── Document envelope ─────────────────────────────────────────────────────────

/// The versioned `library.json` envelope (§2.1). Entries are retained RAW and
/// decoded individually so one malformed entry can never reject the whole file,
/// and re-serializing only the valid ones can never silently erase a
/// quarantined sibling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct LibraryDocument {
    /// `1` in v1; an unknown value is a forward format (read-only fail).
    pub version: u32,
    /// Entries retained RAW and decoded one at a time (§2.1 quarantine).
    pub entries: Vec<Value>,
    /// Orphan-key journal (§2.5): pubkeys minted for a binding whose commit may
    /// not have completed. Non-secret (pubkeys only). The ONLY journal in
    /// `library.json` — binding state is library-linked by definition; plain
    /// crash journals live scope-local (P9-I1, [`journals`]).
    #[serde(default)]
    pub orphan_keys: Vec<String>,
}

impl LibraryDocument {
    /// A valid empty library (the absent-file and freshly-initialized shape).
    pub fn empty() -> Self {
        Self {
            version: SUPPORTED_LIBRARY_VERSION,
            entries: Vec::new(),
            orphan_keys: Vec::new(),
        }
    }
}

// ── Shared content ────────────────────────────────────────────────────────────

/// Allowlisted shared agent content (§2.2). Deliberately NOT `AgentDefinition`:
/// `env_vars`, credentials, identity, `is_active`, catalog `shared`,
/// catalog/team provenance, runtime state, relay, memory, timestamps, and
/// projection metadata are structurally absent — they cannot ride a share.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SharedDefinition {
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub system_prompt: String,
    pub runtime: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub name_pool: Vec<String>,
    /// NIP-AP behavioral defaults, WIRE shape (kebab-case string / optional u32)
    /// — parsed only at the mint boundary, so an unknown future mode string
    /// round-trips byte-identically.
    pub respond_to: Option<String>,
    pub respond_to_allowlist: Vec<String>,
    pub parallelism: Option<u32>,
}

/// The ONLY writer of shared content onto a scoped keyless definition record
/// (§2.2). Assigns exactly the [`SharedDefinition`] slots, plus
/// `library_applied_revision` and `updated_at`; every other field of `local` —
/// identity, `env_vars`, `is_active`, runtime state, `library_ref` — is
/// untouched by construction. The value mapping mirrors
/// `AgentDefinition::into_agent_record` so a record populated this way is
/// byte-identical to one freshly projected.
pub(crate) fn apply_shared_definition(
    local: &mut ManagedAgentRecord,
    shared: &SharedDefinition,
    revision: u64,
) {
    local.name = shared.display_name.clone();
    local.display_name = Some(shared.display_name.clone());
    local.avatar_url = shared.avatar_url.clone();
    local.system_prompt = (!shared.system_prompt.is_empty()).then(|| shared.system_prompt.clone());
    local.runtime = shared.runtime.clone();
    local.model = shared.model.clone();
    local.provider = shared.provider.clone();
    local.name_pool = shared.name_pool.clone();
    local.definition_respond_to = shared.respond_to.clone();
    local.definition_respond_to_allowlist = shared.respond_to_allowlist.clone();
    local.definition_parallelism = shared.parallelism;
    local.library_applied_revision = Some(revision);
    local.updated_at = crate::util::now_iso();
}

// ── Library entry ─────────────────────────────────────────────────────────────

/// A shared library entry (§2.3). `library_id` routes scoped records
/// (`library_ref`/`lib-<id>`, §2.6); `origin` is the share idempotency key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LibraryEntry {
    /// UUID v4, minted once at share commit.
    pub library_id: String,
    /// `(origin scope_id, origin slug)` — share idempotency key.
    pub origin: OriginKey,
    /// Monotonic integer; wall-clock is display-only.
    pub revision: u64,
    /// Tombstone; kept forever in v1.
    pub deleted: bool,
    /// Provenance guard only — never an identity lookup key.
    pub owner_pubkey_at_share: String,
    pub shared: SharedDefinition,
    /// Owner-keyed PUBLIC identity bindings — pubkey + auth tag, NEVER an nsec.
    /// A binding exists only after its nsec is write-and-read-back verified in
    /// the device keyring (§2.5); there is no "pending binding" state.
    pub identity_bindings: BTreeMap<String, IdentityBinding>,
    /// Archive obligations deferred by a protected removal (§3.6 step 3).
    /// PERMANENT journaled retirement markers in v1 (P17-C1): no v1 path
    /// discharges them; their presence keeps `key_archive_protected(pubkey)`
    /// true. SET semantics on `(library_id, scope_id, agent_pubkey)` — every
    /// append is an upsert (P15-MINOR); reads treat legacy duplicate rows as
    /// one obligation.
    #[serde(default)]
    pub deferred_archives: Vec<DeferredArchive>,
    /// Authoritative per-scope membership — sole source for delete-confirm
    /// enumeration, tombstone completion, and key lifetime.
    pub projections: BTreeMap<String, ProjectionEntry>,
}

/// `(origin scope_id, origin slug)` — the share idempotency key (§2.3).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OriginKey {
    pub scope_id: String,
    pub slug: String,
}

/// A verified owner→agent identity binding (§2.5). `auth_tag` is the NIP-OA
/// `auth` tag JSON; the map key is the owner pubkey it embeds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct IdentityBinding {
    pub agent_pubkey: String,
    pub auth_tag: String,
}

/// One skipped archive (§2.3): the identity `agent_pubkey`, live on `scope_id`'s
/// relay, whose archive request was skipped by a protected removal in THAT
/// scope. A permanent v1 retirement marker — never discharged by any v1 path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeferredArchive {
    pub scope_id: String,
    pub agent_pubkey: String,
}

/// This scope's projection of a library entry (§2.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProjectionEntry {
    pub state: ProjectionState,
    /// This scope's actual definition slug, fixed at `Pending` commit: the
    /// deterministic `lib-<library_id>` for a lazily materialized scope, or the
    /// origin record's original human slug for the sharing scope. Always equals
    /// the scoped record's `slug` and its instances' `persona_id`.
    pub local_slug: String,
    /// Non-secret metadata for the ruling-4 confirm dialog, captured at this
    /// scope's own activation (or at share, for the sharing scope).
    pub relay_url: String,
    pub workspace_label: Option<String>,
}

/// The uniform journal-first projection state machine (§2.3, P2-C1/C2). Every
/// bracketed scoped-file step is flanked by library writes: intent precedes the
/// scoped mutation, confirmation follows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) enum ProjectionState {
    /// Journal intent: materialization not yet confirmed.
    Pending,
    Materialized {
        revision: u64,
    },
    /// Journal intent: user removed in this workspace; scoped cascade not yet
    /// confirmed (P2-C2). `manifest` journaled BEFORE any deletion (P4-C3).
    ExcludePending {
        manifest: Option<RemovalManifest>,
    },
    /// Terminal: cascade confirmed; NEVER rematerialize.
    Excluded,
    /// Library deleted; this scope's cascade not yet confirmed.
    DeletePending {
        manifest: Option<RemovalManifest>,
    },
    /// Terminal.
    Deleted,
}

impl ProjectionState {
    /// `Excluded`/`Deleted` are terminal; the identity index only conflicts on
    /// non-terminal `(scope_id, local_slug)` ownership (§2.1 index rule (c)).
    pub fn is_terminal(&self) -> bool {
        matches!(self, ProjectionState::Excluded | ProjectionState::Deleted)
    }
}

/// Everything a removal retry needs after the local records have left disk
/// (§2.3, P4-C3). Captured by the record-owning scope from its own readable
/// cache, in the same or an earlier library write than the FIRST destructive
/// scoped step. Non-secret (pubkeys/coordinates only).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RemovalManifest {
    /// Persona tombstone coordinate: `(owner pubkey, definition d-tag)`.
    pub definition_coordinate: (String, String),
    /// Every linked instance pubkey at capture time; each requires the full
    /// per-pubkey cleanup set (30177 tombstone + archive, key deletion only per
    /// the §2.5 entry-wide lifetime, re-evaluated against the index at execution
    /// time, never trusted stale).
    pub instances: Vec<String>,
}

// ── Quarantine-preserving load (§2.1) ─────────────────────────────────────────

/// The outcome of reading `library.json` (§2.1). The four states the
/// failure-domain rules key on.
#[derive(Debug)]
pub(crate) enum LibraryLoad {
    /// Absent file — a valid empty library (version 1, no entries).
    Empty,
    /// A healthy version-1 document, classified into healthy + quarantined.
    Loaded(LoadedLibrary),
    /// Whole-document syntax/shape failure. Preserved as `library.json.invalid`;
    /// NO library or scoped mutation may proceed.
    Corrupt,
    /// Parsed, but `version` is unknown/forward: read-only fail.
    UnknownVersion(u32),
}

/// A successfully parsed version-1 library, partitioned by the §2.1 rules. The
/// raw `quarantined` values are retained verbatim so a healthy rewrite
/// preserves them value-equivalently (P2-I2).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LoadedLibrary {
    /// Individually valid, semantically sound, non-colliding entries.
    pub healthy: Vec<LibraryEntry>,
    /// Decode / semantic / identity-collision failures, kept RAW.
    pub quarantined: Vec<Value>,
    pub orphan_keys: Vec<String>,
    /// Human-readable reasons, one per quarantined entry, for the UI.
    pub degradations: Vec<String>,
}

impl LoadedLibrary {
    /// Reconstruct the on-disk document, re-serializing healthy entries and
    /// re-attaching every quarantined raw value unchanged (P2-I2 preservation).
    pub fn rebuild_document(&self) -> Result<LibraryDocument, String> {
        let mut entries = Vec::with_capacity(self.healthy.len() + self.quarantined.len());
        for entry in &self.healthy {
            entries.push(
                serde_json::to_value(entry)
                    .map_err(|e| format!("serialize library entry {}: {e}", entry.library_id))?,
            );
        }
        entries.extend(self.quarantined.iter().cloned());
        Ok(LibraryDocument {
            version: SUPPORTED_LIBRARY_VERSION,
            entries,
            orphan_keys: self.orphan_keys.clone(),
        })
    }
}

/// Read and classify `library.json` under `base_dir` (§2.1). Never mutates the
/// file; whole-document corruption is preserved as `.invalid` as a read side
/// effect so the loud-failure evidence survives.
pub(crate) fn load_library(base_dir: &Path) -> LibraryLoad {
    let path = library_path(base_dir);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return LibraryLoad::Empty,
        Err(_) => {
            // An unreadable-but-present file is preserved and treated as
            // corrupt: no mutation may proceed against an unknown on-disk state.
            backup_invalid_store(&path);
            return LibraryLoad::Corrupt;
        }
    };
    let document: LibraryDocument = match serde_json::from_slice(&bytes) {
        Ok(document) => document,
        Err(_) => {
            backup_invalid_store(&path);
            return LibraryLoad::Corrupt;
        }
    };
    if document.version != SUPPORTED_LIBRARY_VERSION {
        return LibraryLoad::UnknownVersion(document.version);
    }
    LibraryLoad::Loaded(classify_entries(document))
}

/// Persist a document (§2.1): atomic temp-file + rename + `0o600`, same as
/// `managed-agents.json` (`storage.rs` `write_agent_store_to_path`). Creates the
/// parent agents dir if needed.
pub(crate) fn save_library_document(
    base_dir: &Path,
    document: &LibraryDocument,
) -> Result<(), String> {
    let path = library_path(base_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create agents dir {}: {e}", parent.display()))?;
    }
    let payload =
        serde_json::to_vec_pretty(document).map_err(|e| format!("serialize library.json: {e}"))?;
    atomic_write_json_restricted(&path, &payload)
}

/// Per-entry decode + semantic validation + document-wide identity index
/// (§2.1). Every failure quarantines its entry (raw-preserved, degradation);
/// identity collisions group-quarantine ALL colliders (never first-wins).
fn classify_entries(document: LibraryDocument) -> LoadedLibrary {
    let LibraryDocument {
        entries,
        orphan_keys,
        ..
    } = document;

    // Pass 1: individual decode + semantic binding validation. Survivors keep
    // their ORIGINAL raw value alongside the decoded form, so a later
    // group-quarantine preserves the exact on-disk bytes (P2-I2) rather than a
    // re-serialization that could drift or fail.
    let mut decoded: Vec<(LibraryEntry, Value)> = Vec::new();
    let mut quarantined: Vec<Value> = Vec::new();
    let mut degradations: Vec<String> = Vec::new();
    for raw in entries {
        match serde_json::from_value::<LibraryEntry>(raw.clone()) {
            Err(e) => {
                degradations.push(format!("library entry failed to decode: {e}"));
                quarantined.push(raw);
            }
            Ok(entry) => match validate_entry_bindings(&entry) {
                Err(reason) => {
                    degradations.push(format!(
                        "library entry {} quarantined: {reason}",
                        entry.library_id
                    ));
                    quarantined.push(raw);
                }
                Ok(()) => decoded.push((entry, raw)),
            },
        }
    }

    // Pass 2: document-wide identity index — collisions group-quarantine every
    // collider (§2.1 rule; P6-I3), preserved via the pass-1 original raw.
    let colliders = identity_collisions(decoded.iter().map(|(entry, _)| entry));
    let mut healthy = Vec::new();
    for (index, (entry, raw)) in decoded.into_iter().enumerate() {
        if colliders.contains(&index) {
            degradations.push(format!(
                "library entry {} quarantined: identity-index collision",
                entry.library_id
            ));
            quarantined.push(raw);
        } else {
            healthy.push(entry);
        }
    }

    LoadedLibrary {
        healthy,
        quarantined,
        orphan_keys,
        degradations,
    }
}

/// Semantic binding validation (§2.5 read validation): every binding's auth tag
/// must verify against its `agent_pubkey` AND embed exactly the owner pubkey it
/// is keyed under. Also rejects an entry that binds one `agent_pubkey` under two
/// different owners. Malformed pubkeys/tags fail closed.
fn validate_entry_bindings(entry: &LibraryEntry) -> Result<(), String> {
    let mut seen_agents: HashMap<String, String> = HashMap::new();
    for (owner_hex, binding) in &entry.identity_bindings {
        let owner = PublicKey::from_hex(owner_hex)
            .map_err(|_| format!("binding owner {owner_hex} is not a valid pubkey"))?;
        let agent = PublicKey::from_hex(&binding.agent_pubkey).map_err(|_| {
            format!(
                "binding agent {} is not a valid pubkey",
                binding.agent_pubkey
            )
        })?;
        let embedded =
            buzz_sdk_pkg::nip_oa::verify_auth_tag(&binding.auth_tag, &agent).map_err(|e| {
                format!(
                    "binding auth tag for {} failed verification: {e}",
                    binding.agent_pubkey
                )
            })?;
        if embedded != owner {
            return Err(format!(
                "binding auth tag for {} embeds {} but is keyed under {owner_hex}",
                binding.agent_pubkey,
                embedded.to_hex()
            ));
        }
        if let Some(prev) = seen_agents.insert(binding.agent_pubkey.clone(), owner_hex.clone()) {
            return Err(format!(
                "agent {} is bound under two owners ({prev} and {owner_hex})",
                binding.agent_pubkey
            ));
        }
    }
    Ok(())
}

/// Build the document-wide identity index over the individually valid entries
/// and return the indices of every collider (§2.1 rule; P6-I3). Collisions on
/// (a) `library_id`, (b) live (non-`deleted`) [`OriginKey`], or (c) a
/// non-terminal `(scope_id, local_slug)` projection claim group-quarantine ALL
/// participants — picking a winner would silently rewrite a scope.
fn identity_collisions<'a>(
    entries: impl Iterator<Item = &'a LibraryEntry>,
) -> std::collections::HashSet<usize> {
    let mut by_library_id: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut by_origin: HashMap<&OriginKey, Vec<usize>> = HashMap::new();
    let mut by_scope_slug: HashMap<(&str, &str), Vec<usize>> = HashMap::new();

    for (index, entry) in entries.enumerate() {
        by_library_id
            .entry(entry.library_id.as_str())
            .or_default()
            .push(index);
        if !entry.deleted {
            by_origin.entry(&entry.origin).or_default().push(index);
        }
        for (scope_id, projection) in &entry.projections {
            if !projection.state.is_terminal() {
                by_scope_slug
                    .entry((scope_id.as_str(), projection.local_slug.as_str()))
                    .or_default()
                    .push(index);
            }
        }
    }

    let mut colliders = std::collections::HashSet::new();
    for group in by_library_id
        .values()
        .chain(by_origin.values())
        .chain(by_scope_slug.values())
    {
        if group.len() > 1 {
            colliders.extend(group.iter().copied());
        }
    }
    colliders
}

#[cfg(test)]
mod tests;
