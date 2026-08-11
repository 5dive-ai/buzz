/**
 * Store-level tests for the tiered observer live-event window.
 *
 * The observer store keeps the full MAX_OBSERVER_EVENTS window only while a
 * session viewer is pinned to an agent (pinObserverAgent). An UNPINNED agent —
 * one observed only by background consumers, never displayed — is bounded to
 * UNPINNED_AGENT_EVENT_TAIL. This is the accumulator Option B bounds: a
 * long-lived session observes many agents over time, and without the tail each
 * would hold its full window forever.
 *
 * These exercise the REAL ingestion path (injectObserverEventsForE2E →
 * appendAgentEvent → the same trim/transcript rebuild the live relay uses) plus
 * the public pin API, asserting:
 *
 *   - an unpinned agent's window truncates to the tail, newest events kept;
 *   - a pinned agent retains its full window (the cap is lifted, not applied);
 *   - unpinning the last viewer immediately bounds the window it accumulated;
 *   - the pin is refcounted — two viewers hold until the last release;
 *   - the newest event always survives (preventSleep reads only events[last]);
 *   - active turns survive event-array eviction (the CRITICAL constraint: the
 *     active-turns bridge processes each event once as it arrives, so a
 *     turn_started aging out of the tail cannot lose the turn);
 *   - resetAgentObserverStore clears pins so they don't leak across sessions.
 *
 * No React/Tauri runtime. The tail (UNPINNED_AGENT_EVENT_TAIL = 100) and the
 * full cap (MAX_OBSERVER_EVENTS = 3000) are private constants; tests drive
 * counts relative to the tail and stay well under the full cap so a pinned
 * agent's retained count proves the cap was lifted rather than merely not hit.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  getAgentObserverSnapshot,
  injectObserverEventsForE2E,
  pinObserverAgent,
  resetAgentObserverStore,
  subscribeAgentObserverStore,
  unpinObserverAgent,
} from "@/features/agents/observerRelayStore.ts";
import {
  getActiveTurnsForAgent,
  resetActiveAgentTurnsStore,
  syncActiveAgentTurnsFromObserver,
} from "@/features/agents/activeAgentTurnsStore.ts";

const TAIL = 100; // UNPINNED_AGENT_EVENT_TAIL (private constant, mirrored here)
const OVER_TAIL = TAIL + 50; // enough to force truncation, far under the 3000 cap

/** 64-hex agent pubkey from a short label. */
function agentPubkey(label) {
  return label.padEnd(64, "0");
}

const AGENT = agentPubkey("a");

/**
 * One live observer event. Monotonic timestamp keyed to seq so the store's
 * timestamp-then-seq sort matches insertion order — the newest event is always
 * the highest seq.
 */
function makeEvent(seq, overrides = {}) {
  return {
    seq,
    timestamp: new Date(1_000_000 + seq * 1000).toISOString(),
    kind: "acp_write",
    agentIndex: 0,
    channelId: "chan-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    payload: {},
    ...overrides,
  };
}

/** Inject `count` events (seq 1..count) one at a time, mirroring the live path
 *  where each relay frame appends and notifies individually. */
function injectSequential(agent, count, makeAt = makeEvent) {
  for (let seq = 1; seq <= count; seq++) {
    injectObserverEventsForE2E(agent, [makeAt(seq)]);
  }
}

function snapshotEvents(agent) {
  return getAgentObserverSnapshot(agent, true).events;
}

