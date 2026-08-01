import assert from "node:assert/strict";
import test from "node:test";

import {
  ReadStateManager,
  applyRemoteContextTimestamp,
  resolveEffectiveTimestamp,
  splitContextsIntoBudgetedSlots,
  trimContextsToBudget,
} from "./readStateManager.ts";

// ── ReadStateManager integration helpers ─────────────────────────────────────
// Provide browser globals required by ReadStateManager (localStorage,
// window.setTimeout/clearTimeout). Each test that uses ReadStateManager
// constructs a fresh in-memory store so tests are isolated.

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
}

// Install browser globals required by ReadStateManager. window.localStorage is
// replaced per-test for isolation; the bare `localStorage` global proxies to it.
{
  const ls = makeLocalStorage();
  if (typeof globalThis.window === "undefined") {
    globalThis.window = {
      localStorage: ls,
      clearTimeout: (id) => clearTimeout(id),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
    };
  } else {
    globalThis.window.localStorage = ls;
    if (!globalThis.window.clearTimeout) {
      globalThis.window.clearTimeout = (id) => clearTimeout(id);
      globalThis.window.setTimeout = (fn, ms) => setTimeout(fn, ms);
    }
  }
  // Ensure bare `localStorage` always proxies to window.localStorage.
  Object.defineProperty(globalThis, "localStorage", {
    get: () => globalThis.window.localStorage,
    configurable: true,
  });
}

/**
 * Build a FenceHandle-shaped fake for use in test relay objects.
 *
 * @param {object} opts
 * @param {boolean}  opts.eose      — if true, `established` resolves immediately (EOSE received).
 * @param {boolean}  opts.lapsesAfterEose — if true, `lapsed` becomes true after established resolves.
 * @param {boolean}  opts.lapseBeforeEose — if true, sets lapsed=true and resolves established together.
 * @param {(ev: object) => void} [opts.captureHandler] — called with the onEvent handler so tests can deliver events.
 */
function makeFenceHandle({
  eose = true,
  lapsesAfterEose = false,
  lapseBeforeEose = false,
} = {}) {
  let lapsed = lapseBeforeEose;
  let resolveEstablished;
  const established = new Promise((r) => {
    resolveEstablished = r;
  });

  if (lapseBeforeEose) {
    // Lapsed before EOSE: resolve immediately with lapsed=true.
    resolveEstablished();
  } else if (eose) {
    resolveEstablished();
    if (lapsesAfterEose) lapsed = true;
  }
  // If neither, `established` never resolves (hung fence — caller will lapse via reconnect).

  return {
    established,
    get lapsed() {
      return lapsed;
    },
    unsubscribe: async () => {},
    /** For tests that need to trigger a lapse mid-enumeration. */
    _lapse() {
      lapsed = true;
    },
  };
}

const threadKey = `thread:${"a".repeat(64)}`;
const channelKey = "channel-1";
const channelResolver = (ctx) =>
  ctx.startsWith("thread:") ? channelKey : null;

test("resolveEffectiveTimestamp returns own value when context has no parent", () => {
  const effectiveState = new Map([[channelKey, 200]]);
  const result = resolveEffectiveTimestamp({
    effectiveState,
    contextId: channelKey,
    parentResolver: channelResolver,
  });
  assert.equal(result, 200);
});

test("resolveEffectiveTimestamp inherits the channel frontier when it is newer than the thread", () => {
  // Channel-read clears its threads: marking the channel read at 300 must
  // dominate a thread last read at 100.
  const effectiveState = new Map([
    [threadKey, 100],
    [channelKey, 300],
  ]);
  const result = resolveEffectiveTimestamp({
    effectiveState,
    contextId: threadKey,
    parentResolver: channelResolver,
  });
  assert.equal(result, 300);
});

test("resolveEffectiveTimestamp keeps the thread frontier when it is newer than the channel", () => {
  const effectiveState = new Map([
    [threadKey, 400],
    [channelKey, 300],
  ]);
  const result = resolveEffectiveTimestamp({
    effectiveState,
    contextId: threadKey,
    parentResolver: channelResolver,
  });
  assert.equal(result, 400);
});

test("resolveEffectiveTimestamp returns the channel frontier when the thread was never read", () => {
  const effectiveState = new Map([[channelKey, 300]]);
  const result = resolveEffectiveTimestamp({
    effectiveState,
    contextId: threadKey,
    parentResolver: channelResolver,
  });
  assert.equal(result, 300);
});

test("resolveEffectiveTimestamp degrades to the thread's own value when the root is unresolvable", () => {
  // Resolver returns null (root not in the event graph) → own term only.
  const effectiveState = new Map([
    [threadKey, 100],
    [channelKey, 300],
  ]);
  const result = resolveEffectiveTimestamp({
    effectiveState,
    contextId: threadKey,
    parentResolver: () => null,
  });
  assert.equal(result, 100);
});

test("resolveEffectiveTimestamp degrades to own value when no resolver is set", () => {
  const effectiveState = new Map([
    [threadKey, 100],
    [channelKey, 300],
  ]);
  const result = resolveEffectiveTimestamp({
    effectiveState,
    contextId: threadKey,
    parentResolver: null,
  });
  assert.equal(result, 100);
});

test("resolveEffectiveTimestamp returns null when neither context nor parent has a value", () => {
  const result = resolveEffectiveTimestamp({
    effectiveState: new Map(),
    contextId: threadKey,
    parentResolver: channelResolver,
  });
  assert.equal(result, null);
});

test("applyRemoteContextTimestamp ignores older remote read markers from newer sync events", () => {
  const effectiveState = new Map([["channel-1", 200]]);
  const contextSourceCreatedAt = new Map([["channel-1", 10]]);

  const result = applyRemoteContextTimestamp({
    effectiveState,
    contextSourceCreatedAt,
    contextId: "channel-1",
    timestamp: 100,
    eventCreatedAt: 11,
  });

  assert.equal(result, "unchanged");
  assert.equal(effectiveState.get("channel-1"), 200);
  assert.equal(contextSourceCreatedAt.get("channel-1"), 11);
});

test("applyRemoteContextTimestamp advances to newer remote read markers", () => {
  const effectiveState = new Map([["channel-1", 100]]);
  const contextSourceCreatedAt = new Map([["channel-1", 10]]);

  const result = applyRemoteContextTimestamp({
    effectiveState,
    contextSourceCreatedAt,
    contextId: "channel-1",
    timestamp: 200,
    eventCreatedAt: 11,
  });

  assert.equal(result, "advanced");
  assert.equal(effectiveState.get("channel-1"), 200);
  assert.equal(contextSourceCreatedAt.get("channel-1"), 11);
});

test("applyRemoteContextTimestamp keeps read markers monotonic even if sync events arrive out of order", () => {
  const effectiveState = new Map([["channel-1", 100]]);
  const contextSourceCreatedAt = new Map([["channel-1", 11]]);

  const result = applyRemoteContextTimestamp({
    effectiveState,
    contextSourceCreatedAt,
    contextId: "channel-1",
    timestamp: 200,
    eventCreatedAt: 10,
  });

  assert.equal(result, "advanced");
  assert.equal(effectiveState.get("channel-1"), 200);
  assert.equal(contextSourceCreatedAt.get("channel-1"), 11);
});

// ── trimContextsToBudget ──────────────────────────────────────────────────────

const CLIENT_ID = "test-client-id";
const MSG_ID = "a".repeat(64);
const THREAD_ID = "b".repeat(64);

test("trimContextsToBudget_underBudget_returnsZeroAndLeavesContextsUnchanged", () => {
  const contexts = { [`msg:${MSG_ID}`]: 100 };
  // A very large budget — nothing should be evicted.
  const { evicted, fitsAfterTrim } = trimContextsToBudget(
    contexts,
    CLIENT_ID,
    1_000_000,
  );
  assert.equal(evicted, 0);
  assert.equal(fitsAfterTrim, true);
  assert.ok(`msg:${MSG_ID}` in contexts);
});

