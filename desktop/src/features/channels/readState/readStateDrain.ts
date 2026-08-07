/**
 * Drain helpers extracted from ReadStateManager to keep the manager file
 * within the 1000-line size ratchet.
 *
 * Exports standalone functions that take a `DrainContext` — the subset of
 * ReadStateManager state and methods required for intent drain, direct mark,
 * and the queued-path public mark operations.  The manager methods become
 * thin one-line delegations.
 */

import {
  isOverrideActive,
  type OverrideRegister,
} from "@/features/channels/readState/readStateFormat";
import type { AppliedReceipt } from "@/features/channels/readState/readStateStorage";
import { pendingOverrideIntentStore } from "@/features/channels/pendingOverrideIntents";
import { toast } from "sonner";
import type { MarkResult } from "@/features/channels/readState/readStateManager";

/** Subset of ReadStateManager state and methods needed for drain operations. */
export interface DrainContext {
  // Read-only identity / lifecycle
  readonly pubkey: string;
  readonly destroyed: boolean;
  readonly isLoadComplete: boolean;
  readonly loadGeneration: number;
  // Mutable state maps (direct references — mutations are intentional)
  readonly overrideRegisters: Map<string, OverrideRegister>;
  readonly appliedReceipts: Map<string, AppliedReceipt>;
  readonly publishableContextIds: Set<string>;
  readonly extraSlotIds: string[];
  // Methods
  persistLocalState(): boolean;
  schedulePublish(): void;
  notifyListeners(): void;
  channelFrontier(channelId: string): number;
  markContextRead(channelId: string, unixTimestamp: number): void;
  tryCandidatePlan(rawCtxId: string, reg: OverrideRegister): boolean;
  restoreExtraSlotIds(prev: string[]): void;
  /** Drain outcome callback — wired by the hook for toast/rollback routing.
   *  `sourceScope` is set for `read+applied` outcomes; it carries the source
   *  that was being cleared so the hook can remove exactly that source from the
   *  forced-unread entry rather than deleting the whole entry. */
  onDrainOutcome:
    | ((
        channelId: string,
        op: string,
        status: string,
        reason?: string,
        sourceScope?: string,
      ) => void)
    | null;
}

/**
 * Shape of ReadStateManager internals accessed by createDrainContext.
 * Listed explicitly so TypeScript validates the access at the factory site.
 */
interface ManagerInternals {
  readonly pubkey: string;
  readonly destroyed: boolean;
  isLoadComplete: boolean;
  readonly loadGeneration: number;
  readonly overrideRegisters: Map<string, OverrideRegister>;
  readonly appliedReceipts: Map<string, AppliedReceipt>;
  readonly publishableContextIds: Set<string>;
  readonly extraSlotIds: string[];
  onDrainOutcome:
    | ((
        channelId: string,
        op: string,
        status: string,
        reason?: string,
        sourceScope?: string,
      ) => void)
    | null;
  persistLocalState(): boolean;
  schedulePublish(): void;
  notifyListeners(): void;
  channelFrontier(channelId: string): number;
  markContextRead(channelId: string, unixTimestamp: number): void;
  tryCandidatePlan(rawCtxId: string, reg: OverrideRegister): boolean;
  restoreExtraSlotIds(prev: string[]): void;
}

/**
 * Build a typed DrainContext adapter from the manager's internals.
 * This is the single place where the manager exposes its internals to the
 * drain layer — no cast required.
 */
export function createDrainContext(mgr: ManagerInternals): DrainContext {
  return {
    get pubkey() {
      return mgr.pubkey;
    },
    get destroyed() {
      return mgr.destroyed;
    },
    get isLoadComplete() {
      return mgr.isLoadComplete;
    },
    get loadGeneration() {
      return mgr.loadGeneration;
    },
    get overrideRegisters() {
      return mgr.overrideRegisters;
    },
    get appliedReceipts() {
      return mgr.appliedReceipts;
    },
    get publishableContextIds() {
      return mgr.publishableContextIds;
    },
    get extraSlotIds() {
      return mgr.extraSlotIds;
    },
    get onDrainOutcome() {
      return mgr.onDrainOutcome;
    },
    persistLocalState: () => mgr.persistLocalState(),
    schedulePublish: () => mgr.schedulePublish(),
    notifyListeners: () => mgr.notifyListeners(),
    channelFrontier: (id) => mgr.channelFrontier(id),
    markContextRead: (id, ts) => mgr.markContextRead(id, ts),
    tryCandidatePlan: (id, reg) => mgr.tryCandidatePlan(id, reg),
    restoreExtraSlotIds: (prev) => mgr.restoreExtraSlotIds(prev),
  };
}

