import type { ControlResultFrame } from "@/shared/api/types";

/**
 * Resolve the outcome of a live `switch_model` across one or more channels.
 *
 * A live switch fires a `switch_model` frame per active channel and learns each
 * channel's result asynchronously over the observer relay. Two statuses
 * fail-fast — any single frame rejects the whole pick immediately, without
 * waiting for the other channels or the timeout:
 *   - `unsupported_model` → the target model isn't available for this agent.
 *   - `failure`           → the adapter refused the switch (the session stays
 *                           on its current model).
 * Their causes differ, so they resolve to distinct outcomes (`"unsupported"`
 * vs `"failed"`) the caller can message separately.
 *
 * `sent` is the busy-path PROVISIONAL ack: the switch was delivered to the
 * in-flight turn, but the adapter isn't consulted until the requeued session
 * runs. The real verdict lands later as a `failure` / `unsupported_model` frame,
 * or — on success — as silence (the backend emits no positive confirmation). So
 * `sent` never counts toward success; the subscription stays alive so a later
 * terminal frame can still settle the pick.
 *
 * The remaining statuses — `switched` / `turn_ending` / `no_active_turn` — are
 * terminal success for their channel and must arrive from every channel before
 * resolving `"ok"`. When no terminal frame settles the pick (the common
 * busy-path success case), the fallback timeout resolves `"ok"` — the override
 * still rides the requeued/next session, we just can't confirm it synchronously.
 *
 * The counting lives here, isolated from React and the relay so it can be unit
 * tested with synthetic frames and a fake clock. The caller injects the
 * relay subscription, the per-channel sends, and the timeout scheduler.
 */
export async function awaitLiveSwitchOutcome({
  channelCount,
  modelId,
  subscribe,
  sendSwitches,
  scheduleTimeout,
}: {
  /** Number of channels the switch was fired to — the success threshold. */
  channelCount: number;
  /** Model being switched to; frames for any other model are ignored. */
  modelId: string;
  /** Register a control-result listener; returns an unsubscribe function. */
  subscribe: (listener: (frame: ControlResultFrame) => void) => () => void;
  /** Fire the per-channel `switch_model` sends. Resolves when all are sent. */
  sendSwitches: () => Promise<void>;
  /** Schedule the no-reply fallback; returns a cancel function. */
  scheduleTimeout: (onTimeout: () => void) => () => void;
}): Promise<"ok" | "unsupported" | "failed"> {
  const settled = new Promise<"ok" | "unsupported" | "failed">((resolve) => {
    let unsubscribe = () => {};
    let cancelTimeout = () => {};
    let remaining = channelCount;
    const finish = (outcome: "ok" | "unsupported" | "failed") => {
      cancelTimeout();
      unsubscribe();
      resolve(outcome);
    };
    cancelTimeout = scheduleTimeout(() => finish("ok"));
    unsubscribe = subscribe((frame) => {
      if (frame.type !== "switch_model" || frame.modelId !== modelId) {
        return;
      }
      if (frame.status === "unsupported_model") {
        // Model unavailable — reject the whole pick immediately.
        finish("unsupported");
        return;
      }
      if (frame.status === "failure") {
        // Adapter refused the switch — reject immediately. The session stays
        // on its current model; distinct outcome so the caller can say why.
        finish("failed");
        return;
      }
      if (frame.status === "sent") {
        // Busy-path provisional ack: the switch was delivered to the in-flight
        // turn, but the adapter isn't consulted until the requeued session runs.
        // Don't count it — a later `failure`/`unsupported_model` may still
        // settle the pick, and on success the backend stays silent, so the
        // timeout fallback is what confirms.
        return;
      }
      // switched / turn_ending / no_active_turn — terminal success for this
      // channel.
      remaining -= 1;
      if (remaining <= 0) {
        finish("ok");
      }
    });
  });

  await sendSwitches();

  return settled;
}
