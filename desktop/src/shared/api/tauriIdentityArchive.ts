import { invokeTauri } from "@/shared/api/tauri";

// ── NIP-IA identity archival ────────────────────────────────────────────────

export type OwnerOfAgent = {
  /** Verified NIP-OA owner pubkey (hex) of the queried target. */
  owner: string;
  /** True iff `owner` equals the current user's pubkey. */
  isMe: boolean;
};

export type ArchivedIdentitiesSnapshot = {
  /** Lowercase-hex pubkeys present in the relay's latest `kind:13535`. */
  archived: string[];
};

export type IdentityArchiveRequest = {
  targetPubkey: string;
  content?: string;
  reason?: string;
  replacedBy?: string;
};

export type IdentityUnarchiveRequest = {
  targetPubkey: string;
  content?: string;
  reason?: string;
};

// ── NipIaOwnerProof ──────────────────────────────────────────────────────────

/** Result of verifying NIP-OA ownership. Mirrors the Rust `NipIaOwnerProof` enum. */
export type NipIaOwnerProof =
  | { result: "verified" }
  | { result: "missing_profile" }
  | { result: "missing_auth" }
  | { result: "multiple_auth_tags" }
  | { result: "invalid_auth" }
  | { result: "owner_mismatch"; declared_owner: string };

// ── Owned-agent relay inventory ─────────────────────────────────────────────

/** Archive tri-state for a single owned-agent instance. */
export type OwnedAgentArchiveState = {
  /** `null` if the snapshot was not loaded (caller may treat as unknown). */
  isArchived: boolean | null;
};

/** A single owned-agent instance from the relay `kind:30177` inventory. */
export type OwnedAgentInstance = {
  pubkey: string;
  displayName: string | null;
  picture: string | null;
  relayUrl: string;
  /** NIP-OA owner proof for this instance — never omitted, only null in older responses. */
  nipIaOwnerProof: NipIaOwnerProof;
  archiveState: OwnedAgentArchiveState;
};

/** Snapshot returned by `get_owned_agent_inventory`. */
export type OwnedAgentInventorySnapshot = {
  /** Whether the archive snapshot was loaded and trusted. */
  archiveStateTrusted: boolean;
  instances: OwnedAgentInstance[];
};

type RawOwnerOfAgent = { owner: string; is_me: boolean };

/**
 * Resolve a target's NIP-OA owner via its live `kind:0` profile event.
 * Returns `null` if the target has no kind:0, no `auth` tag, or the tag
 * fails verification. Gate for the "Archive" button on the owner path.
 */
export async function resolveOaOwner(
  targetPubkey: string,
): Promise<OwnerOfAgent | null> {
  const raw = await invokeTauri<RawOwnerOfAgent | null>("resolve_oa_owner", {
    targetPubkey,
  });
  if (!raw) return null;
  return { owner: raw.owner, isMe: raw.is_me };
}

/**
 * Submit a `kind:9035` NIP-IA archive request. Consent path is chosen by the
 * relay; the desktop attaches the owner's `auth` tag automatically when the
 * caller is the verified owner-of-agent for the target.
 */
export async function archiveIdentity(
  req: IdentityArchiveRequest,
): Promise<void> {
  await invokeTauri("archive_identity", { req });
}

/**
 * Submit a `kind:9036` NIP-IA unarchive request.
 */
export async function unarchiveIdentity(
  req: IdentityUnarchiveRequest,
): Promise<void> {
  await invokeTauri("unarchive_identity", { req });
}

/**
 * Read the relay's latest `kind:13535` archived-identities snapshot.
 * Snapshot is authoritative per NIP-IA §Snapshot and Delta Consistency.
 */
export async function listArchivedIdentities(): Promise<ArchivedIdentitiesSnapshot> {
  return await invokeTauri<ArchivedIdentitiesSnapshot>(
    "list_archived_identities",
  );
}

/**
 * Query the relay's `kind:30177` inventory for agents owned by the current
 * user. Pages to exhaustion internally; returns a complete snapshot.
 */
export async function getOwnedAgentInventory(): Promise<OwnedAgentInventorySnapshot> {
  return await invokeTauri<OwnedAgentInventorySnapshot>(
    "get_owned_agent_inventory",
  );
}