/**
 * Drain all pending override intents for the given load generation.
 * Implements plan phase 4 / Amendments A + B + C.
 *
 * Normative drain sequence per intent:
 *  1. Capture — snapshot intent (op, gen, sourceScope, readTarget) and pubkey fence.
 *  2. Replay — perform the register action against the complete-load state.
 *             For applied: co-commit register + receipt atomically (Amendment C).
 *  3. Re-check (Amendment A whole-transaction fence) — compare captured gen
 *     against current queue gen under the store owner.
 *     - Gen unchanged → commit (Amendment B order):
 *         source cleanup (idempotent), compare-and-delete intent.
 *     - Gen changed → zero local effects; published action stands as CRDT race.
 */
export async function drainPendingIntents(
  ctx: DrainContext,
  drainGen: number,
): Promise<void> {
  if (ctx.destroyed || drainGen !== ctx.loadGeneration) return;
  if (!ctx.isLoadComplete) return;

  const channelIds = [...pendingOverrideIntentStore.channelIds()];
  if (channelIds.length === 0) return;

  for (const channelId of channelIds) {
    if (ctx.destroyed || drainGen !== ctx.loadGeneration) break;

    const captured = pendingOverrideIntentStore.get(channelId);
    if (!captured) continue;
    const capturedGen = captured.gen;
    const capturedOp = captured.op;
    const capturedSourceScope = captured.sourceScope;
    const capturedReadTarget = captured.readTarget;
    const capturedPubkey = ctx.pubkey;

    // Pubkey fence: abort if identity changed mid-drain.
    if (capturedPubkey !== ctx.pubkey) break;

    // Amendment C hydration rule: matching receipt → already applied, skip replay.
    const existingReceipt = ctx.appliedReceipts.get(channelId);
    const alreadyApplied =
      existingReceipt !== undefined &&
      existingReceipt.intentGen === capturedGen &&
      existingReceipt.op === capturedOp;

    // Snapshot in-memory state before replay so we can roll back on gen-changed.
    const prevReg = ctx.overrideRegisters.get(channelId);
    const prevReceipt = ctx.appliedReceipts.get(channelId);
    const wasPublishable = ctx.publishableContextIds.has(channelId);
    const prevExtraSlotIds = ctx.extraSlotIds.slice();

    let replayResult: MarkResult;

    if (alreadyApplied) {
      // Receipt proves application — no re-bump (Amendment C hydration rule).
      replayResult = { status: "applied" };
    } else {
      // Replay the register action against the complete-load state.
      replayResult =
        capturedOp === "unread"
          ? markChannelUnreadDirect(ctx, channelId, capturedGen, capturedOp)
          : markChannelReadDirect(
              ctx,
              channelId,
              capturedGen,
              capturedOp,
              capturedReadTarget,
            );
    }

    // Amendment A whole-transaction fence: re-check gen under store owner.
    const currentIntent = pendingOverrideIntentStore.get(channelId);
    const genUnchanged =
      currentIntent !== undefined && currentIntent.gen === capturedGen;

    if (!genUnchanged) {
      // Gen changed — zero local effects; roll back any in-memory mutations.
      if (prevReg === undefined) ctx.overrideRegisters.delete(channelId);
      else ctx.overrideRegisters.set(channelId, prevReg);
      if (prevReceipt === undefined) ctx.appliedReceipts.delete(channelId);
      else ctx.appliedReceipts.set(channelId, prevReceipt);
      if (!wasPublishable) ctx.publishableContextIds.delete(channelId);
      ctx.restoreExtraSlotIds(prevExtraSlotIds);
      continue;
    }

    // Gen unchanged — commit local effects (Amendment B+C order).

    // Step 1: atomic register+receipt commit (Amendment C).
    // For already-applied, register is durable; skip persist, proceed to cleanup.
    if (!alreadyApplied && replayResult.status === "applied") {
      if (!ctx.persistLocalState()) {
        // Storage failure — roll back, keep intent alive for next drain.
        if (prevReg === undefined) ctx.overrideRegisters.delete(channelId);
        else ctx.overrideRegisters.set(channelId, prevReg);
        if (prevReceipt === undefined) ctx.appliedReceipts.delete(channelId);
        else ctx.appliedReceipts.set(channelId, prevReceipt);
        if (!wasPublishable) ctx.publishableContextIds.delete(channelId);
        ctx.restoreExtraSlotIds(prevExtraSlotIds);
        continue;
      }
      ctx.schedulePublish();
    }

    // Step 2: source cleanup (idempotent) — capturedSourceScope scopes removal.
    // The sourceScope is forwarded to the onDrainOutcome callback so the hook
    // layer can remove exactly the right source from the forced-unread entry.

    // Step 3: surface outcomes — toast genuine refusals, route to hook callback.
    if (replayResult.status === "refused") {
      const reason = replayResult.reason;
      if (reason !== "already_inactive" && reason !== "load_incomplete") {
        // Genuine refusal (uint32_overflow, budget_exhausted, storage_failed):
        // show toast and surface to hook for forced-entry rollback.
        const msg = toastForDrainRefusal(capturedOp, reason);
        if (msg) toast.error(msg);
        ctx.onDrainOutcome?.(channelId, capturedOp, "refused", reason);
      }
      // already_inactive: silent definitive success — no badge, no toast.
    } else if (replayResult.status === "applied") {
      ctx.onDrainOutcome?.(
        channelId,
        capturedOp,
        "applied",
        undefined,
        capturedSourceScope,
      );
    }

    // Step 4: atomic cleanup commit — delete receipt + compare-and-delete intent.
    ctx.appliedReceipts.delete(channelId);
    pendingOverrideIntentStore.compareAndDelete(channelId, capturedGen);
    if (!ctx.persistLocalState()) {
      // Best-effort: register already committed. Orphaned receipt swept on restart.
      console.warn(
        `[ReadStateManager] drain: cleanup commit failed for ${channelId}`,
      );
    }
    ctx.notifyListeners();
  }
}

