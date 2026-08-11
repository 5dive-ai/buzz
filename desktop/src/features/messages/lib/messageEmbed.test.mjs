import assert from "node:assert/strict";
import test from "node:test";

import {
  canReadMessageEmbedSource,
  isEmbeddableMessageEvent,
  isMatchingMessageEmbedEvent,
  messageEmbedExcerpt,
} from "./messageEmbed.ts";

const link = {
  channelId: "channel-1",
  messageId: "event-1",
  threadRootId: null,
};
const event = {
  id: "event-1",
  pubkey: "author",
  created_at: 1,
  kind: 9,
  tags: [["h", "channel-1"]],
  content: "secret",
  sig: "sig",
};

test("canReadMessageEmbedSource allows joined and open channels only", () => {
  assert.equal(canReadMessageEmbedSource(undefined), false);
  assert.equal(
    canReadMessageEmbedSource({ isMember: false, visibility: "private" }),
    false,
  );
  assert.equal(
    canReadMessageEmbedSource({ isMember: true, visibility: "private" }),
    true,
  );
  assert.equal(
    canReadMessageEmbedSource({ isMember: false, visibility: "open" }),
    true,
  );
});

test("isEmbeddableMessageEvent admits user-content kinds and rejects timeline auxiliaries", () => {
  for (const kind of [9, 40002, 40008])
    assert.equal(isEmbeddableMessageEvent({ ...event, kind }), true);
  for (const kind of [7, 40003, 40099, 43003, 47000])
    assert.equal(isEmbeddableMessageEvent({ ...event, kind }), false);
});

test("isMatchingMessageEmbedEvent requires requested id, channel, and user-content kind", () => {
  assert.equal(isMatchingMessageEmbedEvent(event, link), true);
  assert.equal(
    isMatchingMessageEmbedEvent({ ...event, id: "other" }, link),
    false,
  );
  assert.equal(
    isMatchingMessageEmbedEvent(
      { ...event, tags: [["h", "private-other"]] },
      link,
    ),
    false,
  );
  assert.equal(isMatchingMessageEmbedEvent({ ...event, kind: 7 }, link), false);
});

test("messageEmbedExcerpt normalizes whitespace without rendering nested markdown", () => {
  assert.equal(messageEmbedExcerpt("hello\n\n  world"), "hello world");
  assert.equal(
    messageEmbedExcerpt("nested buzz://message?channel=x&id=y"),
    "nested buzz://message?channel=x&id=y",
  );
});
