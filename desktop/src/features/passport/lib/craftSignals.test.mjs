import assert from "node:assert/strict";
import test from "node:test";

import { countCraftSignals } from "./craftSignals.ts";

const AGENT = "a".repeat(64);
const OTHER = "b".repeat(64);

function pullRequest(overrides = {}) {
  return {
    author: AGENT,
    comments: [],
    status: "Open",
    ...overrides,
  };
}

function comment(overrides = {}) {
  return {
    author: AGENT,
    isApproval: false,
    isChangeRequest: false,
    isInlineComment: false,
    ...overrides,
  };
}

function workItems({ issues = [], pullRequests = [] } = {}) {
  return {
    issues: { items: issues },
    pullRequests: { items: pullRequests },
  };
}

test("missing data or pubkey yields zero counts", () => {
  const zero = countCraftSignals(undefined, AGENT);
  assert.deepEqual(zero, {
    closedPrCount: 0,
    issuesOpenedCount: 0,
    mergedPrCount: 0,
    repoCount: 0,
    reviewCount: 0,
  });
  assert.deepEqual(countCraftSignals(workItems(), null), zero);
});

test("authored PRs split into merged and closed, keyed case-insensitively", () => {
  const counts = countCraftSignals(
    workItems({
      pullRequests: [
        {
          project: { id: "repo-1" },
          pullRequest: pullRequest({
            author: AGENT.toUpperCase(),
            status: "Merged",
          }),
        },
        {
          project: { id: "repo-1" },
          pullRequest: pullRequest({ status: "Closed" }),
        },
        {
          project: { id: "repo-1" },
          pullRequest: pullRequest({ status: "Open" }),
        },
        {
          project: { id: "repo-2" },
          pullRequest: pullRequest({ author: OTHER, status: "Merged" }),
        },
      ],
    }),
    AGENT,
  );
  assert.equal(counts.mergedPrCount, 1);
  assert.equal(counts.closedPrCount, 1);
  assert.equal(counts.repoCount, 1);
});

test("only review-weight comments on others' PRs count as reviews", () => {
  const counts = countCraftSignals(
    workItems({
      pullRequests: [
        {
          project: { id: "repo-2" },
          pullRequest: pullRequest({
            author: OTHER,
            comments: [
              comment({ isApproval: true }),
              comment({ isInlineComment: true }),
              comment(), // plain discussion — no review weight
              comment({ author: OTHER, isApproval: true }), // not the agent
            ],
          }),
        },
        {
          // Comments on the agent's own PR never count as reviews.
          project: { id: "repo-1" },
          pullRequest: pullRequest({
            comments: [comment({ isApproval: true })],
          }),
        },
      ],
    }),
    AGENT,
  );
  assert.equal(counts.reviewCount, 2);
  assert.equal(counts.repoCount, 2);
});

test("filed issues count and extend repo spread", () => {
  const counts = countCraftSignals(
    workItems({
      issues: [
        { project: { id: "repo-3" }, issue: { author: AGENT } },
        { project: { id: "repo-3" }, issue: { author: AGENT } },
        { project: { id: "repo-4" }, issue: { author: OTHER } },
      ],
    }),
    AGENT,
  );
  assert.equal(counts.issuesOpenedCount, 2);
  assert.equal(counts.repoCount, 1);
});
