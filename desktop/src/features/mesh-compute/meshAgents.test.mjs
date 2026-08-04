import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract tests for mesh agent detection and the card's call to action.
 *
 * The CTA's value is that it stays quiet. A nudge that renders every time the
 * card does becomes furniture, so most of these tests pin *silence*.
 */

import {
  deriveMeshCallToAction,
  summarizeMeshAgents,
  usesMeshCompute,
} from "./meshAgents.ts";

function persona(overrides = {}) {
  return {
    id: "p1",
    displayName: "Hop",
    provider: "relay-mesh",
    ...overrides,
  };
}

test("mesh agents are identified by provider, not by model string", () => {
  const summary = summarizeMeshAgents([
    persona({ id: "a", displayName: "Zoe" }),
    persona({ id: "b", displayName: "Ada" }),
    persona({ id: "c", displayName: "Other", provider: "anthropic" }),
    // A model that merely mentions a mesh model is not a mesh agent: intent
    // lives in the persisted provider, not in a free-text model field.
    persona({ id: "d", displayName: "Lookalike", provider: null }),
  ]);
  assert.equal(summary.count, 2);
  assert.equal(summary.hasAny, true);
  assert.deepEqual(summary.names, ["Ada", "Zoe"], "names sort for stable copy");
});

test("provider matching tolerates whitespace and absence", () => {
  assert.equal(usesMeshCompute(persona({ provider: " relay-mesh " })), true);
  assert.equal(usesMeshCompute(persona({ provider: "anthropic" })), false);
  assert.equal(usesMeshCompute(persona({ provider: null })), false);
  assert.equal(usesMeshCompute(null), false);
  assert.equal(usesMeshCompute(undefined), false);
});

test("an empty persona list is not an error", () => {
  const summary = summarizeMeshAgents([]);
  assert.equal(summary.hasAny, false);
  assert.deepEqual(summary.names, []);
  assert.equal(summarizeMeshAgents(undefined).hasAny, false);
});

test("the CTA appears only when compute has no consumer", () => {
  // Sharing, but nothing can use it — the dead end worth naming.
  assert.deepEqual(
    deriveMeshCallToAction({
      personas: [persona({ provider: "anthropic" })],
      isSharing: true,
      meshHasCapacity: false,
    }),
    { kind: "createAgent", label: "Set up an agent to use it" },
  );
  // Not sharing, but the community has capacity this person could use.
  assert.equal(
    deriveMeshCallToAction({
      personas: [],
      isSharing: false,
      meshHasCapacity: true,
    }).kind,
    "createAgent",
  );
});

test("the CTA stays silent once a mesh agent exists", () => {
  assert.deepEqual(
    deriveMeshCallToAction({
      personas: [persona()],
      isSharing: true,
      meshHasCapacity: true,
    }),
    { kind: "none" },
  );
});

test("no capacity anywhere means the CTA would just move the dead end", () => {
  // Telling someone to build an agent for a mesh with nothing in it does not
  // help them; it relocates the problem.
  assert.deepEqual(
    deriveMeshCallToAction({
      personas: [],
      isSharing: false,
      meshHasCapacity: false,
    }),
    { kind: "none" },
  );
});

test("an unloaded persona list never prompts a possible duplicate", () => {
  // `undefined` is "not fetched yet". Prompting someone to create an agent they
  // may already have is worse than staying quiet for a moment.
  assert.deepEqual(
    deriveMeshCallToAction({
      personas: undefined,
      isSharing: true,
      meshHasCapacity: true,
    }),
    { kind: "none" },
  );
});
