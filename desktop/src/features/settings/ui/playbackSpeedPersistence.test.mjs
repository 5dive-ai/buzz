import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLoadedPlaybackSpeed,
  cancelPlaybackSpeedPersistence,
  commitPlaybackSpeed,
} from "./playbackSpeedPersistence.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function harness() {
  const calls = [];
  const errors = [];
  const saves = [];
  const speeds = [];
  const state = {
    active: { current: true },
    confirmedSpeed: { current: 1 },
    desiredSpeed: { current: 1 },
    flushPromise: { current: null },
    hasLocalIntent: { current: false },
  };
  const callbacks = {
    persist: (speed) => {
      calls.push(speed);
      const save = deferred();
      saves.push(save);
      return save.promise;
    },
    setError: (error) => errors.push(error),
    setSpeed: (speed) => speeds.push(speed),
  };
  return { callbacks, calls, errors, saves, speeds, state };
}

async function settle(state) {
  while (state.flushPromise.current) {
    await state.flushPromise.current;
  }
}

test("rapid intents persist serially and finish at the latest speed", async () => {
  const h = harness();
  commitPlaybackSpeed(h.state, h.callbacks, 1.25);
  commitPlaybackSpeed(h.state, h.callbacks, 1.5);
  assert.deepEqual(h.calls, [1.25]);

  h.saves[0].resolve();
  await Promise.resolve();
  assert.deepEqual(h.calls, [1.25, 1.5]);
  h.saves[1].resolve();
  await settle(h.state);

  assert.equal(h.state.confirmedSpeed.current, 1.5);
  assert.equal(h.state.desiredSpeed.current, 1.5);
});

test("a stale failure does not roll back a newer successful intent", async () => {
  const h = harness();
  commitPlaybackSpeed(h.state, h.callbacks, 1.25);
  commitPlaybackSpeed(h.state, h.callbacks, 1.5);

  h.saves[0].reject(new Error("first failed"));
  await Promise.resolve();
  assert.deepEqual(h.calls, [1.25, 1.5]);
  h.saves[1].resolve();
  await settle(h.state);

  assert.equal(h.state.confirmedSpeed.current, 1.5);
  assert.equal(h.state.desiredSpeed.current, 1.5);
  assert.deepEqual(h.speeds, [1.25, 1.5]);
  assert.deepEqual(h.errors, [null, null]);
});

test("the latest failure rolls back to the last confirmed speed", async () => {
  const h = harness();
  commitPlaybackSpeed(h.state, h.callbacks, 1.25);
  h.saves[0].reject(new Error("save failed"));
  await settle(h.state);

  assert.equal(h.state.confirmedSpeed.current, 1);
  assert.equal(h.state.desiredSpeed.current, 1);
  assert.deepEqual(h.speeds, [1.25, 1]);
  assert.equal(h.errors.at(-1), "Error: save failed");
});

test("a delayed initial load cannot overwrite a local intent", async () => {
  const h = harness();
  commitPlaybackSpeed(h.state, h.callbacks, 1.5);
  applyLoadedPlaybackSpeed(h.state, h.callbacks, 1);

  assert.equal(h.state.desiredSpeed.current, 1.5);
  assert.deepEqual(h.speeds, [1.5]);

  h.saves[0].resolve();
  await settle(h.state);
  assert.equal(h.state.confirmedSpeed.current, 1.5);
  assert.equal(h.state.desiredSpeed.current, 1.5);
});

test("an unmounted instance cannot persist stale queued intent", async () => {
  const oldInstance = harness();
  commitPlaybackSpeed(oldInstance.state, oldInstance.callbacks, 1.25);
  commitPlaybackSpeed(oldInstance.state, oldInstance.callbacks, 1.5);
  cancelPlaybackSpeedPersistence(oldInstance.state);

  const newInstance = harness();
  commitPlaybackSpeed(newInstance.state, newInstance.callbacks, 0.75);
  assert.deepEqual(oldInstance.calls, [1.25]);
  assert.deepEqual(newInstance.calls, [0.75]);

  oldInstance.saves[0].resolve();
  await settle(oldInstance.state);
  assert.deepEqual(oldInstance.calls, [1.25]);

  newInstance.saves[0].resolve();
  await settle(newInstance.state);
  assert.equal(newInstance.state.confirmedSpeed.current, 0.75);
});
