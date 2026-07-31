export interface ReadStateBlob {
  v: 1;
  client_id: string;
  contexts: Record<string, number>;
}

export const READ_STATE_D_TAG_PREFIX = "read-state:";
export const READ_STATE_FETCH_LIMIT = 500;
export const READ_STATE_HORIZON_SECONDS = 7 * 24 * 60 * 60;

export const MAX_CONTEXTS = 10_000;

// Local-storage cap on within-horizon msg:/thread: markers. Generous multiple
// of what the 32 KB publish budget can round-trip (~290 entries), so anything
// beyond it is local-only dead weight that other devices never see anyway.
export const LOCAL_MAX_PRUNABLE_CONTEXTS = 1_000;

// Maximum plaintext byte length for the JSON blob passed to nip44EncryptToSelf.
// NIP-44 v2 hard-caps plaintext at 65,535 bytes; the relay enforces a 256 KB
// content limit. 32 KB gives ample headroom for NIP-44 overhead (~1.4×
// expansion to ~45 KB ciphertext) while keeping the blob well under both caps.
export const READ_STATE_MAX_PLAINTEXT_BYTES = 32_768;

// Maximum number of slots a client may publish. Each slot is a separate
// kind:30078 event. Splitting across slots is the fallback when channel keys
// alone exceed READ_STATE_MAX_PLAINTEXT_BYTES. 8 slots × ~650 channel keys per
// slot = ~5,200 channels — well beyond any realistic user.
export const READ_STATE_MAX_SLOTS = 8;

// Context-key prefix for a per-MESSAGE read marker (LP4 v3). One grow-only
// marker per reply id; the badge predicate reads effective("msg:<id>") live so
// reading an ancestor never covers a descendant (Issue 2 by construction).
// Distinct from THREAD_PREFIX so the parent resolver and eviction can tell the
// two key families apart.
export const MSG_PREFIX = "msg:";
export const THREAD_PREFIX = "thread:";

// ---------------------------------------------------------------------------
// Reserved namespace — override key prefixes and escape marker
//
// NIP-RS spec (Reserved Namespace section): the `ov_` stem and `esc:` marker
// are reserved for the manual-unread override layer.  Any raw context ID that
// starts with either prefix MUST be escaped before use as a frontier key.
// Override counter keys (`ov_s:`, `ov_c:`, `ov_b:`) are NEVER escaped — they
// are their own wire namespace and are not legitimate frontier keys.
// ---------------------------------------------------------------------------

export const OV_S_PREFIX = "ov_s:" as const;
export const OV_C_PREFIX = "ov_c:" as const;
export const OV_B_PREFIX = "ov_b:" as const;
const OV_STEM = "ov_" as const;
const ESC_PREFIX = "esc:" as const;

/** True for wire keys that are override counters (`ov_s:`, `ov_c:`, `ov_b:`). */
export function isOverrideKey(key: string): boolean {
  return (
    key.startsWith(OV_S_PREFIX) ||
    key.startsWith(OV_C_PREFIX) ||
    key.startsWith(OV_B_PREFIX)
  );
}

/**
 * Escape a raw context ID for use as a frontier key.
 * Prepends `esc:` when the raw ID begins with `ov_` or `esc:`.
 * No-op for the context shapes Buzz generates (UUID, msg:hex64, thread:hex64).
 */
export function escapeFrontierKey(rawCtx: string): string {
  if (rawCtx.startsWith(OV_STEM) || rawCtx.startsWith(ESC_PREFIX)) {
    return ESC_PREFIX + rawCtx;
  }
  return rawCtx;
}

/**
 * Recover the raw context ID from a frontier wire key.
 * Strips exactly one leading `esc:` if present; never strips more.
 */
export function unescapeFrontierKey(wireKey: string): string {
  if (wireKey.startsWith(ESC_PREFIX)) {
    return wireKey.slice(ESC_PREFIX.length);
  }
  return wireKey;
}

// ---------------------------------------------------------------------------
// Override register — the (S, C, B) triple for a single context
// ---------------------------------------------------------------------------

/**
 * A fully-validated override register for one context.
 *
 * A live override (`isOverrideActive === true`) carries all three counters.
 * A tombstone floor carries only `c` (S=0, B=0).
 * A virgin register (never activated) is represented by the absence of this
 * type entirely — it is omitted from the wire.
 *
 * Slice 2 (manager) and slice 3 (UI) use this type as the wire-in/wire-out
 * contract.  Slices MUST NOT construct registers directly — use
 * `encodeOverrideGroup` for encoding and rely on `extractOverrideRegisters`
 * (snapshot.ts) for decoding.
 */
export interface OverrideRegister {
  /** Set counter S — incremented on each mark-unread. */
  readonly s: number;
  /** Clear counter C — incremented on each mark-read. */
  readonly c: number;
  /** Baseline B — effective frontier at the time of the most recent mark-unread. */
  readonly b: number;
}

/**
 * Result of evaluating whether a context has an active manual-unread override.
 *
 * `active` means: `S > 0 AND F <= B AND S > C` (clear-wins tie policy).
 * `frontier` is the merged effective frontier for the context (used by the
 * unread verdict in the UI layer).
 */
