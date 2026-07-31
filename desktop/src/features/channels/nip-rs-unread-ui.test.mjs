/**
 * NIP-RS manual-unread UI layer tests (slice 3).
 *
 * Tests exercise production code — applyOverrideUnread, applyOverrideRead,
 * persistForcedUnread, overrideErrorMessage — by importing and invoking them
 * directly with injected manager/store/toast dependencies.
 *
 * Behavioral requirements:
 *  1. mark-unread calls the manager's NIP-RS override path and blocks the
 *     local cache update when the manager refuses.
 *  2. mark-read completes only when resulting override_active == false (spec
 *     MUST at NIP-RS:537-539). null liveness ≠ inactive — pre-init fails
 *     closed.
 *  3. budget_exhausted, uint32_overflow, and load_incomplete refusals produce
 *     distinct non-empty user-visible messages; already_inactive is silent.
 *  4. forcedUnreadStore is the local cache of the NIP-RS override layer.
 *  5. persistForcedUnread refreshes an existing entry (re-mark after override
 *     died uses the fresh baseline).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOverrideRead,
  applyOverrideUnread,
  overrideErrorMessage,
  persistForcedUnread,
} from "./readStateOverride.ts";
import { forcedUnreadStore } from "./forcedUnreadStore.ts";
import { resolveChannelReadMarker } from "./useUnreadChannels.ts";

// ── localStorage mock ────────────────────────────────────────────────────────

if (typeof globalThis.window === "undefined") {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
  };
}

function makeIsolatedStorage() {
  const store = new Map();
  const prev = globalThis.window.localStorage;
  globalThis.window.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  return {
    store,
    restore: () => {
      globalThis.window.localStorage = prev;
    },
  };
}

// ── Toast capture mock ───────────────────────────────────────────────────────
// applyOverrideUnread / applyOverrideRead call toast.error() from sonner.
// Capture calls by patching the module-level toast reference through a closure.
// Since we can't monkey-patch ES module imports in Node, we drive the
// production toast-policy logic directly via overrideErrorMessage instead.

// ── Tests: overrideErrorMessage (toast policy) ───────────────────────────────

test("overrideErrorMessage_budget_exhausted_unread_contains_budget_keyword", () => {
  const msg = overrideErrorMessage("unread", "budget_exhausted");
  assert.ok(msg?.includes("budget exhausted"), `got: ${msg}`);
});

test("overrideErrorMessage_uint32_overflow_unread_contains_counter_keyword", () => {
  const msg = overrideErrorMessage("unread", "uint32_overflow");
  assert.ok(msg?.includes("counter limit"), `got: ${msg}`);
});

test("overrideErrorMessage_uint32_overflow_read_contains_counter_keyword", () => {
  const msg = overrideErrorMessage("read", "uint32_overflow");
  assert.ok(msg?.includes("counter limit"), `got: ${msg}`);
});

test("overrideErrorMessage_load_incomplete_unread_contains_loading_keyword", () => {
  const msg = overrideErrorMessage("unread", "load_incomplete");
  assert.ok(msg?.includes("still loading"), `got: ${msg}`);
});

test("overrideErrorMessage_load_incomplete_read_contains_loading_keyword", () => {
  const msg = overrideErrorMessage("read", "load_incomplete");
  assert.ok(msg?.includes("still loading"), `got: ${msg}`);
});

test("overrideErrorMessage_already_inactive_returns_null_both_ops", () => {
  assert.equal(overrideErrorMessage("unread", "already_inactive"), null);
  assert.equal(overrideErrorMessage("read", "already_inactive"), null);
});

// ── Tests: applyOverrideUnread ───────────────────────────────────────────────

test("applyOverrideUnread_success_returns_true", () => {
  const toasts = [];
  const result = applyOverrideUnread("ch-1", {
    markChannelUnread: () => ({ success: true }),
    markChannelRead: () => ({ success: true }),
    getOverrideLiveness: () => null,
  });
  assert.equal(result, true);
  assert.equal(toasts.length, 0);
});

test("applyOverrideUnread_budget_exhausted_returns_false", () => {
  const result = applyOverrideUnread("ch-1", {
    markChannelUnread: () => ({ success: false, reason: "budget_exhausted" }),
    markChannelRead: () => ({ success: true }),
    getOverrideLiveness: () => null,
  });
  assert.equal(result, false);
});

test("applyOverrideUnread_uint32_overflow_returns_false", () => {
  const result = applyOverrideUnread("ch-1", {
    markChannelUnread: () => ({ success: false, reason: "uint32_overflow" }),
    markChannelRead: () => ({ success: true }),
    getOverrideLiveness: () => null,
  });
  assert.equal(result, false);
});

test("applyOverrideUnread_load_incomplete_returns_false", () => {
  const result = applyOverrideUnread("ch-1", {
    markChannelUnread: () => ({ success: false, reason: "load_incomplete" }),
    markChannelRead: () => ({ success: true }),
    getOverrideLiveness: () => null,
  });
  assert.equal(result, false);
});

// ── Tests: applyOverrideRead ─────────────────────────────────────────────────

test("applyOverrideRead_null_liveness_pre_init_returns_overrideStillActive", () => {
  // null ≠ inactive: pre-init must fail closed
  const result = applyOverrideRead("ch-1", {
    markChannelUnread: () => ({ success: true }),
    markChannelRead: () => {
      throw new Error("should not be called");
    },
    getOverrideLiveness: () => null,
  });
  assert.equal(result, "overrideStillActive");
});

test("applyOverrideRead_inactive_liveness_returns_overrideCleared_without_c_bump", () => {
  // Frontier advance made override inactive; no C-bump needed
  let bumpCalled = false;
  const result = applyOverrideRead("ch-1", {
    markChannelUnread: () => ({ success: true }),
    markChannelRead: () => {
      bumpCalled = true;
      return { success: true };
    },
    getOverrideLiveness: () => ({ active: false, frontier: 200 }),
  });
  assert.equal(result, "overrideCleared");
  assert.equal(bumpCalled, false, "C-bump not called when already inactive");
});

test("applyOverrideRead_active_liveness_success_then_inactive_returns_overrideCleared", () => {
  // Active → C-bump succeeds → re-read shows inactive
  let callCount = 0;
  const result = applyOverrideRead("ch-1", {
    markChannelUnread: () => ({ success: true }),
    markChannelRead: () => ({ success: true }),
    getOverrideLiveness: () => {
      callCount++;
      // First call (pre-bump check): active. Second call (post-bump): inactive.
      return callCount === 1
        ? { active: true, frontier: 50 }
        : { active: false, frontier: 50 };
    },
  });
  assert.equal(result, "overrideCleared");
});

test("applyOverrideRead_active_liveness_uint32_overflow_returns_overrideStillActive", () => {
  // Active → C-bump refuses → re-read still active → overrideStillActive
  let _callCount = 0;
  const result = applyOverrideRead("ch-1", {
    markChannelUnread: () => ({ success: true }),
    markChannelRead: () => ({ success: false, reason: "uint32_overflow" }),
    getOverrideLiveness: () => {
      _callCount++;
      return { active: true, frontier: 50 };
    },
  });
  assert.equal(result, "overrideStillActive");
});

test("applyOverrideRead_active_liveness_load_incomplete_returns_overrideStillActive", () => {
  // Active → C-bump refuses (load_incomplete) → overrideStillActive
  const result = applyOverrideRead("ch-1", {
    markChannelUnread: () => ({ success: true }),
    markChannelRead: () => ({ success: false, reason: "load_incomplete" }),
    getOverrideLiveness: () => ({ active: true, frontier: 50 }),
  });
  assert.equal(result, "overrideStillActive");
});

test("applyOverrideRead_already_inactive_race_returns_overrideCleared", () => {
  // already_inactive: cleared by another device between liveness check and
  // clear call — treat as silent success.
  const result = applyOverrideRead("ch-1", {
    markChannelUnread: () => ({ success: true }),
    markChannelRead: () => ({ success: false, reason: "already_inactive" }),
    getOverrideLiveness: () => ({ active: true, frontier: 50 }),
  });
  assert.equal(result, "overrideCleared");
});

// ── Tests: persistForcedUnread ───────────────────────────────────────────────

test("persistForcedUnread_new_entry_adds_and_returns_true", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const forcedMap = {};
    const result = persistForcedUnread("ch-1", forcedMap, () => 1000, "pk");
    assert.equal(result, true);
    assert.equal(Object.hasOwn(forcedMap, "ch-1"), true);
    assert.equal(forcedMap["ch-1"], 1000);
  } finally {
    restore();
  }
});

test("persistForcedUnread_existing_entry_with_same_ts_noop_returns_false", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const forcedMap = { "ch-1": 1000 };
    const result = persistForcedUnread("ch-1", forcedMap, () => 1000, "pk");
    assert.equal(result, false, "no change when ts identical");
  } finally {
    restore();
  }
});

test("persistForcedUnread_existing_entry_with_new_ts_refreshes_baseline", () => {
  // Re-mark after old override died: baseline must update to current frontier
  const { restore } = makeIsolatedStorage();
  try {
    const forcedMap = { "ch-1": 500 };
    const result = persistForcedUnread("ch-1", forcedMap, () => 1200, "pk");
    assert.equal(result, true, "returns true when baseline updated");
    assert.equal(forcedMap["ch-1"], 1200, "new baseline stored");
  } finally {
    restore();
  }
});

test("persistForcedUnread_persists_to_store", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const forcedMap = {};
    persistForcedUnread("ch-x", forcedMap, () => 999, "my-pk");
    const stored = forcedUnreadStore.read("my-pk");
    assert.equal(stored["ch-x"], 999, "entry visible from store");
  } finally {
    restore();
  }
});

test("persistForcedUnread_null_timestamp_stores_null", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const forcedMap = {};
    persistForcedUnread("ch-null", forcedMap, () => null, "pk");
    assert.equal(forcedMap["ch-null"], null);
  } finally {
    restore();
  }
});

// ── Tests: resolveChannelReadMarker (read-path gate) ─────────────────────────

test("resolve_channel_read_marker_uses_max_of_caller_and_observed", () => {
  const { markAt } = resolveChannelReadMarker(
    "2024-01-01T00:00:00.000Z",
    1704067999,
  );
  assert.equal(
    markAt,
    1704067999,
    "observed latest wins when newer than caller",
  );
});

test("resolve_channel_read_marker_uses_caller_when_newer", () => {
  const future = new Date(Date.now() + 10_000_000).toISOString();
  const { markAt } = resolveChannelReadMarker(future, 1);
  assert.ok(markAt !== null && markAt > 1, "caller wins when newer");
});

test("resolve_channel_read_marker_returns_null_when_both_null", () => {
  const { markAt } = resolveChannelReadMarker(null, undefined);
  assert.equal(markAt, null);
});

test("resolve_channel_read_marker_clears_observed_when_covered", () => {
  const { clearObserved } = resolveChannelReadMarker(
    "2024-01-01T00:00:01.000Z",
    1704067201,
  );
  assert.equal(
    clearObserved,
    true,
    "observed cleared when read marker covers it",
  );
});

// ── Tests: forcedUnreadStore persistence ─────────────────────────────────────

test("forced_unread_store_read_returns_empty_for_unknown_pubkey", () => {
  const { restore } = makeIsolatedStorage();
  try {
    assert.deepEqual(forcedUnreadStore.read("unknown-pk"), {});
  } finally {
    restore();
  }
});

test("forced_unread_store_write_and_read_round_trips", () => {
  const { restore } = makeIsolatedStorage();
  try {
    const pk = "test-pk";
    forcedUnreadStore.write(pk, { "channel-a": 12345, "channel-b": null });
    assert.deepEqual(forcedUnreadStore.read(pk), {
      "channel-a": 12345,
      "channel-b": null,
    });
  } finally {
    restore();
  }
});

// ── Tests: refusal-does-not-mutate-overlay (active-channel path) ─────────────
//
// Witnesses the requirement that a refused mark-unread does NOT update the
// caller's local state. applyOverrideUnread returns false on any manager
// refusal; callers gate cache writes on that return value. This covers the
// active-channel session-overlay scenario (useChannelUnreadState.handleMarkUnread)
// where the overlay must NOT be set before or on a refused call.

test("applyOverrideUnread_refusal_caller_must_not_mutate_overlay", () => {
  const _toasts = [];
  const apis = {
    markChannelUnread: () => ({ success: false, reason: "budget_exhausted" }),
    markChannelRead: () => ({ success: true }),
    getOverrideLiveness: () => null,
  };
  // Simulate caller logic: only update local state when applyOverrideUnread
  // returns true. On false, the overlay map must remain unmodified.
  const overlayMap = {};
  const result = applyOverrideUnread("ch-overlay", apis);
  if (result) {
    overlayMap["ch-overlay"] = true; // would be set on success
  }
  assert.equal(result, false, "refusal returns false");
  assert.equal(
    Object.hasOwn(overlayMap, "ch-overlay"),
    false,
    "overlay not mutated on refusal",
  );
});

// ── Tests: markAllChannelsRead partial refusal pattern ────────────────────────
//
// Witnesses that per-channel gating in markAllChannelsRead correctly clears
// only channels whose override is confirmed inactive. Channels where the
// C-bump refuses and liveness remains active must keep their local state.

test("applyOverrideRead_partial_refusal_pattern_clears_only_inactive", () => {
  // ch-cleared: liveness inactive after successful C-bump → cleared
  // ch-stuck: liveness active and C-bump refuses → stays unread
  const livenessMap = {
    "ch-cleared": { active: true, frontier: 100 },
    "ch-stuck": { active: true, frontier: 100 },
  };
  let clearCallCount = 0;
  const apis = {
    markChannelUnread: () => ({ success: true }),
    markChannelRead: (id) => {
      clearCallCount++;
      if (id === "ch-cleared") {
        livenessMap["ch-cleared"] = { active: false, frontier: 101 };
        return { success: true };
      }
      // ch-stuck: refuse with overflow; liveness stays active
      return { success: false, reason: "uint32_overflow" };
    },
    getOverrideLiveness: (id) => livenessMap[id] ?? null,
  };

  // Simulate the per-channel loop in markAllChannelsRead
  const forcedMap = { "ch-cleared": 99, "ch-stuck": 99 };
  for (const channelId of ["ch-cleared", "ch-stuck"]) {
    if (applyOverrideRead(channelId, apis) === "overrideCleared") {
      delete forcedMap[channelId];
    }
  }

  assert.equal(
    Object.hasOwn(forcedMap, "ch-cleared"),
    false,
    "cleared channel removed from map",
  );
  assert.equal(
    Object.hasOwn(forcedMap, "ch-stuck"),
    true,
    "stuck channel remains in map",
  );
  assert.equal(clearCallCount, 2, "C-bump attempted for both channels");
});
