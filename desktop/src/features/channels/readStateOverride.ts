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
  overrideErrorMessage,
  type ForcedUnreadMap,
} from "@/features/channels/forcedUnreadStore";

export type { MarkResult, OverrideLiveness };

/** Slice-2 override APIs from ReadStateManager, proxied through useReadState. */
export type OverrideAPIs = {
  markChannelUnread?: (channelId: string) => MarkResult;
  markChannelRead?: (channelId: string) => MarkResult;
  getOverrideLiveness?: (channelId: string) => OverrideLiveness | null;
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
  if (!apis.markChannelUnread) return true; // graceful path before slice-2 wires in
  const result = apis.markChannelUnread(channelId);
  if (!result.success) {
    const msg = overrideErrorMessage("unread", result.reason);
    if (msg) toast.error(msg);
    return false;
  }
  return true;
}

/**
 * If a NIP-RS override is active for `channelId`, call the manager's
 * override-read path (C bump). Shows a toast on failure (except
 * `already_inactive`, which is a silent race condition).
 */
export function applyOverrideRead(channelId: string, apis: OverrideAPIs): void {
  if (!apis.markChannelRead) return;
  const liveness = apis.getOverrideLiveness?.(channelId);
  if (!liveness?.active) return;
  const result = apis.markChannelRead(channelId);
  if (!result.success) {
    const msg = overrideErrorMessage("read", result.reason);
    if (msg) toast.error(msg);
  }
}

/**
 * Persist `channelId` into the forced-unread local cache with the current
 * own timestamp as baseline. No-op if the channel is already in the map.
 * Returns true when the map changed.
 */
export function persistForcedUnread(
  channelId: string,
  forcedMap: ForcedUnreadMap,
  getOwnTimestamp: (id: string) => number | null,
  pubkey: string | undefined,
): boolean {
  if (Object.hasOwn(forcedMap, channelId)) return false;
  forcedMap[channelId] = getOwnTimestamp(channelId);
  if (pubkey) forcedUnreadStore.write(pubkey, forcedMap);
  return true;
}
