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
  localExtraSlotIdsKey,
  type ReadStateBlob,
  type OverrideRegister,
  type OverrideLiveness,
} from "@/features/channels/readState/readStateFormat";
import {
  parseReadStateEvent,
  mergeReadStateEventsStructured,
  type MergedReadState,
} from "@/features/channels/readState/readStateSnapshot";
import {
  readStoredReadState,
  writeStoredReadState,
} from "@/features/channels/readState/readStateStorage";
import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";
import { truncatePubkey } from "@/shared/lib/pubkey";

const CLIENT_ID_KEY_PREFIX = "buzz.nip-rs.client-id";
const SLOT_ID_KEY_PREFIX = "buzz.nip-rs.slot-id";
const DEBOUNCE_MS = 5_000;
// Full-state fetch limit; sub-limit response confirms completeness (no truncation).
const READ_STATE_FULL_FETCH_LIMIT = 5_000;
type OwnBlobEntry = { blob: ReadStateBlob; createdAt: number };

export type MarkResult =
  | { success: true }
  | {
      success: false;
      reason:
        | "uint32_overflow"
        | "budget_exhausted"
        | "load_incomplete"
        | "already_inactive";
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

function clientIdKey(pubkey: string): string {
  return `${CLIENT_ID_KEY_PREFIX}:${pubkey}`;
}

function slotIdKey(pubkey: string): string {
  return `${SLOT_ID_KEY_PREFIX}:${pubkey}`;
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

/**
 * NIP-RS Hierarchical Frontier: `effective(ctx) = max(merged[ctx], effective(parent(ctx)))`.
 * Thread→channel relationship derived from event graph via `parentResolver`.
 */
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

/**
 * Result of a `splitContextsIntoBudgetedSlots` call.
 */
export interface SlotSplitResult {
  /** Contexts record for each slot (primary slot first). */
  slots: Array<Record<string, number>>;
  /** Extra slot IDs beyond the first. Length is `slots.length - 1`. */
  extraSlotIds: string[];
}

/**
 * Partition `channelEntries` across slots so each slot fits within `maxBytes`.
 * Override-bearing groups are pinned to slot 0; remaining keys distributed round-robin.
 * Returns `{ slots, extraSlotIds }` or null when maxSlots is insufficient.
 * Exported for unit testing; callers should prefer `splitContextsIntoSlots()`.
 */
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

  const overrideSuffixes = new Set<string>();
  for (const [key] of channelEntries) {
    if (isOverrideKey(key)) overrideSuffixes.add(key.slice(5)); // all ov_?: prefixes are 5 chars
  }
  const pinnedEntries: [string, number][] = [];
  const roundRobinEntries: [string, number][] = [];
  for (const [key, ts] of channelEntries) {
    if (isOverrideKey(key) || overrideSuffixes.has(key)) {
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
  /** Override registers keyed by raw context ID. */
  private overrideRegisters = new Map<string, OverrideRegister>();
  /** False until initial full-state fetch returns sub-limit (no truncation). Gated ops blocked while false. */
  private isLoadComplete = false;

  constructor(pubkey: string, relayClient: RelayClient) {
    this.pubkey = pubkey;
    this.relayClient = relayClient;
    this.clientId = getOrCreatePersisted(clientIdKey(pubkey), () =>
      crypto.randomUUID(),
    );
    this.slotId = getOrCreatePersisted(slotIdKey(pubkey), () =>
      generateHex(16),
    );
    this.extraSlotIds = loadExtraSlotIds(pubkey);
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.destroyed) return;
    console.debug(
      `[ReadStateManager] initialize pubkey=${truncatePubkey(this.pubkey)} clientId=${this.clientId.substring(0, 8)}… slotId=${this.slotId}`,
    );

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
    console.debug(
      `[ReadStateManager] initialize complete maxFetchedCreatedAt=${this.maxFetchedCreatedAt} contexts=${this.effectiveState.size}`,
    );
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

  /**
   * The context's OWN merged read marker, WITHOUT the hierarchical parent term.
   * Use this for background-channel threads (getEffectiveTimestamp folds in
   * parentResolver which maps threads to the active channel).
   */
  getOwnTimestamp(contextId: string): number | null {
    return this.effectiveState.get(contextId) ?? null;
  }

  /**
   * Inject the thread→channel parent resolver (NIP-RS.md:136-139).
   * The hierarchical max in getEffectiveTimestamp is a no-op until this is set.
   */
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
    let events: RelayEvent[];
    try {
      events = await this.relayClient.fetchEvents({
        kinds: [KIND_READ_STATE],
        authors: [this.pubkey],
        "#t": ["read-state"],
        // No `since` — a finite window can exclude the sole tombstone carrier.
        limit: READ_STATE_FULL_FETCH_LIMIT,
      });
    } catch (error) {
      console.debug("[ReadStateManager] fetchAndMerge failed:", error);
      return;
    }

    // Truncation guard: at-limit response may be incomplete; block gated ops.
    this.isLoadComplete = events.length < READ_STATE_FULL_FETCH_LIMIT;
    if (!this.isLoadComplete) {
      console.warn(
        `[ReadStateManager] fetchAndMerge: ${events.length} events (== limit) — gated ops blocked`,
      );
    }
    await this.mergeEvents(events);
    this.persistLocalState();
    this.notifyListeners();
  }

  private async mergeEvents(events: RelayEvent[]): Promise<void> {
    // Structured merge via slice-1 protocol layer.
    const merged: MergedReadState = await mergeReadStateEventsStructured(
      events,
      this.pubkey,
    );
    for (const [rawCtx, ts] of merged.frontiers) {
      const result = applyRemoteContextTimestamp({
        effectiveState: this.effectiveState,
        contextSourceCreatedAt: this.contextSourceCreatedAt,
        contextId: rawCtx,
        eventCreatedAt: 0, // per-event timestamps updated in the loop below
        timestamp: ts,
      });
      if (result !== "unchanged") {
        this.pendingSyncedAdvances.add(rawCtx);
        this.publishableContextIds.add(rawCtx);
      }
    }
    for (const [rawCtx, reg] of merged.overrides) {
      const ex = this.overrideRegisters.get(rawCtx);
      this.overrideRegisters.set(
        rawCtx,
        ex
          ? {
              s: Math.max(ex.s, reg.s),
              c: Math.max(ex.c, reg.c),
              b: Math.max(ex.b, reg.b),
            }
          : reg,
      );
      this.publishableContextIds.add(rawCtx);
    }
    const ownBlobsBySlot = new Map<string, OwnBlobEntry>();
    for (const event of events) {
      const parsed = await parseReadStateEvent(event, this.pubkey);
      if (!parsed) continue;

      this.maxFetchedCreatedAt = Math.max(
        this.maxFetchedCreatedAt,
        parsed.createdAt,
      );
      for (const rawCtx of parsed.contexts.frontiers.keys()) {
        const src = this.contextSourceCreatedAt.get(rawCtx) ?? 0;
        if (parsed.createdAt > src)
          this.contextSourceCreatedAt.set(rawCtx, parsed.createdAt);
      }
      // Rotate slotId if another client_id squats on our coord.
      if (
        parsed.dTag === `read-state:${this.slotId}` &&
        parsed.blob.client_id !== this.clientId
      ) {
        this.slotId = generateHex(16);
        setLocalStorageItemWithRecovery(slotIdKey(this.pubkey), this.slotId);
      }
      if (parsed.blob.client_id === this.clientId) {
        const existing = ownBlobsBySlot.get(parsed.dTag);
        if (!existing || parsed.createdAt > existing.createdAt) {
          ownBlobsBySlot.set(parsed.dTag, {
            blob: parsed.blob,
            createdAt: parsed.createdAt,
          });
        }
      }
    }

    if (ownBlobsBySlot.size > 0) {
      const unionContexts: Record<string, number> = {};
      for (const { blob } of ownBlobsBySlot.values()) {
        for (const [key, ts] of Object.entries(blob.contexts)) {
          const ex = unionContexts[key];
          if (ex === undefined || ts > ex) unionContexts[key] = ts;
        }
        for (const contextId of Object.keys(blob.contexts))
          this.publishableContextIds.add(contextId);
      }
      this.lastPublishedContexts = unionContexts;
    }
  }

  private async startLiveSubscription(): Promise<void> {
    try {
      const unsub = await this.relayClient.subscribeLive(
        {
          kinds: [KIND_READ_STATE],
          authors: [this.pubkey],
          "#t": ["read-state"],
          limit: READ_STATE_FETCH_LIMIT,
        },
        (event: RelayEvent) => {
          void this.handleIncomingEvent(event);
        },
      );
      if (this.destroyed) {
        unsub();
        return;
      }
      this.unsubscribeLive = unsub;
      console.debug("[ReadStateManager] live subscription established");
    } catch (error) {
      console.debug("[ReadStateManager] live subscription FAILED:", error);
    }
  }

  private async handleIncomingEvent(event: RelayEvent): Promise<void> {
    if (event.pubkey !== this.pubkey || this.destroyed) return;
    console.debug(
      `[ReadStateManager] incoming event=${event.id.substring(0, 8)}… created_at=${event.created_at}`,
    );

    const parsed = await parseReadStateEvent(event, this.pubkey);
    if (!parsed) return;

    this.maxFetchedCreatedAt = Math.max(
      this.maxFetchedCreatedAt,
      parsed.createdAt,
    );
    const { blob } = parsed;
    let anyAdvanced = false;
    for (const [ctx, ts] of Object.entries(blob.contexts)) {
      const result = applyRemoteContextTimestamp({
        effectiveState: this.effectiveState,
        contextSourceCreatedAt: this.contextSourceCreatedAt,
        contextId: ctx,
        timestamp: ts,
        eventCreatedAt: parsed.createdAt,
      });
      if (result === "advanced") {
        this.pendingSyncedAdvances.add(ctx);
        anyAdvanced = true;
      }
      if (!this.publishableContextIds.has(ctx)) {
        this.publishableContextIds.add(ctx);
        anyAdvanced = true;
      }
    }
    console.debug(
      `[ReadStateManager] incoming result anyAdvanced=${anyAdvanced} clientId=${blob.client_id.substring(0, 8)}…`,
    );

    if (anyAdvanced) {
      this.persistLocalState();
      this.notifyListeners();
      // Another client instance: schedule re-publish so our blob converges.
      if (blob.client_id !== this.clientId) this.schedulePublish();
    }
  }

  private schedulePublish(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.publish();
    }, DEBOUNCE_MS);
  }

  private async publish(): Promise<void> {
    console.debug(`[ReadStateManager] publish starting slotId=${this.slotId}`);
    if (!this.isLoadComplete) {
      console.debug("[ReadStateManager] publish blocked: isLoadComplete=false");
      return;
    }
    await this.fetchOwnBlobBeforePublish();
    const contexts = this.currentContexts();

    if (contexts === null) {
      await this.publishSplitSlots();
      return;
    }

    // Transitioning from split to single: delete stale extra-slot blobs.
    if (this.extraSlotIds.length > 0) {
      await this.deleteExtraSlots();
      this.lastPublishedContexts = {};
    }

    if (this.isIdenticalToLastPublished(contexts)) return;
    await this.publishOneSlot(this.slotId, contexts);
  }

  /** Publish a single slot's blob. Updates lastPublishedContexts and maxFetchedCreatedAt on success. */
  private async publishOneSlot(
    slotId: string,
    contexts: Record<string, number>,
  ): Promise<void> {
    const blob: ReadStateBlob = { v: 1, client_id: this.clientId, contexts };
    try {
      const ciphertext = await nip44EncryptToSelf(JSON.stringify(blob));
      const tags: string[][] = [
        ["d", `read-state:${slotId}`],
        ["t", "read-state"],
      ];
      const createdAt = Math.max(
        Math.floor(Date.now() / 1_000),
        this.maxFetchedCreatedAt + 1,
      );
      const event = await signRelayEvent({
        kind: KIND_READ_STATE,
        content: ciphertext,
        createdAt,
        tags,
      });
      await this.relayClient.publishEvent(
        event,
        "Timed out publishing read state.",
        "Failed to publish read state.",
      );
      console.debug(
        `[ReadStateManager] publish accepted slotId=${slotId} createdAt=${createdAt}`,
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

  /**
   * Multi-slot publish path. Partitions channel keys across slots and publishes
   * each independently. Skips if nothing changed since last publish.
   */
  private async publishSplitSlots(): Promise<void> {
    const slots = this.splitContextsIntoSlots();
    if (slots === null) return;

    // No-op suppression: skip if nothing changed.
    const unionContexts: Record<string, number> = {};
    for (const { contexts } of slots) {
      for (const [key, ts] of Object.entries(contexts)) {
        const existing = unionContexts[key];
        if (existing === undefined || ts > existing) unionContexts[key] = ts;
      }
    }
    if (this.isIdenticalToLastPublished(unionContexts)) return;

    // Reset before multi-slot publish to rebuild as union of all slots.
    this.lastPublishedContexts = {};
    for (const { slotId, contexts } of slots) {
      await this.publishOneSlot(slotId, contexts);
    }
  }

  /**
   * Publish NIP-09 kind:5 delete events for all extra slot blobs, then clear
   * extraSlotIds. Gated on isLoadComplete.
   */
  private async deleteExtraSlots(): Promise<void> {
    if (!this.isLoadComplete) {
      console.debug(
        "[ReadStateManager] deleteExtraSlots blocked: isLoadComplete=false",
      );
      return;
    }
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
        console.debug(`[ReadStateManager] deleted extra slot slotId=${slotId}`);
      } catch (error) {
        console.debug(
          `[ReadStateManager] deleteExtraSlots failed for slotId=${slotId}:`,
          error,
        );
        // Non-fatal: stale blob will expire from relay within the horizon window.
      }
    }
    this.extraSlotIds = [];
    saveExtraSlotIds(this.pubkey, []);
  }

  private async fetchOwnBlobBeforePublish(): Promise<void> {
    const allSlotIds = [this.slotId, ...this.extraSlotIds];
    const dTags = allSlotIds.map((id) => `${READ_STATE_D_TAG_PREFIX}${id}`);
    try {
      const events = await this.relayClient.fetchEvents({
        kinds: [KIND_READ_STATE],
        authors: [this.pubkey],
        "#d": dTags,
        limit: READ_STATE_FETCH_LIMIT,
      });
      await this.mergeEvents(events);
      this.persistLocalState();
    } catch (error) {
      console.debug(
        "[ReadStateManager] fetchOwnBlobBeforePublish failed:",
        error,
      );
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

  private currentContexts(): Record<string, number> | null {
    const contexts: Record<string, number> = {};
    for (const [ctx, ts] of this.effectiveState) {
      if (this.publishableContextIds.has(ctx)) contexts[ctx] = ts;
    }

    // Include ov_s/c/b wire entries for any context with an active or tombstoned register.
    for (const [rawCtx, reg] of this.overrideRegisters) {
      if (!this.publishableContextIds.has(rawCtx)) continue;
      const effectiveFrontier = this.resolveOwnEffectiveFrontier(rawCtx);
      const wireEntries = encodeOverrideGroup(rawCtx, reg, effectiveFrontier);
      for (const [key, val] of Object.entries(wireEntries)) contexts[key] = val;
    }

    // Evict oldest msg: then thread: entries until blob fits 32 KB.
    // Channel keys and ov_* entries are never evicted.
    const { evicted, fitsAfterTrim } = trimContextsToBudget(
      contexts,
      this.clientId,
      READ_STATE_MAX_PLAINTEXT_BYTES,
    );
    if (evicted > 0) {
      console.warn(
        `[ReadStateManager] currentContexts trimmed ${evicted} entries`,
      );
    }
    if (!fitsAfterTrim) {
      console.warn(
        "[ReadStateManager] currentContexts: budget exceeded — will split",
      );
      return null;
    }
    return contexts;
  }

  /**
   * Partition the full publishable contexts across multiple slots when channel
   * keys alone exceed READ_STATE_MAX_PLAINTEXT_BYTES. Override-bearing context
   * groups are pinned to slot 0. Returns null when even READ_STATE_MAX_SLOTS
   * slots can't accommodate all channel keys.
   */
  private splitContextsIntoSlots(): Array<{
    slotId: string;
    contexts: Record<string, number>;
  }> | null {
    // Separate channel keys from thread/msg entries. Override wire entries
    // (ov_s:, ov_c:, ov_b:) go in channelEntries for pinning to slot 0.
    const channelEntries: [string, number][] = [];
    const threadMsgEntries: [string, number][] = [];
    for (const [ctx, ts] of this.effectiveState) {
      if (!this.publishableContextIds.has(ctx)) continue;
      if (ctx.startsWith(MSG_PREFIX) || ctx.startsWith(THREAD_PREFIX)) {
        threadMsgEntries.push([ctx, ts]);
      } else {
        channelEntries.push([ctx, ts]);
      }
    }
    // Append override wire entries for publishable contexts.
    for (const [rawCtx, reg] of this.overrideRegisters) {
      if (!this.publishableContextIds.has(rawCtx)) continue;
      const effectiveFrontier = this.resolveOwnEffectiveFrontier(rawCtx);
      for (const [key, val] of Object.entries(
        encodeOverrideGroup(rawCtx, reg, effectiveFrontier),
      )) {
        channelEntries.push([key, val]);
      }
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

    if (result === null) {
      console.error(
        `[ReadStateManager] splitContextsIntoSlots: ${channelEntries.length} channel keys exceed ${READ_STATE_MAX_SLOTS}-slot budget`,
      );
      return null;
    }

    // Persist any newly allocated extra slot IDs.
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

  /** Resolve the effective frontier for `rawCtxId` from own state only (no parentResolver). */
  private resolveOwnEffectiveFrontier(rawCtxId: string): number {
    return this.effectiveState.get(rawCtxId) ?? 0;
  }

  /** Resolve the effective frontier for `channelId` including the parent resolver. */
  private resolveChannelFrontier(channelId: string): number {
    return (
      resolveEffectiveTimestamp({
        effectiveState: this.effectiveState,
        contextId: channelId,
        parentResolver: this.parentResolver,
      }) ?? 0
    );
  }

  /**
   * Return the liveness status of the manual-unread override for `channelId`,
   * or `null` when no override register exists.
   */
  getOverrideLiveness(channelId: string): OverrideLiveness | null {
    const reg = this.overrideRegisters.get(channelId);
    if (!reg) return null;
    const effectiveFrontier = this.resolveChannelFrontier(channelId);
    return {
      active: isOverrideActive(reg, effectiveFrontier),
      frontier: effectiveFrontier,
    };
  }

  /**
   * Mark a channel as manually unread. Bumps S to `max(S,C)+1`, sets B to the
   * effective frontier. Refuses with `load_incomplete`, `uint32_overflow`, or
   * `budget_exhausted` when applicable.
   */
  markChannelUnread(channelId: string): MarkResult {
    if (!this.isLoadComplete)
      return { success: false, reason: "load_incomplete" };
    const existing = this.overrideRegisters.get(channelId);
    const s = existing?.s ?? 0;
    const c = existing?.c ?? 0;
    const b = existing?.b ?? 0;
    const newS = Math.max(s, c) + 1;
    if (newS > 0xffffffff) return { success: false, reason: "uint32_overflow" };
    const effectiveFrontier = this.resolveChannelFrontier(channelId);
    const newReg: OverrideRegister = {
      s: newS,
      c,
      b: Math.max(b, effectiveFrontier),
    };
    if (this.currentContextsWithOverride(channelId, newReg) === null) {
      return { success: false, reason: "budget_exhausted" };
    }
    this.overrideRegisters.set(channelId, newReg);
    this.publishableContextIds.add(channelId);
    this.persistLocalState();
    this.notifyListeners();
    this.schedulePublish();
    return { success: true };
  }

  /**
   * Mark a channel as read. Bumps C to `max(S,C)+1` (clear-wins).
   * Refuses with `already_inactive` when no active override exists.
   */
  markChannelRead(channelId: string): MarkResult {
    if (!this.isLoadComplete)
      return { success: false, reason: "load_incomplete" };
    const reg = this.overrideRegisters.get(channelId);
    const effectiveFrontier = this.resolveChannelFrontier(channelId);
    if (!reg || !isOverrideActive(reg, effectiveFrontier)) {
      return { success: false, reason: "already_inactive" };
    }
    const newC = Math.max(reg.s, reg.c) + 1;
    if (newC > 0xffffffff) return { success: false, reason: "uint32_overflow" };
    const newReg: OverrideRegister = { s: reg.s, c: newC, b: reg.b };
    // Unreachable: clear-wins means newC > reg.s always. Defensive guard.
    if (isOverrideActive(newReg, effectiveFrontier)) {
      console.error(
        "[ReadStateManager] markChannelRead: override still active after bump",
      );
      return { success: false, reason: "already_inactive" };
    }
    this.overrideRegisters.set(channelId, newReg);
    this.publishableContextIds.add(channelId);
    this.persistLocalState();
    this.notifyListeners();
    this.schedulePublish();
    return { success: true };
  }

  /**
   * Trial budget check: temporarily apply `reg` for `rawCtxId` and call
   * `currentContexts()`. Returns null if budget is exhausted after trim.
   */
  private currentContextsWithOverride(
    rawCtxId: string,
    reg: OverrideRegister,
  ): Record<string, number> | null {
    const prev = this.overrideRegisters.get(rawCtxId);
    this.overrideRegisters.set(rawCtxId, reg);
    const result = this.currentContexts();
    if (prev === undefined) {
      this.overrideRegisters.delete(rawCtxId);
    } else {
      this.overrideRegisters.set(rawCtxId, prev);
    }
    return result;
  }

  private hydrateFromLocalStorage(): void {
    const stored = readStoredReadState(this.pubkey);
    for (const [contextId, timestamp] of stored.contexts)
      this.effectiveState.set(contextId, timestamp);
    for (const contextId of stored.publishableContextIds)
      this.publishableContextIds.add(contextId);
    for (const [contextId, createdAt] of stored.contextSourceCreatedAt)
      this.contextSourceCreatedAt.set(contextId, createdAt);
    this.persistLocalState();
  }

  private persistLocalState(): void {
    writeStoredReadState(
      this.pubkey,
      this.effectiveState,
      this.publishableContextIds,
      this.contextSourceCreatedAt,
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
