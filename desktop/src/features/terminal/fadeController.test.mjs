import assert from "node:assert/strict";
import test from "node:test";

import {
  CONCEAL_DURATION_MS,
  FADE_EASING,
  FadeController,
  REVEAL_DURATION_MS,
} from "./fadeController.ts";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fixture() {
  const calls = [];
  const completions = [deferred()];
  const animation = {
    currentTime: 0,
    playbackRate: 0,
    finished: completions[0].promise,
    play() {
      calls.push("play");
      completions.push(deferred());
      this.finished = completions.at(-1).promise;
    },
    reverse() {
      calls.push("reverse");
      completions.push(deferred());
      this.finished = completions.at(-1).promise;
    },
    cancel() {
      calls.push("cancel");
    },
  };
  const surface = {
    style: { opacity: "1", willChange: "auto" },
    animate(frames, options) {
      calls.push({ frames, options });
      return animation;
    },
  };
  return {
    animation,
    calls,
    completions,
    controller: new FadeController(surface),
    surface,
  };
}

test("reversal reuses the one timeline and scales return playback", () => {
  const { animation, calls, controller } = fixture();
  assert.equal(controller.toggle(false), "reveal");
  assert.equal(controller.toggle(false), "conceal");
  assert.equal(calls.filter((call) => typeof call === "object").length, 1);
  assert.equal(
    animation.playbackRate,
    REVEAL_DURATION_MS / CONCEAL_DURATION_MS,
  );
  assert.equal(calls.at(-1), "reverse");
  assert.equal(calls[0].options.easing, FADE_EASING);
});

test("fade durations are half the original timing", () => {
  assert.equal(REVEAL_DURATION_MS, 360);
  assert.equal(CONCEAL_DURATION_MS, 210);
});

test("completed fades retain the timeline but release its compositor hint", async () => {
  const { calls, completions, controller, surface } = fixture();

  assert.equal(controller.toggle(false), "reveal");
  completions[0].resolve();
  await Promise.resolve();
  assert.equal(surface.style.willChange, "auto");

  assert.equal(controller.toggle(false), "conceal");
  assert.equal(calls.includes("cancel"), false);
  assert.equal(surface.style.willChange, "opacity");
  assert.equal(calls.filter((call) => typeof call === "object").length, 1);
});

test("a stale completion cannot release the hint during a reversal", async () => {
  const { completions, controller, surface } = fixture();

  controller.toggle(false);
  controller.toggle(false);
  completions[0].resolve();
  await Promise.resolve();
  assert.equal(surface.style.willChange, "opacity");

  completions[1].resolve();
  await Promise.resolve();
  assert.equal(surface.style.willChange, "auto");
});

test("reduced motion settles immediately without allocating an animation", () => {
  const { calls, controller, surface } = fixture();
  assert.equal(controller.toggle(true), "reveal");
  assert.equal(surface.style.opacity, "0");
  assert.equal(surface.style.willChange, "auto");
  assert.deepEqual(calls, []);
});
