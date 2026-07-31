import { nip44DecryptFromSelf } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import {
  isValidBlob,
  isValidReadStateDTag,
  mergeOverrideRegisters,
  OV_B_PREFIX,
  OV_C_PREFIX,
  OV_S_PREFIX,
  sanitizeContexts,
  type OverrideRegister,
  type ReadStateBlob,
} from "@/features/channels/readState/readStateFormat";

export type ReadStateDecrypt = (ciphertext: string) => Promise<string>;

export type ParsedReadStateEvent = {
  dTag: string;
  blob: ReadStateBlob;
  createdAt: number;
};

export async function parseReadStateEvent(
  event: RelayEvent,
  pubkey: string,
  decrypt: ReadStateDecrypt = nip44DecryptFromSelf,
): Promise<ParsedReadStateEvent | null> {
  if (event.pubkey !== pubkey) return null;

  const dTags = event.tags.filter((tag) => tag[0] === "d");
  if (dTags.length !== 1) return null;
  const dTag = dTags[0]?.[1];
  if (!isValidReadStateDTag(dTag)) return null;

  const tTags = event.tags.filter(
    (tag) => tag[0] === "t" && tag[1] === "read-state",
  );
  if (tTags.length !== 1) return null;

  try {
    const plaintext = await decrypt(event.content);
    const parsed = JSON.parse(plaintext);
    if (!isValidBlob(parsed)) return null;
    return {
      dTag,
      blob: {
        v: 1,
        client_id: parsed.client_id,
        contexts: sanitizeContexts(parsed.contexts),
      },
      createdAt: event.created_at,
    };
  } catch (error) {
    console.debug(
      `[ReadStateSnapshot] decrypt/parse failed event=${event.id.substring(0, 8)}…:`,
      error,
    );
    return null;
  }
}

/**
 * Extract all override registers from a sanitized contexts map.
 *
 * Returns a Map from raw context ID to `OverrideRegister`.  A tombstone floor
 * (`ov_c:` only) is returned as `{ s: 0, c: <floor>, b: 0 }` — the same
 * shape as a dead register, which is correct: the floor's sole purpose is to
 * block counter reuse, and the liveness predicate evaluates to false for it.
 *
 * This is the read-side counterpart of `encodeOverrideGroup`: it reconstructs
 * the register from the flat integer map that `sanitizeContexts` produced.
 * The input MUST already have been through `sanitizeContexts` (so partial
 * groups are absent — they were rejected at validation time).
 */
export function extractOverrideRegisters(
  contexts: ReadonlyMap<string, number> | Record<string, number>,
): Map<string, OverrideRegister> {
  // Collect s/c/b values per context suffix.
  const sVals = new Map<string, number>();
  const cVals = new Map<string, number>();
  const bVals = new Map<string, number>();

  const iterate =
    contexts instanceof Map
      ? [...contexts.entries()]
      : Object.entries(contexts);

  for (const [key, value] of iterate) {
    if (key.startsWith(OV_S_PREFIX))
      sVals.set(key.slice(OV_S_PREFIX.length), value);
    else if (key.startsWith(OV_C_PREFIX))
      cVals.set(key.slice(OV_C_PREFIX.length), value);
    else if (key.startsWith(OV_B_PREFIX))
      bVals.set(key.slice(OV_B_PREFIX.length), value);
  }

  const result = new Map<string, OverrideRegister>();
  const ctxSet = new Set([...sVals.keys(), ...cVals.keys(), ...bVals.keys()]);
  for (const ctx of ctxSet) {
    result.set(ctx, {
      s: sVals.get(ctx) ?? 0,
      c: cVals.get(ctx) ?? 0,
      b: bVals.get(ctx) ?? 0,
    });
  }
  return result;
}

/**
 * Merge override registers from multiple sanitized contexts maps.
 *
 * Applies componentwise `max()` across all sources for each context suffix,
 * returning a single Map from raw context ID to merged `OverrideRegister`.
 * This is the register-level analogue of the frontier `max()` merge.
 */
export function mergeOverrideRegisterMaps(
  ...maps: Array<Map<string, OverrideRegister>>
): Map<string, OverrideRegister> {
  const result = new Map<string, OverrideRegister>();
  for (const source of maps) {
    for (const [ctx, reg] of source) {
      const existing = result.get(ctx);
      result.set(ctx, existing ? mergeOverrideRegisters(existing, reg) : reg);
    }
  }
  return result;
}

export async function mergeReadStateEvents(
  events: RelayEvent[],
  pubkey: string,
  decrypt?: ReadStateDecrypt,
): Promise<Map<string, number>> {
  const contexts = new Map<string, number>();

  for (const event of events) {
    const parsed = await parseReadStateEvent(event, pubkey, decrypt);
    if (!parsed) continue;

    for (const [contextId, timestamp] of Object.entries(parsed.blob.contexts)) {
      const current = contexts.get(contextId) ?? 0;
      if (timestamp > current) {
        contexts.set(contextId, timestamp);
      }
    }
  }

  return contexts;
}

export function getSnapshotReadTimestamp(
  contexts: ReadonlyMap<string, number>,
  contextId: string,
): number | null {
  return contexts.get(contextId) ?? null;
}
