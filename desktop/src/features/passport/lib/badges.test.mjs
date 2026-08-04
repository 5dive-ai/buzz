import assert from "node:assert/strict";
import test from "node:test";

import { computeAgentBadges } from "./badges.ts";

const NOW = 1_800_000_000;
const DAY = 86_400;

function baseInputs(overrides = {}) {
  return {
    activeTurnCount: 0,
    channelCount: 0,
    firstSeenAt: null,
    hasAbout: false,
    hasAvatar: false,
    hasHandle: false,
    hasName: false,
    hasOwner: false,
    memoryCount: null,
    noteCount: 0,
    noteHours: [],
    reactionCount: 0,
    now: NOW,
    ...overrides,
  };
}

function badgeIds(badges) {
  return badges.map((badge) => badge.id);
}

test("a blank record earns no badges", () => {
  assert.deepEqual(computeAgentBadges(baseInputs()), []);
});

test("trust badges reflect provenance facts", () => {
  const badges = computeAgentBadges(
    baseInputs({
      hasAbout: true,
      hasAvatar: true,
      hasHandle: true,
      hasName: true,
      hasOwner: true,
    }),
  );
  assert.deepEqual(badgeIds(badges), [
    "registered-operator",
    "verified-handle",
    "full-papers",
  ]);
});

test("full papers requires every profile field", () => {
  const badges = computeAgentBadges(
    baseInputs({ hasAbout: true, hasAvatar: true, hasName: true }),
  );
  assert.ok(!badgeIds(badges).includes("full-papers"));
});

test("tenure tiers escalate with days on record", () => {
  const veteran = computeAgentBadges(
    baseInputs({ firstSeenAt: NOW - 200 * DAY }),
  );
  assert.equal(veteran[0].name, "Veteran");
  assert.equal(veteran[0].tier, 3);

  const settled = computeAgentBadges(
    baseInputs({ firstSeenAt: NOW - 45 * DAY }),
  );
  assert.equal(settled[0].name, "Settled");
  assert.equal(settled[0].tier, 1);

  const fresh = computeAgentBadges(baseInputs({ firstSeenAt: NOW - 5 * DAY }));
  assert.deepEqual(fresh, []);
});

test("the like ladder honors its BadgeNation heritage", () => {
  const godlike = computeAgentBadges(baseInputs({ reactionCount: 150 }));
  assert.equal(godlike[0].name, "Godlike");
  assert.equal(godlike[0].tier, 3);

  const double = computeAgentBadges(baseInputs({ reactionCount: 5 }));
  assert.equal(double[0].name, "Double Like");
});

test("memories only grant badges when visible to the viewer", () => {
  assert.deepEqual(computeAgentBadges(baseInputs({ memoryCount: null })), []);
  const badges = computeAgentBadges(baseInputs({ memoryCount: 60 }));
  assert.equal(badges[0].name, "Elephant Memory");
});

test("time-of-day flair needs a repeated pattern", () => {
  const night = computeAgentBadges(
    baseInputs({ noteHours: [23, 0, 1, 2, 3, 4] }),
  );
  assert.deepEqual(badgeIds(night), ["night-hawk"]);

  const sparse = computeAgentBadges(baseInputs({ noteHours: [23, 0] }));
  assert.deepEqual(sparse, []);
});

test("on duty appears while the agent is actively working", () => {
  const badges = computeAgentBadges(baseInputs({ activeTurnCount: 2 }));
  assert.equal(badges[0].id, "on-duty");
  assert.match(badges[0].description, /2 channels/);
});
