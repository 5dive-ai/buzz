/**
 * Pure decision for "is the channel timeline still doing its initial load."
 *
 * Extracted so the windows below are covered by the lib `*.test.mjs` suite.
 * The trap: `data !== undefined` looks like "loaded" but the per-channel query
 * cache is seeded early — by a stale `placeholderData` on revisit, and by the
 * live subscription's `setQueryData` — before the authoritative history fetch
 * settles. Treating that as loaded flashes the channel intro/empty state over a
 * list that is about to stream in.
 */
export type TimelineQueryStatus = {
  isPending: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
  dataLength: number | null;
};

export function selectTimelineLoadingState(
  status: TimelineQueryStatus,
  hasSettled = true,
): boolean {
  if (status.isPending) {
    return true;
  }
  if (!hasSettled) {
    // Placeholder rows are a previously-settled timeline (React-Query cache on
    // revisit, or a persisted snapshot) — paint them stale-then-revalidate
    // instead of holding a skeleton over known content.
    if (status.isPlaceholderData && (status.dataLength ?? 0) > 0) {
      return false;
    }
    // Otherwise hold the skeleton for the whole cold load: the live
    // subscription can seed a few rows before the history fetch settles, and
    // painting those as if loaded flashes a near-empty timeline.
    return status.isFetching;
  }
  return (
    status.isFetching &&
    (status.isPlaceholderData || (status.dataLength ?? 0) === 0)
  );
}

/**
 * Per-channel loading latch. Once a channel has settled, a background refetch
 * must not re-show its skeleton, even after visiting another channel. The
 * `hasCachedData` guard makes an entry forgettable in practice: if React Query
 * has garbage-collected that channel, a later cold load still shows loading.
 */
export function resolveTimelineLoadingLatch(
  settledChannelIds: ReadonlySet<string>,
  activeChannelId: string | null,
  loadingNow: boolean,
  hasCachedData: boolean,
): { settledChannelIds: ReadonlySet<string>; isLoading: boolean } {
  if (activeChannelId === null) {
    return { settledChannelIds, isLoading: loadingNow };
  }
  if (settledChannelIds.has(activeChannelId) && hasCachedData) {
    return { settledChannelIds, isLoading: false };
  }
  if (!loadingNow) {
    const nextSettledChannelIds = new Set(settledChannelIds);
    nextSettledChannelIds.add(activeChannelId);
    return { settledChannelIds: nextSettledChannelIds, isLoading: false };
  }
  return { settledChannelIds, isLoading: true };
}
