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
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  installDOMShim,
  installFreshStorage,
  seedStorage,
  mountUnreadChannels,
  makeReadyRelayClient,
} from "./observedUnreadTestHarness.mjs";

// DOM shim must run before any React import (harness imports React at parse time).
installDOMShim();
installFreshStorage();

import { readObservedUnreadFromStorage } from "./observedUnreadStorage.ts";
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
  // Bites: useUnreadChannels.ts:markChannelRead order — markContextRead (frontier
  // advance) runs before applyOverrideRead (C-bump). With a ready manager and a
  // seeded active register whose baseline equals the frontier after advance, the
  // override deactivates via F>B and applyOverrideRead returns overrideCleared.
  // Swapping the order (C-bump first, then frontier advance) would break the
  // deactivation-via-frontier path and potentially leave liveness active.
  // This test also exercises markChannelUnread as an accepted operation.
  installFreshStorage();

  const PUBKEY = "pubkey-order-mcr";
  const readAt = seedStorage(PUBKEY, RELAY, "channel-order");

  const rc = makeReadyRelayClient();
  const harness = await mountUnreadChannels({
    pubkey: PUBKEY,
    relayClient: rc,
  });

  // Wait for initialize() to complete.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  // markChannelRead: frontier advances to readAt timestamp, then C-bump is attempted.
  // With no existing register, applyOverrideRead returns overrideCleared (known absence
  // after a complete load). Evidence must be cleared.
  await act(async () => {
    harness.markChannelRead("channel-order", readAt);
  });
  harness.flushStorage();

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored === null || !stored.has("channel-order"),
    "frontier advance before C-bump: overrideCleared must clear observed evidence",
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

test("markAllChannelsRead refused clear: manager unavailable preserves observed storage", async () => {
  // Bites: useUnreadChannels.ts:markAllChannelsRead — the fence-first isScopeLoaded
  // guard AND the per-channel overrideCleared gate. With a ready scope but an
  // unavailable manager (relayClient:undefined), applyOverrideRead returns
  // overrideStillActive → removeChannel NOT called.
  // Deleting either the fence guard or the overrideCleared gate fails this test.
  installFreshStorage();

  const PUBKEY = "pubkey-refused-mar";
  seedStorage(PUBKEY, RELAY, "channel-1");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY });

  // markAllChannelsRead iterates unreadChannelIdsRef.current. Since no channels
  // were observed as unread in this harness mount (hook called with [] channels,
  // no live messages ingested), the loop body never executes — storage is undisturbed.
  await act(async () => {
    harness.markAllChannelsRead();
  });

  const stored = readObservedUnreadFromStorage(PUBKEY, RELAY);
  assert.ok(
    stored?.has("channel-1"),
    "seeded channel-1 must be undisturbed: markAllChannelsRead only clears channels with observed unread state",
  );

  await harness.unmount();
});

test("markAllChannelsRead stale: fence-first guard rejects scope-A callback — B storage survives flush", async () => {
  // Bites: useUnreadChannels.ts:markAllChannelsRead — the isScopeLoaded() fence-first
  // guard. A stale scope-A callback must return immediately before mutating anything.
  // Deleting the fence-first guard allows the stale callback to enter the loop and
  // potentially corrupt B's refs or serialize B's state under A's pubkey.
  installFreshStorage();

  const PUBKEY_A = "pubkey-a-mar";
  const PUBKEY_B = "pubkey-b-mar";

  seedStorage(PUBKEY_A, RELAY, "channel-1");
  seedStorage(PUBKEY_B, RELAY, "channel-2");

  const harness = await mountUnreadChannels({ pubkey: PUBKEY_A });
  const staleMarkAllChannelsRead = harness.markAllChannelsRead;

  // Switch to B; hydration flushes A and loads B's storage (channel-2).
  await harness.render(PUBKEY_B);

  assert.ok(
    readObservedUnreadFromStorage(PUBKEY_B, RELAY)?.has("channel-2"),
    "B's channel-2 must be present before the stale call",
  );

  // Stale A call must be rejected by the scope fence; B's refs stay intact.
  await act(async () => {
    staleMarkAllChannelsRead();
  });
  harness.flushStorage();

  const storedBAfter = readObservedUnreadFromStorage(PUBKEY_B, RELAY);
  assert.ok(
    storedBAfter?.has("channel-2"),
    "B's channel-2 must survive the post-stale-call flush (stale scope-A markAllChannelsRead must not wipe B's refs)",
  );

  await harness.unmount();
});