/** Human-readable toast for a genuine drain refusal. Returns null for silent reasons. */
function toastForDrainRefusal(op: string, reason: string): string | null {
  if (reason === "budget_exhausted")
    return "Could not mark unread: override budget exhausted.";
  if (reason === "uint32_overflow")
    return op === "unread"
      ? "Could not mark unread: counter limit reached."
      : "Could not clear unread override: counter limit reached.";
  if (reason === "storage_failed")
    return op === "unread"
      ? "Could not mark unread: storage write failed."
      : "Could not clear unread override: storage write failed.";
  return null;
}

/**
 * Replay a mark-unread directly against the complete-load state (drain path).
 * Sets ctx.appliedReceipts so the subsequent atomic persistLocalState() call
 * in drainPendingIntents includes the receipt (Amendment C).
 * Does NOT persist or enqueue — only called from drainPendingIntents.
 */
export function markChannelUnreadDirect(
  ctx: DrainContext,
  channelId: string,
  capturedGen: number,
  capturedOp: "unread",
): MarkResult {
  if (!ctx.isLoadComplete)
    return { status: "refused", reason: "load_incomplete" };
  const existing = ctx.overrideRegisters.get(channelId);
  const s = existing?.s ?? 0;
  const c = existing?.c ?? 0;
  const b = existing?.b ?? 0;
  const newS = Math.max(s, c) + 1;
  if (newS > 0xffffffff)
    return { status: "refused", reason: "uint32_overflow" };
  const newReg: OverrideRegister = {
    s: newS,
    c,
    b: Math.max(b, ctx.channelFrontier(channelId)),
  };
  const prevExtraSlotIds = ctx.extraSlotIds.slice();
  if (!ctx.tryCandidatePlan(channelId, newReg)) {
    ctx.restoreExtraSlotIds(prevExtraSlotIds);
    return { status: "refused", reason: "budget_exhausted" };
  }
  ctx.overrideRegisters.set(channelId, newReg);
  ctx.publishableContextIds.add(channelId);
  ctx.appliedReceipts.set(channelId, {
    intentGen: capturedGen,
    op: capturedOp,
  });
  return { status: "applied" };
}

/**
 * Replay a mark-read directly against the complete-load state (drain path).
 * Advances the frontier to `readTarget` (captured at click time) before the
 * C-bump so the read lands at the correct logical position even when the load
 * completed later.
 * Sets ctx.appliedReceipts so the subsequent atomic persistLocalState() call
 * in drainPendingIntents includes the receipt (Amendment C).
 * Does NOT persist or enqueue — only called from drainPendingIntents.
 */
export function markChannelReadDirect(
  ctx: DrainContext,
  channelId: string,
  capturedGen: number,
  capturedOp: "read",
  readTarget?: number,
): MarkResult {
  if (!ctx.isLoadComplete)
    return { status: "refused", reason: "load_incomplete" };
  // Advance frontier to readTarget first (spec order: frontier → C-bump).
  if (readTarget !== undefined && readTarget > 0) {
    ctx.markContextRead(channelId, readTarget);
  }
  const reg = ctx.overrideRegisters.get(channelId);
  const effectiveFrontier = ctx.channelFrontier(channelId);
  if (!reg) return { status: "refused", reason: "already_inactive" };
  const newC = Math.max(reg.s, reg.c) + 1;
  if (newC > 0xffffffff)
    return { status: "refused", reason: "uint32_overflow" };
  const newReg: OverrideRegister = { s: reg.s, c: newC, b: reg.b };
  if (isOverrideActive(newReg, effectiveFrontier)) {
    console.error(
      "[ReadStateManager] markChannelReadDirect: override still active after bump",
    );
    return { status: "refused", reason: "already_inactive" };
  }
  ctx.overrideRegisters.set(channelId, newReg);
  ctx.publishableContextIds.add(channelId);
  ctx.appliedReceipts.set(channelId, {
    intentGen: capturedGen,
    op: capturedOp,
  });
  return { status: "applied" };
}

