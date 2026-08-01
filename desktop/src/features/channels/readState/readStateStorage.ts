import {
  isPlainRecord,
  localIsoToUnixSeconds,
  localPublishableContextKey,
  localReadStateKey,
  localSourceCreatedAtKey,
  LOCAL_MAX_PRUNABLE_CONTEXTS,
  MSG_PREFIX,
  READ_STATE_HORIZON_SECONDS,
  THREAD_PREFIX,
  type OverrideRegister,
} from "@/features/channels/readState/readStateFormat";
import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";

export type StoredReadState = {
  contexts: Map<string, number>;
  publishableContextIds: Set<string>;
  contextSourceCreatedAt: Map<string, number>;
  overrideRegisters: Map<string, StoredOverrideEntry>;
};

function mergeLocalStorageKey(
  contexts: Map<string, number>,
  key: string,
): void {
  const raw = localStorage.getItem(key);
  if (!raw) return;

  try {
    const parsed = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return;

    for (const [channelId, value] of Object.entries(parsed)) {
      const unixSeconds = localIsoToUnixSeconds(value);
      if (unixSeconds === null) continue;
      const current = contexts.get(channelId) ?? 0;
      if (unixSeconds > current) {
        contexts.set(channelId, unixSeconds);
      }
    }
  } catch (error) {
    console.debug("[ReadStateManager] storage: contexts JSON corrupt:", error);
    // Corrupt localStorage, ignore.
  }
}

function readPublishableContextIds(pubkey: string): Set<string> {
  const result = new Set<string>();
  const raw = localStorage.getItem(localPublishableContextKey(pubkey));
  if (!raw) return result;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return result;

    for (const value of parsed) {
      if (typeof value === "string") {
        result.add(value);
      }
    }
  } catch (error) {
    console.debug(
      "[ReadStateManager] storage: publishableContextIds JSON corrupt:",
      error,
    );
    // Corrupt localStorage, ignore.
  }

  return result;
}

function readContextSourceCreatedAt(pubkey: string): Map<string, number> {
  const result = new Map<string, number>();
  const raw = localStorage.getItem(localSourceCreatedAtKey(pubkey));
  if (!raw) return result;

  try {
    const parsed = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return result;

    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        result.set(key, value);
      }
    }
  } catch (error) {
    console.debug(
      "[ReadStateManager] storage: sourceCreatedAt JSON corrupt:",
      error,
    );
    // Corrupt localStorage, ignore.
  }

  return result;
}

export function readStoredReadState(pubkey: string): StoredReadState {
  const contexts = new Map<string, number>();
  mergeLocalStorageKey(contexts, localReadStateKey(pubkey));

  return {
    contexts,
    publishableContextIds: readPublishableContextIds(pubkey),
    contextSourceCreatedAt: readContextSourceCreatedAt(pubkey),
    overrideRegisters: readOverrideState(pubkey),
  };
}

function isPrunableContextKey(contextId: string): boolean {
  return (
    contextId.startsWith(MSG_PREFIX) || contextId.startsWith(THREAD_PREFIX)
  );
}

// Key for persisted override state: registers + their frontier timestamps in one atomic write.
// v2 stores {s, c, b, f} per context where f = the last known effective frontier.
function localOverrideStateKey(pubkey: string): string {
  return `buzz.nip-rs.override-state.v2:${pubkey}`;
}

// Legacy key retained for migration reads only — never written to after v2 migration.
function localOverrideRegistersKeyLegacy(pubkey: string): string {
  return `buzz.nip-rs.override-registers.v1:${pubkey}`;
}

export type StoredOverrideEntry = OverrideRegister & { f: number };

