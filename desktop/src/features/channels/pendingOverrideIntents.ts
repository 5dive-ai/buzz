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
 *
 * • **Non-reentrant drain transaction** (round-4 ruling):
 *   While the drain is processing channel X (beginTransaction → commitTransaction),
 *   any `enqueue()` for X is buffered rather than applied immediately.  On
 *   `commitTransaction` the buffer is flushed as the new queue entry.  This
 *   prevents a generation change from occurring inside the drain's transaction
 *   window (between the gen check and the cleanup commit), making the Amendment A
 *   fence hold structurally rather than by post-callback compensation.
 */

import type { ForcedUnreadEntry } from "@/features/channels/forcedUnreadStore";

// ── Types ─────────────────────────────────────────────────────────────────────

/** The operation the user intended. */
export type PendingIntentOp = "unread" | "read";

/**
 * One pending intent for a channel.
 *
 * `gen`               — monotonically increasing per-channel generation counter.
 *                       Incremented each time a new intent replaces the previous one.
 * `op`                — the user's intended action.
 * `sourceScope`       — for `read` intents, the exact source (or undefined = all
 *                       sources) whose removal scope was captured at click time.
 *                       Used by the drain to apply source cleanup idempotently.
 * `readTarget`        — for `read` intents, the frontier value captured at click
 *                       time.  Drain advances the frontier to this value before the
 *                       C-bump so that an incomplete-load read later applies at the
 *                       correct logical position.
 * `priorForcedEntry`  — for `unread` intents, the exact forced-unread entry that
 *                       existed before the optimistic write.  Persisted in the v2
 *                       blob so a post-restart refusal can restore byte-for-byte
 *                       rather than deleting the whole multi-source entry.
 *                       `undefined` means no prior entry existed.
 */
