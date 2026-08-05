import type { ControlResultFrame } from "@/shared/api/types";

/**
 * Await the outcome of an effort set (or clear) request.
 *
 * Sends a `set_config_option` frame and waits for the matching final
 * `control_result` from the harness. Two phases:
 *
 *   1. Immediate ack from `handle_set_config_option_control`:
 *      `pending_session` (stored, will apply at next session) or
 *      `cleared` (Auto selected, pool cleared, persist null) or
 *      `invalid_value` (rejected by harness validation).
 *
 *   2. Final ack from `create_session_and_apply_model`:
 *      `ok` (adapter accepted; Desktop persists) or
 *      `failure` (adapter rejected or timeout).
 *
 * The function resolves with the first *terminal* status received:
 *   - `"ok"` / `"failure"` / `"invalid_value"` — terminal.
 *   - `"cleared"` — terminal (clear persists immediately in the observer).
 *   - `"pending_session"` — non-terminal; awaiting final result from the harness.
 *
 * If no terminal result arrives within the timeout, resolves with
 * `"pending_session"` (the effort will be applied at the next session — the UI
 * should show this as a deferred confirmation).
 */
export async function awaitEffortOutcome({
  configId,
  value,
  subscribe,
  send,
  scheduleTimeout,
}: {
  /** The thought_level configId from the session cache. */
  configId: string;
  /** The value being set (or "" for clear). */
  value: string;
  /** Register a control-result listener; returns an unsubscribe function. */
  subscribe: (listener: (frame: ControlResultFrame) => void) => () => void;
  /** Fire the set_config_option send. */
  send: () => Promise<void>;
  /** Schedule the no-reply fallback; returns a cancel function. */
  scheduleTimeout: (onTimeout: () => void) => () => void;
}): Promise<
  "ok" | "failure" | "invalid_value" | "cleared" | "pending_session"
> {
  type Outcome =
    | "ok"
    | "failure"
    | "invalid_value"
    | "cleared"
    | "pending_session";

  const settled = new Promise<Outcome>((resolve) => {
    let unsubscribe = () => {};
    let cancelTimeout = () => {};
    const finish = (outcome: Outcome) => {
      cancelTimeout();
      unsubscribe();
      resolve(outcome);
    };
    cancelTimeout = scheduleTimeout(() => finish("pending_session"));
    unsubscribe = subscribe((frame) => {
      if (frame.type !== "set_config_option" || frame.configId !== configId) {
        return;
      }
      // For non-clear picks, correlate by value too so a stale ack from a
      // previous pick does not mis-resolve the current one.
      if (value !== "" && frame.value !== value) {
        return;
      }
      const s = frame.status;
      if (
        s === "ok" ||
        s === "failure" ||
        s === "invalid_value" ||
        s === "cleared"
      ) {
        finish(s);
        return;
      }
      // pending_session is non-terminal — keep waiting for the final ack.
      // The timeout will eventually fire if no final ack arrives.
    });
  });

  await send();

  return settled;
}
