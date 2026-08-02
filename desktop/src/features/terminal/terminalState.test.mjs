import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_HANDOFF_STATE,
  accumulateScrollLines,
  encodePaste,
  encodeTerminalKey,
  reduceHandoff,
} from "./terminalState.ts";

test("ownership changes on completed chord, never key-down or repeat", () => {
  const down = reduceHandoff(INITIAL_HANDOFF_STATE, {
    type: "chord-down",
    repeat: false,
  });
  assert.equal(down.state.owner, "buzz");
  assert.equal(down.toggled, false);
  assert.equal(
    reduceHandoff(down.state, { type: "chord-up" }).state.owner,
    "terminal",
  );
  assert.deepEqual(
    reduceHandoff(INITIAL_HANDOFF_STATE, {
      type: "chord-down",
      repeat: true,
    }),
    { state: INITIAL_HANDOFF_STATE, toggled: false },
  );
});

test("composition and focus loss cancel an armed chord", () => {
  const armed = reduceHandoff(INITIAL_HANDOFF_STATE, {
    type: "chord-down",
    repeat: false,
  }).state;
  const composing = reduceHandoff(armed, { type: "composition-start" }).state;
  assert.equal(reduceHandoff(composing, { type: "chord-up" }).toggled, false);
  const blurred = reduceHandoff(armed, { type: "focus-lost" }).state;
  assert.equal(reduceHandoff(blurred, { type: "chord-up" }).toggled, false);
});

test("terminal key encoding covers control, navigation, and alt prefixes", () => {
  assert.equal(
    encodeTerminalKey({
      key: "c",
      ctrlKey: true,
      altKey: false,
      metaKey: false,
    }),
    "\u0003",
  );
  assert.equal(
    encodeTerminalKey({
      key: "ArrowUp",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    }),
    "\u001b[A",
  );
  assert.equal(
    encodeTerminalKey({
      key: "x",
      ctrlKey: false,
      altKey: true,
      metaKey: false,
    }),
    "\u001bx",
  );
  assert.equal(
    encodeTerminalKey({
      key: "x",
      ctrlKey: false,
      altKey: false,
      metaKey: true,
    }),
    null,
  );
});

test("bracketed paste wraps the entire payload exactly once", () => {
  assert.equal(encodePaste("a\nb", false), "a\nb");
  assert.equal(encodePaste("a\nb", true), "\u001b[200~a\nb\u001b[201~");
});

test("pixel scrolling retains fractional lines in both directions", () => {
  const state = { remainderPx: 0 };
  let result = accumulateScrollLines(state, 3, 10);
  assert.equal(result.lines, 0);
  result = accumulateScrollLines(result.state, 8, 10);
  assert.equal(result.lines, 1);
  assert.equal(result.state.remainderPx, 1);
  result = accumulateScrollLines(result.state, -12, 10);
  assert.equal(result.lines, -1);
  assert.equal(result.state.remainderPx, -1);
});
