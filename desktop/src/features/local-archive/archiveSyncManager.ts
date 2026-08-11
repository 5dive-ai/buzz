import { relayClient as defaultRelayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_AGENT_OBSERVER_FRAME,
  KIND_AGENT_TURN_METRIC,
} from "@/shared/constants/kinds";
import {
  archiveEvents as defaultArchiveEvents,
  listSaveSubscriptions as defaultListSaveSubscriptions,
  notifyAgentMetricsChanged,
  onSubscriptionChange as defaultOnSubscriptionChange,
  type ArchiveBatchResult,
  type SaveSubscription,
  type ScopeType,
} from "@/shared/api/tauriArchive";

// ── Constants ─────────────────────────────────────────────────────────────────

const FLUSH_BATCH_SIZE = 25;
const FLUSH_IDLE_MS = 2_000;
const DISABLE_AGENT_METRIC_ARCHIVE =
  import.meta.env?.VITE_BUZZ_DISABLE_AGENT_METRIC_ARCHIVE === "1";
const ENABLE_ARCHIVE_PERF_DIAGNOSTICS =
  import.meta.env?.VITE_BUZZ_ARCHIVE_PERF_DIAGNOSTICS === "1";
const PERF_REPORT_INTERVAL_MS = 10_000;
const EVENT_LOOP_PROBE_INTERVAL_MS = 250;
const EVENT_LOOP_STALL_THRESHOLD_MS = 50;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Dependency injection interface — production uses module singletons; tests inject fakes. */
export interface ArchiveSyncDeps {
  relayClient: {
    subscribeLive: (
      filter: RelaySubscriptionFilter,
      onEvent: (event: RelayEvent) => void,
    ) => Promise<() => Promise<void>>;
  };
  listSaveSubscriptions: () => Promise<SaveSubscription[]>;
  archiveEvents: (
    candidates: Array<{
      rawEventJson: string;
      matchedScope: { scopeType: ScopeType; scopeValue: string };
    }>,
  ) => Promise<ArchiveBatchResult>;
  onSubscriptionChange: (listener: () => void) => () => void;
  disableAgentMetricArchive?: boolean;
  enableArchivePerfDiagnostics?: boolean;
  perfNow?: () => number;
  perfLog?: (message: string) => void;
  flushBatchSize?: number;
  flushIdleMs?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFilter(sub: SaveSubscription): RelaySubscriptionFilter {
  const base = { kinds: sub.kinds, limit: 0 } as const;
  switch (sub.scopeType) {
    case "channel_h":
      return { ...base, "#h": [sub.scopeValue] };
    case "owner_p":
      return { ...base, "#p": [sub.scopeValue] };
    case "referenced_e":
      return { ...base, "#e": [sub.scopeValue] };
  }
}

/** Stable key encoding scope + kinds — ensures kinds changes trigger resubscribe. */
function subKey(
  scopeType: ScopeType,
  scopeValue: string,
  kinds: number[],
): string {
  const sortedKinds = [...kinds].sort((a, b) => a - b).join(",");
  return `${scopeType}:${scopeValue}:${sortedKinds}`;
}

/** Scope-only key used to find and tear down a stale sub when kinds change. */
function scopeKey(scopeType: ScopeType, scopeValue: string): string {
  return `${scopeType}:${scopeValue}`;
}

// ── ArchiveSyncManager ────────────────────────────────────────────────────────

/**
 * Always-on manager that opens one live relay subscription per saved archive
 * config and forwards matched events to `archive_events` in debounced batches.
 *
 * Lifecycle: created once at app-shell mount (see `useArchiveSync`), destroyed
 * on community switch. Resubscribes automatically when subscriptions change
 * via the module-level notifier in `tauriArchive.ts`.
 *
 * Accepts optional `deps` for testing — production callers pass nothing.
 */
export class ArchiveSyncManager {
  private readonly deps: Required<
    Omit<
      ArchiveSyncDeps,
      | "disableAgentMetricArchive"
      | "enableArchivePerfDiagnostics"
      | "perfNow"
      | "perfLog"
      | "flushBatchSize"
      | "flushIdleMs"
    >
  >;
  private readonly disableAgentMetricArchive: boolean;
  private readonly enableArchivePerfDiagnostics: boolean;
  private readonly perfNow: () => number;
  private readonly perfLog: (message: string) => void;
  private readonly flushBatchSize: number;
  private readonly flushIdleMs: number;

