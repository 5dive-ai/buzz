/**
 * Pending override intent store for the NIP-RS optimistic mark-unread layer.
 *
 * When the full-state load is incomplete at click time, override actions cannot
 * immediately mutate the register.  Instead the user's intent is recorded here
 * as a pending entry keyed by channelId.  A drain on the next complete-load
 * transition replays each intent through the normal action rules and surfaces
 * the definitive applied/refused result.
 *
 * Design notes
 * ─────────────
 * • **In-memory only** (consolidation ruling):
 *   This store holds in-memory state only.  Persistence is exclusively through
 *   the `buzz.nip-rs.override-state.v2:<pubkey>` blob written by
 *   `writeStoredReadState()` in readStateStorage.ts.  The manager's
 *   `persistLocalState()` is the single commit point for both the intent queue
 *   and the register+receipt.  The former `buzz.nip-rs.pending-intents.v1`
 *   key is never written and is not read after migration.
 *
 * • **Per-channel, last-intent-wins** (plan ruling 3):
 *   A re-mark while a drain is in flight replaces the queue entry and advances
 *   the generation counter.  The drain's re-check detects the generation change
 *   and commits zero local effects for the stale intent.
 *
 * • **Applied receipt** (plan Amendment C):
 *   The receipt `{intentGen, op}` lives inside the v2 blob alongside the
 *   mutated register so register mutation and receipt are never observable
 *   separately.  This store only holds the in-memory intent queue.
 *
 * • **Identity swap** (plan phase 1):
 *   `restoreFromStorage` replaces the in-memory map with the stored data.
 *   Old pubkey data is NOT wiped from the v2 blob — the manager owns that.
 */

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
 * `readTarget`  — for `read` intents, the frontier value captured at click
 *                 time.  Drain advances the frontier to this value before the
 *                 C-bump so that an incomplete-load read later applies at the
 *                 correct logical position.
 */
export type PendingIntent = {
  gen: number;
  op: PendingIntentOp;
  sourceScope?: string;
  readTarget?: number;
};

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Pending intent store — one instance per session, pure in-memory.
 *
 * All mutations are synchronous and serialised through this object.  The store
 * owner is the single authority for generation ordering (plan ruling 3:
 * enqueue-during-drain serialises through the store owner).
 *
 * Persistence is exclusively through the manager's `persistLocalState()` which
 * serialises the in-memory map into the v2 blob's `pendingIntents` sub-object.
 */
export class PendingOverrideIntentStore {
  private _nextGen = 1;
  private intents = new Map<string, PendingIntent>();

  /**
   * Restore in-memory state from deserialized storage (called by manager
   * during `hydrateFromLocalStorage`).  Replaces any in-memory state.
   */
  restoreFromStorage(
    intents: ReadonlyMap<string, PendingIntent>,
    nextGen: number,
  ): void {
    this.intents = new Map(intents);
    this._nextGen = nextGen;
  }

  /**
   * Enqueue a new intent for `channelId`, replacing any existing one.
   *
   * Returns the enqueued intent (including the assigned generation).
   * The generation is monotonically increasing per-channel-session, making
   * every intent distinguishable from predecessors.
   *
   * Does NOT persist — the caller (drain or manager) calls persistLocalState().
   */
  enqueue(
    channelId: string,
    op: PendingIntentOp,
    sourceScope?: string,
    readTarget?: number,
  ): PendingIntent {
    const gen = this._nextGen++;
    const intent: PendingIntent = {
      gen,
      op,
      ...(sourceScope !== undefined ? { sourceScope } : {}),
      ...(readTarget !== undefined ? { readTarget } : {}),
    };
    this.intents.set(channelId, intent);
    return intent;
  }

  /**
   * Get the current intent for `channelId`, or undefined if none exists.
   */
  get(channelId: string): PendingIntent | undefined {
    return this.intents.get(channelId);
  }

  /**
   * Return all current channel IDs that have a pending intent.
   * Used by the drain to iterate over all pending work.
   */
  channelIds(): IterableIterator<string> {
    return this.intents.keys();
  }

  /**
   * Compare-and-delete: atomically verify that the current intent's generation
   * still matches `capturedGen`, then delete the intent.
   *
   * Returns true when the deletion was performed; false when the generation
   * no longer matches (a newer intent replaced this one).
   *
   * Does NOT persist — caller calls persistLocalState() afterward.
   */
  compareAndDelete(channelId: string, capturedGen: number): boolean {
    const current = this.intents.get(channelId);
    if (!current || current.gen !== capturedGen) return false;
    this.intents.delete(channelId);
    return true;
  }

  /** Current nextGen value — used by readStateStorage serialization. */
  get nextGen(): number {
    return this._nextGen;
  }

  /** Current intents map — used by readStateStorage serialization. */
  get all(): ReadonlyMap<string, PendingIntent> {
    return this.intents;
  }

  /** Number of pending intents.  Used by tests and diagnostics. */
  get size(): number {
    return this.intents.size;
  }
}

/** Singleton store — one per renderer process, shared across all manager instances. */
export const pendingOverrideIntentStore = new PendingOverrideIntentStore();