test("trimContextsToBudget_overBudget_evictsMsgEntriesOldestFirst", () => {
  // Build a contexts map that exceeds a tiny budget.
  // Three msg entries with timestamps 1 (oldest), 2, 3 (newest).
  const contexts = {
    [`msg:${MSG_ID}`]: 1,
    [`msg:${"c".repeat(64)}`]: 3,
    [`msg:${"d".repeat(64)}`]: 2,
  };
  const encoder = new TextEncoder();
  // Budget that requires evicting at least one entry.
  const budget =
    encoder.encode(JSON.stringify({ v: 1, client_id: CLIENT_ID, contexts }))
      .length - 10;

  const { evicted, fitsAfterTrim } = trimContextsToBudget(
    contexts,
    CLIENT_ID,
    budget,
  );
  assert.ok(evicted >= 1, `expected at least 1 eviction, got ${evicted}`);
  assert.equal(fitsAfterTrim, true);
  // The oldest entry (ts=1) must be gone.
  assert.ok(
    !(`msg:${MSG_ID}` in contexts),
    "oldest msg entry should be evicted",
  );
  // Result must fit within budget.
  const resultSize = encoder.encode(
    JSON.stringify({ v: 1, client_id: CLIENT_ID, contexts }),
  ).length;
  assert.ok(
    resultSize <= budget,
    `result ${resultSize} exceeds budget ${budget}`,
  );
});

test("trimContextsToBudget_channelKeysNeverEvicted", () => {
  // Fill with msg entries plus one channel key; budget forces eviction.
  const contexts = {};
  for (let i = 0; i < 50; i++) {
    contexts[`msg:${i.toString().padStart(64, "0")}`] = i;
  }
  contexts["channel:some-channel-id"] = 999;

  const encoder = new TextEncoder();
  const fullSize = encoder.encode(
    JSON.stringify({ v: 1, client_id: CLIENT_ID, contexts }),
  ).length;
  const budget = Math.floor(fullSize / 2);

  const { fitsAfterTrim } = trimContextsToBudget(contexts, CLIENT_ID, budget);

  // Channel key must survive regardless of how many msg entries were evicted.
  assert.ok(
    "channel:some-channel-id" in contexts,
    "channel key must not be evicted",
  );
  assert.equal(fitsAfterTrim, true);
  const resultSize = encoder.encode(
    JSON.stringify({ v: 1, client_id: CLIENT_ID, contexts }),
  ).length;
  assert.ok(
    resultSize <= budget,
    `result ${resultSize} exceeds budget ${budget}`,
  );
});

test("trimContextsToBudget_msgEvictedBeforeThread", () => {
  // One msg entry (older) and one thread entry (newer).
  // Budget forces exactly one eviction; msg must go first.
  const contexts = {
    [`msg:${MSG_ID}`]: 1,
    [`thread:${THREAD_ID}`]: 2,
  };
  const encoder = new TextEncoder();
  // Tight budget: remove exactly one entry.
  const oneEntrySize = encoder.encode(
    JSON.stringify({
      v: 1,
      client_id: CLIENT_ID,
      contexts: { [`thread:${THREAD_ID}`]: 2 },
    }),
  ).length;
  const budget = oneEntrySize + 5; // fits one entry, not two

  const { evicted, fitsAfterTrim } = trimContextsToBudget(
    contexts,
    CLIENT_ID,
    budget,
  );
  assert.equal(evicted, 1);
  assert.equal(fitsAfterTrim, true);
  assert.ok(
    !(`msg:${MSG_ID}` in contexts),
    "msg entry should be evicted before thread",
  );
  assert.ok(`thread:${THREAD_ID}` in contexts, "thread entry should survive");
});

test("trimContextsToBudget_emptyContexts_returnsZeroAndFits", () => {
  // Empty contexts: blob is just the skeleton — fits any reasonable budget.
  const contexts = {};
  const { evicted, fitsAfterTrim } = trimContextsToBudget(
    contexts,
    CLIENT_ID,
    1_000_000,
  );
  assert.equal(evicted, 0);
  assert.equal(fitsAfterTrim, true);
});

test("trimContextsToBudget_channelOnlyBlobExceedsBudget_fitsAfterTrimFalse", () => {
  // Channel keys cannot be evicted. If the channel-only skeleton exceeds the
  // budget, fitsAfterTrim must be false so the caller can suppress the publish.
  const contexts = {
    "channel:some-channel-id": 100,
  };
  const encoder = new TextEncoder();
  const skeletonSize = encoder.encode(
    JSON.stringify({ v: 1, client_id: CLIENT_ID, contexts }),
  ).length;
  // Budget smaller than the channel-only skeleton — cannot be satisfied.
  const budget = skeletonSize - 1;

  const { evicted, fitsAfterTrim } = trimContextsToBudget(
    contexts,
    CLIENT_ID,
    budget,
  );
  assert.equal(evicted, 0, "no evictable entries exist");
  assert.equal(fitsAfterTrim, false, "channel-only blob still exceeds budget");
  // Channel key must still be present.
  assert.ok("channel:some-channel-id" in contexts);
});

// ── splitContextsIntoBudgetedSlots ────────────────────────────────────────────

// Build a channel key that is ~70 bytes in the JSON blob:
// `"channel-<64-hex>":1` ≈ 70 bytes including quotes, colon, comma.
const makeChannelKey = (n) => `channel-${n.toString().padStart(64, "0")}`;
const makeThreadKey = (n) => `thread:${n.toString().padStart(64, "0")}`;
const makeMsgKey = (n) => `msg:${n.toString().padStart(64, "0")}`;

// Compute the byte size of a single-slot blob with the given contexts.
const blobSize = (clientId, contexts) => {
  const encoder = new TextEncoder();
  return encoder.encode(JSON.stringify({ v: 1, client_id: clientId, contexts }))
    .length;
};

let slotCounter = 0;
const deterministicSlotId = () =>
  `slot-${(++slotCounter).toString().padStart(4, "0")}`;

test("splitContextsIntoBudgetedSlots_fitsInOneSlot_returnsSingleSlot", () => {
  // 3 channel keys — easily fits in one slot with a generous budget.
  const channelEntries = [
    [makeChannelKey(1), 100],
    [makeChannelKey(2), 200],
    [makeChannelKey(3), 300],
  ];
  const result = splitContextsIntoBudgetedSlots({
    channelEntries,
    threadMsgEntries: [],
    clientId: CLIENT_ID,
    initialSlotCount: 1,
    maxSlots: 8,
    maxBytes: 1_000_000,
    slotIdGenerator: deterministicSlotId,
  });

  assert.ok(result !== null, "should succeed");
  assert.equal(result.slots.length, 1, "single slot");
  assert.equal(result.extraSlotIds.length, 0, "no extra slots allocated");
  // All channel keys present in slot 0.
  for (const [key] of channelEntries) {
    assert.ok(key in result.slots[0], `${key} should be in slot 0`);
  }
});

test("splitContextsIntoBudgetedSlots_requiresGrowth_allocatesExtraSlot", () => {
  // Build enough channel keys that a single slot overflows a tight budget
  // but two slots fit.
  const channelEntries = [];
  for (let i = 0; i < 20; i++) {
    channelEntries.push([makeChannelKey(i), i + 1]);
  }
  const encoder = new TextEncoder();
  // Budget that fits ~10 channel keys but not 20.
  const tenKeyContexts = Object.fromEntries(channelEntries.slice(0, 10));
  const tenKeySize = encoder.encode(
    JSON.stringify({ v: 1, client_id: CLIENT_ID, contexts: tenKeyContexts }),
  ).length;
  const budget = tenKeySize + 50; // fits 10 but not 20

  const result = splitContextsIntoBudgetedSlots({
    channelEntries,
    threadMsgEntries: [],
    clientId: CLIENT_ID,
    initialSlotCount: 1,
    maxSlots: 8,
    maxBytes: budget,
    slotIdGenerator: deterministicSlotId,
  });

  assert.ok(result !== null, "should succeed with 2 slots");
  assert.equal(result.slots.length, 2, "two slots");
  assert.equal(result.extraSlotIds.length, 1, "one extra slot allocated");
  // All 20 keys present across both slots.
  const allKeys = new Set([
    ...Object.keys(result.slots[0]),
    ...Object.keys(result.slots[1]),
  ]);
  for (const [key] of channelEntries) {
    assert.ok(allKeys.has(key), `${key} should appear in some slot`);
  }
  // Each slot fits within budget.
  for (const slotContexts of result.slots) {
    const size = encoder.encode(
      JSON.stringify({ v: 1, client_id: CLIENT_ID, contexts: slotContexts }),
    ).length;
    assert.ok(size <= budget, `slot size ${size} exceeds budget ${budget}`);
  }
});

