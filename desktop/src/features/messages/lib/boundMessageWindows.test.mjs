/**
 * Store-level tests for enforceMessageWindowBounds against a REAL QueryClient.
 *
 * These exercise the collect → fold → select → remove path at the cache
 * boundary — the layer above the pure policy unit — asserting:
 *   - channels and threads are bounded independently at their caps;
 *   - eviction is least-recently-updated first;
 *   - evicting a channel removes BOTH its window and messages keys together;
 *   - an active channel (mounted observer) is never evicted, even when stale;
 *   - a pending send pins its channel — including the cross-key case where the
 *     optimistic event lands on a non-visible channel-window `liveOverlay`;
 *   - an evicted channel reads back absent → the freshness seam re-fetches;
 *   - a guarded background write cannot resurrect an evicted key (durable
 *     truncation contract).
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import {
  channelMessagesKey,
  channelWindowKey,
  threadRepliesKey,
} from "./messageQueryKeys.ts";
import {
  emptyChannelWindowStore,
  mergeLiveChannelWindowEvent,
} from "./channelWindowStore.ts";
import { shouldRefreshChannelWindowAfterSubscribe } from "./projectChannelWindow.ts";
import {
  enforceMessageWindowBounds,
  MAX_RETAINED_MESSAGE_CHANNELS,
  MAX_RETAINED_MESSAGE_THREADS,
} from "./boundMessageWindows.ts";

const CHAN_CAP = MAX_RETAINED_MESSAGE_CHANNELS;
const THREAD_CAP = MAX_RETAINED_MESSAGE_THREADS;

let client;

/** A relay event; `pending` marks an un-acked optimistic send. */
function event(id, createdAt, extra = {}) {
  return {
    id: id.padEnd(64, "0"),
    pubkey: "a".repeat(64),
    created_at: createdAt,
    kind: 9,
    tags: [["h", "channel"]],
    content: id,
    sig: "b".repeat(128),
    ...extra,
  };
}

/**
 * Seed a channel's window + messages keys at a given recency. `updatedAt`
 * drives `dataUpdatedAt` so the LRU order is deterministic in tests.
 */
function seedChannel(channelId, updatedAt, { pendingSend = false } = {}) {
  let store = emptyChannelWindowStore();
  if (pendingSend) {
    store = mergeLiveChannelWindowEvent(
      store,
      event(`pending-${channelId}`, updatedAt, { pending: true }),
    );
  }
  client.setQueryData(channelWindowKey(channelId), store, { updatedAt });
  client.setQueryData(channelMessagesKey(channelId), [], { updatedAt });
}

function seedThread(channelId, rootId, updatedAt) {
  client.setQueryData(threadRepliesKey(channelId, rootId), [], { updatedAt });
}

/** Mount an observer so the query reports `isActive()` — a pinned view. */
function mountChannel(channelId) {
  const windowObserver = new QueryObserver(client, {
    queryKey: channelWindowKey(channelId),
    enabled: true,
  });
  const messagesObserver = new QueryObserver(client, {
    queryKey: channelMessagesKey(channelId),
    enabled: true,
  });
  const unsubWindow = windowObserver.subscribe(() => {});
  const unsubMessages = messagesObserver.subscribe(() => {});
  return () => {
    unsubWindow();
    unsubMessages();
  };
}

function hasChannel(channelId) {
  return (
    client.getQueryData(channelWindowKey(channelId)) !== undefined ||
    client.getQueryData(channelMessagesKey(channelId)) !== undefined
  );
}

