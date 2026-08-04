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
import type { ObservedUnreadEvent } from "@/features/channels/unreadChannelCounts";

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
  /** True only when the manager's full-state load is complete (loadComplete).
   *  A manager that finished initializing with an incomplete load must NOT be
   *  treated as ready — null liveness after an incomplete load means "not found
   *  in a partial view", not "known absent register". */
  isReadStateReady: boolean;
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
 * `overrideCleared` — the NIP-RS override is now known inactive (no register
 *   exists, the frontier deactivated it, or the C-bump succeeded). Callers
 *   should clear local presentation.
 *
 * `overrideStillActive` — the manager is unavailable (fail-closed) or the
 *   C-bump was refused and liveness remains active. Callers MUST NOT clear
 *   local unread presentation; NIP-RS:537-539 requires success only when
 *   resulting override_active == false.
 */
export type OverrideReadOutcome = "overrideCleared" | "overrideStillActive";

/**
 * Attempt to clear the NIP-RS override for `channelId` as part of an explicit
 * mark-read transition. Models the transition as a single outcome:
 *
 *   1. Load not complete (!isReadStateReady): fail-closed —
 *      return overrideStillActive (null liveness after an incomplete load is
 *      ambiguous, not known absence).
 *   2. liveness === null (load complete, no register): return overrideCleared
 *      (known absence after a complete load; no C-bump needed).
 *   3. liveness exists (active or inactive): always call markChannelRead —
 *      spec NIP-RS:537-539 requires the C-bump even when the frontier already
 *      deactivated the override. Then re-read liveness.
 *      a. Resulting liveness inactive (or already_inactive race): cleared.
 *      b. uint32 refusal AND F > B (frontier already deactivated): cleared,
 *         no error toast (representable C-bump was not possible, frontier
 *         already provides the inactive verdict).
 *      c. Other refusal keeping liveness active: show toast, overrideStillActive.
 */
export function applyOverrideRead(
  channelId: string,
  apis: OverrideAPIs,
): OverrideReadOutcome {
  // Step 1: manager unavailable → fail closed.
  if (!apis.isReadStateReady) return "overrideStillActive";

  const liveness = apis.getOverrideLiveness(channelId);

  // Step 2: load complete but no register at all → known absence, cleared.
  if (liveness === null) return "overrideCleared";

  // Step 3: register exists — always attempt the C-bump (NIP-RS:537-539).
  const result = apis.markChannelRead(channelId);

  if (!result.success && result.reason === "already_inactive") {
    // Race: cleared by another device between our check and the call.
    return "overrideCleared";
  }

  // Re-read liveness after the attempt.
  const afterLiveness = apis.getOverrideLiveness(channelId);
  // Covers: successful C-bump (inactive after), F>B deactivation (inactive after),
  // and uint32 refusal where F>B already deactivated the register.
  if (afterLiveness === null || !afterLiveness.active) {
    return "overrideCleared";
  }

  // Refused and still active.
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

/**
 * Per-channel evidence maps that `markAllChannelsRead` mutates.
 * Extracted so the per-channel transition can be tested without the full hook.
 */
export type MarkAllEvidenceMaps = {
  forcedUnread: ForcedUnreadMap;
  latestByChannel: Map<string, number>;
  observedUnreadEvents: Map<string, Map<string, ObservedUnreadEvent>>;
};

/**
 * Apply the per-channel mark-all-read transition for a single channel ID.
 *
 * Calls `applyOverrideRead` to attempt the NIP-RS C-bump. On `overrideCleared`,
 * removes the channel's entry from all three evidence maps. On
 * `overrideStillActive` (refused or load incomplete), all maps are left
 * intact — the caller must NOT wipe evidence for channels whose clear was
 * refused. Returns the outcome for caller use.
 */
export function applyMarkAllReadTransition(
  channelId: string,
  apis: OverrideAPIs,
  maps: MarkAllEvidenceMaps,
): OverrideReadOutcome {
  const outcome = applyOverrideRead(channelId, apis);
  if (outcome === "overrideCleared") {
    delete maps.forcedUnread[channelId];
    maps.latestByChannel.delete(channelId);
    maps.observedUnreadEvents.delete(channelId);
  }
  return outcome;
}