test("splitContextsIntoBudgetedSlots_exceedsMaxSlots_returnsNull", () => {
  // Build enough channel keys that even maxSlots=2 can't fit them with a
  // very tight budget (1 byte — nothing can fit).
  const channelEntries = [[makeChannelKey(1), 1]];
  const result = splitContextsIntoBudgetedSlots({
    channelEntries,
    threadMsgEntries: [],
    clientId: CLIENT_ID,
    initialSlotCount: 1,
    maxSlots: 2,
    maxBytes: 1, // impossibly small
    slotIdGenerator: deterministicSlotId,
  });

  assert.equal(result, null, "should return null when max slots exceeded");
});

test("splitContextsIntoBudgetedSlots_includesThreadMsgInPrimarySlot", () => {
  // Channel key in slot 0; thread and msg entries should also land in slot 0.
  const channelEntries = [[makeChannelKey(1), 100]];
  const threadMsgEntries = [
    [makeThreadKey(1), 200],
    [makeMsgKey(1), 300],
  ];

  const result = splitContextsIntoBudgetedSlots({
    channelEntries,
    threadMsgEntries,
    clientId: CLIENT_ID,
    initialSlotCount: 1,
    maxSlots: 8,
    maxBytes: 1_000_000,
    slotIdGenerator: deterministicSlotId,
  });

  assert.ok(result !== null, "should succeed");
  assert.equal(result.slots.length, 1);
  // Channel key in slot 0.
  assert.ok(makeChannelKey(1) in result.slots[0], "channel key in slot 0");
  // Thread and msg entries in slot 0.
  assert.ok(makeThreadKey(1) in result.slots[0], "thread key in slot 0");
  assert.ok(makeMsgKey(1) in result.slots[0], "msg key in slot 0");
});

test("splitContextsIntoBudgetedSlots_threadMsgTrimmedWhenPrimarySlotOverBudget", () => {
  // Channel key fills the primary slot to near-budget. Thread/msg entries
  // added to slot 0 would overflow — trimContextsToBudget must evict them.
  const channelEntries = [[makeChannelKey(1), 100]];
  // Compute the size of a blob with just the channel key.
  const channelOnlyContexts = { [makeChannelKey(1)]: 100 };
  const channelOnlySize = blobSize(CLIENT_ID, channelOnlyContexts);
  // Budget = channel-only size + 5 bytes: fits the channel key but not
  // an additional thread/msg entry (~70+ bytes each).
  const budget = channelOnlySize + 5;

  const threadMsgEntries = [[makeThreadKey(1), 200]];

  const result = splitContextsIntoBudgetedSlots({
    channelEntries,
    threadMsgEntries,
    clientId: CLIENT_ID,
    initialSlotCount: 1,
    maxSlots: 8,
    maxBytes: budget,
    slotIdGenerator: deterministicSlotId,
  });

  assert.ok(result !== null, "should succeed");
  // Channel key must survive (never evicted by trimContextsToBudget).
  assert.ok(makeChannelKey(1) in result.slots[0], "channel key survives");
  // Thread entry must be evicted (doesn't fit within budget).
  assert.ok(
    !(makeThreadKey(1) in result.slots[0]),
    "thread key evicted to fit budget",
  );
  // Slot 0 must fit within budget.
  const size = blobSize(CLIENT_ID, result.slots[0]);
  assert.ok(size <= budget, `slot 0 size ${size} exceeds budget ${budget}`);
});

// ── ReadStateManager.publish — no-op suppression in split mode ────────────────

// Verify that publishSplitSlots returns early (no relay writes) when the
// union of all slot contexts is identical to lastPublishedContexts.
//
// Strategy: construct a ReadStateManager with enough channel keys to force
// split mode, then mock publishOneSlot (private, accessed via bracket notation)
// to avoid tauri calls while still simulating its effect on lastPublishedContexts.
// Call publish() twice with the same effectiveState and assert that
// publishOneSlot is called only on the first publish (no-op on the second).
test("publishSplitSlots_noopSuppression_skipsWhenUnchanged", async () => {
  // Isolate localStorage so slot IDs don't leak between tests.
  globalThis.window.localStorage = makeLocalStorage();

  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeFenced: async (_filter, _onEvent) =>
      makeFenceHandle({ eose: true }),
    subscribeLive: async (_f, _h) => () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
  };

  const pubkey = "b".repeat(64);
  const mgr = new ReadStateManager(pubkey, fakeRelay);

  // Add enough channel keys to exceed the 32KB single-slot budget.
  // Each key is ~70 bytes in the blob; 700 keys ≈ 49KB > 32KB.
  const ts = 1_000_000;
  for (let i = 0; i < 700; i++) {
    const channelId = `channel-${i.toString().padStart(64, "0")}`;
    mgr.markContextRead(channelId, ts);
  }

  // Confirm split mode: currentContexts() must return null.
  assert.equal(
    mgr.currentContexts(),
    null,
    "precondition: 700 channel keys must exceed single-slot budget",
  );

  // Replace publishOneSlot with a stub that records calls and simulates the
  // lastPublishedContexts merge (the only side-effect the no-op check depends
  // on). This avoids tauri (nip44EncryptToSelf / signRelayEvent) while keeping
  // the suppression logic under test.
  let publishOneSlotCallCount = 0;
  mgr.publishOneSlot = async (_slotId, contexts) => {
    publishOneSlotCallCount++;
    for (const [key, tsVal] of Object.entries(contexts)) {
      mgr.lastPublishedContexts[key] = tsVal;
    }
  };

  // Simulate a completed full-state load so the truncation guard does not
  // block the publish path. The guard is tested separately.
  mgr.isLoadComplete = true;

  // First publish: contexts differ from lastPublishedContexts ({}) → must publish.
  await mgr.publish();
  const callsAfterFirst = publishOneSlotCallCount;
  assert.ok(callsAfterFirst > 0, "first publish must call publishOneSlot");

  // Second publish with identical effectiveState: union equals lastPublishedContexts
  // → no-op suppression must fire → publishOneSlot must NOT be called again.
  await mgr.publish();
  assert.equal(
    publishOneSlotCallCount,
    callsAfterFirst,
    "second publish with unchanged state must not call publishOneSlot (no-op suppression)",
  );

  mgr.destroy();
});

// ── NIP-RS override layer: mandatory acceptance tests ─────────────────────────

// Helper: build a ReadStateManager with mocked relay and localStorage.
// subscribeFenced returns an immediately-established fence (happy path).
// subscribeLive is still wired for the live subscription path.
function makeManager(pubkey = "a".repeat(64)) {
  globalThis.window.localStorage = makeLocalStorage();
  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeFenced: async (_filter, _onEvent) =>
      makeFenceHandle({ eose: true }),
    subscribeLive: async (_f, _h) => () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
  };
  return new ReadStateManager(pubkey, fakeRelay);
}

// ── Test 1: no ov_* key ever reaches a non-primary slot ──────────────────────
test("splitContextsIntoBudgetedSlots_noOverrideKeyInNonPrimarySlot", () => {
  // Build channel entries that include ov_* keys for two contexts.
  // Also include enough plain channel entries to force multi-slot distribution.
  const ctx1 = "a".repeat(64);
  const ctx2 = "b".repeat(64);

  const ovEntries = [
    [`ov_s:${ctx1}`, 1],
    [`ov_c:${ctx1}`, 0],
    [`ov_b:${ctx1}`, 100],
    [ctx1, 100], // frontier for ctx1 (normal, no escape needed)
    [`ov_s:${ctx2}`, 2],
    [`ov_c:${ctx2}`, 1],
    [`ov_b:${ctx2}`, 200],
    [ctx2, 200], // frontier for ctx2
  ];

  // Add enough plain channel entries to force at least 2 slots.
  // We need the round-robin entries (NOT the pinned ov entries) to overflow.
  const plainChannelEntries = [];
  for (let i = 0; i < 30; i++) {
    plainChannelEntries.push([makeChannelKey(i), i + 1]);
  }
  const channelEntries = [...ovEntries, ...plainChannelEntries];

  const encoder = new TextEncoder();
  // Compute the size of a slot containing only the 8 override+frontier entries.
  const ovOnlyContexts = Object.fromEntries(ovEntries);
  const ovOnlySize = encoder.encode(
    JSON.stringify({ v: 1, client_id: CLIENT_ID, contexts: ovOnlyContexts }),
  ).length;
  // Budget: fits the override entries + ~10 plain entries per slot,
  // but not all 30 plain entries in one slot (forces at least 3 slots).
  // Add 15 plain entries to the ov-only size to get a safe per-slot budget.
  const fifteenPlain = Object.fromEntries(plainChannelEntries.slice(0, 15));
  const fifteenPlainSize = encoder.encode(
    JSON.stringify({ v: 1, client_id: CLIENT_ID, contexts: fifteenPlain }),
  ).length;
  const budget = ovOnlySize + fifteenPlainSize;

  const result = splitContextsIntoBudgetedSlots({
    channelEntries,
    threadMsgEntries: [],
    clientId: CLIENT_ID,
    initialSlotCount: 1,
    maxSlots: 8,
    maxBytes: budget,
    slotIdGenerator: deterministicSlotId,
  });

  assert.ok(result !== null, "should succeed");
  assert.ok(result.slots.length >= 2, "should use at least 2 slots");

  // Verify: no ov_* key appears in any non-primary slot.
  for (let slotIdx = 1; slotIdx < result.slots.length; slotIdx++) {
    const slot = result.slots[slotIdx];
    for (const key of Object.keys(slot)) {
      assert.ok(
        !key.startsWith("ov_"),
        `ov_* key "${key}" must not appear in slot ${slotIdx} (non-primary)`,
      );
    }
  }

  // Verify: ov_* keys and their frontier siblings ARE in slot 0.
  const slot0 = result.slots[0];
  assert.ok(`ov_s:${ctx1}` in slot0, "ov_s:ctx1 must be in slot 0");
  assert.ok(`ov_c:${ctx1}` in slot0, "ov_c:ctx1 must be in slot 0");
  assert.ok(`ov_b:${ctx1}` in slot0, "ov_b:ctx1 must be in slot 0");
  assert.ok(ctx1 in slot0, "frontier for ctx1 must be in slot 0");
  assert.ok(`ov_s:${ctx2}` in slot0, "ov_s:ctx2 must be in slot 0");
  assert.ok(ctx2 in slot0, "frontier for ctx2 must be in slot 0");
});

