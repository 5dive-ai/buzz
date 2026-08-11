import type { Query, QueryClient } from "@tanstack/react-query";

import type { ChannelWindowStore } from "./channelWindowStore";
import type { RelayEvent } from "@/shared/api/types";
import {
  selectMessageWindowEvictionUnits,
  type MessageWindowUnit,
} from "./messageWindowEviction";

/**
 * Maximum number of distinct unpinned channel timelines and thread subtrees
 * retained in the query cache. Channels and threads are bounded independently
 * so a burst of open threads never evicts channel scrollback and vice versa.
 * A revisit re-fetches from the relay (cache miss, not data loss).
 */
export const MAX_RETAINED_MESSAGE_CHANNELS = 12;
export const MAX_RETAINED_MESSAGE_THREADS = 24;

const CHANNEL_WINDOW = "channel-window";
const CHANNEL_MESSAGES = "channel-messages";
const THREAD_REPLIES = "thread-replies";

/** A cached message query keyed by its parsed unit id, tagged by kind. */
type ClassifiedQuery = {
  query: Query;
  unitId: string;
  kind: "channel" | "thread";
};

/**
 * Classify a cache query as a channel-timeline key, a thread key, or neither.
 * Channel units fold both `channel-window` and `channel-messages` under the
 * channel id so they evict together; thread units key on channel + root.
 */
function classifyQuery(query: Query): ClassifiedQuery | null {
  const key = query.queryKey;
  const head = key[0];
  if (
    (head === CHANNEL_WINDOW || head === CHANNEL_MESSAGES) &&
    typeof key[1] === "string"
  ) {
    return { query, unitId: key[1], kind: "channel" };
  }
  if (
    head === THREAD_REPLIES &&
    typeof key[1] === "string" &&
    typeof key[2] === "string"
  ) {
    return { query, unitId: `${key[1]}\u0000${key[2]}`, kind: "thread" };
  }
  return null;
}

/** Whether a query's cached data holds an optimistic pending send. */
function holdsPendingSend(query: Query): boolean {
  const data = query.state.data;
  if (Array.isArray(data)) {
    return (data as RelayEvent[]).some((event) => event.pending);
  }
  // A channel-window store keeps optimistic sends in its live overlay — the
  // seam that catches a send-from-thread landing on a non-visible channel.
  const overlay = (data as ChannelWindowStore | undefined)?.liveOverlay;
  return Array.isArray(overlay) && overlay.some((event) => event.pending);
}

/**
 * Fold classified queries into eviction units. A unit is pinned when ANY of
 * its queries has a mounted observer (the view is on screen — the "none"
 * placeholder channel is inactive and so never pins) or holds a pending send.
 * Recency is the freshest `dataUpdatedAt` across the unit's queries.
 */
function foldUnits(queries: ClassifiedQuery[]): Map<string, MessageWindowUnit> {
  const units = new Map<string, MessageWindowUnit>();
  for (const { query, unitId } of queries) {
    const pinned = query.isActive() || holdsPendingSend(query);
    const recency = query.state.dataUpdatedAt;
    const existing = units.get(unitId);
    if (existing) {
      existing.pinned ||= pinned;
      existing.recency = Math.max(existing.recency, recency);
    } else {
      units.set(unitId, { unitId, pinned, recency });
    }
  }
  return units;
}

/**
 * Enforce the retained-timeline bound on the query cache. Collects every
 * channel and thread query, folds them into pinned/recency units, selects the
 * least-recently-updated unpinned units beyond the caps, and removes their
 * queries. Channels and threads are bounded independently.
 *
 * Removal (not invalidation) is deliberate: a removed key reads back as absent,
 * so `shouldRefreshChannelWindowAfterSubscribe` re-fetches fresh on revisit and
 * a guarded background write (`(current) => !current ? current : merge`) is a
 * no-op that cannot silently resurrect the evicted key.
 */
export function enforceMessageWindowBounds(queryClient: QueryClient): void {
  const channels: ClassifiedQuery[] = [];
  const threads: ClassifiedQuery[] = [];
  for (const query of queryClient.getQueryCache().getAll()) {
    const classified = classifyQuery(query);
    if (!classified) continue;
    (classified.kind === "channel" ? channels : threads).push(classified);
  }

  const evictChannels = new Set(
    selectMessageWindowEvictionUnits(
      [...foldUnits(channels).values()],
      MAX_RETAINED_MESSAGE_CHANNELS,
    ),
  );
  const evictThreads = new Set(
    selectMessageWindowEvictionUnits(
      [...foldUnits(threads).values()],
      MAX_RETAINED_MESSAGE_THREADS,
    ),
  );
  if (evictChannels.size === 0 && evictThreads.size === 0) return;

  for (const { query, unitId, kind } of [...channels, ...threads]) {
    const evict = kind === "channel" ? evictChannels : evictThreads;
    if (evict.has(unitId)) {
      queryClient.getQueryCache().remove(query);
    }
  }
}
