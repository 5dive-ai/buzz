import assert from "node:assert/strict";
import test from "node:test";

import { scheduleGeneratedPreviews } from "./generatedPreviewScheduling.ts";

const message = (href, index) => ({
  kind: "message",
  href,
  index,
  channelId: "channel",
  messageId: href,
});
const link = (href, index) => ({
  kind: "link",
  index,
  preview: {
    kind: "generic-link",
    href,
    provider: "Web",
    title: href,
    typeLabel: "link",
  },
});
const resolved = (href) => ({
  kind: "generic-link",
  href,
  provider: "Web",
  title: href,
  typeLabel: "link",
});

test("pending and unavailable messages do not hide a resolved later link", () => {
  const messages = Array.from({ length: 8 }, (_, index) =>
    message(`buzz://message/${index}`, index),
  );
  const laterLink = link("https://example.com", 8);
  const availability = new Map(
    messages.map((candidate, index) => [
      candidate.href,
      index % 2 === 0 ? "pending" : "unavailable",
    ]),
  );
  const result = scheduleGeneratedPreviews(
    [...messages, laterLink],
    new Map([[laterLink.preview.href, resolved(laterLink.preview.href)]]),
    availability,
  );

  assert.deepEqual(result.visibleCandidates, [laterLink]);
  assert.deepEqual(
    [...result.attemptedMessageHrefs],
    messages.map(({ href }) => href),
  );
});

test("failed message attempts backfill until eight available previews are selected", () => {
  const candidates = Array.from({ length: 12 }, (_, index) =>
    message(`buzz://message/${index}`, index),
  );
  const availability = new Map(
    candidates.map((candidate, index) => [
      candidate.href,
      index < 2 ? "unavailable" : "available",
    ]),
  );
  const result = scheduleGeneratedPreviews(candidates, new Map(), availability);

  assert.deepEqual(
    result.visibleCandidates.map(({ href }) => href),
    candidates.slice(2, 10).map(({ href }) => href),
  );
  assert.deepEqual(
    [...result.attemptedMessageHrefs],
    candidates.slice(0, 10).map(({ href }) => href),
  );
});

test("the first resolved candidate owns controls while an earlier message is pending", () => {
  const pending = message("buzz://message/pending", 0);
  const availableLink = link("https://example.com/ready", 1);
  const availableMessage = message("buzz://message/ready", 2);
  const result = scheduleGeneratedPreviews(
    [pending, availableLink, availableMessage],
    new Map([
      [availableLink.preview.href, resolved(availableLink.preview.href)],
    ]),
    new Map([
      [pending.href, "pending"],
      [availableMessage.href, "available"],
    ]),
  );

  assert.equal(result.visibleCandidates[0], availableLink);
  assert.deepEqual(result.visibleCandidates, [availableLink, availableMessage]);
});