// ── Test 1b: reserved esc: raw ID — unescape-before-group rule ───────────────
test("splitContextsIntoBudgetedSlots_escapedFrontierKeyStaysWithItsOverrideGroup", () => {
  // A context whose raw ID starts with "ov_" must be escaped to "esc:ov_s:evil"
  // as a frontier wire key.  The ov_* siblings are keyed by the RAW suffix
  // "ov_s:evil".  The splitter must unescape "esc:ov_s:evil" → "ov_s:evil"
  // and recognise it as belonging to the same group as ov_s:ov_s:evil etc.
  const rawCtx = "ov_s:evil";
  const wireKey = `esc:${rawCtx}`; // what currentContexts() emits

  const channelEntries = [
    [`ov_s:${rawCtx}`, 1], // ov_s:ov_s:evil
    [`ov_c:${rawCtx}`, 0], // ov_c:ov_s:evil
    [`ov_b:${rawCtx}`, 50], // ov_b:ov_s:evil
    [wireKey, 50], // esc:ov_s:evil  (escaped frontier)
  ];
  // Add plain entries to force multi-slot so the splitter actually partitions.
  const plain = [];
  for (let i = 0; i < 20; i++) plain.push([makeChannelKey(i), i + 1]);
  const allEntries = [...channelEntries, ...plain];

  const encoder = new TextEncoder();
  // Budget: fits the override group + 5 plain entries, not all 20.
  const groupOnly = Object.fromEntries(channelEntries);
  const fivePlain = Object.fromEntries(plain.slice(0, 5));
  const budget =
    encoder.encode(
      JSON.stringify({ v: 1, client_id: CLIENT_ID, contexts: groupOnly }),
    ).length +
    encoder.encode(
      JSON.stringify({ v: 1, client_id: CLIENT_ID, contexts: fivePlain }),
    ).length;

  const result = splitContextsIntoBudgetedSlots({
    channelEntries: allEntries,
    threadMsgEntries: [],
    clientId: CLIENT_ID,
    initialSlotCount: 1,
    maxSlots: 8,
    maxBytes: budget,
    slotIdGenerator: deterministicSlotId,
  });

  assert.ok(result !== null, "should succeed");
  assert.ok(result.slots.length >= 2, "should split");
  const slot0 = result.slots[0];
  // The escaped frontier key and all three ov_* siblings must be in slot 0.
  assert.ok(
    wireKey in slot0,
    `${wireKey} (escaped frontier) must be in slot 0`,
  );
  assert.ok(`ov_s:${rawCtx}` in slot0, "ov_s: sibling must be in slot 0");
  assert.ok(`ov_c:${rawCtx}` in slot0, "ov_c: sibling must be in slot 0");
  assert.ok(`ov_b:${rawCtx}` in slot0, "ov_b: sibling must be in slot 0");
  // No ov_* or esc: entry in non-primary slots.
  for (let i = 1; i < result.slots.length; i++) {
    for (const key of Object.keys(result.slots[i])) {
      assert.ok(
        !key.startsWith("ov_") && !key.startsWith("esc:"),
        `reserved key "${key}" must not appear in slot ${i}`,
      );
    }
  }
});

// ── Test 2: NIP-RS fenced enumeration — EOSE, lapse, epoch-zero, retry ────────
// All fetchAndMerge tests use subscribeFenced returning a proper FenceHandle so
// the loader only declares complete after an EOSE-established fence.

// Helper to build a minimal valid-looking relay event for the pubkey.
function makeFakeEvent(pubkey, createdAt) {
  return {
    id: `${createdAt.toString(16).padStart(8, "0")}${"0".repeat(56)}`,
    pubkey,
    kind: 30078,
    content: "",
    tags: [],
    created_at: createdAt,
    sig: "s".repeat(128),
  };
}

// ── 2a: empty relay + EOSE → complete ────────────────────────────────────────
test("fetchAndMerge_emptyRelay_setsLoadComplete", async () => {
  // A relay with no events + EOSE-established fence → empty first band → complete.
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "a".repeat(64);
  let subscribeFencedCallCount = 0;
  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_filter, _onEvent) => {
      subscribeFencedCallCount++;
      return makeFenceHandle({ eose: true });
    },
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  await mgr.fetchAndMerge();
  assert.equal(
    mgr.isLoadComplete,
    true,
    "empty relay with EOSE-established fence must produce complete load",
  );
  assert.equal(
    subscribeFencedCallCount,
    1,
    "subscribeFenced must be called exactly once for the fence",
  );
  mgr.destroy();
});

// ── 2b: lapse before EOSE → incomplete (250 ms fallback does NOT count) ───────
test("fetchAndMerge_lapseBeforeEose_setsLoadIncomplete", async () => {
  // The fence lapses (lapsed=true) before EOSE resolves — this is the case
  // the old subscribeLive 250 ms fallback would have falsely treated as complete.
  // With a proper fence, lapse before EOSE must force complete:false.
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "a1".repeat(32);
  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_filter, _onEvent) =>
      makeFenceHandle({ eose: false, lapseBeforeEose: true }),
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  await mgr.fetchAndMerge();
  assert.equal(
    mgr.isLoadComplete,
    false,
    "lapse before EOSE (e.g. 250 ms fallback path) must produce incomplete load",
  );
  mgr.destroy();
});

// ── 2c: terminal-CLOSED → lapse → incomplete ─────────────────────────────────
test("fetchAndMerge_terminalClosed_setsLoadIncomplete", async () => {
  // Relay sends CLOSED before EOSE: fence.lapsed=true, established resolves.
  // CLOSED does NOT count as EOSE — load must be incomplete.
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "a2".repeat(32);
  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_filter, _onEvent) =>
      makeFenceHandle({ eose: false, lapseBeforeEose: true }),
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  await mgr.fetchAndMerge();
  assert.equal(
    mgr.isLoadComplete,
    false,
    "terminal CLOSED (fence lapse before EOSE) must produce incomplete load",
  );
  mgr.destroy();
});

// ── 2d: reconnect during post-empty barrier → lapse after tentative complete ──
test("fetchAndMerge_lapseAfterEmptyBand_forcesIncomplete", async () => {
  // Empty first band → loader sets complete=true tentatively; fence lapses
  // after EOSE (simulates mid-load reconnect). Final fence.lapsed check must
  // override and force complete:false.
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "a3".repeat(32);
  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_filter, _onEvent) =>
      makeFenceHandle({ eose: true, lapsesAfterEose: true }),
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  await mgr.fetchAndMerge();
  assert.equal(
    mgr.isLoadComplete,
    false,
    "lapse after tentative complete must override and force incomplete",
  );
  mgr.destroy();
});