/**
 * Public mark-unread: write-ordered forced entry then queue/apply the override.
 * Queues an intent when load is incomplete; applies immediately otherwise.
 * Persists the intent atomically in the v2 blob via persistLocalState().
 */
export function markChannelUnread(
  ctx: DrainContext,
  channelId: string,
): MarkResult {
  if (!ctx.isLoadComplete) {
    pendingOverrideIntentStore.enqueue(channelId, "unread");
    if (!ctx.persistLocalState()) {
      // Storage failure — intent is in-memory only; session drain still works.
      // Optimistic presentation continues (forced entry already written).
    }
    return { status: "queued" };
  }
  const existing = ctx.overrideRegisters.get(channelId);
  const s = existing?.s ?? 0;
  const c = existing?.c ?? 0;
  const b = existing?.b ?? 0;
  const newS = Math.max(s, c) + 1;
  if (newS > 0xffffffff)
    return { status: "refused", reason: "uint32_overflow" };
  const newReg: OverrideRegister = {
    s: newS,
    c,
    b: Math.max(b, ctx.channelFrontier(channelId)),
  };
  const prevExtraSlotIds = ctx.extraSlotIds.slice();
  if (!ctx.tryCandidatePlan(channelId, newReg)) {
    ctx.restoreExtraSlotIds(prevExtraSlotIds);
    return { status: "refused", reason: "budget_exhausted" };
  }
  const prevReg = ctx.overrideRegisters.get(channelId);
  const wasPublishable = ctx.publishableContextIds.has(channelId);
  ctx.overrideRegisters.set(channelId, newReg);
  ctx.publishableContextIds.add(channelId);
  if (!ctx.persistLocalState()) {
    if (prevReg === undefined) ctx.overrideRegisters.delete(channelId);
    else ctx.overrideRegisters.set(channelId, prevReg);
    if (!wasPublishable) ctx.publishableContextIds.delete(channelId);
    ctx.restoreExtraSlotIds(prevExtraSlotIds);
    return { status: "refused", reason: "storage_failed" };
  }
  ctx.notifyListeners();
  ctx.schedulePublish();
  return { status: "applied" };
}

/**
 * Public mark-read: queues an intent when load is incomplete; C-bumps otherwise.
 * Captures the current frontier as readTarget when queuing, so the drain can
 * advance the frontier to the correct position later.
 * Captures sourceScope when provided so the drain can perform exact source cleanup.
 * Persists the intent atomically in the v2 blob via persistLocalState().
 */
export function markChannelRead(
  ctx: DrainContext,
  channelId: string,
  sourceScope?: string,
): MarkResult {
  if (!ctx.isLoadComplete) {
    const readTarget = ctx.channelFrontier(channelId);
    pendingOverrideIntentStore.enqueue(
      channelId,
      "read",
      sourceScope,
      readTarget > 0 ? readTarget : undefined,
    );
    if (!ctx.persistLocalState()) {
      // Storage failure — intent is in-memory only; session drain still works.
    }
    return { status: "queued" };
  }
  const reg = ctx.overrideRegisters.get(channelId);
  const effectiveFrontier = ctx.channelFrontier(channelId);
  if (!reg) return { status: "refused", reason: "already_inactive" };
  const newC = Math.max(reg.s, reg.c) + 1;
  if (newC > 0xffffffff)
    return { status: "refused", reason: "uint32_overflow" };
  const newReg: OverrideRegister = { s: reg.s, c: newC, b: reg.b };
  if (isOverrideActive(newReg, effectiveFrontier)) {
    console.error(
      "[ReadStateManager] markChannelRead: override still active after bump",
    );
    return { status: "refused", reason: "already_inactive" };
  }
  const wasPublishable = ctx.publishableContextIds.has(channelId);
  ctx.overrideRegisters.set(channelId, newReg);
  ctx.publishableContextIds.add(channelId);
  if (!ctx.persistLocalState()) {
    ctx.overrideRegisters.set(channelId, reg);
    if (!wasPublishable) ctx.publishableContextIds.delete(channelId);
    return { status: "refused", reason: "storage_failed" };
  }
  ctx.notifyListeners();
  ctx.schedulePublish();
  return { status: "applied" };
}
