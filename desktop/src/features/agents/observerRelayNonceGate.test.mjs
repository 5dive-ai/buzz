import assert from "node:assert/strict";
import test from "node:test";

import {
  registerEffortNonce,
  resetAgentObserverStore,
  _testNonceGate,
} from "./observerRelayStore.ts";

const PUBKEY = "aabb";

// Reset store state before each test so nonce map is clean.
function setup() {
  resetAgentObserverStore();
}

// ── startup path (no nonce ever registered) ───────────────────────────────────

test("nonce gate: passes ack with no nonce when no nonce has been registered (startup path)", () => {
  setup();
  // Pre-any-pick: startup-applied effort acks carry no nonce.
  assert.equal(_testNonceGate(PUBKEY, undefined), true);
});

test("nonce gate: rejects ack WITH a nonce when no nonce has been registered", () => {
  setup();
  // Startup path: a nonce-bearing ack should not pass through the no-nonce gate.
  // This prevents a stale ack from an old session from persisting during startup.
  assert.equal(_testNonceGate(PUBKEY, "some-nonce"), false);
});

// ── post-registration path (nonce registered via registerEffortNonce) ─────────

test("nonce gate: passes ack with matching nonce once a nonce is registered", () => {
  setup();
  registerEffortNonce(PUBKEY, "nonce-42");
  assert.equal(_testNonceGate(PUBKEY, "nonce-42"), true);
});

test("nonce gate: rejects ack with mismatched nonce once a nonce is registered", () => {
  setup();
  registerEffortNonce(PUBKEY, "nonce-current");
  // Stale ack from a prior pick.
  assert.equal(_testNonceGate(PUBKEY, "nonce-old"), false);
});

test("nonce gate: rejects nonce-less ack once a nonce is registered (P3 bypass fix)", () => {
  setup();
  // P3: once a nonce has been registered, a nonce-less ok/cleared ack must NOT
  // pass through — it is a stale result from before the nonce system was in place
  // or from a superseded pick. Without this fix the ack would bypass the gate.
  registerEffortNonce(PUBKEY, "nonce-registered");
  assert.equal(_testNonceGate(PUBKEY, undefined), false);
});

// ── per-agent isolation ───────────────────────────────────────────────────────

test("nonce gate: different agents are isolated — no cross-registration", () => {
  setup();
  registerEffortNonce("agent-a", "nonce-a");
  // agent-b has no registered nonce → startup path applies.
  assert.equal(_testNonceGate("agent-b", undefined), true);
  assert.equal(_testNonceGate("agent-b", "nonce-a"), false);
});

// ── reset clears nonce state ──────────────────────────────────────────────────

test("resetAgentObserverStore clears currentEffortNonce so startup path is restored", () => {
  setup();
  registerEffortNonce(PUBKEY, "nonce-registered");
  // Before reset: nonce-less ack is blocked.
  assert.equal(_testNonceGate(PUBKEY, undefined), false);

  resetAgentObserverStore();
  // After reset: no nonce registered → startup path active again.
  assert.equal(_testNonceGate(PUBKEY, undefined), true);
});