// ── 2e: single event completes after pinned-window discharge ──────────────────
test("fetchAndMerge_singleEvent_completesAfterPinnedWindowDischarge", async () => {
  // Single event at T=1000: band=1, C=1, L=2 → max(C,L)=2.
  // Pinned window {since:1000, until:1000} returns 1 event → 1 < 2 → discharged.
  // Continuation {until:999} returns 0 → complete.
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "b".repeat(64);
  const event = makeFakeEvent(pubkey, 1000);
  const fakeRelay = {
    fetchEvents: async (filter) => {
      if (filter.since !== undefined && filter.until !== undefined)
        return [event]; // pinned
      if (filter.until !== undefined && filter.until < 1000) return []; // continuation
      return [event]; // initial band
    },
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_filter, _onEvent) =>
      makeFenceHandle({ eose: true }),
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  await mgr.fetchAndMerge();
  assert.equal(
    mgr.isLoadComplete,
    true,
    "single-event relay must produce complete load after pinned-window discharge",
  );
  mgr.destroy();
});

// ── 2f: pinned-window-at-cap → incomplete ────────────────────────────────────
test("fetchAndMerge_pinnedWindowAtCap_setsLoadIncomplete", async () => {
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "c".repeat(64);
  const events = [
    makeFakeEvent(pubkey, 2000),
    makeFakeEvent(pubkey, 2000),
    makeFakeEvent(pubkey, 2000),
  ];
  const fakeRelay = {
    fetchEvents: async (filter) => {
      if (filter.since !== undefined) return events; // pinned window returns cap-many
      return events;
    },
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_filter, _handler) =>
      makeFenceHandle({ eose: true }),
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  await mgr.fetchAndMerge();
  assert.equal(
    mgr.isLoadComplete,
    false,
    "pinned window returning ≥ max(C,L) must produce incomplete load",
  );
  mgr.destroy();
});

// ── 2g: epoch-zero termination ───────────────────────────────────────────────
test("fetchAndMerge_epochZero_completesAfterEmptyContinuation", async () => {
  // T=0: an event at created_at=0 → T=0. The continuation query `until:0`
  // with no `since` returns empty → history exhausted → complete.
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "a4".repeat(32);
  const event = makeFakeEvent(pubkey, 0); // created_at=0
  const fakeRelay = {
    fetchEvents: async (filter) => {
      if (filter.since !== undefined) return [event]; // pinned window: 1 < max(1,2)=2 → discharged
      if (filter.until === 0 && filter.since === undefined) return []; // T=0 continuation → complete
      return [event]; // initial band
    },
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_filter, _onEvent) =>
      makeFenceHandle({ eose: true }),
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  await mgr.fetchAndMerge();
  assert.equal(
    mgr.isLoadComplete,
    true,
    "T=0 with empty continuation must produce complete load",
  );
  mgr.destroy();
});

// ── 2h: subscribeFenced throws → fence fails → incomplete ────────────────────
test("fetchAndMerge_fenceFails_setsLoadIncomplete", async () => {
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "d".repeat(64);
  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async () => {
      throw new Error("connection refused");
    },
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  await mgr.fetchAndMerge();
  assert.equal(
    mgr.isLoadComplete,
    false,
    "subscribeFenced failure must produce incomplete load",
  );
  mgr.destroy();
});

// ── 2i: incomplete load blocks gated operations ───────────────────────────────
test("fetchAndMerge_incompleteLoad_blocksGatedOperations", async () => {
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "e".repeat(64);
  const events = [
    makeFakeEvent(pubkey, 1000),
    makeFakeEvent(pubkey, 1000),
    makeFakeEvent(pubkey, 1000),
  ];
  let publishCalls = 0;
  const fakeRelay = {
    fetchEvents: async (filter) => {
      if (filter.since !== undefined) return events; // pinned window
      return events; // band
    },
    publishEvent: async () => {
      publishCalls++;
    },
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_f, _h) => makeFenceHandle({ eose: true }),
    subscribeLive: async (_f, _h) => () => {},
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  mgr.markContextRead("ch", 1000);
  await mgr.fetchAndMerge();

  assert.equal(mgr.isLoadComplete, false, "precondition: load is incomplete");

  mgr.fetchOwnBlobBeforePublish = async () => true;
  await mgr.publish();
  assert.equal(publishCalls, 0, "publish must be blocked when load incomplete");

  const ur = mgr.markChannelUnread("ch");
  assert.equal(ur.success, false);
  assert.equal(ur.reason, "load_incomplete");

  const rr = mgr.markChannelRead("ch");
  assert.equal(rr.success, false);
  assert.equal(rr.reason, "load_incomplete");

  mgr.extraSlotIds = ["fakeextraslot0000000000000000000"];
  await mgr.deleteExtraSlots();
  assert.equal(
    publishCalls,
    0,
    "deleteExtraSlots must not publish when load incomplete",
  );

  mgr.destroy();
});

// ── 2j: production retry path fires on reconnect ─────────────────────────────
test("retryLoad_firesOnReconnect_andClearsIncomplete", async () => {
  // startLiveSubscription wires retryLoad() via subscribeToReconnects.
  // (1) reconnect listener registered; (2) firing it re-runs fetchAndMerge.
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "a5".repeat(32);
  let reconnectCb = null;
  let callRound = 0;
  const fakeRelay = {
    fetchEvents: async (filter) => {
      callRound++;
      if (callRound <= 3) {
        if (filter.since !== undefined)
          return [
            makeFakeEvent(pubkey, 1000),
            makeFakeEvent(pubkey, 1000),
            makeFakeEvent(pubkey, 1000),
          ];
        return [
          makeFakeEvent(pubkey, 1000),
          makeFakeEvent(pubkey, 1000),
          makeFakeEvent(pubkey, 1000),
        ];
      }
      return [];
    },
    publishEvent: async () => {},
    subscribeToReconnects: (cb) => {
      reconnectCb = cb;
      return () => {
        reconnectCb = null;
      };
    },
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_f, _h) => makeFenceHandle({ eose: true }),
    subscribeLive: async (_f, _h) => () => {},
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  await mgr.initialize();
  assert.equal(
    mgr.isLoadComplete,
    false,
    "precondition: first load is incomplete",
  );
  assert.ok(
    reconnectCb !== null,
    "subscribeToReconnects listener must be registered",
  );

  callRound = 999;
  reconnectCb();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    mgr.isLoadComplete,
    true,
    "reconnect-triggered retry must clear incomplete when relay is now empty",
  );
  mgr.destroy();
});

// ── 2k: direct retry clears incomplete ───────────────────────────────────────
test("fetchAndMerge_retryClears_incomplete", async () => {
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "f".repeat(64);
  let callRound = 0;
  const fakeRelay = {
    fetchEvents: async (filter) => {
      callRound++;
      if (callRound <= 3) {
        if (filter.since !== undefined)
          return [
            makeFakeEvent(pubkey, 1000),
            makeFakeEvent(pubkey, 1000),
            makeFakeEvent(pubkey, 1000),
          ];
        return [
          makeFakeEvent(pubkey, 1000),
          makeFakeEvent(pubkey, 1000),
          makeFakeEvent(pubkey, 1000),
        ];
      }
      return [];
    },
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_f, _h) => makeFenceHandle({ eose: true }),
    subscribeLive: async (_f, _h) => () => {},
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  await mgr.fetchAndMerge();
  assert.equal(mgr.isLoadComplete, false, "first load must be incomplete");

  callRound = 999;
  await mgr.fetchAndMerge();
  assert.equal(
    mgr.isLoadComplete,
    true,
    "retry with empty relay must set complete",
  );
  mgr.destroy();
});