export type PendingIntent = {
  gen: number;
  op: PendingIntentOp;
  sourceScope?: string;
  readTarget?: number;
  priorForcedEntry?: ForcedUnreadEntry;
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
 *
 * ### Drain transaction latch
 * The drain calls `beginTransaction(channelId)` before processing a channel and
 * `commitTransaction(channelId)` after the cleanup commit (or abort).  While a
 * transaction is open, `enqueue()` for that channel buffers the intent instead
 * of applying it immediately.  `commitTransaction` flushes the buffer as the
 * new queue entry, so it becomes visible for the *next* drain pass.
 *
 * This ensures no generation change can occur between the gen check and the
 * cleanup commit — the Amendment A fence holds structurally.
 */
export class PendingOverrideIntentStore {
  private _nextGen = 1;
  private intents = new Map<string, PendingIntent>();
  /** Channels currently inside a drain transaction. */
  private lockedChannels = new Set<string>();
  /** Buffered enqueues for locked channels (last-write-wins, same as live enqueue). */
  private deferredEnqueues = new Map<
    string,
    {
      op: PendingIntentOp;
      sourceScope?: string;
      readTarget?: number;
      priorForcedEntry?: ForcedUnreadEntry;
    }
  >();

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
   * **If `channelId` is currently inside a drain transaction** (between
   * `beginTransaction` and `commitTransaction`), the intent is buffered and
   * will be applied as the queue entry when `commitTransaction` is called.
   * The method still returns a synthetic intent object reflecting the buffered
   * parameters; callers that just check `status: "queued"` need not change.
   *
   * Does NOT persist — the caller (drain or manager) calls persistLocalState().
   */
  enqueue(
    channelId: string,
    op: PendingIntentOp,
    sourceScope?: string,
    readTarget?: number,
    priorForcedEntry?: ForcedUnreadEntry,
  ): PendingIntent {
    if (this.lockedChannels.has(channelId)) {
      // Channel is in a drain transaction — buffer the enqueue.
      this.deferredEnqueues.set(channelId, {
        op,
        ...(sourceScope !== undefined ? { sourceScope } : {}),
        ...(readTarget !== undefined ? { readTarget } : {}),
        ...(priorForcedEntry !== undefined ? { priorForcedEntry } : {}),
      });
      // Return a synthetic placeholder — gen will be assigned on commitTransaction.
      // Callers checking status="queued" are unaffected; they do not inspect gen.
      return {
        gen: -1, // placeholder; replaced on flush
        op,
        ...(sourceScope !== undefined ? { sourceScope } : {}),
        ...(readTarget !== undefined ? { readTarget } : {}),
        ...(priorForcedEntry !== undefined ? { priorForcedEntry } : {}),
      };
    }
    const gen = this._nextGen++;
    const intent: PendingIntent = {
      gen,
      op,
      ...(sourceScope !== undefined ? { sourceScope } : {}),
      ...(readTarget !== undefined ? { readTarget } : {}),
      ...(priorForcedEntry !== undefined ? { priorForcedEntry } : {}),
    };
    this.intents.set(channelId, intent);
    return intent;
  }

  /**
   * Open a drain transaction for `channelId`.
   * While open, `enqueue()` for this channel buffers rather than applying.
   * Must be paired with exactly one `commitTransaction(channelId)` call.
   */
  beginTransaction(channelId: string): void {
    this.lockedChannels.add(channelId);
  }

  /**
   * Promote a buffered (deferred) enqueue into the live queue for `channelId`.
   *
   * Called INSIDE the drain transaction — BEFORE the step-3 cleanup
   * `persistLocalState()` — so the promoted gen2 `pi`/`ng` is written to the
   * durable blob in the same commit as gen1's cleanup.  The transaction latch
   * remains held after this call; `commitTransaction` then simply unlocks.
   *
   * Returns `true` if a deferred enqueue was promoted (caller must persist and
   * schedule a fresh drain pass); `false` if no enqueue was pending.
   *
   * Must only be called while a transaction is open for `channelId`.
   */
  promoteDeferred(channelId: string): boolean {
    const deferred = this.deferredEnqueues.get(channelId);
    if (deferred === undefined) return false;
    this.deferredEnqueues.delete(channelId);
    const gen = this._nextGen++;
    const intent: PendingIntent = {
      gen,
      op: deferred.op,
      ...(deferred.sourceScope !== undefined
        ? { sourceScope: deferred.sourceScope }
        : {}),
      ...(deferred.readTarget !== undefined
        ? { readTarget: deferred.readTarget }
        : {}),
      ...(deferred.priorForcedEntry !== undefined
        ? { priorForcedEntry: deferred.priorForcedEntry }
        : {}),
    };
    this.intents.set(channelId, intent);
    return true;
  }

  /**
   * Close a drain transaction for `channelId`.
   *
   * If `promoteDeferred` was already called, the deferred map is clear and this
   * call simply releases the lock — no-op flush.  If `promoteDeferred` was NOT
   * called (e.g. the storage-failure `continue` path skipped the normal cleanup
   * flow), any remaining buffered enqueue is promoted here so it is not silently
   * discarded; it will drain in the next pass from in-memory state.
   *
   * Safe to call even if no transaction was open (idempotent unlock).
   */
  commitTransaction(channelId: string): void {
    this.lockedChannels.delete(channelId);
    // Fallback flush: promote any enqueue that was not already promoted by
    // promoteDeferred() (e.g. storage-failure continue path).
    const deferred = this.deferredEnqueues.get(channelId);
    if (deferred === undefined) return;
    this.deferredEnqueues.delete(channelId);
    const gen = this._nextGen++;
    const intent: PendingIntent = {
      gen,
      op: deferred.op,
      ...(deferred.sourceScope !== undefined
        ? { sourceScope: deferred.sourceScope }
        : {}),
      ...(deferred.readTarget !== undefined
        ? { readTarget: deferred.readTarget }
        : {}),
      ...(deferred.priorForcedEntry !== undefined
        ? { priorForcedEntry: deferred.priorForcedEntry }
        : {}),
    };
    this.intents.set(channelId, intent);
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
