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
  overrideRegisters: Map<string, OverrideRegister>;
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
    overrideRegisters: readOverrideRegisters(pubkey),
  };
}

function isPrunableContextKey(contextId: string): boolean {
  return (
    contextId.startsWith(MSG_PREFIX) || contextId.startsWith(THREAD_PREFIX)
  );
}

// Key for persisted override registers (raw context ID → OverrideRegister triple).
function localOverrideRegistersKey(pubkey: string): string {
  return `buzz.nip-rs.override-registers.v1:${pubkey}`;
}

function readOverrideRegisters(pubkey: string): Map<string, OverrideRegister> {
  const result = new Map<string, OverrideRegister>();
  const raw = localStorage.getItem(localOverrideRegistersKey(pubkey));
  if (!raw) return result;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return result;
    for (const [rawCtx, value] of Object.entries(parsed)) {
      if (!isPlainRecord(value)) continue;
      const s = value.s;
      const c = value.c;
      const b = value.b;
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
        result.set(rawCtx, { s, c, b });
      }
    }
  } catch {
    // Corrupt storage — return empty map; will be repopulated on next ingest.
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
  overrideRegisters: ReadonlyMap<string, OverrideRegister>,
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

  // Persist override registers atomically with frontier state.
  const regState: Record<string, { s: number; c: number; b: number }> = {};
  for (const [rawCtx, reg] of overrideRegisters) {
    regState[rawCtx] = { s: reg.s, c: reg.c, b: reg.b };
  }
  const ok4 = setLocalStorageItemWithRecovery(
    localOverrideRegistersKey(pubkey),
    JSON.stringify(regState),
  );

  return ok1 && ok2 && ok3 && ok4;
}
