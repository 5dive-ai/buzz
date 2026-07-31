/**
 * Per-pubkey localStorage cache of channels manually marked unread via
 * right-click → "mark unread". Keyed by channelId (not thread-root). Persisted
 * so the sidebar badge survives reload and the rail observer can read it for
 * inactive communities.
 *
 * Each entry stores the channel's own NIP-RS read marker (unix seconds) at the
 * moment mark-unread was invoked, or null if no marker existed yet. The rail
 * observer gates the forced-unread OR on this baseline: if the observed synced
 * read marker has since advanced past markerAtWhenForced, the cross-device read
 * wins and the dot is not lit.
 *
 * On identity change, the in-memory map is swapped to the current pubkey's
 * persisted data. Old pubkey data is NOT wiped from localStorage.
 *
 * This store is the local-device cache of the NIP-RS manual-unread override
 * layer (kind:30078 `ov_*` entries). Marking a channel unread publishes a
 * NIP-RS override event to the relay via ReadStateManager so the override
 * propagates to other devices. Marking a channel read clears the override
 * both locally and on the relay. The `markerAtWhenForced` baseline still drives
 * the "cross-device read already covered this" gate for the rail observer.
 */

/** channelId → NIP-RS read marker (unix seconds) at force-time, or null */
export type ForcedUnreadMap = Record<string, number | null>;

// ---------------------------------------------------------------------------
// NIP-RS override mark-result types (shared with useUnreadChannels)
// ---------------------------------------------------------------------------

/**
 * Result returned by ReadStateManager.markChannelOverrideUnread /
 * markChannelOverrideRead (slice 2). `success: false` carries a reason code
 * that is mapped to a user-visible toast by overrideErrorMessage below.
 */
export type MarkOverrideResult =
  | { success: true }
  | {
      success: false;
      reason:
        | "uint32_overflow"
        | "budget_exhausted"
        | "load_incomplete"
        | "already_inactive";
    };

/** Override liveness for one channel — returned by getOverrideLiveness. */
export type OverrideLiveness = { active: boolean; frontier: number };

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

const STORAGE_PREFIX = "buzz-forced-unread.v1";
const storageKey = (pubkey: string) => `${STORAGE_PREFIX}:${pubkey}`;

export const forcedUnreadStore = {
  read(pubkey: string): ForcedUnreadMap {
    try {
      const raw = window.localStorage.getItem(storageKey(pubkey));
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        return {};
      const result: ForcedUnreadMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === "string" && (v === null || typeof v === "number")) {
          result[k] = v as number | null;
        }
      }
      return result;
    } catch {
      return {};
    }
  },
  write(pubkey: string, map: ForcedUnreadMap): void {
    try {
      window.localStorage.setItem(storageKey(pubkey), JSON.stringify(map));
    } catch {
      // Ignore storage errors (private browsing, quota exceeded).
    }
  },
};