// ── Test 3: live events go through structured ingest ──────────────────────────
test("handleIncomingEvent_liveOverride_updatesRegisterViaIngest", async () => {
  // Construct a fake event whose content decrypts to a NIP-RS blob with an
  // override register.  Use a __TAURI_INTERNALS__ mock so parseReadStateEvent
  // can decrypt without a real NIP-44 key.
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "aa".repeat(32);
  const rawCtx = `live-channel-${"x".repeat(51)}`;
  const channelFrontier = 100;
  // Build a blob where the register (S=3, C=1, B=50) is ACTIVE:
  // isOverrideActive = S>0 && F<=B && S>C. B=50, frontier=100 → F>B → INACTIVE.
  // Corrected: to make this active we need B >= F, e.g. B=100 with F=100 (boundary).
  // Using B=100 so the register is genuinely active: 3>0, 100<=100, 3>1 → active.
  const blobContexts = {
    [rawCtx]: channelFrontier,
    [`ov_s:${rawCtx}`]: 3,
    [`ov_c:${rawCtx}`]: 1,
    [`ov_b:${rawCtx}`]: 100, // B=100 >= F=100 → active
  };
  const plaintext = JSON.stringify({
    v: 1,
    client_id: "other-device",
    contexts: blobContexts,
  });

  // Install Tauri IPC mock so nip44_decrypt_from_self returns our plaintext.
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command === "nip44_decrypt_from_self") {
        if (args.ciphertext === "FAKE_CIPHER") return plaintext;
        throw new Error("unknown ciphertext");
      }
      throw new Error(`Unexpected Tauri command: ${command}`);
    },
  };

  let liveHandler = null;
  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_filter, _onEvent) =>
      makeFenceHandle({ eose: true }),
    subscribeLive: async (_filter, handler) => {
      liveHandler = handler;
      return () => {};
    },
  };
  try {
    const mgr = new ReadStateManager(pubkey, fakeRelay);
    await mgr.initialize();

    // Build fake NIP-RS event.
    const fakeEvent = {
      id: "b".repeat(64),
      pubkey,
      created_at: 2_000_000,
      kind: 30078,
      tags: [
        ["d", "read-state:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"],
        ["t", "read-state"],
      ],
      content: "FAKE_CIPHER",
      sig: "s".repeat(128),
    };

    // Deliver via the live subscription callback (same path as relay push).
    // Track decrypt count: each live event must decrypt exactly once.
    let decryptCount = 0;
    const origInvoke = globalThis.window.__TAURI_INTERNALS__.invoke;
    globalThis.window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "nip44_decrypt_from_self") decryptCount++;
      return origInvoke(command, args);
    };
    assert.ok(liveHandler !== null, "live subscription must be established");
    liveHandler(fakeEvent); // void-wrapped; wait for async completion
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      decryptCount,
      1,
      "live event must decrypt exactly once (no double-parse)",
    );

    // The override register must now reflect the ingested remote values.
    const reg = mgr.overrideRegisters.get(rawCtx);
    assert.ok(reg, "override register must exist after live delivery");
    assert.equal(reg.s, 3, "S must be 3 from live event");
    assert.equal(reg.c, 1, "C must be 1 from live event");
    assert.equal(reg.b, 100, "B must be 100 from live event");

    // Verify the register is genuinely active: isOverrideActive(S=3,C=1,B=100,F=100).
    const livenessActive = mgr.getOverrideLiveness(rawCtx);
    assert.ok(
      livenessActive !== null,
      "liveness must be available after live delivery",
    );
    assert.equal(
      livenessActive.active,
      true,
      "register must be active (B=100 >= F=100, S>C)",
    );

    // ── existing-key live clear (higher C defeating S) ───────────────────
    // A follow-up event with S=3, C=4 (C > S → inactive/tombstone).
    const blobClear = {
      [rawCtx]: channelFrontier,
      [`ov_c:${rawCtx}`]: 4, // tombstone floor: max(S=3,C=1)+1=4
    };
    const ptClear = JSON.stringify({
      v: 1,
      client_id: "other-device-2",
      contexts: blobClear,
    });
    const fakeEventClear = {
      id: "c".repeat(64),
      pubkey,
      created_at: 2_000_001,
      kind: 30078,
      tags: [
        ["d", "read-state:b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"],
        ["t", "read-state"],
      ],
      content: "FAKE_CIPHER_2",
      sig: "s".repeat(128),
    };
    globalThis.window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "nip44_decrypt_from_self") {
        if (args.ciphertext === "FAKE_CIPHER_2") return ptClear;
        if (args.ciphertext === "FAKE_CIPHER") return plaintext;
        throw new Error("unknown ciphertext");
      }
      throw new Error(`Unexpected Tauri command: ${command}`);
    };
    liveHandler(fakeEventClear); // void-wrapped; wait for async completion
    await new Promise((r) => setTimeout(r, 50));
    const regAfterClear = mgr.overrideRegisters.get(rawCtx);
    assert.ok(regAfterClear, "register must still exist after clear event");
    // tombstone floor: only ov_c:ctx=4 is present → S=0, C=4, B=0 merged via componentwise max
    // after merge with prior (S=3, C=1, B=100): S=3, C=4, B=100 — override_active = S <= C = inactive
    assert.equal(
      regAfterClear.c,
      4,
      "C must be 4 (tombstone floor from clear event)",
    );
    const liveness = mgr.getOverrideLiveness(rawCtx);
    assert.ok(liveness !== null, "liveness must be available");
    assert.equal(
      liveness.active,
      false,
      "override must be inactive after clear",
    );

    mgr.destroy();
  } finally {
    delete globalThis.window.__TAURI_INTERNALS__;
  }
});

// ── Test 4: fetch-before-write failure → zero publishes ──────────────────────
test("publish_fetchOwnBlobFails_doesNotPublish", async () => {
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "bb".repeat(32);
  let publishCalls = 0;
  const fakeRelay = {
    fetchEvents: async (filter) => {
      // Own-blob fetch (has #d filter) → fail.
      if (filter["#d"]) throw new Error("relay unreachable");
      return [];
    },
    publishEvent: async () => {
      publishCalls++;
    },
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_f, _h) => makeFenceHandle({ eose: true }),
    subscribeLive: async (_f, _h) => () => {},
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  mgr.isLoadComplete = true;
  mgr.markContextRead("ch", 1000);
  await mgr.publish();
  assert.equal(
    publishCalls,
    0,
    "publish must not call publishEvent when fetchOwnBlobBeforePublish fails",
  );
  mgr.destroy();
});

// ── Test 5: durability — register survives restart before debounce ────────────
test("overrideRegister_survivesRestartBeforeDebounce", () => {
  // markChannelUnread persists the register via persistLocalState.
  // A new ReadStateManager constructed from the same localStorage must see it.
  const ls = makeLocalStorage();
  globalThis.window.localStorage = ls;
  const pubkey = "cc".repeat(32);
  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_f, _h) => makeFenceHandle({ eose: true }),
    subscribeLive: async (_f, _h) => () => {},
  };
  const mgr1 = new ReadStateManager(pubkey, fakeRelay);
  mgr1.isLoadComplete = true;
  mgr1.effectiveState.set("restart-ch", 1000);
  mgr1.publishableContextIds.add("restart-ch");
  const result = mgr1.markChannelUnread("restart-ch");
  assert.equal(result.success, true, "mark-unread must succeed");
  mgr1.destroy();

  // Construct a new manager on the same localStorage — no relay fetch yet.
  globalThis.window.localStorage = ls;
  const mgr2 = new ReadStateManager(pubkey, fakeRelay);
  mgr2.hydrateFromLocalStorage();
  const liveness = mgr2.getOverrideLiveness("restart-ch");
  assert.ok(liveness !== null, "register must be hydrated after restart");
  assert.equal(
    liveness.active,
    true,
    "override must still be active after restart",
  );
  mgr2.destroy();
});

// ── Test 6: durability — tombstone floor survives restart with fetch failure ──
test("overrideRegister_tombstoneFloorSurvivesRestartWithFetchFailure", async () => {
  const ls = makeLocalStorage();
  globalThis.window.localStorage = ls;
  const pubkey = "dd".repeat(32);
  const goodRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_f, _h) => makeFenceHandle({ eose: true }),
    subscribeLive: async (_f, _h) => () => {},
  };
  // Establish a mark-read tombstone floor: S=1, C=max(S,C)+1=2 (clear-wins → inactive).
  const mgr1 = new ReadStateManager(pubkey, goodRelay);
  mgr1.isLoadComplete = true;
  mgr1.effectiveState.set("tombstone-ch", 500);
  mgr1.publishableContextIds.add("tombstone-ch");
  mgr1.markChannelUnread("tombstone-ch"); // S→max(0,0)+1=1, C=0, B→frontier
  mgr1.markChannelRead("tombstone-ch"); // C→max(1,0)+1=2 (clear-wins)
  const tomb = mgr1.overrideRegisters.get("tombstone-ch");
  assert.ok(tomb, "tombstone register must exist");
  assert.equal(tomb.s, 1);
  assert.equal(tomb.c, 2); // max(S=1,C=0)+1 = 2
  mgr1.destroy();

  // New manager: initialize() with a relay that throws on fetchEvents.
  // Tombstone must still be present even after failed fetch.
  globalThis.window.localStorage = ls;
  const failRelay = {
    fetchEvents: async () => {
      throw new Error("network unavailable");
    },
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async () => {
      throw new Error("network unavailable");
    },
    subscribeLive: async () => {
      throw new Error("network unavailable");
    },
  };
  const mgr2 = new ReadStateManager(pubkey, failRelay);
  await mgr2.initialize(); // fetch fails, but hydration must have run first
  const reg = mgr2.overrideRegisters.get("tombstone-ch");
  assert.ok(reg, "tombstone register must survive restart with fetch failure");
  assert.equal(reg.s, 1, "S must be preserved");
  assert.equal(reg.c, 2, "C must be preserved (tombstone floor: max(1,0)+1=2)");
  mgr2.destroy();
});

