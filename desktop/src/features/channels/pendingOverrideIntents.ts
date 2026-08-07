/**
 * Pending override intent store for the NIP-RS optimistic mark-unread layer.
 *
 * When the full-state load is incomplete at click time, override actions cannot
 * immediately mutate the register.  Instead the user's intent is recorded here
 * as a pending entry keyed by (pubkey, channelId).  A drain on the next
 * complete-load transition replays each intent through the normal action rules
 * and surfaces the definitive applied/refused result.
 *
 * Design notes
 * ─────────────
 * • **Separate store, deterministic write ordering** (plan ruling 2):
 *   `forcedUnreadStore` entries (the optimistic local badge) are written
 *   BEFORE the intent.  A crash between the two leaves bold with no queued
 *   bump — pre-#3966 per-device behaviour, always safe.
 *
 * • **Per-channel, last-intent-wins** (plan ruling 3):
 *   A re-mark while a drain is in flight replaces the queue entry and advances
 *   the generation counter.  The drain's re-check detects the generation change
 *   and commits zero local effects for the stale intent.
 *
 * • **Applied receipt** (plan Amendment C):
 *   The receipt `{intentGen, op}` is NOT stored here — it lives inside the
 *   `buzz.nip-rs.override-state.v2:<pubkey>` blob alongside the mutated
 *   register (`readStateStorage.ts`) so register mutation and receipt are
 *   never observable separately.  This store only holds the intent queue and
 *   exposes the generation counter.
 *
 * • **Storage failure** (plan ruling 2):
 *   If the localStorage write fails, the intent is kept in-memory and
 *   classified `storage_failed` internally.  Optimistic presentation and
 *   same-session drain still work; a crash before drain degrades to
 *   per-device behaviour.
 *
 * • **Identity swap** (plan phase 1):
 *   `loadForPubkey` replaces the in-memory map with the new pubkey's persisted
 *   data.  Old pubkey data is NOT wiped from localStorage.
 */

import { isPlainRecord } from "@/features/channels/readState/readStateFormat";

// ── Types ─────────────────────────────────────────────────────────────────────

/** The operation the user intended. */
export type PendingIntentOp = "unread" | "read";

/**
 * One pending intent for a channel.
 *
 * `gen`         — monotonically increasing per-channel generation counter.
 *                 Incremented each time a new intent replaces the previous one.
 * `op`          — the user's intended action.
 * `sourceScope` — for `read` intents, the exact source (or undefined = all
 *                 sources) whose removal scope was captured at click time.
 *                 Used by the drain to apply source cleanup idempotently.
 */
export type PendingIntent = {
  gen: number;
  op: PendingIntentOp;
  sourceScope?: string;
};

