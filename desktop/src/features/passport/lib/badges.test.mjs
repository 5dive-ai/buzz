import assert from "node:assert/strict";
import test from "node:test";

import { computeAgentBadges } from "./badges.ts";

const NOW = 1_800_000_000;
const DAY = 86_400;

function baseInputs(overrides = {}) {
  return {
    activeTurnCount: 0,
    channelCount: 0,
    closedPrCount: 0,
    firstSeenAt: null,
    hasAbout: false,
    hasAvatar: false,
    hasHandle: false,
    hasName: false,
    hasOwner: false,
    issuesOpenedCount: 0,
    memoryCount: null,
    mergedPrCount: 0,
    noteCount: 0,
    reactionCount: 0,
    repoCount: 0,
    reviewCount: 0,
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

test("merged pull requests earn the shipped ladder", () => {
  const first = computeAgentBadges(baseInputs({ mergedPrCount: 1 }));
  assert.equal(first[0].name, "First Merge");
  assert.equal(first[0].tier, 1);
  assert.match(first[0].description, /1 pull request merged/);

  const machine = computeAgentBadges(baseInputs({ mergedPrCount: 24 }));
  assert.equal(machine[0].name, "Merge Machine");
  assert.equal(machine[0].tier, 3);
});

test("high signal requires a decided sample and a high merge rate", () => {
  const strong = computeAgentBadges(
    baseInputs({ closedPrCount: 1, mergedPrCount: 9 }),
  );
  assert.ok(badgeIds(strong).includes("high-signal"));
  const highSignal = strong.find((badge) => badge.id === "high-signal");
  assert.match(highSignal.description, /9 of 10/);

  // Same rate but too few decided PRs to mean anything.
  const tinySample = computeAgentBadges(
    baseInputs({ closedPrCount: 0, mergedPrCount: 4 }),
  );
  assert.ok(!badgeIds(tinySample).includes("high-signal"));

  // Enough volume but half the PRs got rejected.
  const lowRate = computeAgentBadges(
    baseInputs({ closedPrCount: 5, mergedPrCount: 5 }),
  );
  assert.ok(!badgeIds(lowRate).includes("high-signal"));
});

test("issues filed earn the bug hunter ladder", () => {
  const spotter = computeAgentBadges(baseInputs({ issuesOpenedCount: 1 }));
  assert.equal(spotter[0].name, "Bug Spotter");

  const exterminator = computeAgentBadges(
    baseInputs({ issuesOpenedCount: 20 }),
  );
  assert.equal(exterminator[0].name, "Exterminator");
  assert.equal(exterminator[0].tier, 3);
});

test("reviews given and repo spread earn craft badges", () => {
  const badges = computeAgentBadges(
    baseInputs({ repoCount: 4, reviewCount: 12 }),
  );
  assert.deepEqual(badgeIds(badges), ["reviewer", "cross-pollinator"]);
  assert.equal(badges[0].name, "Reviewer");
  assert.equal(badges[1].name, "Multi-Repo");
});

test("craft badges precede tenure and activity", () => {
  const badges = computeAgentBadges(
    baseInputs({
      firstSeenAt: NOW - 200 * DAY,
      mergedPrCount: 5,
      noteCount: 30,
    }),
  );
  assert.deepEqual(badgeIds(badges), [
    "shipped",
    "high-signal",
    "tenure",
    "scribe",
  ]);
});

test("on duty appears while the agent is actively working", () => {
  const badges = computeAgentBadges(baseInputs({ activeTurnCount: 2 }));
  assert.equal(badges[0].id, "on-duty");
  assert.match(badges[0].description, /2 channels/);
});
