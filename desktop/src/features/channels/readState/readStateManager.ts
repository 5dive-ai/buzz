import { nip44EncryptToSelf, signRelayEvent } from "@/shared/api/tauri";
import type { RelayClient } from "@/shared/api/relayClientSession";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_READ_STATE } from "@/shared/constants/kinds";
import {
  READ_STATE_D_TAG_PREFIX,
  READ_STATE_FETCH_LIMIT,
  READ_STATE_MAX_PLAINTEXT_BYTES,
  READ_STATE_MAX_SLOTS,
  MSG_PREFIX,
  THREAD_PREFIX,
  isOverrideKey,
  encodeOverrideGroup,
  isOverrideActive,
  escapeFrontierKey,
  unescapeFrontierKey,
  localExtraSlotIdsKey,
  type ReadStateBlob,
  type OverrideRegister,
  type OverrideLiveness,
} from "@/features/channels/readState/readStateFormat";
import {
  parseReadStateEvent,
  mergeOverrideRegisterMaps,
  type MergedReadState,
  type ParsedReadStateEvent,
} from "@/features/channels/readState/readStateSnapshot";
import {
  readStoredReadState,
  writeStoredReadState,
} from "@/features/channels/readState/readStateStorage";
import {
  fencedEnumerationLoad,
  deduplicateByCoordinate,
} from "@/features/channels/readState/readStateFencedLoader";
import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";

const CLIENT_ID_KEY_PREFIX = "buzz.nip-rs.client-id";
const SLOT_ID_KEY_PREFIX = "buzz.nip-rs.slot-id";
const DEBOUNCE_MS = 5_000;

export type MarkResult =
  | { success: true }
  | {
      success: false;
      reason:
        | "uint32_overflow"
        | "budget_exhausted"
        | "load_incomplete"
        | "already_inactive"
        | "storage_failed";
    };

/** Explicit delta returned by `ingest()`. */
export type IngestDelta = {
  /** Contexts whose frontier or override register changed. */
  changedContexts: Set<string>;
  /** True if any canonical form changed (triggers convergence publish). */
  canonicalChanged: boolean;
};

function generateHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function getOrCreatePersisted(key: string, generator: () => string): string {
  let value = localStorage.getItem(key);
  if (!value) {
    value = generator();
    setLocalStorageItemWithRecovery(key, value);
  }
  return value;
}