describe("enforceMessageWindowBounds", () => {
  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
  });

  it("test_channels_up_to_cap_are_all_retained", () => {
    for (let i = 0; i < CHAN_CAP; i += 1) seedChannel(`chan-${i}`, i);
    enforceMessageWindowBounds(client);
    for (let i = 0; i < CHAN_CAP; i += 1) {
      assert.ok(hasChannel(`chan-${i}`), `chan-${i} must be retained at cap`);
    }
  });

  it("test_exceeding_cap_evicts_least_recently_updated_channel", () => {
    for (let i = 0; i <= CHAN_CAP; i += 1) seedChannel(`chan-${i}`, i);
    enforceMessageWindowBounds(client);
    assert.equal(hasChannel("chan-0"), false, "oldest channel evicted");
    for (let i = 1; i <= CHAN_CAP; i += 1) {
      assert.ok(hasChannel(`chan-${i}`), `chan-${i} must survive`);
    }
  });

  it("test_evicting_a_channel_removes_both_window_and_messages_keys", () => {
    for (let i = 0; i <= CHAN_CAP; i += 1) seedChannel(`chan-${i}`, i);
    enforceMessageWindowBounds(client);
    assert.equal(
      client.getQueryData(channelWindowKey("chan-0")),
      undefined,
      "window key gone",
    );
    assert.equal(
      client.getQueryData(channelMessagesKey("chan-0")),
      undefined,
      "messages key gone",
    );
  });

  it("test_active_channel_is_never_evicted_even_when_least_recent", () => {
    // chan-0 is the oldest (recency 0) but mounted → pinned. One extra channel
    // over cap forces an eviction; the next-oldest unpinned (chan-1) goes.
    for (let i = 0; i <= CHAN_CAP; i += 1) seedChannel(`chan-${i}`, i);
    const unmount = mountChannel("chan-0");
    enforceMessageWindowBounds(client);
    assert.ok(hasChannel("chan-0"), "active channel pinned");
    assert.equal(hasChannel("chan-1"), false, "next-oldest unpinned evicted");
    unmount();
  });

  it("test_pending_send_pins_its_channel_via_window_overlay", () => {
    // chan-0 is oldest and inactive but holds an optimistic send in its window
    // overlay (the cross-key send-from-thread seam) → pinned. chan-1 evicted.
    for (let i = 0; i <= CHAN_CAP; i += 1) {
      seedChannel(`chan-${i}`, i, { pendingSend: i === 0 });
    }
    enforceMessageWindowBounds(client);
    assert.ok(hasChannel("chan-0"), "channel with pending send pinned");
    assert.equal(hasChannel("chan-1"), false, "next-oldest unpinned evicted");
  });

  it("test_threads_are_bounded_independently_from_channels", () => {
    // Many channels AND many threads over both caps: each bounded to its own
    // cap, neither starving the other.
    for (let i = 0; i <= CHAN_CAP; i += 1) seedChannel(`chan-${i}`, i);
    for (let i = 0; i <= THREAD_CAP; i += 1) seedThread("c", `root-${i}`, i);
    enforceMessageWindowBounds(client);
    // Oldest of each evicted; newest survive.
    assert.equal(hasChannel("chan-0"), false);
    assert.equal(
      client.getQueryData(threadRepliesKey("c", "root-0")),
      undefined,
      "oldest thread evicted",
    );
    assert.notEqual(
      client.getQueryData(threadRepliesKey("c", `root-${THREAD_CAP}`)),
      undefined,
      "newest thread survives",
    );
  });

  it("test_evicted_channel_reads_absent_so_revisit_refetches", () => {
    for (let i = 0; i <= CHAN_CAP; i += 1) seedChannel(`chan-${i}`, i);
    enforceMessageWindowBounds(client);
    // Freshness seam: an evicted channel has no messages state, so a resubscribe
    // must refresh (returns true) rather than reading a stale window as fresh.
    assert.equal(
      shouldRefreshChannelWindowAfterSubscribe(client, "chan-0"),
      true,
      "evicted channel must refetch on revisit",
    );
  });

  it("test_guarded_background_write_does_not_resurrect_evicted_channel", () => {
    for (let i = 0; i <= CHAN_CAP; i += 1) seedChannel(`chan-${i}`, i);
    enforceMessageWindowBounds(client);
    // The background live path writes messages with a guarded updater that
    // no-ops when the key is absent. It must NOT rebuild the evicted key.
    client.setQueryData(channelMessagesKey("chan-0"), (current) =>
      !current ? current : [...current, event("live", 999)],
    );
    assert.equal(
      client.getQueryData(channelMessagesKey("chan-0")),
      undefined,
      "guarded write must not resurrect an evicted key",
    );
  });
});