describe("observer tiered live-event window — store level", () => {
  beforeEach(() => {
    resetAgentObserverStore();
    resetActiveAgentTurnsStore();
  });

  it("test_unpinned_agent_window_truncates_to_tail", () => {
    injectSequential(AGENT, OVER_TAIL);

    const events = snapshotEvents(AGENT);
    assert.equal(
      events.length,
      TAIL,
      "an unpinned agent's window must be bounded to the tail",
    );
    assert.equal(
      events[events.length - 1].seq,
      OVER_TAIL,
      "the newest event must be retained",
    );
    assert.equal(
      events[0].seq,
      OVER_TAIL - TAIL + 1,
      "the oldest events beyond the tail must be dropped",
    );
  });

  it("test_pinned_agent_retains_full_window", () => {
    // Pinning lifts the cap to MAX_OBSERVER_EVENTS. OVER_TAIL is far under it,
    // so a pinned agent keeps every event — proving the pin lifted the cap
    // rather than the count merely not reaching it.
    pinObserverAgent(AGENT);
    injectSequential(AGENT, OVER_TAIL);

    const events = snapshotEvents(AGENT);
    assert.equal(
      events.length,
      OVER_TAIL,
      "a pinned agent retains its full window, well past the unpinned tail",
    );
    assert.equal(events[events.length - 1].seq, OVER_TAIL);
    assert.equal(events[0].seq, 1, "the oldest event is still present");
  });

  it("test_unpin_last_viewer_truncates_existing_window", () => {
    // A viewer accumulates a deep window; closing it must immediately reclaim
    // the scroll-back down to the tail (not wait for the next append to trim).
    pinObserverAgent(AGENT);
    injectSequential(AGENT, OVER_TAIL);
    assert.equal(snapshotEvents(AGENT).length, OVER_TAIL, "full while pinned");

    unpinObserverAgent(AGENT);

    const events = snapshotEvents(AGENT);
    assert.equal(
      events.length,
      TAIL,
      "unpinning the last viewer bounds the window it accumulated",
    );
    assert.equal(
      events[events.length - 1].seq,
      OVER_TAIL,
      "truncation keeps the newest events, drops the oldest",
    );
  });

  it("test_refcount_two_viewers_stays_pinned_until_last_unpin", () => {
    // Two mounted viewers of the same agent compose. The window stays full
    // until the SECOND unpin — a refcount, not a boolean flag.
    pinObserverAgent(AGENT);
    pinObserverAgent(AGENT);
    injectSequential(AGENT, OVER_TAIL);

    unpinObserverAgent(AGENT);
    assert.equal(
      snapshotEvents(AGENT).length,
      OVER_TAIL,
      "still pinned while one viewer remains",
    );

    unpinObserverAgent(AGENT);
    assert.equal(
      snapshotEvents(AGENT).length,
      TAIL,
      "window bounded only after the last viewer unpins",
    );
  });

  it("test_newest_event_survives_tail_for_prevent_sleep", () => {
    // preventSleepActivity reads ONLY events[events.length - 1]. The tail must
    // never drop the newest event, or wake-lock refresh would stall.
    injectSequential(AGENT, OVER_TAIL);

    const events = snapshotEvents(AGENT);
    const newest = events[events.length - 1];
    assert.equal(newest.seq, OVER_TAIL, "newest event survives the tail");
    assert.equal(
      newest.timestamp,
      makeEvent(OVER_TAIL).timestamp,
      "the retained newest event is the last one appended",
    );
  });

  it("test_active_turns_survive_event_eviction", () => {
    // The CRITICAL constraint. The active-turns bridge subscribes to the store
    // and drains the snapshot on every notify — so each event is processed once
    // as it arrives (as the newest event), advancing the per-(agent,channel)
    // watermark. A turn_started can then age out of the tail without losing the
    // turn: turn state lives in activeAgentTurnsStore, independent of the event
    // array, and the watermark blocks any re-processing that never comes.
    const RUNNING = [{ pubkey: AGENT, status: "running" }];
    const unsubscribe = subscribeAgentObserverStore(() => {
      syncActiveAgentTurnsFromObserver(RUNNING);
    });

    try {
      // A turn starts. The bridge drains this notify and marks the turn active.
      injectObserverEventsForE2E(AGENT, [
        makeEvent(1, { kind: "turn_started", channelId: "c1", turnId: "t1" }),
      ]);
      assert.ok(
        getActiveTurnsForAgent(AGENT).some((t) => t.channelId === "c1"),
        "turn is active immediately after turn_started",
      );

      // Flood the window past the tail so turn_started ages out. Each event
      // notifies, draining the bridge — but the watermark is already past
      // turn_started, so it is never reprocessed and the turn is not disturbed.
      for (let seq = 2; seq <= OVER_TAIL + 1; seq++) {
        injectObserverEventsForE2E(AGENT, [
          makeEvent(seq, { kind: "acp_write", channelId: "c1", turnId: "t1" }),
        ]);
      }

      // The event array has evicted turn_started...
      const events = snapshotEvents(AGENT);
      assert.equal(events.length, TAIL, "window is bounded to the tail");
      assert.ok(
        !events.some((e) => e.kind === "turn_started"),
        "turn_started has aged out of the event array",
      );

      // ...but the turn is still active. Truncation cannot lose turns.
      assert.ok(
        getActiveTurnsForAgent(AGENT).some((t) => t.channelId === "c1"),
        "the active turn survives event-array eviction",
      );
    } finally {
      unsubscribe();
    }
  });

  it("test_reset_clears_pins", () => {
    // A pin outstanding at reset must not survive it — otherwise a phantom pin
    // would keep the next session's same-key agent unbounded.
    pinObserverAgent(AGENT);
    resetAgentObserverStore();

    // If the pin leaked, the window below would stay full at OVER_TAIL.
    injectSequential(AGENT, OVER_TAIL);
    assert.equal(
      snapshotEvents(AGENT).length,
      TAIL,
      "pin state must not survive reset — the agent is unpinned again",
    );
  });
});