  // full subKey (scope+kinds) → unsub
  private active = new Map<string, () => Promise<void>>();
  // Single-flight reload state — exactly one doResubscribe body runs at a time.
  // Any reload request arriving while one is running sets reloadPending so that
  // the loop runs one additional full pass after the current one finishes.
  // This structural guarantee makes concurrent list/subscribe awaits impossible,
  // eliminating all interleaving defects without per-boundary guards.
  private reloading = false;
  private reloadPending = false;
  private buffer: Array<{
    rawEventJson: string;
    matchedScope: { scopeType: ScopeType; scopeValue: string };
  }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private perfReportTimer: ReturnType<typeof setInterval> | null = null;
  private eventLoopProbeTimer: ReturnType<typeof setInterval> | null = null;
  private perfWindowStartedAt = 0;
  private nextEventLoopProbeAt = 0;
  private perfCounters = {
    observerEvents: 0,
    observerBytes: 0,
    metricEvents: 0,
    metricBytes: 0,
    archiveBatches: 0,
    archiveEvents: 0,
    archiveBytes: 0,
    stalls: 0,
    stallMs: 0,
    maxStallMs: 0,
  };
  private destroyed = false;
  private offSubscriptionChange: (() => void) | null = null;

  constructor(deps?: ArchiveSyncDeps) {
    this.deps = {
      relayClient: deps?.relayClient ?? defaultRelayClient,
      listSaveSubscriptions:
        deps?.listSaveSubscriptions ?? defaultListSaveSubscriptions,
      archiveEvents: deps?.archiveEvents ?? defaultArchiveEvents,
      onSubscriptionChange:
        deps?.onSubscriptionChange ?? defaultOnSubscriptionChange,
    };
    this.disableAgentMetricArchive =
      deps?.disableAgentMetricArchive ?? DISABLE_AGENT_METRIC_ARCHIVE;
    this.enableArchivePerfDiagnostics =
      deps?.enableArchivePerfDiagnostics ?? ENABLE_ARCHIVE_PERF_DIAGNOSTICS;
    this.perfNow = deps?.perfNow ?? (() => performance.now());
    this.perfLog = deps?.perfLog ?? ((message) => console.info(message));
    this.flushBatchSize = deps?.flushBatchSize ?? FLUSH_BATCH_SIZE;
    this.flushIdleMs = deps?.flushIdleMs ?? FLUSH_IDLE_MS;
  }

  async start(): Promise<void> {
    this.startPerfDiagnostics();
    // Register the change listener before the initial load so that any
    // subscription change arriving while the first pass is running sets
    // reloadPending and gets picked up by the coalescing loop.
    this.offSubscriptionChange = this.deps.onSubscriptionChange(() => {
      this.resubscribeAll();
    });
    await this.runReloadLoop();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.perfReportTimer !== null) {
      clearInterval(this.perfReportTimer);
      this.perfReportTimer = null;
    }
    if (this.eventLoopProbeTimer !== null) {
      clearInterval(this.eventLoopProbeTimer);
      this.eventLoopProbeTimer = null;
    }
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.offSubscriptionChange?.();
    this.offSubscriptionChange = null;
    // Flush any buffered events before tearing down.
    if (this.buffer.length > 0) {
      const toFlush = this.buffer.splice(0);
      this.sendBatch(toFlush, "flush on destroy failed");
    }
    for (const [, unsub] of this.active) {
      void unsub();
    }
    this.active.clear();
  }

  /**
   * Request a reload of all save subscriptions.
   *
   * If no reload is currently running, starts one immediately via
   * `runReloadLoop`. If one is already running, sets `reloadPending` so
   * the loop runs exactly one additional full pass after the current pass
   * completes — no matter how many changes arrive mid-run, they coalesce
   * into a single follow-up pass.
   */
  private resubscribeAll(): void {
    if (this.reloading) {
      this.reloadPending = true;
      return;
    }
    void this.runReloadLoop();
  }

