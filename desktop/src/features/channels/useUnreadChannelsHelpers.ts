/**
 * Shared constants, types, stores, and pure helpers extracted from
 * useUnreadChannels to keep that file within the repository size ratchet.
 * All exports are load-bearing for useUnreadChannels.ts.
 */
import * as React from "react";
import type { UseLiveChannelUpdatesOptions } from "@/features/channels/useLiveChannelUpdates";
import { makeRootIdStore } from "@/features/channels/unreadRootIdStore";
import {
  getThreadReference,
  isBroadcastReply,
} from "@/features/messages/lib/threading";
import type { RelayClient } from "@/shared/api/relayClientSession";
import type { Channel } from "@/shared/api/types";
import { CHANNEL_MESSAGE_EVENT_KINDS } from "@/shared/constants/kinds";
import { DM_NOTIFIABLE_EVENT_KINDS } from "./isDmNotifiableKind";
import {
  forcedUnreadStore,
  removeForcedUnreadSource,
  type ForcedUnreadEntry,
  type ForcedUnreadMap,
  type ForcedUnreadSource,
} from "@/features/channels/forcedUnreadStore";

export type UseUnreadChannelsOptions = UseLiveChannelUpdatesOptions & {
  pubkey?: string;
  relayClient?: RelayClient;
  relayUrl?: string;
  mutedChannelIds?: ReadonlySet<string>;
};

// Per-channel cap on the catch-up REQ. We only consume the *max matching*
// event per channel, but the relay can return self-authored / non-trigger
// events that we discard client-side, so we need enough head-room for the
// filter to find one external trigger message. 1000 matches the live sub's
// per-channel limit elsewhere in the app.
export const CATCH_UP_LIMIT = 1000;

export function channelCatchUpEventKinds(
  channelType: Channel["channelType"] | undefined,
) {
  return channelType === "dm"
    ? DM_NOTIFIABLE_EVENT_KINDS
    : CHANNEL_MESSAGE_EVENT_KINDS;
}

export const participationStore = makeRootIdStore(
  "buzz-thread-participation.v1",
);
export const authoredStore = makeRootIdStore("buzz-thread-authored.v1");
// Thread roots where an external message @-mentioned the current user. The
// badge gate ORs this in so a mention recipient who never participated,
// authored, or followed still gets the thread-unread badge.
export const mentionedStore = makeRootIdStore("buzz-thread-mentioned.v1");
export const mutedStore = makeRootIdStore("buzz-thread-muted.v1");

function parseTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function toUnixSeconds(isoOrMs: string | null | undefined): number | null {
  const ms = parseTimestamp(isoOrMs);
  return ms === null ? null : Math.floor(ms / 1_000);
}

// Resolve where the read marker should land when a channel is marked read.
// Folds the caller's timeline position together with the newest event this
// client has observed live (`observedLatest`), so an explicit "mark read" still
// covers messages that arrived faster than channel metadata — this fold is
// load-bearing for the Esc shortcut, sidebar mark-read, and empty-channel open,
// all of which pass a null/stale caller value. `clearObserved` reports whether
// the resulting marker covers the observed timestamp, signalling the caller to
// drop its observed refs so the unread memo sees `latest === undefined` until a
// genuinely newer event arrives.
export function resolveChannelReadMarker(
  callerReadAt: string | null | undefined,
  observedLatest: number | undefined,
): { markAt: number | null; clearObserved: boolean } {
  const callerUnix = toUnixSeconds(callerReadAt);
  const markAt = Math.max(callerUnix ?? 0, observedLatest ?? 0) || null;
  return {
    markAt,
    clearObserved:
      markAt !== null &&
      observedLatest !== undefined &&
      observedLatest <= markAt,
  };
}

export function resolveObservedUnreadRootId(tags: string[][]): string | null {
  return isBroadcastReply(tags) ? null : getThreadReference(tags).rootId;
}

/**
 * Hook that builds and wires the drain outcome callback into the ReadStateManager
 * via `setOnDrainOutcome`. Creates and owns the pending-unread-snapshots map.
 * Returns the snapshots ref for use in markChannelUnread.
 *
 * Handles:
 *  - `unread + refused` → restore forced-unread entry to its pre-mark snapshot
 *  - `unread + applied` → discard snapshot (intent succeeded)
 *  - `read + applied`  → remove forced-unread entry (or specific source), mirroring
 *                        the synchronous overrideCleared path
 *
 * Genuine refusal toasts are fired in the drain itself and not repeated here.
 */
export function useDrainOutcomeCallback(
  setOnDrainOutcome: (
    cb:
      | ((
          channelId: string,
          op: string,
          status: string,
          reason?: string,
          sourceScope?: string,
        ) => void)
      | null,
  ) => void,
  forcedUnreadRef: React.MutableRefObject<ForcedUnreadMap>,
  pubkey: string | undefined,
  bumpLatestVersion: () => void,
): React.MutableRefObject<Map<string, ForcedUnreadEntry | undefined>> {
  const pendingUnreadSnapshotsRef = React.useRef(
    new Map<string, ForcedUnreadEntry | undefined>(),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable refs; setOnDrainOutcome is stable
  React.useEffect(() => {
    setOnDrainOutcome((channelId, op, status, _reason, sourceScope) => {
      if (op === "unread" && status === "refused") {
        // Roll back the optimistic forced-unread entry to its exact prior state.
        const prior = pendingUnreadSnapshotsRef.current.get(channelId);
        pendingUnreadSnapshotsRef.current.delete(channelId);
        if (prior === undefined) {
          if (Object.hasOwn(forcedUnreadRef.current, channelId)) {
            delete forcedUnreadRef.current[channelId];
            if (pubkey)
              forcedUnreadStore.write(pubkey, forcedUnreadRef.current);
            bumpLatestVersion();
          }
        } else {
          forcedUnreadRef.current[channelId] = prior;
          if (pubkey) forcedUnreadStore.write(pubkey, forcedUnreadRef.current);
          bumpLatestVersion();
        }
      } else if (op === "unread" && status === "applied") {
        pendingUnreadSnapshotsRef.current.delete(channelId);
      } else if (op === "read" && status === "applied") {
        if (Object.hasOwn(forcedUnreadRef.current, channelId)) {
          if (sourceScope !== undefined) {
            const current = forcedUnreadRef.current[channelId];
            const next = removeForcedUnreadSource(
              current,
              sourceScope as ForcedUnreadSource,
            );
            if (next !== undefined) {
              forcedUnreadRef.current[channelId] = next;
            } else {
              delete forcedUnreadRef.current[channelId];
            }
          } else {
            delete forcedUnreadRef.current[channelId];
          }
          if (pubkey) forcedUnreadStore.write(pubkey, forcedUnreadRef.current);
          bumpLatestVersion();
        }
      }
    });
    return () => {
      setOnDrainOutcome(null);
    };
  }, [pubkey, setOnDrainOutcome]);
  return pendingUnreadSnapshotsRef;
}
