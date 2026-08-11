import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveTimelineLoadingLatch,
  selectTimelineLoadingState,
} from "./timelineLoadingState.ts";

const settled = {
  isPending: false,
  isFetching: false,
  isPlaceholderData: false,
  dataLength: null,
};

test("pending first fetch with no cache is loading", () => {
  assert.equal(
    selectTimelineLoadingState({ ...settled, isPending: true }),
    true,
  );
});

test("stale placeholder while refetching is loading", () => {
  // Revisited within gcTime: placeholderData hands back a cached array while the
  // authoritative fetch runs. Must keep the skeleton up, not flash the intro.
  assert.equal(
    selectTimelineLoadingState({
      ...settled,
      isFetching: true,
      isPlaceholderData: true,
      dataLength: 0,
    }),
    true,
  );
});

test("subscription-seeded empty cache while fetching is loading", () => {
  // The live subscription's setQueryData seeds [] before history settles, so
  // data is defined but empty and a fetch is still in flight.
  assert.equal(
    selectTimelineLoadingState({
      ...settled,
      isFetching: true,
      isPlaceholderData: false,
      dataLength: 0,
    }),
    true,
  );
});

test("settled with rows is not loading", () => {
  assert.equal(
    selectTimelineLoadingState({ ...settled, dataLength: 5 }),
    false,
  );
});

test("settled and genuinely empty is not loading (real empty channel)", () => {
  assert.equal(
    selectTimelineLoadingState({ ...settled, dataLength: 0 }),
    false,
  );
});

test("background refetch of a populated channel is not loading", () => {
  // staleTime expiry can trigger a background refetch; with rows already present
  // we are loaded and must not re-show the skeleton.
  assert.equal(
    selectTimelineLoadingState({
      ...settled,
      isFetching: true,
      dataLength: 12,
    }),
    false,
  );
});

test("initial load holds the skeleton while the cold-load top-up fetches", () => {
  // Cold load seeds rows before its row-floor top-up finishes, so dataLength>0
  // while isFetching is still true. Before settle, hold the skeleton — dropping
  // it here is what exposed the older-fetch spinner on first load.
  assert.equal(
    selectTimelineLoadingState(
      { ...settled, isFetching: true, dataLength: 8 },
      false,
    ),
    true,
  );
});

test("pre-settle placeholder rows paint immediately (snapshot revisit)", () => {
  // A revisit painting from the React-Query cache or a persisted snapshot:
  // placeholder rows are a previously-settled timeline, not a partial cold
  // load — show them stale-then-revalidate instead of a skeleton.
  assert.equal(
    selectTimelineLoadingState(
      { ...settled, isFetching: true, isPlaceholderData: true, dataLength: 8 },
      false,
    ),
    false,
  );
});

test("pre-settle EMPTY placeholder still holds the skeleton", () => {
  assert.equal(
    selectTimelineLoadingState(
      { ...settled, isFetching: true, isPlaceholderData: true, dataLength: 0 },
      false,
    ),
    true,
  );
});

test("settled channel with rows mid-refetch is not loading", () => {
  // Same query shape, but after first settle: the latch owns refetch blips, so
  // present rows mean loaded.
  assert.equal(
    selectTimelineLoadingState(
      { ...settled, isFetching: true, dataLength: 8 },
      true,
    ),
    false,
  );
});

test("latch: loading on first entry to a channel", () => {
  const r = resolveTimelineLoadingLatch(new Set(), "chan-a", true, false);
  assert.equal(r.isLoading, true);
  assert.deepEqual([...r.settledChannelIds], []);
});

test("latch: settles when loadingNow turns false, recording the channel", () => {
  const r = resolveTimelineLoadingLatch(new Set(), "chan-a", false, true);
  assert.equal(r.isLoading, false);
  assert.deepEqual([...r.settledChannelIds], ["chan-a"]);
});

test("latch: background refetch blip stays loaded once settled", () => {
  const r = resolveTimelineLoadingLatch(
    new Set(["chan-a"]),
    "chan-a",
    true,
    true,
  );
  assert.equal(r.isLoading, false);
});

test("latch: remembers both channels across an A-B-A revisit", () => {
  const settledChannels = new Set(["chan-a", "chan-b"]);

  assert.equal(
    resolveTimelineLoadingLatch(settledChannels, "chan-a", true, true)
      .isLoading,
    false,
  );
  assert.equal(
    resolveTimelineLoadingLatch(settledChannels, "chan-b", true, true)
      .isLoading,
    false,
  );
});

test("latch: a settled channel goes cold after its query cache is collected", () => {
  const r = resolveTimelineLoadingLatch(
    new Set(["chan-a"]),
    "chan-a",
    true,
    false,
  );
  assert.equal(r.isLoading, true);
});

test("latch: no active channel passes loadingNow through untouched", () => {
  assert.equal(
    resolveTimelineLoadingLatch(new Set(["chan-a"]), null, true, false)
      .isLoading,
    true,
  );
  assert.equal(
    resolveTimelineLoadingLatch(new Set(["chan-a"]), null, false, false)
      .isLoading,
    false,
  );
});
