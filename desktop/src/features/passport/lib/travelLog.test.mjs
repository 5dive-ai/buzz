import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRelayUrl, upsertTravelLogEntry } from "./travelLog.ts";

test("first visit creates an entry with matching first/last timestamps", () => {
  const entries = upsertTravelLogEntry(
    [],
    { name: "Buzz HQ", relayUrl: "wss://relay.example.com" },
    "2026-08-04T12:00:00.000Z",
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "Buzz HQ");
  assert.equal(entries[0].firstVisitedAt, "2026-08-04T12:00:00.000Z");
  assert.equal(entries[0].lastVisitedAt, "2026-08-04T12:00:00.000Z");
});

test("revisits refresh lastVisitedAt and name but keep firstVisitedAt", () => {
  const first = upsertTravelLogEntry(
    [],
    { name: "Buzz HQ", relayUrl: "wss://relay.example.com" },
    "2026-01-01T00:00:00.000Z",
  );
  const second = upsertTravelLogEntry(
    first,
    { name: "Buzz HQ (renamed)", relayUrl: "wss://relay.example.com/" },
    "2026-08-04T12:00:00.000Z",
  );
  assert.equal(second.length, 1);
  assert.equal(second[0].name, "Buzz HQ (renamed)");
  assert.equal(second[0].firstVisitedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(second[0].lastVisitedAt, "2026-08-04T12:00:00.000Z");
});

test("relay URLs are keyed case-insensitively and without trailing slashes", () => {
  assert.equal(
    normalizeRelayUrl("WSS://Relay.Example.com/"),
    normalizeRelayUrl("wss://relay.example.com"),
  );
});

test("distinct servers accumulate, most recently visited first", () => {
  let entries = upsertTravelLogEntry(
    [],
    { name: "Alpha", relayUrl: "wss://alpha.example" },
    "2026-01-01T00:00:00.000Z",
  );
  entries = upsertTravelLogEntry(
    entries,
    { name: "Beta", relayUrl: "wss://beta.example" },
    "2026-02-01T00:00:00.000Z",
  );
  entries = upsertTravelLogEntry(
    entries,
    { name: "Alpha", relayUrl: "wss://alpha.example" },
    "2026-03-01T00:00:00.000Z",
  );
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["Alpha", "Beta"],
  );
  assert.equal(entries[0].firstVisitedAt, "2026-01-01T00:00:00.000Z");
});