// ── Test 7: budget planner ────────────────────────────────────────────────────
test("markChannelUnread_visibleRefusal_atBudgetExhaustionAndUint32Max", () => {
  const mgr = makeManager();
  // Simulate completed load so mark operations are not blocked by load_incomplete.
  mgr.isLoadComplete = true;

  // ── uint32 max refusal ────────────────────────────────────────────────────
  const UINT32_MAX = 0xffffffff;
  const overflowCtx = "overflow-channel";
  mgr.overrideRegisters.set(overflowCtx, {
    s: UINT32_MAX,
    c: UINT32_MAX,
    b: 0,
  });
  mgr.publishableContextIds.add(overflowCtx);
  mgr.effectiveState.set(overflowCtx, 100);

  const overflowResult = mgr.markChannelUnread(overflowCtx);
  assert.equal(overflowResult.success, false);
  assert.equal(
    overflowResult.reason,
    "uint32_overflow",
    "markChannelUnread must refuse with uint32_overflow when S is at max",
  );

  // ── multi-slot success: 700 frontier-only channels → split planner must succeed ─
  // Thufir's deterministic witness: 700 plain frontier channels overflow a single slot
  // but the splitter can spread them across ≤ 8 slots. A new override group in the
  // primary must succeed because the pure candidate planner tries the split path.
  const splitMgr = makeManager("f".repeat(64));
  splitMgr.isLoadComplete = true;
  for (let i = 0; i < 700; i++) {
    const ctx = `frontier-ch-${i.toString().padStart(60, "0")}`;
    splitMgr.effectiveState.set(ctx, 1000 + i);
    splitMgr.publishableContextIds.add(ctx);
  }
  const splitCtx = `new-override-ctx-${"n".repeat(48)}`;
  const splitResult = splitMgr.markChannelUnread(splitCtx);
  assert.equal(
    splitResult.success,
    true,
    "700 frontier-only channels must allow a new override via multi-slot split",
  );
  assert.ok(
    splitMgr.overrideRegisters.has(splitCtx),
    "override register must be committed on split success",
  );
  splitMgr.destroy();

  // ── near-limit refusal: all 8 slots insufficient → budget_exhausted, no mutation ─
  // Pack so many non-evictable override groups that even 8 slots cannot accommodate
  // the new entry. Each override group contributes ov_s+ov_c+ov_b+frontier ≈ 4 keys
  // × ~75 bytes each + JSON overhead.  200 groups × 4 keys ≈ 300 bytes each ≈ 60 KB
  // per slot if split across 8 → ~7.5 KB per slot, which fits. We need them to NOT fit.
  // Easiest: fill primary to near-capacity with 250 big-key override groups so even
  // splitting all 8 slots still cannot carry the new group in primary (which must
  // hold ALL override groups per spec, so they all go in slot 0).
  const fullMgr = makeManager("aa".repeat(32));
  fullMgr.isLoadComplete = true;
  // 250 override groups with long context IDs ≈ 250 × (4 keys × ~100 bytes) = 100 KB
  // → exceeds READ_STATE_MAX_PLAINTEXT_BYTES (32 KB) even in slot 0 alone.
  for (let i = 0; i < 250; i++) {
    const ctx = `ov-ch-${i.toString().padStart(60, "0")}`;
    fullMgr.overrideRegisters.set(ctx, { s: 1, c: 0, b: 0 });
    fullMgr.effectiveState.set(ctx, 1000 + i);
    fullMgr.publishableContextIds.add(ctx);
  }
  const nearCtx = `near-limit-ctx-${"z".repeat(49)}`;
  const nearResult = fullMgr.markChannelUnread(nearCtx);
  assert.equal(
    nearResult.success,
    false,
    "near-limit manager with 250 non-evictable override groups must refuse",
  );
  assert.equal(nearResult.reason, "budget_exhausted");
  assert.ok(
    !fullMgr.overrideRegisters.has(nearCtx),
    "budget_exhausted must not mutate overrideRegisters",
  );
  fullMgr.destroy();

  // Verify the uint32_overflow register was not mutated in the original mgr.
  const reg = mgr.overrideRegisters.get(overflowCtx);
  assert.ok(reg, "overflow channel register must still exist");
  assert.equal(reg.s, UINT32_MAX, "overflow register S must be unchanged");

  mgr.destroy();
});

// ── Test 8: persistence failure — storage_failed + rollback + coherent restart ─
test("markChannelUnread_storageFailure_returnsStorageFailed", () => {
  // Use a throwing localStorage to simulate quota failure.
  const throwingLS = makeLocalStorage();
  const originalSetItem = throwingLS.setItem.bind(throwingLS);
  // Allow initial writes (ClientId, slotId), then fail on override writes.
  let writeCount = 0;
  throwingLS.setItem = (key, value) => {
    writeCount++;
    if (writeCount > 2) throw new Error("QuotaExceededError");
    originalSetItem(key, value);
  };
  globalThis.window.localStorage = throwingLS;
  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeFenced: async (_f, _h) => makeFenceHandle({ eose: true }),
    subscribeLive: async (_f, _h) => () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
  };
  const mgr = new ReadStateManager("st".repeat(32), fakeRelay);
  mgr.isLoadComplete = true;
  mgr.effectiveState.set("storage-test-ch", 1000);

  // Snapshot pre-mutation state for rollback verification.
  const regBefore = mgr.overrideRegisters.get("storage-test-ch");
  const wasPublishableBefore = mgr.publishableContextIds.has("storage-test-ch");

  const result = mgr.markChannelUnread("storage-test-ch");
  assert.equal(
    result.success,
    false,
    "markChannelUnread must fail when localStorage throws",
  );
  assert.equal(result.reason, "storage_failed");

  // Contract 3 rollback: manager state must be unchanged after storage_failed.
  const regAfter = mgr.overrideRegisters.get("storage-test-ch");
  assert.deepEqual(
    regAfter,
    regBefore,
    "overrideRegisters must be rolled back after storage failure",
  );
  assert.equal(
    mgr.publishableContextIds.has("storage-test-ch"),
    wasPublishableBefore,
    "publishableContextIds must be rolled back after storage failure",
  );

  // Coherent restart: a new manager on the same (throwing) storage must see no
  // orphaned register — the failed write must not have partially persisted.
  const mgr2 = new ReadStateManager("st".repeat(32), fakeRelay);
  mgr2.hydrateFromLocalStorage();
  const regOnRestart = mgr2.overrideRegisters.get("storage-test-ch");
  assert.equal(
    regOnRestart,
    undefined,
    "a failed mark must not persist any register (coherent restart)",
  );
  mgr.destroy();
  mgr2.destroy();
});

// ── Test 9: inactive existing register still gets C-bump on markChannelRead ───
test("markChannelRead_inactiveExistingRegister_performsCBump", () => {
  const mgr = makeManager();
  mgr.isLoadComplete = true;
  // Inject an inactive register: S=1, C=2 (clear-wins: C > S → inactive).
  const ctx = "inactive-ch";
  mgr.overrideRegisters.set(ctx, { s: 1, c: 2, b: 0 });
  mgr.publishableContextIds.add(ctx);
  mgr.effectiveState.set(ctx, 100);

  // Verify it is indeed inactive.
  const livenessBefore = mgr.getOverrideLiveness(ctx);
  assert.ok(livenessBefore !== null, "register must exist");
  assert.equal(livenessBefore.active, false, "register must be inactive");

  // markChannelRead must still perform the C-bump (spec NIP-RS.md:537-539).
  const result = mgr.markChannelRead(ctx);
  assert.equal(
    result.success,
    true,
    "markChannelRead must succeed on inactive register",
  );

  const reg = mgr.overrideRegisters.get(ctx);
  assert.ok(reg, "register must still exist after markChannelRead");
  // newC = max(S=1, C=2) + 1 = 3
  assert.equal(
    reg.c,
    3,
    "C must be bumped to max(S,C)+1=3 even when already inactive",
  );
  assert.equal(reg.s, 1, "S must be unchanged");
  mgr.destroy();
});

