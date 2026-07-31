import { nip44DecryptFromSelf } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import {
  isValidBlob,
  isValidReadStateDTag,
  mergeOverrideRegisters,
  parseContexts,
  sanitizeContexts,
  type OverrideRegister,
  type ParsedContexts,
  type ReadStateBlob,
} from "@/features/channels/readState/readStateFormat";

export type ReadStateDecrypt = (ciphertext: string) => Promise<string>;

export type ParsedReadStateEvent = {
  dTag: string;
  blob: ReadStateBlob;
  /** Structured decode: frontiers keyed by raw ctx ID, overrides by raw ctx ID. */
  contexts: ParsedContexts;
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
    const sanitized = sanitizeContexts(parsed.contexts);
    return {
      dTag,
      blob: {
        v: 1,
        client_id: parsed.client_id,
        contexts: sanitized,
      },
      contexts: parseContexts(parsed.contexts),
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
 * Merge override registers from multiple register maps.
 *
 * Applies componentwise `max()` across all sources for each context suffix,
 * returning a single Map from raw context ID to merged `OverrideRegister`.
 * Slices 2–3 call this after collecting `ParsedReadStateEvent.contexts.overrides`
 * maps from each parsed event.
 */
export function mergeOverrideRegisterMaps(
  ...maps: Array<ReadonlyMap<string, OverrideRegister>>
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
  const frontiers = new Map<string, number>();

  for (const event of events) {
    const parsed = await parseReadStateEvent(event, pubkey, decrypt);
    if (!parsed) continue;

    // Use the structured frontiers (keyed by raw ctx ID, unescaped) rather
    // than the flat blob.contexts, which retains wire keys for readStateManager.
    for (const [rawCtx, ts] of parsed.contexts.frontiers) {
      const current = frontiers.get(rawCtx) ?? 0;
      if (ts > current) {
        frontiers.set(rawCtx, ts);
      }
    }
  }

  return frontiers;
}

export function getSnapshotReadTimestamp(
  contexts: ReadonlyMap<string, number>,
  contextId: string,
): number | null {
  return contexts.get(contextId) ?? null;
}