export interface OverrideLiveness {
  readonly active: boolean;
  /** The merged effective frontier value passed to `isOverrideActive`. */
  readonly frontier: number;
}

/**
 * Evaluate the liveness predicate from the spec (clear-wins, mandatory).
 *
 * override_active(S, C, B, F) = S > 0 AND F <= B AND S > C
 *
 * F is the merged effective frontier for the context — typically
 * `contexts.get(rawCtxId) ?? 0` after applying the hierarchical frontier rule.
 */
export function isOverrideActive(
  reg: OverrideRegister,
  frontier: number,
): boolean {
  return reg.s > 0 && frontier <= reg.b && reg.s > reg.c;
}

/**
 * Componentwise `max()` merge of two override registers.
 * Commutative, associative, idempotent — same as the frontier max() merge.
 */
export function mergeOverrideRegisters(
  a: OverrideRegister,
  b: OverrideRegister,
): OverrideRegister {
  return {
    s: Math.max(a.s, b.s),
    c: Math.max(a.c, b.c),
    b: Math.max(a.b, b.b),
  };
}

/**
 * Canonical wire encoding of an override register for a given context.
 *
 * Applies the tombstone-floor / virgin-omit rules from the spec
 * (Mandatory Canonical Publication section) so publishers always emit
 * a correctly-shaped group.
 *
 * Returns a partial `contexts` patch to be merged into the blob before
 * serialization.  Caller is responsible for including the frontier entry
 * for `rawCtxId` separately.
 *
 * @param rawCtxId  Raw (unescaped) context ID — e.g. `"abc-channel-uuid"`.
 * @param reg       Override register to encode.
 * @param frontier  Current merged effective frontier for this context.
 */
export function encodeOverrideGroup(
  rawCtxId: string,
  reg: OverrideRegister,
  frontier: number,
): Record<string, number> {
  const virgin = reg.s === 0 && reg.c === 0;
  if (virgin) {
    // Virgin registers are omitted entirely from the wire.
    return {};
  }
  const active = isOverrideActive(reg, frontier);
  if (active) {
    // Live override: publish all three keys.
    return {
      [`${OV_S_PREFIX}${rawCtxId}`]: reg.s,
      [`${OV_C_PREFIX}${rawCtxId}`]: reg.c,
      [`${OV_B_PREFIX}${rawCtxId}`]: reg.b,
    };
  }
  // Dead override: tombstone floor — only ov_c: with value max(S, C).
  return {
    [`${OV_C_PREFIX}${rawCtxId}`]: Math.max(reg.s, reg.c),
  };
}

// ---------------------------------------------------------------------------
// Override group validation — used inside sanitizeContexts
//
// The spec requires that override entries be validated as a complete logical
// group BEFORE any per-entry processing.  This function partitions the raw
// contexts map into (a) validated override groups and (b) everything else,
// so that sanitizeContexts can apply group-first rules without mixing the two
// validation paths.
// ---------------------------------------------------------------------------

/**
 * A validated override group ready for merge.
 * `kind === "live"` → three-key group with all counters present.
 * `kind === "floor"` → tombstone, only `c` is meaningful (s=0, b=0).
 */
export type ValidatedOverrideGroup =
  | { kind: "live"; reg: OverrideRegister }
  | { kind: "floor"; c: number };

/**
 * Partition the raw contexts map into validated override groups and
 * non-override entries.
 *
 * Override entries that fail group validation are silently dropped (per spec:
 * "the entire override group is rejected"); the corresponding frontier entry
 * for `<ctx>` is retained in `nonOverride`.
 *
 * @returns
 *   `overrides`   — Map from raw context ID to validated group.
 *   `nonOverride` — Raw contexts map with all `ov_*` keys removed (frontier
 *                   entries and escaped keys remain for standard processing).
 */
export function partitionOverrideGroups(contexts: Record<string, unknown>): {
  overrides: Map<string, ValidatedOverrideGroup>;
  nonOverride: Record<string, unknown>;
} {
  // First pass: collect all ov_* entries by context suffix.
  const sMap = new Map<string, unknown>();
  const cMap = new Map<string, unknown>();
  const bMap = new Map<string, unknown>();
  const nonOverride: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(contexts)) {
    if (key.startsWith(OV_S_PREFIX)) {
      sMap.set(key.slice(OV_S_PREFIX.length), value);
    } else if (key.startsWith(OV_C_PREFIX)) {
      cMap.set(key.slice(OV_C_PREFIX.length), value);
    } else if (key.startsWith(OV_B_PREFIX)) {
      bMap.set(key.slice(OV_B_PREFIX.length), value);
    } else {
      nonOverride[key] = value;
    }
  }

  // Second pass: validate each unique ctx suffix as a group.
  const ctxSuffixes = new Set([...sMap.keys(), ...cMap.keys(), ...bMap.keys()]);
  const overrides = new Map<string, ValidatedOverrideGroup>();

  for (const ctx of ctxSuffixes) {
    const hasS = sMap.has(ctx);
    const hasC = cMap.has(ctx);
    const hasB = bMap.has(ctx);

    const sVal = sMap.get(ctx);
    const cVal = cMap.get(ctx);
    const bVal = bMap.get(ctx);

    const isUint32 = (v: unknown): v is number =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4294967295;

    if (!hasS && hasC && !hasB) {
      // Tombstone floor: only ov_c: present — must be a valid uint32.
      if (!isUint32(cVal)) continue; // invalid — drop group silently
      overrides.set(ctx, { kind: "floor", c: cVal });
    } else if (hasS && hasC && hasB) {
      // Complete live group: all three keys must have valid uint32 values.
      if (!isUint32(sVal) || !isUint32(cVal) || !isUint32(bVal)) continue;
      overrides.set(ctx, {
        kind: "live",
        reg: { s: sVal, c: cVal, b: bVal },
      });
    } else {
      // Partial group or any other shape — reject the whole group (spec).
      // The frontier entry for this ctx remains in nonOverride; do nothing here.
    }
  }

  return { overrides, nonOverride };
}