function loadExtraSlotIds(pubkey: string): string[] {
  try {
    const raw = localStorage.getItem(localExtraSlotIdsKey(pubkey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
  } catch {
    return [];
  }
}

function saveExtraSlotIds(pubkey: string, ids: string[]): void {
  setLocalStorageItemWithRecovery(
    localExtraSlotIdsKey(pubkey),
    JSON.stringify(ids),
  );
}

export type ApplyRemoteContextResult = "unchanged" | "advanced";

export type ContextParentResolver = (contextId: string) => string | null;

/** Coherent projection (completeness + frontiers + overrides) for UI consumption via `getProjection()`. */
export type ReadStateProjection = {
  loadComplete: boolean;
  frontiers: ReadonlyMap<string, number>;
  overrides: ReadonlyMap<string, OverrideRegister>;
};

/** NIP-RS Hierarchical Frontier: `effective(ctx) = max(merged[ctx], effective(parent(ctx)))`. */
export function resolveEffectiveTimestamp(args: {
  effectiveState: Map<string, number>;
  contextId: string;
  parentResolver: ContextParentResolver | null;
}): number | null {
  const { effectiveState, contextId, parentResolver } = args;
  const own = effectiveState.get(contextId) ?? null;
  const parentId = parentResolver?.(contextId) ?? null;
  if (parentId === null) return own;
  const parent = effectiveState.get(parentId) ?? null;
  if (parent === null) return own;
  if (own === null) return parent;
  return Math.max(own, parent);
}

export function applyRemoteContextTimestamp(args: {
  effectiveState: Map<string, number>;
  contextSourceCreatedAt: Map<string, number>;
  contextId: string;
  timestamp: number;
  eventCreatedAt: number;
}): ApplyRemoteContextResult {
  const {
    effectiveState,
    contextSourceCreatedAt,
    contextId,
    timestamp,
    eventCreatedAt,
  } = args;
  const sourceCreatedAt = contextSourceCreatedAt.get(contextId) ?? 0;
  const current = effectiveState.get(contextId) ?? 0;
  const next = Math.max(current, timestamp);
  const result: ApplyRemoteContextResult =
    next === current ? "unchanged" : "advanced";
  if (result === "advanced") effectiveState.set(contextId, next);
  if (eventCreatedAt > sourceCreatedAt)
    contextSourceCreatedAt.set(contextId, eventCreatedAt);
  return result;
}

/** Result of `splitContextsIntoBudgetedSlots`. */
export interface SlotSplitResult {
  slots: Array<Record<string, number>>;
  extraSlotIds: string[];
}

/** Partition `channelEntries` across slots, override groups pinned to slot 0. Exported for testing. */
export function splitContextsIntoBudgetedSlots(args: {
  channelEntries: [string, number][];
  threadMsgEntries: [string, number][];
  clientId: string;
  initialSlotCount: number;
  maxSlots: number;
  maxBytes: number;
  slotIdGenerator: () => string;
}): SlotSplitResult | null {
  const {
    channelEntries,
    threadMsgEntries,
    clientId,
    initialSlotCount,
    maxSlots,
    maxBytes,
    slotIdGenerator,
  } = args;

  const encoder = new TextEncoder();
  const blobFor = (c: Record<string, number>) =>
    JSON.stringify({ v: 1, client_id: clientId, contexts: c });

  const overrideRawIds = new Set<string>();
  for (const [key] of channelEntries) {
    if (isOverrideKey(key)) overrideRawIds.add(key.slice(5));
  }
  const pinnedEntries: [string, number][] = [];
  const roundRobinEntries: [string, number][] = [];
  for (const [key, ts] of channelEntries) {
    if (isOverrideKey(key) || overrideRawIds.has(unescapeFrontierKey(key))) {
      pinnedEntries.push([key, ts]);
    } else {
      roundRobinEntries.push([key, ts]);
    }
  }
  let slotCount = initialSlotCount;
  const extraSlotIds: string[] = [];
  const distribute = (count: number): Array<Record<string, number>> => {
    const slotContexts: Array<Record<string, number>> = Array.from(
      { length: count },
      () => ({}),
    );
    for (let i = 0; i < roundRobinEntries.length; i++) {
      const [key, ts] = roundRobinEntries[i];
      slotContexts[i % count][key] = ts;
    }
    for (const [key, ts] of pinnedEntries) slotContexts[0][key] = ts;
    return slotContexts;
  };

  let slotContexts = distribute(slotCount);
  while (
    slotContexts.some((c) => encoder.encode(blobFor(c)).length > maxBytes) &&
    slotCount < maxSlots
  ) {
    extraSlotIds.push(slotIdGenerator());
    slotCount++;
    slotContexts = distribute(slotCount);
  }
  if (slotContexts.some((c) => encoder.encode(blobFor(c)).length > maxBytes))
    return null;
  for (const [key, ts] of threadMsgEntries) slotContexts[0][key] = ts;
  trimContextsToBudget(slotContexts[0], clientId, maxBytes);
  return { slots: slotContexts, extraSlotIds };
}

export interface TrimResult {
  evicted: number;
  fitsAfterTrim: boolean;
}

/** Trim a contexts map to fit within `maxBytes`. Evicts oldest msg:, then thread:. Channel keys and ov_* entries are never evicted. Mutates in place. Returns `{ evicted, fitsAfterTrim }`. */
export function trimContextsToBudget(
  contexts: Record<string, number>,
  clientId: string,
  maxBytes: number,
): TrimResult {
  const encoder = new TextEncoder();
  const blobFor = (c: Record<string, number>) =>
    JSON.stringify({ v: 1, client_id: clientId, contexts: c });

  let currentBytes = encoder.encode(blobFor(contexts)).length;
  if (currentBytes <= maxBytes) {
    return { evicted: 0, fitsAfterTrim: true };
  }

  const msgEntries: [string, number][] = [];
  const threadEntries: [string, number][] = [];
  for (const [key, ts] of Object.entries(contexts)) {
    if (isOverrideKey(key)) continue;
    if (key.startsWith(MSG_PREFIX)) msgEntries.push([key, ts]);
    else if (key.startsWith(THREAD_PREFIX)) threadEntries.push([key, ts]);
  }
  msgEntries.sort((a, b) => a[1] - b[1]);
  threadEntries.sort((a, b) => a[1] - b[1]);
  const toEvict: string[] = [];
  for (const [key, ts] of [...msgEntries, ...threadEntries]) {
    if (currentBytes <= maxBytes) break;
    currentBytes -= key.length + 3 + String(ts).length + 1;
    toEvict.push(key);
  }
  for (const key of toEvict) delete contexts[key];
  const fitsAfterTrim = encoder.encode(blobFor(contexts)).length <= maxBytes;
  return { evicted: toEvict.length, fitsAfterTrim };
}

export class ReadStateManager {
  private pubkey: string;
  private relayClient: RelayClient;
  private clientId: string;
  private slotId: string;
  private extraSlotIds: string[];
  private effectiveState = new Map<string, number>();
  private publishableContextIds = new Set<string>();
  private lastPublishedContexts: Record<string, number> = {};
  private debounceTimer: number | null = null;
  private listeners = new Set<() => void>();
  private unsubscribeLive: (() => void) | null = null;
  private initialized = false;
  private maxFetchedCreatedAt = 0;
  private contextSourceCreatedAt = new Map<string, number>();
  private pendingSyncedAdvances = new Set<string>();
  private destroyed = false;
  private parentResolver: ContextParentResolver | null = null;
  private overrideRegisters = new Map<string, OverrideRegister>();
  private isLoadComplete = false;

  constructor(pubkey: string, relayClient: RelayClient) {
    this.pubkey = pubkey;
    this.relayClient = relayClient;
    this.clientId = getOrCreatePersisted(
      `${CLIENT_ID_KEY_PREFIX}:${pubkey}`,
      () => crypto.randomUUID(),
    );
    this.slotId = getOrCreatePersisted(`${SLOT_ID_KEY_PREFIX}:${pubkey}`, () =>
      generateHex(16),
    );
    this.extraSlotIds = loadExtraSlotIds(pubkey);
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.destroyed) return;
    this.hydrateFromLocalStorage();
    await this.fetchAndMerge();
    if (this.destroyed) return;
    await this.startLiveSubscription();
    if (this.destroyed) return;
    const initContexts = this.currentContexts();
    if (
      initContexts === null ||
      !this.isIdenticalToLastPublished(initContexts)
    ) {
      this.schedulePublish();
    }
    this.initialized = true;
    this.notifyListeners();
  }

  markContextRead(contextId: string, unixTimestamp: number): void {
    this.advanceContext(contextId, unixTimestamp, { publishable: true });
    this.contextSourceCreatedAt.set(
      contextId,
      Math.max(Math.floor(Date.now() / 1_000), this.maxFetchedCreatedAt + 1),
    );
  }

  seedContextRead(contextId: string, unixTimestamp: number): void {
    this.advanceContext(contextId, unixTimestamp, { publishable: false });
  }

  private advanceContext(
    contextId: string,
    unixTimestamp: number,
    options: { publishable: boolean },
  ): void {
    const current = this.effectiveState.get(contextId) ?? 0;
    if (unixTimestamp <= current) {
      if (!options.publishable || this.publishableContextIds.has(contextId))
        return;
      this.publishableContextIds.add(contextId);
      this.persistLocalState();
      this.schedulePublish();
      return;
    }
    this.effectiveState.set(contextId, unixTimestamp);
    if (options.publishable) this.publishableContextIds.add(contextId);
    this.persistLocalState();
    this.notifyListeners();
    if (options.publishable) this.schedulePublish();
  }

  getEffectiveTimestamp(contextId: string): number | null {
    return resolveEffectiveTimestamp({
      effectiveState: this.effectiveState,
      contextId,
      parentResolver: this.parentResolver,
    });
  }

  getOwnTimestamp(contextId: string): number | null {
    return this.effectiveState.get(contextId) ?? null;
  }

  setContextParentResolver(resolver: ContextParentResolver | null): void {
    this.parentResolver = resolver;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      void this.publish();
    }
    if (this.unsubscribeLive) {
      void this.unsubscribeLive();
      this.unsubscribeLive = null;
    }
    this.listeners.clear();
  }

  private async fetchAndMerge(): Promise<void> {
    if (this.destroyed) return;
    const result = await fencedEnumerationLoad(this.relayClient, this.pubkey);
    if (this.destroyed) return;
    this.isLoadComplete = result.complete;
    if (!result.complete)
      console.warn(
        "[ReadStateManager] fetchAndMerge: load incomplete — gated ops blocked",
      );
    this.processLoadedParsedEvents(result.events);
    const merged = mergeParsedEvents(result.events);
    await this.ingest(merged);
    this.persistLocalState();
    this.notifyListeners();
  }

  /** Retry a failed load: resets isLoadComplete, re-runs the full enumeration. */
  async retryLoad(): Promise<void> {
    if (this.destroyed) return;
    this.isLoadComplete = false;
    await this.fetchAndMerge();
  }

  /** Shared ingest: accept pre-merged state and return semantic delta (changed contexts, canonical flip). */
  private async ingest(merged: MergedReadState): Promise<IngestDelta> {
    const delta: IngestDelta = {
      changedContexts: new Set(),
      canonicalChanged: false,
    };

    // Snapshot canonical forms before frontier merge (a frontier advance can flip live→tombstone).
    const prevCanonicalByCtx = new Map<string, string>();
    for (const rawCtx of merged.frontiers.keys()) {
      const reg = this.overrideRegisters.get(rawCtx);
      if (reg !== undefined)
        prevCanonicalByCtx.set(
          rawCtx,
          canonicalKey(reg, this.channelFrontier(rawCtx)),
        );
    }

    for (const [rawCtx, ts] of merged.frontiers) {
      const result = applyRemoteContextTimestamp({
        effectiveState: this.effectiveState,
        contextSourceCreatedAt: this.contextSourceCreatedAt,
        contextId: rawCtx,
        eventCreatedAt: 0,
        timestamp: ts,
      });
      if (result !== "unchanged") {
        delta.changedContexts.add(rawCtx);
        this.pendingSyncedAdvances.add(rawCtx);
        this.publishableContextIds.add(rawCtx);
      }
    }

    for (const [rawCtx, prevCanon] of prevCanonicalByCtx) {
      const reg = this.overrideRegisters.get(rawCtx);
      if (reg !== undefined) {
        const newCanon = canonicalKey(reg, this.channelFrontier(rawCtx));
        if (newCanon !== prevCanon) delta.canonicalChanged = true;
      }
    }

    // ── Override register merge ───────────────────────────────────────────
    for (const [rawCtx, reg] of merged.overrides) {
      const ex = this.overrideRegisters.get(rawCtx);
      const m: OverrideRegister = ex
        ? {
            s: Math.max(ex.s, reg.s),
            c: Math.max(ex.c, reg.c),
            b: Math.max(ex.b, reg.b),
          }
        : reg;
      const changed = !ex || m.s !== ex.s || m.c !== ex.c || m.b !== ex.b;
      if (changed) {
        this.overrideRegisters.set(rawCtx, m);
        delta.changedContexts.add(rawCtx);
        this.publishableContextIds.add(rawCtx);
        const prevCanon = ex
          ? canonicalKey(ex, this.channelFrontier(rawCtx))
          : null;
        if (prevCanon !== canonicalKey(m, this.channelFrontier(rawCtx)))
          delta.canonicalChanged = true;
      }
    }

    return delta;
  }

  /** Process already-parsed events for metadata, conflict rotation, and maxFetchedCreatedAt. */
  private processLoadedParsedEvents(events: ParsedReadStateEvent[]): void {
    for (const parsed of events) {
      this.maxFetchedCreatedAt = Math.max(
        this.maxFetchedCreatedAt,
        parsed.createdAt,
      );
      for (const rawCtx of parsed.contexts.frontiers.keys()) {
        const src = this.contextSourceCreatedAt.get(rawCtx) ?? 0;
        if (parsed.createdAt > src)
          this.contextSourceCreatedAt.set(rawCtx, parsed.createdAt);
      }
      // Slot-conflict rotation (spec MUST NOT, NIP-RS.md:55-64,402-406).
      if (
        parsed.dTag === `read-state:${this.slotId}` &&
        parsed.blob.client_id !== this.clientId
      ) {
        this.slotId = generateHex(16);
        setLocalStorageItemWithRecovery(
          `${SLOT_ID_KEY_PREFIX}:${this.pubkey}`,
          this.slotId,
        );
      }
      if (parsed.blob.client_id === this.clientId) {
        // Own-blob: union lastPublishedContexts and mark publishable.
        const unionContexts: Record<string, number> = {
          ...this.lastPublishedContexts,
        };
        for (const [key, ts] of Object.entries(parsed.blob.contexts)) {
          const ex = unionContexts[key];
          if (ex === undefined || ts > ex) unionContexts[key] = ts;
        }
        for (const contextId of Object.keys(parsed.blob.contexts))
          this.publishableContextIds.add(contextId);
        this.lastPublishedContexts = unionContexts;
      }
    }
  }

  /** Ingest parsed events: process metadata then merge into frontier/override maps. */
  private async ingestParsedEvents(
    events: ParsedReadStateEvent[],
  ): Promise<IngestDelta> {
    this.processLoadedParsedEvents(events);
    const merged = mergeParsedEvents(events);
    return this.ingest(merged);
  }

  private async startLiveSubscription(): Promise<void> {
    // Wire retryLoad on reconnects so incomplete init doesn't brick the manager.
    const unsubReconnect = this.relayClient.subscribeToReconnects(() => {
      if (this.destroyed) return;
      void this.retryLoad();
    });
    try {
      const unsub = await this.relayClient.subscribeLive(
        {
          kinds: [KIND_READ_STATE],
          authors: [this.pubkey],
          limit: READ_STATE_FETCH_LIMIT,
        },
        (event: RelayEvent) => {
          void this.handleIncomingEvent(event);
        },
      );
      if (this.destroyed) {
        unsub();
        unsubReconnect();
        return;
      }
      this.unsubscribeLive = () => {
        unsub();
        unsubReconnect();
      };
    } catch {
      unsubReconnect();
      // Live subscription is best-effort; missed events will be caught on reconnect.
    }
  }

  private async handleIncomingEvent(event: RelayEvent): Promise<void> {
    if (event.pubkey !== this.pubkey || this.destroyed) return;
    // Parse once: use the result for both ingest and the convergence client_id check.
    const parsed = await parseReadStateEvent(event, this.pubkey);
    if (!parsed) return;
    const delta = await this.ingestParsedEvents([parsed]);
    if (delta.changedContexts.size > 0 || this.pendingSyncedAdvances.size > 0) {
      this.persistLocalState();
      this.notifyListeners();
      if (delta.canonicalChanged && parsed.blob.client_id !== this.clientId) {
        this.schedulePublish();
      }
    }
  }

  private schedulePublish(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.publish();
    }, DEBOUNCE_MS);
  }

  private async publish(): Promise<void> {
    if (!this.isLoadComplete) return;
    if (!(await this.fetchOwnBlobBeforePublish())) {
      console.warn(
        "[ReadStateManager] publish aborted: read-before-write failed",
      );
      return;
    }
    const contexts = this.currentContexts();
    if (contexts === null) {
      await this.publishSplitSlots();
      return;
    }
    if (this.extraSlotIds.length > 0) {
      await this.deleteExtraSlots();
      this.lastPublishedContexts = {};
    }
    if (this.isIdenticalToLastPublished(contexts)) return;
    await this.publishOneSlot(this.slotId, contexts);
  }

  private async publishOneSlot(
    slotId: string,
    contexts: Record<string, number>,
  ): Promise<void> {
    const blob: ReadStateBlob = { v: 1, client_id: this.clientId, contexts };
    try {
      const ciphertext = await nip44EncryptToSelf(JSON.stringify(blob));
      const createdAt = Math.max(
        Math.floor(Date.now() / 1_000),
        this.maxFetchedCreatedAt + 1,
      );
      const event = await signRelayEvent({
        kind: KIND_READ_STATE,
        content: ciphertext,
        createdAt,
        tags: [
          ["d", `read-state:${slotId}`],
          ["t", "read-state"],
        ],
      });
      await this.relayClient.publishEvent(
        event,
        "Timed out publishing read state.",
        "Failed to publish read state.",
      );
      for (const key of Object.keys(contexts)) {
        if (this.lastPublishedContexts[key] !== contexts[key])
          this.contextSourceCreatedAt.set(key, createdAt);
      }
      for (const [key, ts] of Object.entries(contexts))
        this.lastPublishedContexts[key] = ts;
      this.maxFetchedCreatedAt = Math.max(
        this.maxFetchedCreatedAt,
        event.created_at,
      );
    } catch (error) {
      console.warn("[ReadStateManager] publish failed:", error);
    }
  }

  private async publishSplitSlots(): Promise<void> {
    const slots = this.splitContextsIntoSlots();
    if (slots === null) return;
    const unionContexts: Record<string, number> = {};
    for (const { contexts } of slots) {
      for (const [key, ts] of Object.entries(contexts)) {
        const existing = unionContexts[key];
        if (existing === undefined || ts > existing) unionContexts[key] = ts;
      }
    }
    if (this.isIdenticalToLastPublished(unionContexts)) return;
    this.lastPublishedContexts = {};
    for (const { slotId, contexts } of slots)
      await this.publishOneSlot(slotId, contexts);
  }

  private async deleteExtraSlots(): Promise<void> {
    if (!this.isLoadComplete) return;
    for (const slotId of this.extraSlotIds) {
      try {
        const aTagValue = `${KIND_READ_STATE}:${this.pubkey}:${READ_STATE_D_TAG_PREFIX}${slotId}`;
        const event = await signRelayEvent({
          kind: 5,
          content: "",
          tags: [["a", aTagValue]],
        });
        await this.relayClient.publishEvent(
          event,
          "Timed out deleting extra read-state slot.",
          "Failed to delete extra read-state slot.",
        );
      } catch {
        /* Non-fatal */
      }
    }
    this.extraSlotIds = [];
    saveExtraSlotIds(this.pubkey, []);
  }

  private async fetchOwnBlobBeforePublish(): Promise<boolean> {
    const dTags = [this.slotId, ...this.extraSlotIds].map(
      (id) => `${READ_STATE_D_TAG_PREFIX}${id}`,
    );
    try {
      const events = await this.relayClient.fetchEvents({
        kinds: [KIND_READ_STATE],
        authors: [this.pubkey],
        "#d": dTags,
        limit: READ_STATE_FETCH_LIMIT,
      });
      const deduped = deduplicateByCoordinate(events);
      // Parse once: use same path as full-state load (Contract 2 — metadata/conflict).
      const parsed: ParsedReadStateEvent[] = [];
      for (const ev of deduped) {
        const p = await parseReadStateEvent(ev, this.pubkey);
        if (p) parsed.push(p);
      }
      this.processLoadedParsedEvents(parsed);
      const merged = mergeParsedEvents(parsed);
      await this.ingest(merged);
      this.persistLocalState();
      return true;
    } catch {
      return false;
    }
  }

  private isIdenticalToLastPublished(
    contexts: Record<string, number>,
  ): boolean {
    const currentKeys = Object.keys(contexts);
    if (Object.keys(this.lastPublishedContexts).length !== currentKeys.length)
      return false;
    for (const key of currentKeys) {
      if (this.lastPublishedContexts[key] !== contexts[key]) return false;
    }
    return true;
  }

  /** Effective frontier including parent resolver. */
  private channelFrontier(channelId: string): number {
    return (
      resolveEffectiveTimestamp({
        effectiveState: this.effectiveState,
        contextId: channelId,
        parentResolver: this.parentResolver,
      }) ?? 0
    );
  }

  /**
   * Build the single-slot contexts record. Uses `channelFrontier()` for
   * canonical serialization — same resolver as `getOverrideLiveness()`.
   * Returns null when the record doesn't fit in one slot.
   */
  private currentContexts(): Record<string, number> | null {
    const contexts: Record<string, number> = {};
    for (const [ctx, ts] of this.effectiveState) {
      if (this.publishableContextIds.has(ctx))
        contexts[escapeFrontierKey(ctx)] = ts;
    }
    for (const [rawCtx, reg] of this.overrideRegisters) {
      if (!this.publishableContextIds.has(rawCtx)) continue;
      // Use channelFrontier — same resolver as getOverrideLiveness.
      const frontier = this.channelFrontier(rawCtx);
      const wireEntries = encodeOverrideGroup(rawCtx, reg, frontier);
      for (const [key, val] of Object.entries(wireEntries)) contexts[key] = val;
    }
    const { evicted, fitsAfterTrim } = trimContextsToBudget(
      contexts,
      this.clientId,
      READ_STATE_MAX_PLAINTEXT_BYTES,
    );
    if (evicted > 0)
      console.warn(
        `[ReadStateManager] currentContexts trimmed ${evicted} entries`,
      );
    if (!fitsAfterTrim) return null;
    return contexts;
  }

  private splitContextsIntoSlots(): Array<{
    slotId: string;
    contexts: Record<string, number>;
  }> | null {
    const channelEntries: [string, number][] = [];
    const threadMsgEntries: [string, number][] = [];
    for (const [ctx, ts] of this.effectiveState) {
      if (!this.publishableContextIds.has(ctx)) continue;
      if (ctx.startsWith(MSG_PREFIX) || ctx.startsWith(THREAD_PREFIX)) {
        threadMsgEntries.push([ctx, ts]);
      } else {
        channelEntries.push([escapeFrontierKey(ctx), ts]);
      }
    }
    for (const [rawCtx, reg] of this.overrideRegisters) {
      if (!this.publishableContextIds.has(rawCtx)) continue;
      const frontier = this.channelFrontier(rawCtx);
      for (const [key, val] of Object.entries(
        encodeOverrideGroup(rawCtx, reg, frontier),
      ))
        channelEntries.push([key, val]);
    }
    const allSlotIds = [this.slotId, ...this.extraSlotIds];
    const result = splitContextsIntoBudgetedSlots({
      channelEntries,
      threadMsgEntries,
      clientId: this.clientId,
      initialSlotCount: allSlotIds.length,
      maxSlots: READ_STATE_MAX_SLOTS,
      maxBytes: READ_STATE_MAX_PLAINTEXT_BYTES,
      slotIdGenerator: () => generateHex(16),
    });
    if (result === null) return null;
    const newExtraSlotIds = [...allSlotIds.slice(1), ...result.extraSlotIds];
    if (newExtraSlotIds.length !== this.extraSlotIds.length) {
      this.extraSlotIds = newExtraSlotIds;
      saveExtraSlotIds(this.pubkey, this.extraSlotIds);
    }
    const finalSlotIds = [...allSlotIds, ...result.extraSlotIds];
    return finalSlotIds.map((slotId, i) => ({
      slotId,
      contexts: result.slots[i],
    }));
  }

  getOverrideLiveness(channelId: string): OverrideLiveness | null {
    const reg = this.overrideRegisters.get(channelId);
    if (!reg) return null;
    const effectiveFrontier = this.channelFrontier(channelId);
    return {
      active: isOverrideActive(reg, effectiveFrontier),
      frontier: effectiveFrontier,
    };
  }

  /** Coherent snapshot of completeness + frontiers + overrides. Maps are live read-only views — re-read on manager notifications; clone for snapshot semantics. */
  getProjection(): ReadStateProjection {
    return {
      loadComplete: this.isLoadComplete,
      frontiers: this.effectiveState,
      overrides: this.overrideRegisters,
    };
  }

  /** Candidate planner: trials candidate against single- and multi-slot paths. May mutate extraSlotIds as a side effect — caller must snapshot and restore on failure. */
  private tryCandidatePlan(rawCtxId: string, reg: OverrideRegister): boolean {
    const prev = this.overrideRegisters.get(rawCtxId);
    const wasPublishable = this.publishableContextIds.has(rawCtxId);
    this.overrideRegisters.set(rawCtxId, reg);
    this.publishableContextIds.add(rawCtxId);
    const single = this.currentContexts();
    const fits = single !== null || this.splitContextsIntoSlots() !== null;
    if (prev === undefined) {
      this.overrideRegisters.delete(rawCtxId);
    } else {
      this.overrideRegisters.set(rawCtxId, prev);
    }
    if (!wasPublishable) this.publishableContextIds.delete(rawCtxId);
    return fits;
  }

  /** Restore extra slot IDs (action rollback). If prior was empty, removes the key (absent → absent). */
  private restoreExtraSlotIds(prev: string[]): void {
    const changed =
      prev.length !== this.extraSlotIds.length ||
      prev.some((id, i) => id !== this.extraSlotIds[i]);
    this.extraSlotIds = prev;
    if (changed)
      prev.length === 0
        ? localStorage.removeItem(localExtraSlotIdsKey(this.pubkey))
        : saveExtraSlotIds(this.pubkey, this.extraSlotIds);
  }

  markChannelUnread(channelId: string): MarkResult {
    if (!this.isLoadComplete)
      return { success: false, reason: "load_incomplete" };
    const existing = this.overrideRegisters.get(channelId);
    const s = existing?.s ?? 0;
    const c = existing?.c ?? 0;
    const b = existing?.b ?? 0;
    const newS = Math.max(s, c) + 1;
    if (newS > 0xffffffff) return { success: false, reason: "uint32_overflow" };
    const newReg: OverrideRegister = {
      s: newS,
      c,
      b: Math.max(b, this.channelFrontier(channelId)),
    };
    // Snapshot extraSlotIds before the probe (probe mutates it via splitContextsIntoSlots).
    const prevExtraSlotIds = this.extraSlotIds.slice();
    if (!this.tryCandidatePlan(channelId, newReg)) {
      this.restoreExtraSlotIds(prevExtraSlotIds);
      return { success: false, reason: "budget_exhausted" };
    }
    const prevReg = this.overrideRegisters.get(channelId);
    const wasPublishable = this.publishableContextIds.has(channelId);
    this.overrideRegisters.set(channelId, newReg);
    this.publishableContextIds.add(channelId);
    if (!this.persistLocalState()) {
      if (prevReg === undefined) this.overrideRegisters.delete(channelId);
      else this.overrideRegisters.set(channelId, prevReg);
      if (!wasPublishable) this.publishableContextIds.delete(channelId);
      this.restoreExtraSlotIds(prevExtraSlotIds);
      return { success: false, reason: "storage_failed" };
    }
    this.notifyListeners();
    this.schedulePublish();
    return { success: true };
  }

  markChannelRead(channelId: string): MarkResult {
    if (!this.isLoadComplete)
      return { success: false, reason: "load_incomplete" };
    const reg = this.overrideRegisters.get(channelId);
    const effectiveFrontier = this.channelFrontier(channelId);
    if (!reg) return { success: false, reason: "already_inactive" };
    // Always attempt C-bump (spec NIP-RS.md:537-539).
    const newC = Math.max(reg.s, reg.c) + 1;
    if (newC > 0xffffffff) return { success: false, reason: "uint32_overflow" };
    const newReg: OverrideRegister = { s: reg.s, c: newC, b: reg.b };
    if (isOverrideActive(newReg, effectiveFrontier)) {
      console.error(
        "[ReadStateManager] markChannelRead: override still active after bump",
      );
      return { success: false, reason: "already_inactive" };
    }
    const wasPublishable = this.publishableContextIds.has(channelId);
    this.overrideRegisters.set(channelId, newReg);
    this.publishableContextIds.add(channelId);
    if (!this.persistLocalState()) {
      // v2 write failed — roll back.
      this.overrideRegisters.set(channelId, reg);
      if (!wasPublishable) this.publishableContextIds.delete(channelId);
      return { success: false, reason: "storage_failed" };
    }
    this.notifyListeners();
    this.schedulePublish();
    return { success: true };
  }

  private hydrateFromLocalStorage(): void {
    const stored = readStoredReadState(this.pubkey);
    for (const [contextId, timestamp] of stored.contexts)
      this.effectiveState.set(contextId, timestamp);
    for (const contextId of stored.publishableContextIds)
      this.publishableContextIds.add(contextId);
    for (const [contextId, createdAt] of stored.contextSourceCreatedAt)
      this.contextSourceCreatedAt.set(contextId, createdAt);
    for (const [ctx, e] of stored.overrideRegisters) {
      const ex = this.overrideRegisters.get(ctx);
      const merged = ex
        ? {
            s: Math.max(ex.s, e.s),
            c: Math.max(ex.c, e.c),
            b: Math.max(ex.b, e.b),
          }
        : { s: e.s, c: e.c, b: e.b };
      this.overrideRegisters.set(ctx, merged);
      if (e.f > 0 && !this.effectiveState.has(ctx))
        this.effectiveState.set(ctx, e.f);
      this.publishableContextIds.add(ctx); // v2 entry is inherently publishable
    }
    this.persistLocalState();
  }

  /** Persist local state. Returns false only if the v2 override write failed (commit point). */
  private persistLocalState(): boolean {
    const entries = new Map(
      [...this.overrideRegisters].map(([ctx, r]) => [
        ctx,
        { s: r.s, c: r.c, b: r.b, f: this.channelFrontier(ctx) },
      ]),
    );
    return writeStoredReadState(
      this.pubkey,
      this.effectiveState,
      this.publishableContextIds,
      this.contextSourceCreatedAt,
      entries,
    );
  }

  drainSyncedAdvances(): ReadonlySet<string> {
    const drained = this.pendingSyncedAdvances;
    this.pendingSyncedAdvances = new Set<string>();
    return drained;
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.debug("[ReadStateManager] listener threw:", error);
      }
    }
  }
}

/** Canonical key for an override register: encodes liveness + component values. */
function canonicalKey(reg: OverrideRegister, frontier: number): string {
  const active = isOverrideActive(reg, frontier);
  if (active) return `live:${reg.s},${reg.c},${reg.b}`;
  const floor = Math.max(reg.s, reg.c);
  return floor > 0 ? `dead:${floor}` : "virgin";
}

/** Build MergedReadState from pre-parsed events — no second decrypt. */
function mergeParsedEvents(events: ParsedReadStateEvent[]): MergedReadState {
  const frontiers = new Map<string, number>();
  const overrideMaps: Array<ReadonlyMap<string, OverrideRegister>> = [];
  for (const p of events) {
    for (const [rawCtx, ts] of p.contexts.frontiers) {
      const current = frontiers.get(rawCtx) ?? 0;
      if (ts > current) frontiers.set(rawCtx, ts);
    }
    overrideMaps.push(p.contexts.overrides);
  }
  return { frontiers, overrides: mergeOverrideRegisterMaps(...overrideMaps) };
}
