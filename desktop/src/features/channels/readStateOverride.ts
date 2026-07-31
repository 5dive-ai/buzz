/**
 * UI-layer helpers for the NIP-RS manual-unread override layer (slice 3).
 *
 * Provides the seam between useUnreadChannels and the ReadStateManager's
 * override APIs (markChannelUnread / markChannelRead / getOverrideLiveness),
 * added by slice 2 (nip-rs-unread-manager).
 */
import { toast } from "sonner";

import type { OverrideLiveness } from "@/features/channels/readState/readStateFormat";
import type { MarkResult } from "@/features/channels/readState/readStateManager";
import {
  forcedUnreadStore,
  type ForcedUnreadMap,
} from "@/features/channels/forcedUnreadStore";

export type { MarkResult, OverrideLiveness };

/**
 * User-visible error message for a failed NIP-RS override operation.
 * Returns null for silent failure reasons (already_inactive race condition).
 */
export function overrideErrorMessage(
  op: "unread" | "read",
  reason: string,
): string | null {
  if (reason === "budget_exhausted")
    return "Could not mark unread: override budget exhausted. Clear some channels first.";
  if (reason === "uint32_overflow")
    return op === "unread"
      ? "Could not mark unread: counter limit reached for this channel."
      : "Could not clear unread override: counter limit reached.";
  if (reason === "load_incomplete")
    return op === "unread"
      ? "Could not mark unread: read state is still loading. Try again shortly."
      : "Could not clear unread override: read state is still loading.";
  if (reason === "already_inactive") return null;
  return op === "unread"
    ? "Could not mark unread."
    : "Could not clear unread override.";
}

/** Slice-2 override APIs from ReadStateManager, proxied through useReadState. */
export type OverrideAPIs = {
  markChannelUnread: (channelId: string) => MarkResult;
  markChannelRead: (channelId: string) => MarkResult;
  getOverrideLiveness: (channelId: string) => OverrideLiveness | null;
};

/**
 * Call the manager's override-unread path (S bump + B set to effective
 * frontier). Returns true when the local cache should be updated; returns false
 * and shows a toast when the manager refuses.
 */
export function applyOverrideUnread(
  channelId: string,
  apis: OverrideAPIs,
): boolean {
  const result = apis.markChannelUnread(channelId);
  if (!result.success) {
    const msg = overrideErrorMessage("unread", result.reason);
    if (msg) toast.error(msg);
    return false;
  }
  return true;
}

/**
 * Outcome of the explicit mark-read transition for one channel.
 *
 * `overrideCleared` — the NIP-RS override is now known inactive (either it was
 *   already inactive, or the C-bump succeeded and the resulting liveness is
 *   inactive). Callers should clear local presentation.
 *
 * `overrideStillActive` — the C-bump was refused (or returned a result where
 *   liveness remains active / unknown). Callers must NOT clear local unread
 *   presentation; the spec MUST at NIP-RS:537-539 requires success only when
 *   resulting override_active == false.
 */
export type OverrideReadOutcome = "overrideCleared" | "overrideStillActive";

/**
 * Attempt to clear the NIP-RS override for `channelId` as part of an explicit
 * mark-read transition. Models the transition as a single outcome:
 *
 *   1. If liveness is null (pre-init): fail-closed — return overrideStillActive
 *      without calling the manager (null ≠ inactive).
 *   2. If liveness is inactive: return overrideCleared immediately (no C-bump
 *      needed; the frontier advance already made override_active == false).
 *   3. If liveness is active: call markChannelRead, then re-read liveness.
 *      - If resulting liveness is inactive (or already_inactive race): cleared.
 *      - If the manager refused for any reason that keeps liveness active:
 *        show a toast and return overrideStillActive.
 *
 * Special edge (permitted by spec): if the caller's frontier advance made
 * F > B, liveness is already inactive before the C-bump — this is detected at
 * step 2, so no error toast fires in that case.
 */
export function applyOverrideRead(
  channelId: string,
  apis: OverrideAPIs,
): OverrideReadOutcome {
  const liveness = apis.getOverrideLiveness(channelId);

  // Pre-init: null ≠ inactive. Fail closed.
  if (liveness === null) return "overrideStillActive";

  // Already inactive (frontier advance made F > B, or never active).
  if (!liveness.active) return "overrideCleared";

  // Active override: attempt the C-bump.
  const result = apis.markChannelRead(channelId);

  if (!result.success && result.reason === "already_inactive") {
    // Race condition: cleared by another device between our liveness check and
    // the clear call. Silent success.
    return "overrideCleared";
  }

  // Re-read liveness after the attempt.
  const afterLiveness = apis.getOverrideLiveness(channelId);
  if (afterLiveness !== null && !afterLiveness.active) {
    return "overrideCleared";
  }

  // Refused and still active (or unknown post-call liveness).
  if (!result.success) {
    const msg = overrideErrorMessage("read", result.reason);
    if (msg) toast.error(msg);
  }
  return "overrideStillActive";
}

/**
 * Persist `channelId` into the forced-unread local cache with the current own
 * timestamp as baseline. Always refreshes an existing entry (so a successful
 * re-mark after the old override died uses the fresh baseline). Returns true
 * when the map changed.
 */
export function persistForcedUnread(
  channelId: string,
  forcedMap: ForcedUnreadMap,
  getOwnTimestamp: (id: string) => number | null,
  pubkey: string | undefined,
): boolean {
  const newTs = getOwnTimestamp(channelId);
  if (Object.hasOwn(forcedMap, channelId) && forcedMap[channelId] === newTs) {
    return false;
  }
  forcedMap[channelId] = newTs;
  if (pubkey) forcedUnreadStore.write(pubkey, forcedMap);
  return true;
}
