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
    subscribeLive: () => () => {},
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
function makeManager(pubkey = "a".repeat(64)) {
  globalThis.window.localStorage = makeLocalStorage();
  const fakeRelay = {
    fetchEvents: async () => [],
    publishEvent: async () => {},
    subscribeLive: () => () => {},
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
    [ctx1, 100], // frontier for ctx1
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

// ── Test 2: full-page fetch blocks four gated operations ─────────────────────
test("fetchAndMerge_fullPage_blocksGatedOperations", async () => {
  globalThis.window.localStorage = makeLocalStorage();

  // Relay returns exactly READ_STATE_FULL_FETCH_LIMIT events → truncation guard fires.
  // We simulate this by making fetchEvents return an array of `limit` length.
  // The actual events don't need to be valid — mergeEvents handles parse failures.
  const FULL_FETCH_LIMIT = 5_000;
  const fakeEvents = new Array(FULL_FETCH_LIMIT).fill({
    id: "x".repeat(64),
    pubkey: "a".repeat(64),
    kind: 30078,
    content: "",
    tags: [],
    created_at: 1000,
    sig: "s".repeat(128),
  });

  let publishCalls = 0;
  const fakeRelay = {
    fetchEvents: async () => fakeEvents,
    publishEvent: async () => {
      publishCalls++;
    },
    subscribeLive: async () => () => {},
  };

  const pubkey = "a".repeat(64);
  const mgr = new ReadStateManager(pubkey, fakeRelay);

  // Seed some context reads so there's something to publish.
  mgr.markContextRead("channel-test", 1000);

  // Run fetchAndMerge (internals) via initialize() — the relay returns a full
  // page, so isLoadComplete must remain false.
  // We override subscribeLive to avoid hanging on a real subscription.
  await mgr.fetchAndMerge();

  // 1. publish() must be blocked (isLoadComplete=false).
  await mgr.publish();
  assert.equal(
    publishCalls,
    0,
    "publish must be blocked when isLoadComplete=false",
  );

  // 2. markChannelUnread must return load_incomplete.
  const unreadResult = mgr.markChannelUnread("channel-test");
  assert.equal(unreadResult.success, false);
  assert.equal(
    unreadResult.reason,
    "load_incomplete",
    "markChannelUnread must refuse with load_incomplete",
  );

  // 3. markChannelRead must return load_incomplete.
  const readResult = mgr.markChannelRead("channel-test");
  assert.equal(readResult.success, false);
  assert.equal(
    readResult.reason,
    "load_incomplete",
    "markChannelRead must refuse with load_incomplete",
  );

  // 4. deleteExtraSlots must be blocked (isLoadComplete=false).
  // Inject a fake extraSlotId to verify deletion is suppressed.
  mgr.extraSlotIds = ["fakeextraslot000"];
  await mgr.deleteExtraSlots();
  assert.equal(
    publishCalls,
    0,
    "deleteExtraSlots must not call publishEvent when isLoadComplete=false",
  );

  mgr.destroy();
});

// ── Test 3: visible refusal at budget exhaustion and uint32 max ───────────────
test("markChannelUnread_visibleRefusal_atBudgetExhaustionAndUint32Max", () => {
  const mgr = makeManager();
  // Simulate completed load so mark operations are not blocked by load_incomplete.
  mgr.isLoadComplete = true;

  // ── uint32 max refusal ────────────────────────────────────────────────────
  // Inject a register where S is already at uint32 max and S == C (so
  // max(S,C)+1 would overflow).
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

  // ── budget exhaustion refusal ─────────────────────────────────────────────
  // Fill effectiveState with enough channel keys to consume the entire 32 KiB
  // budget, then attempt to add a new override group. With no prunable entries
  // (no msg:/thread: keys), the budget check must fail.
  //
  // Each channel key is ~70 bytes. 32768 / 70 ≈ 468 keys to fill the budget.
  // Use 500 keys to ensure we are well over budget on the channel-only side.
  const budgetCtx = "budget-channel-00000000000000000000000000000000";
  for (let i = 0; i < 500; i++) {
    const ch = `ch-${i.toString().padStart(64, "0")}`;
    mgr.effectiveState.set(ch, i + 1);
    mgr.publishableContextIds.add(ch);
  }
  // The new context has no existing override register — mark it unread.
  mgr.effectiveState.set(budgetCtx, 999);
  mgr.publishableContextIds.add(budgetCtx);

  const budgetResult = mgr.markChannelUnread(budgetCtx);
  // 500 channel keys × ~70 bytes ≈ 35 KB > 32 KiB; with no prunable entries
  // (no msg:/thread: keys), the budget check must fail.
  assert.equal(
    budgetResult.success,
    false,
    "markChannelUnread must refuse when channel-only keys exhaust the budget",
  );
  assert.equal(
    budgetResult.reason,
    "budget_exhausted",
    "refusal must name budget_exhausted (not a silent drop or panic)",
  );
  // Whether it succeeds or fails, the manager must not have corrupted state.
  // Verify the uint32_overflow register was not mutated.
  const reg = mgr.overrideRegisters.get(overflowCtx);
  assert.ok(reg, "overflow channel register must still exist");
  assert.equal(reg.s, UINT32_MAX, "overflow register S must be unchanged");

  mgr.destroy();
});
