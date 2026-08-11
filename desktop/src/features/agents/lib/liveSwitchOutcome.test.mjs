import assert from "node:assert/strict";
import test from "node:test";

import { awaitLiveSwitchOutcome } from "./liveSwitchOutcome.ts";

const MODEL = "goose-claude-fable-5";

function frame(status, overrides = {}) {
  return { type: "switch_model", status, modelId: MODEL, ...overrides };
}

/**
 * A controllable test harness mirroring the real wiring: a single-listener
 * pub/sub whose unsubscribe genuinely detaches (so post-unsubscribe pushes are
 * no-ops, matching `observerRelayStore`), a manual timeout, and a deferred
 * `sendSwitches` the test resolves explicitly.
 */
function harness(channelCount) {
  let listener = null;
  let timeoutCb = null;
  let unsubscribeCalls = 0;
  let cancelTimeoutCalls = 0;
  let sendResolve;
  const sendStarted = new Promise((resolve) => {
    sendResolve = resolve;
  });

  const outcome = awaitLiveSwitchOutcome({
    channelCount,
    modelId: MODEL,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        unsubscribeCalls += 1;
        listener = null;
      };
    },
    sendSwitches: () => {
      sendResolve();
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
    sendStarted,
    push: (f) => listener?.(f),
    fireTimeout: () => timeoutCb?.(),
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    get cancelTimeoutCalls() {
      return cancelTimeoutCalls;
    },
  };
}

test("awaitLiveSwitchOutcome fast sent on one channel does not mask a later unsupported on another", async () => {
  const h = harness(2);
  // Channel A acks fast as `sent`; a first-ack-resolves impl would settle "ok"
  // here. The fail-fast contract must keep waiting and then reject on B.
  h.push(frame("sent"));
  h.push(frame("unsupported_model"));
  assert.equal(await h.outcome, "unsupported");
});

test("awaitLiveSwitchOutcome resolves ok only after the last channel acks", async () => {
  const h = harness(3);
  let settled = false;
  void h.outcome.then(() => {
    settled = true;
  });

  // The `.then` that flips `settled` flushes on a later microtask tick than a
  // single drain, so a single `await Promise.resolve()` would let this
  // assertion pass even against a first-ack-resolves bug. Draining several
  // ticks guarantees a resolved promise's callback has run, so the interim
  // `settled === false` checks deterministically regress an early resolve.
  const drainMicrotasks = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };

  // The three terminal-success statuses (`switched` / `turn_ending` /
  // `no_active_turn`) each count for one channel; only the third settles "ok".
  h.push(frame("switched"));
  await drainMicrotasks();
  assert.equal(settled, false, "must not resolve on the first ack");

  h.push(frame("turn_ending"));
  await drainMicrotasks();
  assert.equal(settled, false, "must not resolve before the last ack");

  h.push(frame("no_active_turn"));
  assert.equal(await h.outcome, "ok");
});

test("awaitLiveSwitchOutcome rejects on unsupported immediately and unsubscribes exactly once", async () => {
  const h = harness(2);
  h.push(frame("unsupported_model"));
  assert.equal(await h.outcome, "unsupported");
  assert.equal(h.unsubscribeCalls, 1);
  assert.equal(h.cancelTimeoutCalls, 1);

  // A second rejection arriving after the first must not re-resolve or
  // re-unsubscribe — the listener is already detached.
  h.push(frame("unsupported_model"));
  assert.equal(h.unsubscribeCalls, 1, "no double-unsubscribe on a late frame");
});

test("awaitLiveSwitchOutcome settles failed immediately on an adapter-refused frame without waiting for other channels or the timeout", async () => {
  const h = harness(3);
  // channelCount 3, so a success-path impl would need three acks. A single
  // `failure` frame must fail-fast to "failed" (not "unsupported", not "ok")
  // before the other two channels reply — proving it never traverses the
  // success-count path.
  h.push(frame("failure"));
  assert.equal(await h.outcome, "failed");
  // The timeout was cancelled (no 8s wait) and the listener detached exactly
  // once — the frame settled synchronously, not via the fallback.
  assert.equal(h.cancelTimeoutCalls, 1, "timeout cancelled, not awaited");
  assert.equal(h.unsubscribeCalls, 1);

  // A later frame must not re-resolve or re-unsubscribe.
  h.push(frame("switched"));
  assert.equal(h.unsubscribeCalls, 1, "no double-unsubscribe on a late frame");
});

