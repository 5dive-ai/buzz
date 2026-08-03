import assert from "node:assert/strict";
import test from "node:test";

import { parseLinkPreviewSnapshots } from "./linkPreviewSnapshot.ts";

const HASH = "a".repeat(64);
const ORIGIN = "https://relay.example";
const CONTENT = "Read https://linear.app/acme/issue/ABC-123/example";
const URL = "https://linear.app/acme/issue/ABC-123/example";
const valid = [
  "link-preview",
  "snapshot",
  "1",
  URL,
  "Example",
  "Linear",
  "Description",
  `${ORIGIN}/media/${HASH}.png`,
  HASH,
  "",
  "",
];

test("authored snapshots render only exact local media tied to message content", () => {
  assert.equal(parseLinkPreviewSnapshots([valid], CONTENT, ORIGIN).length, 1);
  assert.equal(
    parseLinkPreviewSnapshots([valid], "no matching link", ORIGIN).length,
    0,
  );
  assert.equal(parseLinkPreviewSnapshots([valid], CONTENT, null).length, 0);
});

test("authored snapshots reject remote, malformed, credentialed, and hash-mismatched media", () => {
  for (const image of [
    `https://evil.example/media/${HASH}.png`,
    `${ORIGIN}/media/${HASH}.png?token=leak`,
    `${ORIGIN}/media/${HASH}.png#fragment`,
    `https://user@relay.example/media/${HASH}.png`,
    `${ORIGIN}/media/${HASH}.svg`,
    `${ORIGIN}/media/${HASH}.png/extra`,
  ]) {
    const tag = [...valid];
    tag[7] = image;
    assert.equal(
      parseLinkPreviewSnapshots([tag], CONTENT, ORIGIN).length,
      0,
      image,
    );
  }
  const mismatch = [...valid];
  mismatch[8] = "b".repeat(64);
  assert.equal(
    parseLinkPreviewSnapshots([mismatch], CONTENT, ORIGIN).length,
    0,
  );
});

test("messages without authored snapshots never create recipient previews", () => {
  assert.deepEqual(parseLinkPreviewSnapshots([], CONTENT, ORIGIN), []);
  assert.deepEqual(parseLinkPreviewSnapshots(undefined, CONTENT, ORIGIN), []);
});