/** In-memory + persisted state for one pubkey. */
type PendingIntentRecord = {
  /** Next generation to assign when a new intent is enqueued. */
  nextGen: number;
  /** Per-channel intent. At most one intent per channel at any time. */
  intents: Map<string, PendingIntent>;
  /** True when the last localStorage write failed. */
  storageFailed: boolean;
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const STORAGE_PREFIX = "buzz.nip-rs.pending-intents.v1";
const storageKey = (pubkey: string) => `${STORAGE_PREFIX}:${pubkey}`;

// ── Serialisation ─────────────────────────────────────────────────────────────

type PersistedIntentEntry = {
  gen: number;
  op: PendingIntentOp;
  sourceScope?: string;
};

type PersistedRecord = {
  nextGen: number;
  intents: Record<string, PersistedIntentEntry>;
};

function serialise(record: PendingIntentRecord): string {
  const intents: Record<string, PersistedIntentEntry> = {};
  for (const [channelId, intent] of record.intents) {
    const entry: PersistedIntentEntry = { gen: intent.gen, op: intent.op };
    if (intent.sourceScope !== undefined)
      entry.sourceScope = intent.sourceScope;
    intents[channelId] = entry;
  }
  return JSON.stringify({ nextGen: record.nextGen, intents });
}

function deserialise(pubkey: string): PendingIntentRecord {
  const empty: PendingIntentRecord = {
    nextGen: 1,
    intents: new Map(),
    storageFailed: false,
  };
  try {
    const raw = localStorage.getItem(storageKey(pubkey));
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return empty;
    const { nextGen, intents } = parsed as Partial<PersistedRecord>;
    if (
      typeof nextGen !== "number" ||
      !Number.isInteger(nextGen) ||
      nextGen < 1
    )
      return empty;
    if (!isPlainRecord(intents)) return empty;
    const map = new Map<string, PendingIntent>();
    for (const [channelId, entry] of Object.entries(intents)) {
      if (!isPlainRecord(entry)) continue;
      const { gen, op, sourceScope } = entry as Partial<PersistedIntentEntry>;
      if (typeof gen !== "number" || !Number.isInteger(gen) || gen < 1)
        continue;
      if (op !== "unread" && op !== "read") continue;
      if (sourceScope !== undefined && typeof sourceScope !== "string")
        continue;
      map.set(channelId, {
        gen,
        op,
        ...(sourceScope !== undefined ? { sourceScope } : {}),
      });
    }
    return { nextGen, intents: map, storageFailed: false };
  } catch {
    return empty;
  }
}

function persist(pubkey: string, record: PendingIntentRecord): void {
  try {
    localStorage.setItem(storageKey(pubkey), serialise(record));
    record.storageFailed = false;
  } catch {
    record.storageFailed = true;
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Pending intent store — one instance per session, keyed by pubkey.
 *
 * All mutations are synchronous and serialised through this object.  The store
 * owner is the single authority for generation ordering (plan ruling 3:
 * enqueue-during-drain serialises through the store owner).
 */
export class PendingOverrideIntentStore {
  private pubkey: string | null = null;
  private record: PendingIntentRecord = {
    nextGen: 1,
    intents: new Map(),
    storageFailed: false,
  };

  /**
   * Load or swap to the given pubkey's persisted intents.
   * Called on identity initialisation and identity change.
   */
  loadForPubkey(pubkey: string): void {
    this.pubkey = pubkey;
    this.record = deserialise(pubkey);
  }

  /**
   * Enqueue a new intent for `channelId`, replacing any existing one.
   *
   * Returns the enqueued intent (including the assigned generation).
   * The generation is monotonically increasing per-channel (and
   * per-pubkey-session), making every intent distinguishable from predecessors.
   */
  enqueue(
    channelId: string,
    op: PendingIntentOp,
    sourceScope?: string,
  ): PendingIntent {
    const gen = this.record.nextGen++;
    const intent: PendingIntent = {
      gen,
      op,
      ...(sourceScope !== undefined ? { sourceScope } : {}),
    };
    this.record.intents.set(channelId, intent);
    if (this.pubkey) persist(this.pubkey, this.record);
    return intent;
  }

  /**
   * Get the current intent for `channelId`, or undefined if none exists.
   * Called from the drain capture step and from hydration.
   */
  get(channelId: string): PendingIntent | undefined {
    return this.record.intents.get(channelId);
  }

  /**
   * Return all current channel IDs that have a pending intent.
   * Used by the drain to iterate over all pending work.
   */
  channelIds(): IterableIterator<string> {
    return this.record.intents.keys();
  }

  /**
   * Compare-and-delete: atomically verify that the current intent's generation
   * still matches `capturedGen`, then delete the intent (and its receipt is
   * deleted by the caller via `readStateStorage` in the same transaction).
   *
   * Returns true when the deletion was performed; false when the generation
   * no longer matches (a newer intent replaced this one).
   *
   * This is the Amendment A + B compare-and-delete seam.  Called after the
   * Amendment C gen re-check confirms the generation is current.
   */
  compareAndDelete(channelId: string, capturedGen: number): boolean {
    const current = this.record.intents.get(channelId);
    if (!current || current.gen !== capturedGen) return false;
    this.record.intents.delete(channelId);
    if (this.pubkey) persist(this.pubkey, this.record);
    return true;
  }

  /**
   * True if the last localStorage write failed.  Same-session drain still
   * works; a crash before drain degrades to per-device behaviour.
   */
  get isStorageFailed(): boolean {
    return this.record.storageFailed;
  }

  /**
   * Number of pending intents.  Used by tests and diagnostics.
   */
  get size(): number {
    return this.record.intents.size;
  }
}

/** Singleton store — one per renderer process, shared across all manager instances. */
export const pendingOverrideIntentStore = new PendingOverrideIntentStore();
