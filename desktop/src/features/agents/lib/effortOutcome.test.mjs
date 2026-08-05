import assert from "node:assert/strict";
import test from "node:test";

import { awaitEffortOutcome } from "./effortOutcome.ts";

const CONFIG_ID = "effort";

function frame(status, overrides = {}) {
  return {
    type: "set_config_option",
    status,
    configId: CONFIG_ID,
    value: "high",
    category: "thought_level",
    ...overrides,
  };
}

/**
 * A controllable test harness that wires awaitEffortOutcome with:
 *   - a pub/sub whose unsubscribe genuinely detaches (post-detach pushes no-op)
 *   - a manual timeout the test fires explicitly
 *   - a deferred send the test can inspect
 */
function harness(value = "high") {
  let listener = null;
  let timeoutCb = null;
  let unsubscribeCalls = 0;
  let cancelTimeoutCalls = 0;
  let sendCalled = false;

  const outcome = awaitEffortOutcome({
    configId: CONFIG_ID,
    value,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        unsubscribeCalls += 1;
        listener = null;
      };
    },
    send: () => {
      sendCalled = true;
      return Promise.resolve();
    },
    scheduleTimeout: (cb) => {
      timeoutCb = cb;
      return () => {
        cancelTimeoutCalls += 1;
      };
    },
  });

  return {
    outcome,
    push: (f) => listener?.(f),
    fireTimeout: () => timeoutCb?.(),
    get sendCalled() {
      return sendCalled;
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    get cancelTimeoutCalls() {
      return cancelTimeoutCalls;
    },
  };
}

// ── subscription ordering ─────────────────────────────────────────────────────

test("awaitEffortOutcome subscribes before sending so no ack is dropped", async () => {
  const h = harness();
  // Push an ack synchronously — if subscribe happened after send, this would
  // be dropped and the outcome would never resolve (only the timeout would).
  h.push(frame("ok"));
  assert.equal(await h.outcome, "ok");
  assert.equal(h.sendCalled, true, "send must have been called");
});

// ── terminal statuses ─────────────────────────────────────────────────────────

test("awaitEffortOutcome resolves 'ok' on accepted ack", async () => {
  const h = harness();
  h.push(frame("ok"));
  assert.equal(await h.outcome, "ok");
});

test("awaitEffortOutcome resolves 'failure' on rejected ack", async () => {
  const h = harness();
  h.push(frame("failure"));
  assert.equal(await h.outcome, "failure");
});

test("awaitEffortOutcome resolves 'invalid_value' on validation rejection", async () => {
  const h = harness();
  h.push(frame("invalid_value"));
  assert.equal(await h.outcome, "invalid_value");
});

// ── clear path (I-1) ──────────────────────────────────────────────────────────

test("awaitEffortOutcome resolves 'cleared' when Auto (empty value) is selected", async () => {
  const h = harness(""); // empty value = clear
  h.push(
    frame("cleared", { value: "" }), // harness sends value: "" in the clear ack
  );
  assert.equal(await h.outcome, "cleared");
});

// ── pending_session / deferred path ──────────────────────────────────────────

test("awaitEffortOutcome keeps waiting on pending_session and resolves ok on final ack", async () => {
  const h = harness();
  let settled = false;
  void h.outcome.then(() => {
    settled = true;
  });

  const drain = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  h.push(frame("pending_session"));
  await drain();
  assert.equal(settled, false, "pending_session must not settle the outcome");

  h.push(frame("ok"));
  assert.equal(await h.outcome, "ok");
});

test("awaitEffortOutcome resolves 'pending_session' via timeout when harness never replies", async () => {
  const h = harness();
  h.fireTimeout();
  assert.equal(await h.outcome, "pending_session");
  assert.equal(h.unsubscribeCalls, 1, "timeout must unsubscribe");
});

// ── correlation ───────────────────────────────────────────────────────────────

test("awaitEffortOutcome ignores acks for a different configId", async () => {
  const h = harness();
  h.push(frame("ok", { configId: "some_other_option" }));
  let settled = false;
  void h.outcome.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, "unrelated configId must not advance outcome");

  h.push(frame("ok"));
  assert.equal(await h.outcome, "ok");
});

test("awaitEffortOutcome ignores acks for a different value when non-empty", async () => {
  const h = harness("high");
  // An ack for a different value — stale ack from a prior pick.
  h.push(frame("ok", { value: "low" }));
  let settled = false;
  void h.outcome.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(
    settled,
    false,
    "stale ack for different value must not settle outcome",
  );

  h.push(frame("ok", { value: "high" }));
  assert.equal(await h.outcome, "ok");
});

test("awaitEffortOutcome ignores acks of wrong control type", async () => {
  const h = harness();
  h.push({ type: "switch_model", status: "ok", configId: CONFIG_ID });
  let settled = false;
  void h.outcome.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, "wrong type must not settle outcome");

  h.push(frame("ok"));
  assert.equal(await h.outcome, "ok");
});

// ── cleanup ───────────────────────────────────────────────────────────────────

test("awaitEffortOutcome unsubscribes and cancels timeout exactly once on success", async () => {
  const h = harness();
  h.push(frame("ok"));
  await h.outcome;
  assert.equal(h.unsubscribeCalls, 1);
  assert.equal(h.cancelTimeoutCalls, 1);

  // A late ack must not re-unsubscribe — listener is already detached.
  h.push(frame("ok"));
  assert.equal(h.unsubscribeCalls, 1, "no double-unsubscribe on late ack");
});
