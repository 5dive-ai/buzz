import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUnifiedGroups,
  profileAgentsForGroup,
} from "./unifiedAgentGroups.ts";

function agent(pubkey, overrides = {}) {
  return {
    pubkey,
    name: overrides.name ?? "Fizz",
    personaId: overrides.personaId ?? "builtin:fizz",
    status: overrides.status ?? "stopped",
    ...overrides,
  };
}

const fizz = { id: "builtin:fizz", displayName: "Fizz" };

test("buildUnifiedGroups retains every managed instance for one persona", () => {
  const first = agent("a".repeat(64));
  const second = agent("b".repeat(64));

  const { groups, ungrouped, unknown } = buildUnifiedGroups(
    [fizz],
    [first, second],
  );

  assert.deepEqual(groups, [{ persona: fizz, agents: [first, second] }]);
  assert.deepEqual(ungrouped, []);
  assert.deepEqual(unknown, []);
});

test("profileAgentsForGroup returns every instance in stable order without mutating input", () => {
  const stopped = agent("a".repeat(64), { name: "Zulu" });
  const runningLater = agent("c".repeat(64), {
    name: "Alpha",
    status: "running",
  });
  const runningEarlier = agent("b".repeat(64), {
    name: "Alpha",
    status: "running",
  });
  const input = [stopped, runningLater, runningEarlier];

  assert.deepEqual(profileAgentsForGroup(input), [
    runningEarlier,
    runningLater,
    stopped,
  ]);
  assert.deepEqual(input, [stopped, runningLater, runningEarlier]);
});

test("a relay-restored persona instance follows the same visible group path", () => {
  const relayRestored = agent("c".repeat(64), {
    name: "Recovered Fizz",
    status: "stopped",
  });

  const { groups } = buildUnifiedGroups([fizz], [relayRestored]);

  assert.deepEqual(profileAgentsForGroup(groups[0].agents), [relayRestored]);
});

test("a persona with no managed instance remains an empty group", () => {
  const { groups } = buildUnifiedGroups([fizz], []);

  assert.deepEqual(groups, [{ persona: fizz, agents: [] }]);
  assert.deepEqual(profileAgentsForGroup(groups[0].agents), []);
});