// ---------------------------------------------------------------------------
// Core validation and sanitization
// ---------------------------------------------------------------------------

const EVENT_ID_PATTERN = /^[0-9a-f]{64}$/;

export function maxReadAt(...markers: Array<number | null>): number | null {
  return markers.reduce<number | null>((latest, marker) => {
    if (marker === null) return latest;
    if (latest === null || marker > latest) return marker;
    return latest;
  }, null);
}

export function msgContextKey(messageId: string): string {
  return `${MSG_PREFIX}${messageId}`;
}

// Spec-conformance helpers for well-known interoperable context keys. Runtime
// folding/eviction remains prefix-based so opaque client-local keys still work.
export function isThreadContextKey(value: string): value is `thread:${string}` {
  if (!value.startsWith(THREAD_PREFIX)) return false;
  return EVENT_ID_PATTERN.test(value.slice(THREAD_PREFIX.length));
}

export function isMsgContextKey(value: string): value is `msg:${string}` {
  if (!value.startsWith(MSG_PREFIX)) return false;
  return EVENT_ID_PATTERN.test(value.slice(MSG_PREFIX.length));
}

export function localReadStateKey(pubkey: string): string {
  return `buzz.channel-read-state.v2:${pubkey}`;
}

export function localPublishableContextKey(pubkey: string): string {
  return `buzz.channel-read-state.publishable.v1:${pubkey}`;
}

export function localSourceCreatedAtKey(pubkey: string): string {
  return `buzz.channel-read-state.source-created-at.v1:${pubkey}`;
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidBlob(obj: unknown): obj is ReadStateBlob {
  if (!isPlainRecord(obj)) return false;
  const record = obj;
  if (record.v !== 1) return false;
  if (
    typeof record.client_id !== "string" ||
    record.client_id.length === 0 ||
    record.client_id.length > 64
  )
    return false;
  if (!isPlainRecord(record.contexts)) return false;
  if (Object.keys(record.contexts).length > MAX_CONTEXTS) return false;
  return true;
}

/**
 * Sanitize and validate a raw contexts object from a decoded blob.
 *
 * Override entries (`ov_*` keys) are validated as complete logical groups
 * BEFORE any per-entry processing, per the spec's Content Validation section.
 * Partial groups are rejected (dropped) while their corresponding frontier
 * entry is retained.  Validated override groups are re-encoded into the result
 * as raw entries so that the rest of the pipeline (merge, liveness) operates
 * on a flat integer map — the same type as frontier entries.
 *
 * Escaped frontier keys (`esc:…`) pass through unchanged; unescaping happens
 * at read time in the snapshot layer.
 */
export function sanitizeContexts(
  contexts: Record<string, unknown>,
): Record<string, number> {
  // Step 1: partition override groups from the rest (group-first validation).
  const { overrides, nonOverride } = partitionOverrideGroups(contexts);

  // Step 2: sanitize non-override entries with the standard per-entry rules.
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(nonOverride)) {
    if (new TextEncoder().encode(key).length > 256) continue;
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (value < 0 || value > 4294967295) continue;
    result[key] = value;
  }

  // Step 3: fold validated override groups back as integer entries.
  for (const [ctx, group] of overrides) {
    if (group.kind === "floor") {
      result[`${OV_C_PREFIX}${ctx}`] = group.c;
    } else {
      result[`${OV_S_PREFIX}${ctx}`] = group.reg.s;
      result[`${OV_C_PREFIX}${ctx}`] = group.reg.c;
      result[`${OV_B_PREFIX}${ctx}`] = group.reg.b;
    }
  }

  return result;
}

export function isValidReadStateDTag(
  value: string | undefined,
): value is string {
  if (!value?.startsWith(READ_STATE_D_TAG_PREFIX)) return false;
  const slotId = value.slice(READ_STATE_D_TAG_PREFIX.length);
  return slotId.length > 0 && slotId.length <= 64 && isAscii(slotId);
}

export function localExtraSlotIdsKey(pubkey: string): string {
  return `buzz.nip-rs.extra-slot-ids:${pubkey}`;
}

export function localIsoToUnixSeconds(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1_000);
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}