// ── Test 10: coordinate dedupe — newer version wins, older version dropped ────
test("deduplicateByCoordinate_newerVersionWins_olderDropped", async () => {
  const { deduplicateByCoordinate } = await import(
    "./readStateFencedLoader.ts"
  );
  const pubkey = "de".repeat(32);
  const dTag = "read-state:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
  const older = {
    id: "b".repeat(64),
    pubkey,
    created_at: 1_000,
    kind: 30078,
    tags: [["d", dTag]],
    content: "older",
    sig: "s".repeat(128),
  };
  const newer = {
    id: "a".repeat(64), // lower id — for tie-break test below
    pubkey,
    created_at: 2_000,
    kind: 30078,
    tags: [["d", dTag]],
    content: "newer",
    sig: "s".repeat(128),
  };
  const deduped = deduplicateByCoordinate([older, newer]);
  assert.equal(deduped.length, 1, "dedup must yield one event");
  assert.equal(deduped[0].content, "newer", "newer created_at must win");

  // Tie-break: same created_at, lower id wins.
  const tie1 = { ...older, created_at: 3_000, id: "c".repeat(64) };
  const tie2 = { ...newer, created_at: 3_000, id: "a".repeat(64) };
  const tieDuped = deduplicateByCoordinate([tie1, tie2]);
  assert.equal(tieDuped.length, 1, "tie-break dedup must yield one event");
  assert.equal(tieDuped[0].id, "a".repeat(64), "lower id must win on tie");
});

// ── Test 11: lapse mid-enumeration → incomplete ───────────────────────────────
test("fetchAndMerge_lapseMidEnumeration_setsLoadIncomplete", async () => {
  // Simulate a connection lapse after the first band is fetched but before
  // the pinned window returns. The fence.lapsed flag is set mid-enumeration.
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "ef".repeat(32);
  const event = makeFakeEvent(pubkey, 1000);

  // Build a fence that starts unlapsed but lapses when the pinned window fires.
  const fence = makeFenceHandle({ eose: true });
  const fakeRelay = {
    fetchEvents: async (filter) => {
      if (filter.since !== undefined) {
        // Pinned window: trigger lapse mid-enumeration.
        fence._lapse();
        return [event];
      }
      return [event]; // initial band
    },
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_filter, _onEvent) => fence,
    subscribeLive: async (_f, _h) => () => {},
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  await mgr.fetchAndMerge();
  assert.equal(
    mgr.isLoadComplete,
    false,
    "lapse during enumeration must produce incomplete load",
  );
  mgr.destroy();
});

// ── Test 12: foreign client_id at initial load triggers slot rotation ─────────
test("fetchAndMerge_foreignClientId_rotatesSlotAndUpdatesMetadata", async () => {
  // If a fetched event carries our slot coordinate but a different client_id,
  // the manager must rotate slotId and record maxFetchedCreatedAt.
  // Also validates read-before-write path: fetchOwnBlobBeforePublish runs the
  // same parsed-record metadata path (Contract 2).
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "a6".repeat(32);

  // Install Tauri IPC mock.
  const slotId = "deadbeefdeadbeef0123456789abcdef"; // will be the initial slotId
  const foreignClientId = "other-client-uuid-9999";
  const blob = JSON.stringify({
    v: 1,
    client_id: foreignClientId,
    contexts: { "ch-conflict": 500 },
  });
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command === "nip44_decrypt_from_self") {
        if (args.ciphertext === "CONFLICT_CIPHER") return blob;
        return JSON.stringify({
          v: 1,
          client_id: foreignClientId,
          contexts: {},
        });
      }
      throw new Error(`Unexpected: ${command}`);
    },
  };

  // Build a fetched event at our slot coordinate but with foreign client_id.
  const conflictEvent = {
    id: "f0".repeat(32),
    pubkey,
    created_at: 12345,
    kind: 30078,
    tags: [
      ["d", `read-state:${slotId}`],
      ["t", "read-state"],
    ],
    content: "CONFLICT_CIPHER",
    sig: "s".repeat(128),
  };

  const fakeRelay = {
    // Respect `until` so the loader terminates: once `until` drops below the
    // event's created_at the relay returns empty, ending the enumeration.
    fetchEvents: async (filter) => {
      if (filter.until !== undefined && conflictEvent.created_at > filter.until)
        return [];
      return [conflictEvent];
    },
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_f, _h) => makeFenceHandle({ eose: true }),
    subscribeLive: async (_f, _h) => () => {},
  };

  try {
    const mgr = new ReadStateManager(pubkey, fakeRelay);
    // Pre-seed the manager's slotId to match the conflict event's d-tag.
    mgr.slotId = slotId;
    await mgr.fetchAndMerge();

    // Slot rotation: slotId must differ from the conflicting coordinate.
    assert.notEqual(
      mgr.slotId,
      slotId,
      "slotId must rotate when fetched event carries foreign client_id at our coordinate",
    );

    // maxFetchedCreatedAt must reflect the fetched event's created_at.
    assert.equal(
      mgr.maxFetchedCreatedAt,
      12345,
      "maxFetchedCreatedAt must be updated from fetched event created_at",
    );
  } finally {
    delete globalThis.window.__TAURI_INTERNALS__;
  }
});

// ── Test 13: frontier-only advance schedules canonical convergence ─────────────
test("ingest_frontierAdvanceFlipsRegister_schedulesCanonicalConvergence", async () => {
  // A frontier advance that flips an override register from live→tombstone must
  // set canonicalChanged=true and trigger schedulePublish (debounce timer set).
  globalThis.window.localStorage = makeLocalStorage();
  const pubkey = "a7".repeat(32);

  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeToReconnects: () => () => {},
    getConnectionGeneration: () => 0,
    subscribeFenced: async (_f, _h) => makeFenceHandle({ eose: true }),
    subscribeLive: async (_f, _h) => () => {},
  };
  const mgr = new ReadStateManager(pubkey, fakeRelay);
  mgr.isLoadComplete = true;

  // Seed an active register: S=5, C=0, B=10, F=5.
  // isOverrideActive(S=5,C=0,B=10,F=5) = 5>0 && 5<=10 && 5>0 → active.
  const ctx = "convergence-ch";
  mgr.overrideRegisters.set(ctx, { s: 5, c: 0, b: 10 });
  mgr.effectiveState.set(ctx, 5);
  mgr.publishableContextIds.add(ctx);

  // Verify it's active before the frontier advance.
  const before = mgr.getOverrideLiveness(ctx);
  assert.ok(before?.active, "register must be active before frontier advance");

  // Deliver a frontier advance F=11 (> B=10) → register becomes dead.
  // Simulate via a live event that carries only the frontier for this ctx.
  // Build a minimal fake event that encodes just the frontier key.
  const frontierBlob = JSON.stringify({
    v: 1,
    client_id: "peer-device",
    contexts: { [ctx]: 11 }, // frontier advance → F=11 > B=10 → inactive
  });
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (command, _args) => {
      if (command === "nip44_decrypt_from_self") return frontierBlob;
      throw new Error(`Unexpected: ${command}`);
    },
  };

  try {
    // Fire the live subscription callback directly.
    const fakeEvent = {
      id: "cc".repeat(32),
      pubkey,
      created_at: 9999,
      kind: 30078,
      tags: [
        ["d", "read-state:cc99aa00112233445566778899aabbcc"],
        ["t", "read-state"],
      ],
      content: "FRONTIER_CIPHER",
      sig: "s".repeat(128),
    };

    // Access the private handleIncomingEvent via the test helper path.
    await mgr.handleIncomingEvent(fakeEvent);

    // Register must now be inactive.
    const after = mgr.getOverrideLiveness(ctx);
    assert.ok(after !== null, "liveness must still be available");
    assert.equal(
      after.active,
      false,
      "frontier advance past B must flip register to inactive",
    );

    // debounceTimer must be set (schedulePublish was called for convergence).
    assert.ok(
      mgr.debounceTimer !== null,
      "frontier-only canonical deactivation must schedule a convergence publish",
    );
  } finally {
    delete globalThis.window.__TAURI_INTERNALS__;
    mgr.destroy();
  }
});