function readOverrideState(pubkey: string): Map<string, StoredOverrideEntry> {
  const result = new Map<string, StoredOverrideEntry>();
  const raw = localStorage.getItem(localOverrideStateKey(pubkey));
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (isPlainRecord(parsed)) {
        for (const [rawCtx, value] of Object.entries(parsed)) {
          if (!isPlainRecord(value)) continue;
          const { s, c, b, f } = value;
          if (
            typeof s === "number" &&
            Number.isInteger(s) &&
            s >= 0 &&
            s <= 0xffffffff &&
            typeof c === "number" &&
            Number.isInteger(c) &&
            c >= 0 &&
            c <= 0xffffffff &&
            typeof b === "number" &&
            Number.isInteger(b) &&
            b >= 0 &&
            typeof f === "number" &&
            Number.isInteger(f) &&
            f >= 0
          ) {
            result.set(rawCtx, { s, c, b, f });
          }
        }
      }
    } catch {
      // Corrupt storage — return empty; repopulated on next ingest.
    }
    return result;
  }
  // Migration: read from legacy v1 key if v2 key absent.
  const legacyRaw = localStorage.getItem(
    localOverrideRegistersKeyLegacy(pubkey),
  );
  if (!legacyRaw) return result;
  try {
    const parsed = JSON.parse(legacyRaw);
    if (!isPlainRecord(parsed)) return result;
    for (const [rawCtx, value] of Object.entries(parsed)) {
      if (!isPlainRecord(value)) continue;
      const { s, c, b } = value;
      if (
        typeof s === "number" &&
        Number.isInteger(s) &&
        s >= 0 &&
        s <= 0xffffffff &&
        typeof c === "number" &&
        Number.isInteger(c) &&
        c >= 0 &&
        c <= 0xffffffff &&
        typeof b === "number" &&
        Number.isInteger(b) &&
        b >= 0
      ) {
        result.set(rawCtx, { s, c, b, f: 0 }); // frontier unknown from legacy key
      }
    }
  } catch {
    // Corrupt legacy storage — ignore.
  }
  return result;
}

/**
 * Drops msg:/thread: markers older than the relay's 7-day horizon, then caps
 * the survivors at LOCAL_MAX_PRUNABLE_CONTEXTS (oldest first). Channel keys
 * are never pruned — they are small, bounded by membership, and losing one
 * would resurrect the channel's unread badge. Mirrors the eviction order the
 * publish path already applies in trimContextsToBudget.
 */
export function pruneStaleContexts(
  contexts: ReadonlyMap<string, number>,
  nowUnixSeconds: number,
): Map<string, number> {
  const cutoff = nowUnixSeconds - READ_STATE_HORIZON_SECONDS;
  const kept = new Map<string, number>();
  const prunable: [string, number][] = [];

  for (const [contextId, timestamp] of contexts) {
    if (!isPrunableContextKey(contextId)) {
      kept.set(contextId, timestamp);
    } else if (timestamp >= cutoff) {
      prunable.push([contextId, timestamp]);
    }
  }

  if (prunable.length > LOCAL_MAX_PRUNABLE_CONTEXTS) {
    prunable.sort((a, b) => b[1] - a[1]);
    prunable.length = LOCAL_MAX_PRUNABLE_CONTEXTS;
  }
  for (const [contextId, timestamp] of prunable) {
    kept.set(contextId, timestamp);
  }
  return kept;
}

export function writeStoredReadState(
  pubkey: string,
  contexts: ReadonlyMap<string, number>,
  publishableContextIds: ReadonlySet<string>,
  contextSourceCreatedAt: ReadonlyMap<string, number>,
  overrideRegisters: ReadonlyMap<string, StoredOverrideEntry>,
): boolean {
  const pruned = pruneStaleContexts(contexts, Math.floor(Date.now() / 1_000));

  const state: Record<string, string> = {};
  for (const [contextId, timestamp] of pruned) {
    state[contextId] = new Date(timestamp * 1_000).toISOString();
  }

  const ok1 = setLocalStorageItemWithRecovery(
    localReadStateKey(pubkey),
    JSON.stringify(state),
  );
  const ok2 = setLocalStorageItemWithRecovery(
    localPublishableContextKey(pubkey),
    JSON.stringify([...publishableContextIds].filter((id) => pruned.has(id))),
  );

  const sourceState: Record<string, number> = {};
  for (const [contextId, createdAt] of contextSourceCreatedAt) {
    if (pruned.has(contextId)) {
      sourceState[contextId] = createdAt;
    }
  }
  const ok3 = setLocalStorageItemWithRecovery(
    localSourceCreatedAtKey(pubkey),
    JSON.stringify(sourceState),
  );

  // Persist override registers atomically with their frontier timestamps (v2).
  // Registers and frontiers in one JSON blob — a single write ensures they are
  // never torn: a register cannot be present without its associated frontier.
  const overrideState: Record<
    string,
    { s: number; c: number; b: number; f: number }
  > = {};
  for (const [rawCtx, entry] of overrideRegisters) {
    overrideState[rawCtx] = { s: entry.s, c: entry.c, b: entry.b, f: entry.f };
  }
  const ok4 = setLocalStorageItemWithRecovery(
    localOverrideStateKey(pubkey),
    JSON.stringify(overrideState),
  );

  return ok1 && ok2 && ok3 && ok4;
}
