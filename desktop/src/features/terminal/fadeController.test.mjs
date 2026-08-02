import assert from "node:assert/strict";
import test from "node:test";

import {
  CONCEAL_DURATION_MS,
  FADE_EASING,
  FadeController,
  REVEAL_DURATION_MS,
} from "./fadeController.ts";

function fixture() {
  const calls = [];
  let resolveFinished;
  const animation = {
    currentTime: 0,
    playbackRate: 0,
    finished: new Promise((resolve) => {
      resolveFinished = resolve;
    }),
    play() {
      calls.push("play");
    },
    reverse() {
      calls.push("reverse");
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
    controller: new FadeController(surface),
    resolveFinished,
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

test("reduced motion settles immediately without allocating an animation", () => {
  const { calls, controller, surface } = fixture();
  assert.equal(controller.toggle(true), "reveal");
  assert.equal(surface.style.opacity, "0");
  assert.equal(surface.style.willChange, "auto");
  assert.deepEqual(calls, []);
});
