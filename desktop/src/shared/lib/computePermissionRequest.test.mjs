/**
 * Named test matrix for `computePermissionRequest` and `selectProseOrPermission`.
 *
 * Fixtures use the frozen schema (event b31c716e).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  computePermissionRequest,
  selectProseOrPermission,
} from "./computePermissionRequest.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AGENT_PUBKEY =
  "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const ATTACKER_PUBKEY =
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const OWNER_PUBKEY =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const PENDING_PAYLOAD = {
  v: 1,
  state: "pending",
  requestNonce: "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  sessionId: "sess-abc",
  turnId: "turn-xyz",
  expiresAt: 9999999999,
  optionIds: ["opt-allow", "opt-deny"],
  labels: { "opt-allow": "Allow once", "opt-deny": "Deny" },
  hasDurableRule: false,
  durableRuleNote: null,
};

const RESOLVED_PAYLOAD = {
  v: 1,
  state: "resolved",
  requestNonce: "a9f3b2c1-d4e5-4f6a-b7c8-d9e0f1a2b3c4",
  originalEventId:
    "deadbeef0001deadbeef0002deadbeef0003deadbeef0004deadbeef0005dead",
  sessionId: "sess-abc",
  turnId: "turn-xyz",
  expiresAt: 9999999999,
  optionIds: ["opt-allow", "opt-deny"],
  labels: { "opt-allow": "Allow once", "opt-deny": "Deny" },
  hasDurableRule: false,
  durableRuleNote: null,
  outcome: "applied",
  chosenOptionId: "opt-allow",
};

function fence(payload) {
  return `\`\`\`buzz:permission-request\n${JSON.stringify(payload)}\n\`\`\``;
}

function body(payload) {
  return `May I?\n\n${fence(payload)}`;
}

// ── computePermissionRequest ──────────────────────────────────────────────────

test("test_not_interactive_returns_null", () => {
  assert.equal(
    computePermissionRequest(
      body(PENDING_PAYLOAD),
      false,
      AGENT_PUBKEY,
      AGENT_PUBKEY,
    ),
    null,
  );
});

test("test_missing_agentPubkey_returns_null", () => {
  assert.equal(
    computePermissionRequest(
      body(PENDING_PAYLOAD),
      true,
      undefined,
      AGENT_PUBKEY,
    ),
    null,
  );
});

test("test_missing_signerPubkey_returns_null", () => {
  assert.equal(
    computePermissionRequest(
      body(PENDING_PAYLOAD),
      true,
      AGENT_PUBKEY,
      undefined,
    ),
    null,
  );
});

test("test_forged_card_wrong_signer_returns_null", () => {
  // agentPubkey (channel's known agent) ≠ signerPubkey (event signer)
  assert.equal(
    computePermissionRequest(
      body(PENDING_PAYLOAD),
      true,
      AGENT_PUBKEY,
      ATTACKER_PUBKEY,
    ),
    null,
  );
});

test("test_valid_signer_returns_payload", () => {
  const result = computePermissionRequest(
    body(PENDING_PAYLOAD),
    true,
    AGENT_PUBKEY,
    AGENT_PUBKEY,
  );
  assert.deepEqual(result, PENDING_PAYLOAD);
});

test("test_signer_check_is_case_insensitive", () => {
  const result = computePermissionRequest(
    body(PENDING_PAYLOAD),
    true,
    AGENT_PUBKEY.toUpperCase(),
    AGENT_PUBKEY.toLowerCase(),
  );
  assert.deepEqual(result, PENDING_PAYLOAD);
});

test("test_no_sentinel_returns_null", () => {
  assert.equal(
    computePermissionRequest(
      "No sentinel here",
      true,
      AGENT_PUBKEY,
      AGENT_PUBKEY,
    ),
    null,
  );
});

test("test_agent_signed_edit_resolves_card", () => {
  const result = computePermissionRequest(
    body(RESOLVED_PAYLOAD),
    true,
    AGENT_PUBKEY,
    AGENT_PUBKEY, // original event signer
    AGENT_PUBKEY, // edit signer == agent ✓
  );
  assert.deepEqual(result, RESOLVED_PAYLOAD);
});

test("test_owner_signed_edit_does_not_resolve", () => {
  assert.equal(
    computePermissionRequest(
      body(RESOLVED_PAYLOAD),
      true,
      AGENT_PUBKEY,
      AGENT_PUBKEY,
      OWNER_PUBKEY, // edit signer is owner, not agent ✗
    ),
    null,
  );
});

test("test_attacker_signed_edit_does_not_resolve", () => {
  assert.equal(
    computePermissionRequest(
      body(RESOLVED_PAYLOAD),
      true,
      AGENT_PUBKEY,
      AGENT_PUBKEY,
      ATTACKER_PUBKEY, // attacker edit ✗
    ),
    null,
  );
});

test("test_resolved_body_with_no_edit_arrived_parses_body_directly", () => {
  // When editSignerPubkey is undefined, no edit-authenticity check runs.
  // If the original event body happened to contain a resolved sentinel, we
  // return it. This handles the edge case where the edit arrives before we
  // query the original event.
  const result = computePermissionRequest(
    body(RESOLVED_PAYLOAD),
    true,
    AGENT_PUBKEY,
    AGENT_PUBKEY,
    undefined,
  );
  assert.deepEqual(result, RESOLVED_PAYLOAD);
});

// ── selectProseOrPermission ───────────────────────────────────────────────────

test("test_selectProseOrPermission_returns_markdown_when_no_request", () => {
  const node = "markdown-node";
  assert.equal(selectProseOrPermission(null, node), node);
});

test("test_selectProseOrPermission_returns_null_when_request_present", () => {
  // Pass a typed object directly (not parsed from content)
  assert.equal(selectProseOrPermission(PENDING_PAYLOAD, "markdown-node"), null);
});