  /**
   * Runs `doResubscribe` in a loop, draining any reload requests that
   * arrive while a pass is in flight. The loop terminates once no reload
   * is pending and the manager has not been destroyed.
   *
   * Awaited directly by `start()` for the initial load.
   */
  private async runReloadLoop(): Promise<void> {
    this.reloading = true;
    try {
      do {
        this.reloadPending = false;
        await this.doResubscribe();
      } while (this.reloadPending && !this.destroyed);
    } finally {
      this.reloading = false;
    }
  }

  /**
   * One full reload pass: fetch the current subscription list, tear down
   * removed or kind-changed subscriptions, and open new ones.
   *
   * Only one instance of this method ever runs at a time (enforced by
   * `runReloadLoop`). That single-flight guarantee makes concurrent
   * list/subscribe awaits structurally impossible.
   */
  private async doResubscribe(): Promise<void> {
    if (this.destroyed) return;

    let subs: SaveSubscription[];
    try {
      subs = await this.deps.listSaveSubscriptions();
    } catch (err) {
      console.warn("[archiveSyncManager] list_save_subscriptions failed:", err);
      return;
    }

    if (this.destroyed) return;

    if (this.disableAgentMetricArchive) {
      subs = subs.flatMap((sub) => {
        const kinds = sub.kinds.filter(
          (kind) => kind !== KIND_AGENT_TURN_METRIC,
        );
        return kinds.length > 0 ? [{ ...sub, kinds }] : [];
      });
    }

    // Full keys (scope+kinds) for the current subscription list.
    const wanted = new Set(
      subs.map((s) => subKey(s.scopeType, s.scopeValue, s.kinds)),
    );

    // Tear down subscriptions that are no longer needed or whose kinds changed.
    // A stale entry whose scope is still present but with different kinds will
    // have a different full key and be absent from `wanted`, so it gets torn
    // down here and recreated below with the new filter.
    for (const [key, unsub] of this.active) {
      if (!wanted.has(key)) {
        void unsub();
        this.active.delete(key);
      }
    }

    // Open new subscriptions for any full key not already active.
    // No concurrency guards are needed here: single-flight serialization
    // ensures this loop body is the only async path running, so nothing
    // can add a duplicate entry to `active` between iterations.
    for (const sub of subs) {
      if (this.destroyed) return;

      const key = subKey(sub.scopeType, sub.scopeValue, sub.kinds);
      if (this.active.has(key)) continue;

      const scopeType = sub.scopeType;
      const scopeValue = sub.scopeValue;
      const filter = buildFilter(sub);

      let dispose: (() => Promise<void>) | undefined;
      try {
        dispose = await this.deps.relayClient.subscribeLive(
          filter,
          (event: RelayEvent) => {
            this.enqueue(event, scopeType, scopeValue);
          },
        );
      } catch (err) {
        console.warn(
          `[archiveSyncManager] subscribeLive failed for ${scopeKey(scopeType, scopeValue)}:`,
          err,
        );
        // Do NOT add key to active — next resubscribeAll will retry.
        continue;
      }

      // A destroy() call may have arrived while subscribeLive was pending.
      // Tear down the just-opened subscription and bail out.
      if (this.destroyed) {
        void dispose();
        return;
      }

      this.active.set(key, dispose);
    }
  }

  private startPerfDiagnostics(): void {
    if (!this.enableArchivePerfDiagnostics || this.perfReportTimer !== null) {
      return;
    }

    this.perfWindowStartedAt = this.perfNow();
    this.nextEventLoopProbeAt =
      this.perfWindowStartedAt + EVENT_LOOP_PROBE_INTERVAL_MS;
    this.perfLog(
      `[archive-perf] started metricArchiveDisabled=${this.disableAgentMetricArchive}`,
    );

    this.eventLoopProbeTimer = setInterval(() => {
      const now = this.perfNow();
      const delayMs = Math.max(0, now - this.nextEventLoopProbeAt);
      this.nextEventLoopProbeAt = now + EVENT_LOOP_PROBE_INTERVAL_MS;
      if (delayMs >= EVENT_LOOP_STALL_THRESHOLD_MS) {
        this.perfCounters.stalls++;
        this.perfCounters.stallMs += delayMs;
        this.perfCounters.maxStallMs = Math.max(
          this.perfCounters.maxStallMs,
          delayMs,
        );
      }
    }, EVENT_LOOP_PROBE_INTERVAL_MS);

    this.perfReportTimer = setInterval(() => {
      this.reportPerfWindow();
    }, PERF_REPORT_INTERVAL_MS);
  }

