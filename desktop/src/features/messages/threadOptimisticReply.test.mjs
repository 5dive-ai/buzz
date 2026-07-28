/**
 * Regression tests for the thread-pane echo-chamber bug.
 *
 * The bug: `useSendMessageMutation` optimistically painted only the channel
 * window, never `threadRepliesKey(channelId, rootId)` — the cache the thread
 * pane renders. The only live writer into that cache was the relay's
 * WebSocket echo (post-commit, fire-and-forget on the relay), so your own
 * thread reply waited a full round-trip plus fanout lag to appear while the
 * main pane painted instantly.
 *
 * Test coverage:
 *   1. insertPendingThreadReply lands the pending reply in the thread cache
 *      keyed by the resolved root (direct reply: root === parent).
 *   2. Top-level sends (no thread reference) leave every thread cache alone.
 *   3. Nested replies whose parent lives only in the thread cache still
 *      resolve the true root (collectReplyParentContext), instead of
 *      mis-rooting at the parent id.
 *   4. reconcileSentThreadReply swaps pending → confirmed under the same
 *      localKey so the rendered row never remounts.
 *   5. A WS echo that races ahead of the REST response does not duplicate:
 *      the echo replaces the pending entry, and reconciliation stays
 *      single-entry.
 *   6. rollbackPendingThreadReply removes only the failed pending entry,
 *      keeping live replies that arrived while the send was in flight.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient } from "@tanstack/react-query";

import {
  collectReplyParentContext,
  createOptimisticMessage,
  insertPendingThreadReply,
  reconcileSentThreadReply,
  rollbackPendingThreadReply,
} from "./hooks.ts";
import { mergeMessages } from "./lib/messageMerge.ts";
import {
  channelMessagesKey,
  threadRepliesKey,
} from "./lib/messageQueryKeys.ts";

const CHANNEL_ID = "channel-1";
const IDENTITY = {
  pubkey: "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222",
};

function makeEvent({ id, parentId, rootId, content, pubkey, createdAt }) {
  const tags = [
    ["p", pubkey ?? IDENTITY.pubkey],
    ["h", CHANNEL_ID],
  ];
  if (parentId) {
    if (rootId && rootId !== parentId) {
      tags.push(["e", rootId, "", "root"]);
      tags.push(["e", parentId, "", "reply"]);
    } else {
      tags.push(["e", parentId, "", "reply"]);
    }
  }
  return {
    id,
    pubkey: pubkey ?? IDENTITY.pubkey,
    created_at: createdAt ?? 1_700_000_000,
    kind: 9,
    tags,
    content,
    sig: "",
  };
}

function makePendingReply(queryClient, parentId, content = "pending reply") {
  return createOptimisticMessage(
    CHANNEL_ID,
    content,
    IDENTITY,
    collectReplyParentContext(queryClient, CHANNEL_ID),
    [],
    parentId,
    [],
  );
}

// ---------------------------------------------------------------------------
// 1. Pending insert lands in the thread cache under the resolved root
// ---------------------------------------------------------------------------

test("insertPendingThreadReply_directReplyToRoot_insertsPendingUnderRootKey", () => {
  const queryClient = new QueryClient();
  const root = makeEvent({ id: "root-1", content: "thread root" });
  queryClient.setQueryData(channelMessagesKey(CHANNEL_ID), [root]);

  const pending = makePendingReply(queryClient, "root-1");
  const threadKey = insertPendingThreadReply(queryClient, CHANNEL_ID, pending);

  assert.deepEqual(threadKey, threadRepliesKey(CHANNEL_ID, "root-1"));
  const cached = queryClient.getQueryData(threadKey);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].id, pending.id);
  assert.equal(cached[0].pending, true);
});

// ---------------------------------------------------------------------------
// 2. Top-level sends never touch thread caches
// ---------------------------------------------------------------------------

test("insertPendingThreadReply_topLevelMessage_returnsUndefinedWritesNothing", () => {
  const queryClient = new QueryClient();
  const pending = makePendingReply(queryClient, null, "top-level post");

  const threadKey = insertPendingThreadReply(queryClient, CHANNEL_ID, pending);

  assert.equal(threadKey, undefined);
  assert.deepEqual(
    queryClient.getQueriesData({ queryKey: ["thread-replies"] }),
    [],
  );
});

// ---------------------------------------------------------------------------
// 3. Nested reply: parent only in the thread cache still resolves true root
// ---------------------------------------------------------------------------

test("insertPendingThreadReply_nestedReplyParentOnlyInThreadCache_usesTrueRoot", () => {
  const queryClient = new QueryClient();
  const root = makeEvent({ id: "root-1", content: "thread root" });
  const nestedParent = makeEvent({
    id: "reply-1",
    parentId: "root-1",
    rootId: "root-1",
    content: "existing reply",
  });
  // The nested parent is a thread reply — it lives in the thread cache, not
  // the channel timeline.
  queryClient.setQueryData(channelMessagesKey(CHANNEL_ID), [root]);
  queryClient.setQueryData(threadRepliesKey(CHANNEL_ID, "root-1"), [
    nestedParent,
  ]);

  const pending = makePendingReply(queryClient, "reply-1", "nested reply");
  const threadKey = insertPendingThreadReply(queryClient, CHANNEL_ID, pending);

  // Without collectReplyParentContext the root would mis-resolve to
  // "reply-1" and the optimistic insert would strand under the wrong key.
  assert.deepEqual(threadKey, threadRepliesKey(CHANNEL_ID, "root-1"));
  const cached = queryClient.getQueryData(threadKey);
  assert.equal(cached.length, 2);
  assert.ok(cached.some((event) => event.id === pending.id));
});

// ---------------------------------------------------------------------------
// 4. Success reconciliation: pending → confirmed, render identity stable
// ---------------------------------------------------------------------------

test("reconcileSentThreadReply_swapsPendingForConfirmedKeepingLocalKey", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(channelMessagesKey(CHANNEL_ID), [
    makeEvent({ id: "root-1", content: "thread root" }),
  ]);
  const pending = makePendingReply(queryClient, "root-1");
  const threadKey = insertPendingThreadReply(queryClient, CHANNEL_ID, pending);

  const confirmed = makeEvent({
    id: "real-1",
    parentId: "root-1",
    content: "pending reply",
  });
  reconcileSentThreadReply(queryClient, threadKey, pending.id, confirmed);

  const cached = queryClient.getQueryData(threadKey);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].id, "real-1");
  assert.equal(cached[0].pending ?? false, false);
  assert.equal(
    cached[0].localKey,
    pending.id,
    "confirmed event must keep the pending localKey so the row never remounts",
  );
});

// ---------------------------------------------------------------------------
// 5. WS echo racing ahead of the REST response cannot duplicate
// ---------------------------------------------------------------------------

test("reconcileSentThreadReply_echoArrivedFirst_staysSingleEntry", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(channelMessagesKey(CHANNEL_ID), [
    makeEvent({ id: "root-1", content: "thread root" }),
  ]);
  const pending = makePendingReply(queryClient, "root-1");
  const threadKey = insertPendingThreadReply(queryClient, CHANNEL_ID, pending);

  // The live subscription echo lands before onSuccess runs. mergeMessages
  // must recognize the pending entry (content/kind/pubkey/thread refs) and
  // replace it in place.
  const echo = makeEvent({
    id: "real-1",
    parentId: "root-1",
    content: "pending reply",
  });
  queryClient.setQueryData(
    threadKey,
    mergeMessages(queryClient.getQueryData(threadKey), echo),
  );
  const afterEcho = queryClient.getQueryData(threadKey);
  assert.equal(afterEcho.length, 1);
  assert.equal(afterEcho[0].id, "real-1");
  assert.equal(afterEcho[0].localKey, pending.id);

  // onSuccess now reconciles the same confirmed event — still one entry.
  reconcileSentThreadReply(queryClient, threadKey, pending.id, echo);
  const cached = queryClient.getQueryData(threadKey);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].id, "real-1");
  assert.equal(cached[0].localKey, pending.id);
});

// ---------------------------------------------------------------------------
// 6. Error rollback: failed pending goes, in-flight live replies stay
// ---------------------------------------------------------------------------

test("rollbackPendingThreadReply_removesPendingKeepsInFlightLiveReplies", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(channelMessagesKey(CHANNEL_ID), [
    makeEvent({ id: "root-1", content: "thread root" }),
  ]);
  const pending = makePendingReply(queryClient, "root-1");
  const threadKey = insertPendingThreadReply(queryClient, CHANNEL_ID, pending);

  // Someone else's reply arrives over the live subscription mid-send.
  const liveReply = makeEvent({
    id: "other-1",
    parentId: "root-1",
    content: "someone else's reply",
    pubkey: "bbbb1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222",
  });
  queryClient.setQueryData(
    threadKey,
    mergeMessages(queryClient.getQueryData(threadKey), liveReply),
  );

  rollbackPendingThreadReply(queryClient, threadKey, pending.id);

  const cached = queryClient.getQueryData(threadKey);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].id, "other-1");
});
