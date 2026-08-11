import type { QueryClient } from "@tanstack/react-query";
import * as React from "react";

import { enforceMessageWindowBounds } from "./lib/boundMessageWindows";

const BOUNDED_MESSAGE_KEYS = new Set([
  "channel-window",
  "channel-messages",
  "thread-replies",
]);

/**
 * Bound the number of channel timelines and thread subtrees retained in the
 * query cache. Every visited channel/thread lingers for `gcTime` (one hour)
 * after its view unmounts, so a session that roams many channels accumulates
 * every timeline's window store and flattened array at once — the renderer
 * memory leak behind the v0.5.9 lag. This mounts one cache subscription per
 * QueryClient that evicts the least-recently-updated unpinned timelines past a
 * fixed cap (see `enforceMessageWindowBounds`).
 *
 * Mounted once inside `CommunityQueryProvider`, so the bound applies to every
 * window that renders it — the main app, the huddle room, and the companion —
 * each on its own client.
 *
 * A new message key entering the cache is the only event that can push the
 * count over its cap, so the sweep is triggered on `added` for a bounded key
 * and coalesced to one run per microtask (a channel open adds two keys at
 * once). Removals emit `removed`, never `added`, so eviction cannot re-trigger
 * itself. The sweep runs synchronously in a single tick — collect then remove
 * — so a view mounting mid-sweep cannot be misread as inactive.
 */
export function useBoundedMessageWindows(queryClient: QueryClient): void {
  React.useEffect(() => {
    let scheduled = false;
    const sweep = () => {
      scheduled = false;
      enforceMessageWindowBounds(queryClient);
    };
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type !== "added" ||
        !BOUNDED_MESSAGE_KEYS.has(event.query.queryKey[0])
      ) {
        return;
      }
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(sweep);
    });
  }, [queryClient]);
}