  private reportPerfWindow(): void {
    const now = this.perfNow();
    const durationMs = Math.round(now - this.perfWindowStartedAt);
    const counters = this.perfCounters;
    this.perfLog(
      `[archive-perf] windowMs=${durationMs} metricArchiveDisabled=${this.disableAgentMetricArchive} observerEvents=${counters.observerEvents} observerBytes=${counters.observerBytes} metricEvents=${counters.metricEvents} metricBytes=${counters.metricBytes} archiveBatches=${counters.archiveBatches} archiveEvents=${counters.archiveEvents} archiveBytes=${counters.archiveBytes} stalls=${counters.stalls} stallMs=${Math.round(counters.stallMs)} maxStallMs=${Math.round(counters.maxStallMs)}`,
    );
    this.perfWindowStartedAt = now;
    this.perfCounters = {
      observerEvents: 0,
      observerBytes: 0,
      metricEvents: 0,
      metricBytes: 0,
      archiveBatches: 0,
      archiveEvents: 0,
      archiveBytes: 0,
      stalls: 0,
      stallMs: 0,
      maxStallMs: 0,
    };
  }

  private enqueue(
    event: RelayEvent,
    scopeType: ScopeType,
    scopeValue: string,
  ): void {
    if (this.destroyed) return;
    const rawEventJson = JSON.stringify(event);
    if (this.enableArchivePerfDiagnostics) {
      if (event.kind === KIND_AGENT_OBSERVER_FRAME) {
        this.perfCounters.observerEvents++;
        this.perfCounters.observerBytes += rawEventJson.length;
      } else if (event.kind === KIND_AGENT_TURN_METRIC) {
        this.perfCounters.metricEvents++;
        this.perfCounters.metricBytes += rawEventJson.length;
      }
    }
    this.buffer.push({
      rawEventJson,
      matchedScope: { scopeType, scopeValue },
    });
    if (this.buffer.length >= this.flushBatchSize) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushIdleMs);
  }

  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    this.sendBatch(batch, "archive_events failed");
  }

  /**
   * Fire-and-forget `archiveEvents(batch)`, shared by the idle/size-triggered
   * flush and the destroy-time flush. Notifies `onAgentMetricsChanged`
   * subscribers only when the backend confirms `persistedAgentMetrics > 0` —
   * the backend is authoritative, so a rejected call, a duplicate-only batch,
   * or a batch with no kind-44200 events never notifies.
   */
  private sendBatch(
    batch: Array<{
      rawEventJson: string;
      matchedScope: { scopeType: ScopeType; scopeValue: string };
    }>,
    errLabel: string,
  ): void {
    if (this.enableArchivePerfDiagnostics) {
      this.perfCounters.archiveBatches++;
      this.perfCounters.archiveEvents += batch.length;
      this.perfCounters.archiveBytes += batch.reduce(
        (total, candidate) => total + candidate.rawEventJson.length,
        0,
      );
    }
    void this.deps
      .archiveEvents(batch)
      .then((result) => {
        if (result.persistedAgentMetrics > 0) {
          notifyAgentMetricsChanged();
        }
      })
      .catch((err: unknown) => {
        console.warn(`[archiveSyncManager] ${errLabel}:`, err);
      });
  }
}

// ── React hook ────────────────────────────────────────────────────────────────

import * as React from "react";

/**
 * Starts the ArchiveSyncManager once `ready` is true and tears it down on
 * unmount. The `ready` gate ensures observer reconciliation completes before
 * any relay listeners open — kind 24200 is relay-ephemeral, so frames emitted
 * before the listener opens are permanently lost.
 */
export function useArchiveSync(ready: boolean): void {
  React.useEffect(() => {
    if (!ready) return;

    const manager = new ArchiveSyncManager();
    void manager.start();
    return () => {
      manager.destroy();
    };
  }, [ready]);
}
