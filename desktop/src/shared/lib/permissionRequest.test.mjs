/**
 * Named test matrix for the `permissionRequest` sentinel parser.
 *
 * All fixtures are verbatim from Duncan's frozen schema (event b31c716e).
 * Tests cover: parse, reject, and sentinel extraction/stripping.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── Import via dynamic import to work with the ESM test runner ────────────────
// The tests run against the compiled JS (tsc outputs CJS); for the mjs runner
// we use a relative path that resolves after build or through tsx.

const mod = await import("./permissionRequest.js").catch(
  () => import("./permissionRequest.ts"),
);
const { extractPermissionRequest, stripPermissionRequestSentinel } = mod;

// ── Fixtures (verbatim from event b31c716e) ───────────────────────────────────

const PENDING_NORMAL = {
  v: 1,
  state: "pending",
  requestNonce: "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  sessionId: "sess-abc",
  turnId: "turn-xyz",
  expiresAt: 1786206732,
  optionIds: ["opt-allow", "opt-deny"],
  labels: { "opt-allow": "Allow once", "opt-deny": "Deny" },
  hasDurableRule: false,
  durableRuleNote: null,
};

const PENDING_DURABLE = {
  v: 1,
  state: "pending",
  requestNonce: "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
  sessionId: "sess-abc",
  turnId: "turn-xyz",
  expiresAt: 1786206732,
  optionIds: ["opt-allow-once", "opt-allow-always", "opt-deny"],
  labels: {
    "opt-allow-once": "Allow once",
    "opt-allow-always": "Always allow",
    "opt-deny": "Deny",
  },
  hasDurableRule: true,
  durableRuleNote:
    "Includes an 'Always allow' option — creates a machine-wide durable rule in Codex.",
};

const RESOLVED_APPLIED = {
  v: 1,
  state: "resolved",
  requestNonce: "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  originalEventId:
    "deadbeef0001deadbeef0002deadbeef0003deadbeef0004deadbeef0005dead",
  sessionId: "sess-abc",
  turnId: "turn-xyz",
  expiresAt: 1786206732,
  optionIds: ["opt-allow", "opt-deny"],
  labels: { "opt-allow": "Allow once", "opt-deny": "Deny" },
  hasDurableRule: false,
  durableRuleNote: null,
  outcome: "applied",
  chosenOptionId: "opt-allow",
};

const RESOLVED_TIMED_OUT = {
  v: 1,
  state: "resolved",
  requestNonce: "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  originalEventId:
    "deadbeef0001deadbeef0002deadbeef0003deadbeef0004deadbeef0005dead",
  sessionId: "sess-abc",
  turnId: "turn-xyz",
  expiresAt: 1786206732,
  optionIds: ["opt-allow", "opt-deny"],
  labels: { "opt-allow": "Allow once", "opt-deny": "Deny" },
  hasDurableRule: false,
  durableRuleNote: null,
  outcome: "timed_out",
  chosenOptionId: null,
};

const RESOLVED_CANCELLED = {
  v: 1,
  state: "resolved",
  requestNonce: "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  originalEventId:
    "deadbeef0001deadbeef0002deadbeef0003deadbeef0004deadbeef0005dead",
  sessionId: "sess-abc",
  turnId: "turn-xyz",
  expiresAt: 1786206732,
  optionIds: ["opt-allow", "opt-deny"],
  labels: { "opt-allow": "Allow once", "opt-deny": "Deny" },
  hasDurableRule: false,
  durableRuleNote: null,
  outcome: "cancelled",
  chosenOptionId: null,
};

const RESOLVED_REJECTED = {
  v: 1,
  state: "resolved",
  requestNonce: "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  originalEventId:
    "deadbeef0001deadbeef0002deadbeef0003deadbeef0004deadbeef0005dead",
  sessionId: "sess-abc",
  turnId: "turn-xyz",
  expiresAt: 1786206732,
  optionIds: ["opt-allow", "opt-deny"],
  labels: { "opt-allow": "Allow once", "opt-deny": "Deny" },
  hasDurableRule: false,
  durableRuleNote: null,
  outcome: "rejected",
  chosenOptionId: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrap(payload) {
  return `Some prose above.\n\n\`\`\`buzz:permission-request\n${JSON.stringify(payload)}\n\`\`\`\n`;
}

// ── Parse: happy-path fixtures ────────────────────────────────────────────────

describe("extractPermissionRequest — pending fixtures", () => {
  it("test_pending_normal_parses_correctly", () => {
    const result = extractPermissionRequest(wrap(PENDING_NORMAL));
    assert.ok(result !== null, "should parse");
    assert.equal(result.state, "pending");
    assert.equal(result.requestNonce, "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4");
    assert.equal(result.sessionId, "sess-abc");
    assert.equal(result.turnId, "turn-xyz");
    assert.equal(result.expiresAt, 1786206732);
    assert.deepEqual(result.optionIds, ["opt-allow", "opt-deny"]);
    assert.deepEqual(result.labels, {
      "opt-allow": "Allow once",
      "opt-deny": "Deny",
    });
    assert.equal(result.hasDurableRule, false);
    assert.equal(result.durableRuleNote, null);
    // pending has no originalEventId, outcome, chosenOptionId
    assert.ok(!("originalEventId" in result));
    assert.ok(!("outcome" in result));
    assert.ok(!("chosenOptionId" in result));
  });

  it("test_pending_durable_rule_parses_correctly", () => {
    const result = extractPermissionRequest(wrap(PENDING_DURABLE));
    assert.ok(result !== null, "should parse");
    assert.equal(result.state, "pending");
    assert.equal(result.hasDurableRule, true);
    assert.equal(
      result.durableRuleNote,
      "Includes an 'Always allow' option — creates a machine-wide durable rule in Codex.",
    );
    assert.deepEqual(result.optionIds, [
      "opt-allow-once",
      "opt-allow-always",
      "opt-deny",
    ]);
    assert.equal(result.labels["opt-allow-always"], "Always allow");
  });
});

describe("extractPermissionRequest — resolved fixtures", () => {
  it("test_resolved_applied_parses_correctly", () => {
    const result = extractPermissionRequest(wrap(RESOLVED_APPLIED));
    assert.ok(result !== null, "should parse");
    assert.equal(result.state, "resolved");
    assert.equal(result.outcome, "applied");
    assert.equal(result.chosenOptionId, "opt-allow");
    assert.equal(
      result.originalEventId,
      "deadbeef0001deadbeef0002deadbeef0003deadbeef0004deadbeef0005dead",
    );
  });

  it("test_resolved_timed_out_parses_correctly", () => {
    const result = extractPermissionRequest(wrap(RESOLVED_TIMED_OUT));
    assert.ok(result !== null, "should parse");
    assert.equal(result.state, "resolved");
    assert.equal(result.outcome, "timed_out");
    assert.equal(result.chosenOptionId, null);
  });

  it("test_resolved_cancelled_parses_correctly", () => {
    const result = extractPermissionRequest(wrap(RESOLVED_CANCELLED));
    assert.ok(result !== null, "should parse");
    assert.equal(result.state, "resolved");
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.chosenOptionId, null);
  });

  it("test_resolved_rejected_parses_correctly", () => {
    const result = extractPermissionRequest(wrap(RESOLVED_REJECTED));
    assert.ok(result !== null, "should parse");
    assert.equal(result.state, "resolved");
    assert.equal(result.outcome, "rejected");
    assert.equal(result.chosenOptionId, null);
  });
});

// ── Parse: rejection cases ────────────────────────────────────────────────────

describe("extractPermissionRequest — rejection cases", () => {
  it("test_no_sentinel_returns_null", () => {
    assert.equal(extractPermissionRequest("just prose, no fence"), null);
  });

  it("test_wrong_version_returns_null", () => {
    const bad = { ...PENDING_NORMAL, v: 2 };
    assert.equal(extractPermissionRequest(wrap(bad)), null);
  });

  it("test_unknown_state_returns_null", () => {
    const bad = { ...PENDING_NORMAL, state: "unknown" };
    assert.equal(extractPermissionRequest(wrap(bad)), null);
  });

  it("test_empty_optionIds_returns_null", () => {
    const bad = { ...PENDING_NORMAL, optionIds: [] };
    assert.equal(extractPermissionRequest(wrap(bad)), null);
  });

  it("test_too_many_optionIds_returns_null", () => {
    const bad = {
      ...PENDING_NORMAL,
      optionIds: Array.from({ length: 11 }, (_, i) => `opt-${i}`),
      labels: Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [`opt-${i}`, `Option ${i}`]),
      ),
    };
    assert.equal(extractPermissionRequest(wrap(bad)), null);
  });

  it("test_label_exceeding_200_chars_returns_null", () => {
    const longLabel = "x".repeat(201);
    const bad = {
      ...PENDING_NORMAL,
      labels: { "opt-allow": longLabel, "opt-deny": "Deny" },
    };
    assert.equal(extractPermissionRequest(wrap(bad)), null);
  });

  it("test_missing_requestNonce_returns_null", () => {
    const { requestNonce: _, ...bad } = PENDING_NORMAL;
    assert.equal(extractPermissionRequest(wrap(bad)), null);
  });

  it("test_resolved_missing_originalEventId_returns_null", () => {
    const { originalEventId: _, ...bad } = RESOLVED_APPLIED;
    assert.equal(extractPermissionRequest(wrap(bad)), null);
  });

  it("test_resolved_originalEventId_wrong_length_returns_null", () => {
    const bad = { ...RESOLVED_APPLIED, originalEventId: "tooshort" };
    assert.equal(extractPermissionRequest(wrap(bad)), null);
  });

  it("test_invalid_json_returns_null", () => {
    const content = "```buzz:permission-request\n{not valid json}\n```\n";
    assert.equal(extractPermissionRequest(content), null);
  });

  it("test_empty_fence_body_returns_null", () => {
    const content = "```buzz:permission-request\n\n```\n";
    assert.equal(extractPermissionRequest(content), null);
  });

  it("test_non_finite_expiresAt_returns_null", () => {
    const bad = { ...PENDING_NORMAL, expiresAt: Infinity };
    assert.equal(extractPermissionRequest(wrap(bad)), null);
  });
});

// ── stripPermissionRequestSentinel ───────────────────────────────────────────

describe("stripPermissionRequestSentinel", () => {
  it("test_strip_removes_fence_and_preserves_prose", () => {
    const content = `Some prose.\n\n\`\`\`buzz:permission-request\n${JSON.stringify(PENDING_NORMAL)}\n\`\`\`\n`;
    const stripped = stripPermissionRequestSentinel(content);
    assert.ok(!stripped.includes("buzz:permission-request"));
    assert.ok(stripped.includes("Some prose."));
  });

  it("test_strip_no_sentinel_returns_original", () => {
    const content = "just prose here";
    assert.equal(stripPermissionRequestSentinel(content), content);
  });

  it("test_strip_empty_string_returns_empty", () => {
    assert.equal(stripPermissionRequestSentinel(""), "");
  });
});
