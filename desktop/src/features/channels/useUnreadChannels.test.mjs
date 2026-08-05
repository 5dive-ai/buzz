/**
 * Boundary tests for useUnreadChannels — exercises the real parent-to-owner
 * boundary between useUnreadChannels and useObservedUnreadPersistence.
 *
 * These tests mount the FULL production hook (via createRoot + act) to verify
 * that markChannelRead and markAllChannelsRead satisfy the structural seam contract:
 * the fenced persistence owner is the SOLE mutator of observed/latest evidence;
 * evidence deletion is gated on the manager outcome (overrideCleared); stale
 * scope-A callbacks cannot corrupt scope-B refs or storage after a scope switch.
 *
 * The controllable NIP-RS manager (makeReadyRelayClient) gives us isLoadComplete:
 * true so the production clear-transition paths are exercised end-to-end.
 *
 * Near-overflow registers are seeded via localStorage (buzz.nip-rs.override-state.v2:*)
 * — the plaintext production ingest path (readStateStorage.ts). hydrateFromLocalStorage()
 * picks them up at ReadStateManager construction time; no NIP-44 or tauri IPC needed.
 *
 * ## Mutation-test coverage (all three verified by manual mutation)
 *
 * Mutation (a): delete the isScopeLoaded() fence-first guard in markAllChannelsRead
 *   → "markAllChannelsRead stale" FAILS: stale A callback reaches the trailing
 *     forcedUnreadStore.write(pubkeyA, ...) and overwrites A's storage with B's map.
 *
 * Mutation (b): remove the overrideCleared gate in markAllChannelsRead (unconditional
 *   delete + removeChannel)
 *   → "markAllChannelsRead refused clear" FAILS: with a near-overflow register
 *     {s:MAX, c:0, b:10B} seeded via localStorage, the C-bump overflows and
 *     liveness remains active (frontier ~1.75B < b=10B), so applyOverrideRead
 *     returns overrideStillActive — but the un-gated path deletes the forced
 *     entry anyway.
 *
 * Mutation (c): swap frontier-advance and C-bump order in markChannelRead
 *   → "markChannelRead frontier-advance-before-cbump ordering" FAILS: with a
 *     near-overflow register {s:MAX, c:0, b:1}, the C-bump alone overflows
 *     (uint32_overflow, overrideStillActive), but F>B=1 deactivates the register
 *     only when the frontier advance ran first. Swapping order leaves the forced
 *     entry alive instead of deleting it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  installDOMShim,
  installFreshStorage,
  seedStorage,
  mountUnreadChannels,
  makeReadyRelayClient,
  makeChannel,
} from "./observedUnreadTestHarness.mjs";

// DOM shim must run before any React import (harness imports React at parse time).
installDOMShim();
installFreshStorage();

import { readObservedUnreadFromStorage } from "./observedUnreadStorage.ts";
import { forcedUnreadStore } from "./forcedUnreadStore.ts";
import { act } from "react";

// ── Helpers ───────────────────────────────────────────────────────────────────

const RELAY = "wss://relay.example.com";

// ── markChannelRead seam tests ────────────────────────────────────────────────

test("markChannelRead refused clear: manager unavailable preserves forced and observed evidence", async () => {
  // Bites: useUnreadChannels.ts:markChannelRead — observedPersistence.removeChannel is
  // inside the overrideCleared gate. With relayClient:undefined, isLoadComplete=false,
  // applyOverrideRead returns overrideStillActive, so removeChannel is NOT called.
  // Deleting the gate (or moving removeChannel outside it) fails this test.
  installFreshStorage();

  const PUBKEY = "pubkey-refused-mcr";
  const readAt = seedStorage(PUBKEY, RELAY, "channel-forced");

  // No relayClient → manager unavailable → isLoadComplete:false → overrideStillActive.
  const harness = await mountUnreadChannels({ pubkey: PUBKEY });

  await act(async () => {
    harness.markChannelRead("channel-forced", readAt);
  });
  harness.flushStorage();

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored?.has("channel-forced"),
    "refused clear (manager unavailable) must NOT remove observed evidence from storage",
  );

  await harness.unmount();
});

test("markChannelRead accepted clear: ready manager removes forced and observed evidence", async () => {
  // Bites: useUnreadChannels.ts:markChannelRead — when applyOverrideRead returns
  // overrideCleared (ready manager, successful C-bump / no register), removeChannel
  // IS called and evidence is cleared. Removing the overrideCleared gate fails this
  // test because it would cause a refused-clear to also wipe evidence (caught by
  // the refused test above), not because cleared stops working.
  // Deleting the applyOverrideRead call entirely breaks the refused test.
  installFreshStorage();

  const PUBKEY = "pubkey-accepted-mcr";
  const readAt = seedStorage(PUBKEY, RELAY, "channel-clear");

  // Ready manager: isLoadComplete:true, no existing register → getOverrideLiveness
  // returns null → applyOverrideRead returns overrideCleared immediately (known absence).
  const rc = makeReadyRelayClient();
  const harness = await mountUnreadChannels({
    pubkey: PUBKEY,
    relayClient: rc,
  });

  // Wait for ReadStateManager.initialize() to complete (sets isLoadComplete:true).
  // The initialize promise resolves in a microtask from act's async flush.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  await act(async () => {
    harness.markChannelRead("channel-clear", readAt);
  });
  harness.flushStorage();

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored === null || !stored.has("channel-clear"),
    "accepted clear (ready manager, no register) must remove observed evidence from storage",
  );

  await harness.unmount();
});

test("markChannelRead frontier-advance-before-cbump: spec ordering gates override removal", async () => {
  // Bites: useUnreadChannels.ts:markChannelRead overrideCleared gate — with a ready
  // manager and an active register (created by markChannelUnread), applyOverrideRead
  // returns overrideCleared (C-bump deactivates the register), removeChannel IS called,
  // and evidence is cleared. Removing the overrideCleared gate in markChannelRead would
  // also clear evidence for refused outcomes (caught by the refused test above).
  //
  // NOTE: The frontier-advance-before-C-bump ordering cannot be independently bited
  // with normal counter values — C-bump alone deactivates {s:1,c:0,b:0} → {s:1,c:2,b:0}
  // regardless of whether frontier advance happened first. See the ordering test below
  // for the near-overflow probe that makes order observable.
  // This test verifies the with-register accepted path end-to-end.
  installFreshStorage();

  const PUBKEY = "pubkey-order-mcr";
  const readAt = seedStorage(PUBKEY, RELAY, "channel-order");

  const rc = makeReadyRelayClient();
  const harness = await mountUnreadChannels({
    pubkey: PUBKEY,
    channels: [makeChannel("channel-order")],
    relayClient: rc,
  });

  // Wait for initialize() to complete (sets isLoadComplete:true).
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  // Create an active register via markChannelUnread, then clear it via markChannelRead.
  // With a ready manager + register present, applyOverrideRead: liveness exists →
  // C-bump → deactivates ({s:1,c:2,b:0}, frontier-after-advance) → overrideCleared.
  // Evidence must be cleared.
  await act(async () => {
    harness.markChannelUnread("channel-order");
  });

  await act(async () => {
    harness.markChannelRead("channel-order", readAt);
  });
  harness.flushStorage();

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored === null || !stored.has("channel-order"),
    "markChannelRead with active register: overrideCleared must clear observed evidence",
  );

  await harness.unmount();
});

test("markChannelRead frontier-advance-before-cbump ordering: F>B deactivation requires advance before C-bump", async () => {
  // Bites: useUnreadChannels.ts:markChannelRead — the frontier advance
  // (`markContextRead`) running BEFORE `applyOverrideRead` (C-bump). With a
  // near-overflow register {s:MAX, c:0, b:1} seeded via hydrateFromLocalStorage,
  // the C-bump overflows (uint32_overflow) and is the ONLY deactivation path that
  // fails. Deactivation must come from F>B: advance sets F >> B=1 → inactive.
  //
  // Correct order: advance → F > B=1 → liveness inactive → overrideCleared → entry deleted.
  // Swapped order: C-bump first (overflow, still active) → overrideStillActive → entry survives.
  //
  // isOverrideActive = s>0 && frontier<=b && s>c:
  //   With F=0 (pre-advance): MAX>0 && 0<=1 && MAX>0 → ACTIVE.
  //   With F=~1.75B (post-advance): MAX>0 && 1.75B<=1 → INACTIVE.
  installFreshStorage();

  const PUBKEY = "pubkey-order-cbump-frontier";
  // Near-overflow register: s=MAX, c=0, b=1. C-bump overflows; only F>B clears.
  const V2_KEY = `buzz.nip-rs.override-state.v2:${PUBKEY}`;
  const FORCED_KEY = `buzz-forced-unread.v1:${PUBKEY}`;
  localStorage.setItem(
    V2_KEY,
    JSON.stringify({ "channel-c": { s: 4294967295, c: 0, b: 1, f: 0 } }),
  );
  localStorage.setItem(FORCED_KEY, JSON.stringify({ "channel-c": 100 }));
  const readAt = seedStorage(PUBKEY, RELAY, "channel-c");

  const rc = makeReadyRelayClient();
  const harness = await mountUnreadChannels({
    pubkey: PUBKEY,
    channels: [makeChannel("channel-c")],
    relayClient: rc,
  });

  // Wait for initialize() + hydrateFromLocalStorage() to complete.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  // markChannelRead: advance runs first → F (~1.75B) > B (1) → liveness inactive.
  // Then C-bump overflows but re-read liveness is inactive → overrideCleared.
  // Forced entry must be deleted.
  await act(async () => {
    harness.markChannelRead("channel-c", readAt);
  });
  harness.flushStorage();

  const forcedMap = forcedUnreadStore.read(PUBKEY);
  assert.ok(
    !Object.hasOwn(forcedMap, "channel-c"),
    "frontier-advance-before-cbump ordering: F>B must deactivate the register before the C-bump attempt",
  );

  await harness.unmount();
});

test("markChannelRead topLevelOnly: leaves observed refs intact regardless of override outcome", async () => {
  installFreshStorage();

  const PUBKEY = "pubkey-tlo-mcr";
  const readAt = seedStorage(PUBKEY, RELAY, "channel-tlo");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY });

  // topLevelOnly=true: clearObserved stays false → removeChannel never called.
  await act(async () => {
    harness.markChannelRead("channel-tlo", readAt, { topLevelOnly: true });
  });
  harness.flushStorage();

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored?.has("channel-tlo"),
    "topLevelOnly=true must leave observed storage intact",
  );

  await harness.unmount();
});

// ── markChannelRead stale-scope test ──────────────────────────────────────────

test("markChannelRead stale: scope-A callback rejects after scope B loads — B storage survives flush", async () => {
  installFreshStorage();

  const PUBKEY_A = "pubkey-a-mcr";
  const PUBKEY_B = "pubkey-b-mcr";
  const SHARED_CHANNEL = "channel-shared";

  const readAtA = seedStorage(PUBKEY_A, RELAY, SHARED_CHANNEL, "evt-a");
  seedStorage(PUBKEY_B, RELAY, SHARED_CHANNEL, "evt-b");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY_A });
  const staleMarkChannelRead = harness.markChannelRead;

  // Switch to B; hydration flushes A and loads B's storage.
  await harness.render(PUBKEY_B);

  assert.ok(
    readObservedUnreadFromStorage(PUBKEY_B, RELAY)?.has(SHARED_CHANNEL),
    "B's channel-shared must be present before the stale call",
  );

  // Stale A call must be rejected by the scope fence; B's refs stay intact.
  await act(async () => {
    staleMarkChannelRead(SHARED_CHANNEL, readAtA);
  });
  harness.flushStorage();

  const storedBAfter = readObservedUnreadFromStorage(PUBKEY_B, RELAY);
  assert.ok(
    storedBAfter?.has(SHARED_CHANNEL),
    "B's channel-shared must survive the post-stale-call flush",
  );

  await harness.unmount();
});

// ── markAllChannelsRead seam tests ────────────────────────────────────────────

test("markAllChannelsRead accepted path: ready manager clears forced and observed evidence", async () => {
  // Bites: useUnreadChannels.ts:markAllChannelsRead — the per-channel transition loop
  // and overrideCleared gate. With a ready manager and a non-empty unread set (channel
  // seeded into unreadChannelIds via markChannelUnread), markAllChannelsRead enters the
  // loop, calls applyOverrideRead, gets overrideCleared (C-bump deactivates register),
  // and deletes the forced entry + calls removeChannel. Deleting the loop entry-point
  // (applyOverrideRead call) or the forcedUnreadRef deletion fails this test.
  //
  // Mutation (b) bites the "refused clear" test below, not this one: with normal
  // counters applyOverrideRead always returns overrideCleared, so the gate's presence
  // is not observable here. This test verifies the accepted-clearing path end-to-end.
  installFreshStorage();

  const PUBKEY = "pubkey-accepted-mar";
  seedStorage(PUBKEY, RELAY, "channel-1");

  const rc = makeReadyRelayClient();
  const harness = await mountUnreadChannels({
    pubkey: PUBKEY,
    channels: [makeChannel("channel-1")],
    relayClient: rc,
  });

  // Wait for initialize() to complete (sets isLoadComplete:true) and scope to hydrate
  // (so latestByChannelRef loads the seeded event from storage).
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  // Create a register for "channel-1" so it appears in unreadChannelIds via
  // getOverrideLiveness("channel-1").active === true. This also ensures the loop body
  // executes rather than being skipped by an empty unreadChannelIdsRef.
  await act(async () => {
    harness.markChannelUnread("channel-1");
  });

  // markAllChannelsRead: fence passes (scope loaded), loop processes "channel-1",
  // applyOverrideRead → overrideCleared (C-bump deactivates {s:1,c:0,b:0}),
  // forced entry deleted, removeChannel clears observed refs and schedules persist.
  await act(async () => {
    harness.markAllChannelsRead();
  });
  harness.flushStorage();

  // Forced entry must be gone from persisted storage.
  const forcedMap = forcedUnreadStore.read(PUBKEY);
  assert.ok(
    !Object.hasOwn(forcedMap, "channel-1"),
    "markAllChannelsRead accepted path: forced-unread entry must be deleted",
  );

  // Observed evidence must be cleared from storage.
  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored === null || !stored.has("channel-1"),
    "markAllChannelsRead accepted path: observed evidence must be removed",
  );

  await harness.unmount();
});

test("markAllChannelsRead refused clear: overrideCleared gate preserves forced entry on uint32_overflow", async () => {
  // Bites: useUnreadChannels.ts:markAllChannelsRead — the `if (outcome ===
  // "overrideCleared")` gate. With a near-overflow register seeded via
  // hydrateFromLocalStorage ({s:MAX, c:0, b:10B}), the C-bump overflows
  // (uint32_overflow refusal) and the frontier advance stays below b, so
  // liveness remains active → applyOverrideRead returns overrideStillActive.
  // The forced entry must NOT be deleted. Removing the gate (unconditional
  // delete + removeChannel) deletes the entry even though the override is live.
  //
  // Seeding path: localStorage v2 key is the plaintext production ingest path
  // (readStateStorage.ts); hydrateFromLocalStorage() ingests it on init,
  // no NIP-44 or tauri IPC involved.
  installFreshStorage();

  const PUBKEY = "pubkey-refused-mar-overflow";
  // Seed a near-overflow register: s=MAX, c=0, b=10B (frontier stays below b).
  // isOverrideActive = s>0 && frontier<=b && s>c → true at any reasonable ts.
  const V2_KEY = `buzz.nip-rs.override-state.v2:${PUBKEY}`;
  const FORCED_KEY = `buzz-forced-unread.v1:${PUBKEY}`;
  localStorage.setItem(
    V2_KEY,
    JSON.stringify({
      "channel-b": { s: 4294967295, c: 0, b: 99999999999, f: 0 },
    }),
  );
  localStorage.setItem(FORCED_KEY, JSON.stringify({ "channel-b": 100 }));
  // Seed observed storage so latestByChannelRef is populated for frontier advance.
  seedStorage(PUBKEY, RELAY, "channel-b");

  const rc = makeReadyRelayClient();
  const harness = await mountUnreadChannels({
    pubkey: PUBKEY,
    channels: [makeChannel("channel-b")],
    relayClient: rc,
  });

  // Wait for initialize() + hydrateFromLocalStorage() to complete.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  // markAllChannelsRead: "channel-b" is in unreadChannelIds (liveness active),
  // frontier advance sets effectiveState to ts (~1.75B) < b (10B), C-bump overflows,
  // applyOverrideRead → overrideStillActive → forced entry must be preserved.
  await act(async () => {
    harness.markAllChannelsRead();
  });
  harness.flushStorage();

  const forcedMap = forcedUnreadStore.read(PUBKEY);
  assert.ok(
    Object.hasOwn(forcedMap, "channel-b"),
    "refused clear (uint32_overflow): forced-unread entry must be preserved",
  );

  await harness.unmount();
});

test("markAllChannelsRead stale: fence-first guard rejects scope-A callback — A storage survives", async () => {
  // Bites: useUnreadChannels.ts:markAllChannelsRead — the isScopeLoaded() fence-first
  // guard at :1004. Without the guard the stale scope-A callback falls through to the
  // trailing `forcedUnreadStore.write(pubkeyA, forcedUnreadRef.current)` at :1027. At
  // that point forcedUnreadRef.current holds B's (empty) map, and pubkey is A's captured
  // value, so `forcedUnreadStore.write(A, {})` overwrites A's persisted forced-unread
  // entries with an empty map. With the guard, isScopeLoaded() returns false (scope
  // switched to B) and the callback returns before reaching the write.
  //
  // Observable corruption: A's storage key is silently wiped by the stale callback —
  // not just the observed evidence (which is internally fenced by removeChannel) but
  // the forced-unread store, which is NOT internally fenced in the hook's write path.
  installFreshStorage();

  const PUBKEY_A = "pubkey-a-mar-fence";
  const PUBKEY_B = "pubkey-b-mar-fence";

  // Mount A with a ready manager and a channel so markChannelUnread can create a register.
  const rc = makeReadyRelayClient();
  const harness = await mountUnreadChannels({
    pubkey: PUBKEY_A,
    channels: [makeChannel("channel-1")],
    relayClient: rc,
  });

  // Wait for A's manager to initialize.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  // Create a forced-unread entry for A under "channel-1". forcedUnreadStore.write is
  // called by markChannelUnread on acceptance; A's storage key now has a non-empty map.
  await act(async () => {
    harness.markChannelUnread("channel-1");
  });

  // Confirm A has a forced-unread entry before the scope switch.
  const forcedBefore = forcedUnreadStore.read(PUBKEY_A);
  assert.ok(
    Object.hasOwn(forcedBefore, "channel-1"),
    "A must have a forced-unread entry before the stale call",
  );

  // Capture the stale markAllChannelsRead callback (closes over pubkeyA, observedPersistence_A).
  const staleMarkAllChannelsRead = harness.markAllChannelsRead;

  // Switch to scope B. forcedUnreadRef.current is now reset to B's empty map.
  // observedPersistence's scopeLoadedRef is updated to scope_B — so isScopeLoaded()
  // on the OLD persistence object returns false (scope_B ≠ scope_A).
  await harness.render(PUBKEY_B, rc, [makeChannel("channel-1")]);

  // Stale A callback: without the fence-first guard, it would reach
  //   forcedUnreadStore.write(pubkeyA, {})  — B's empty map under A's key.
  // With the guard: isScopeLoaded() → false → return immediately.
  await act(async () => {
    staleMarkAllChannelsRead();
  });
  harness.flushStorage();

  // A's forced-unread storage must be intact — not wiped by the stale callback.
  const forcedAfter = forcedUnreadStore.read(PUBKEY_A);
  assert.ok(
    Object.hasOwn(forcedAfter, "channel-1"),
    "A's forced-unread storage must survive the stale markAllChannelsRead call (fence-first guard preserved it)",
  );

  await harness.unmount();
});