test("awaitLiveSwitchOutcome stays unsettled after a provisional sent, then settles failed when the adapter rejection arrives", async () => {
  // The real busy-path producer order: the harness acks `sent` immediately
  // (the switch was delivered to the in-flight turn), then — after the requeued
  // session consults the adapter — emits `failure` seconds later. With one
  // active channel a first-ack-resolves impl would settle "ok" on `sent` and
  // detach before `failure` arrives; this regresses that.
  const h = harness(1);
  let settled = false;
  void h.outcome.then(() => {
    settled = true;
  });
  const drainMicrotasks = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };

  h.push(frame("sent"));
  await drainMicrotasks();
  assert.equal(settled, false, "provisional `sent` must not resolve the pick");
  assert.equal(h.unsubscribeCalls, 0, "subscription stays alive after `sent`");
  assert.equal(h.cancelTimeoutCalls, 0, "timeout still armed after `sent`");

  h.push(frame("failure"));
  assert.equal(await h.outcome, "failed");
  assert.equal(h.cancelTimeoutCalls, 1, "timeout cancelled, not awaited");
  assert.equal(h.unsubscribeCalls, 1);
});

test("awaitLiveSwitchOutcome stays unsettled after a provisional sent, then resolves ok via the timeout when no terminal frame arrives", async () => {
  // Busy-path success emits no positive confirmation frame — after `sent`, the
  // backend stays silent. The pick must remain unsettled until the fallback
  // timeout resolves "ok".
  const h = harness(1);
  let settled = false;
  void h.outcome.then(() => {
    settled = true;
  });
  const drainMicrotasks = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };

  h.push(frame("sent"));
  await drainMicrotasks();
  assert.equal(settled, false, "provisional `sent` must not resolve the pick");
  assert.equal(h.cancelTimeoutCalls, 0, "timeout still armed after `sent`");

  h.fireTimeout();
  assert.equal(await h.outcome, "ok");
  assert.equal(h.unsubscribeCalls, 1, "timeout fallback unsubscribes");
});

test("awaitLiveSwitchOutcome ignores frames for a different model or control type", async () => {
  const h = harness(1);
  h.push(frame("sent", { modelId: "some-other-model" }));
  h.push({ type: "cancel_turn", status: "sent", modelId: MODEL });
  let settled = false;
  void h.outcome.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, "unrelated frames must not advance the count");

  h.push(frame("switched"));
  assert.equal(await h.outcome, "ok");
});

test("awaitLiveSwitchOutcome resolves ok via the timeout fallback when the harness never replies", async () => {
  const h = harness(2);
  h.fireTimeout();
  assert.equal(await h.outcome, "ok");
  assert.equal(h.unsubscribeCalls, 1, "timeout fallback unsubscribes");
});

test("awaitLiveSwitchOutcome fires the per-channel sends after subscribing", async () => {
  const h = harness(1);
  // The subscription is registered before the sends fire, so a frame arriving
  // mid-send is never dropped. Awaiting sendStarted proves sends ran. Uses a
  // terminal-success frame (`switched`) since the provisional `sent` no longer
  // settles the pick on its own.
  await h.sendStarted;
  h.push(frame("switched"));
  assert.equal(await h.outcome, "ok");
});

test("awaitLiveSwitchOutcome with zero channels resolves ok at the timeout (no acks expected)", async () => {
  // No active turns means channelCount 0: remaining starts at 0 but the success
  // resolve only fires inside a frame callback, so with no frames the timeout
  // fallback is what settles it. This documents the degenerate path.
  const h = harness(0);
  h.fireTimeout();
  assert.equal(await h.outcome, "ok");
});
