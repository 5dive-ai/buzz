/**
 * NIP-RS full-state fenced loader.
 *
 * Implements the NIP-RS §Full-State Load procedure (NIP-RS.md:321-377):
 * - Tag-free filter established on the fence subscription BEFORE the first
 *   enumeration query (NIP-RS.md:341-345).
 * - Lapse detection via BOTH a reconnect listener AND connection-generation
 *   checks before and after every band query. If the generation changes at
 *   any point, the fence lapsed and the load is potentially incomplete.
 * - Descending `until` cursor with pinned-window check (NIP-RS.md:350-352).
 * - Delivery barrier: after the terminal empty continuation, we wait one
 *   EVENT_BATCH_MS tick so the relay client's 16 ms event-batch timer can
 *   flush any in-flight fence events, then drain `fenceEvents` before verdict
 *   (NIP-RS.md:343,353).
 * - `T === 0` completes only after an explicitly empty continuation
 *   (NIP-RS.md:352).
 * - Coordinate deduplicated by `d` tag (greatest `created_at`, lowest id)
 *   fed into a single structured merge (NIP-RS.md:348).
 */

import type { RelayClient } from "@/shared/api/relayClientSession";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_READ_STATE } from "@/shared/constants/kinds";
import { mergeReadStateEventsStructured } from "@/features/channels/readState/readStateSnapshot";
import type { MergedReadState } from "@/features/channels/readState/readStateSnapshot";
import { isValidReadStateDTag } from "@/features/channels/readState/readStateFormat";
import { EVENT_BATCH_MS } from "@/shared/api/relayClientTimings";

/** Number of events per enumeration band. MUST be ≥ L=2 (NIP-RS.md:347). */
const BAND_LIMIT = 500;
/** NIP-RS §Floor: relay MUST deliver ≥ L events when ≥ L exist (NIP-RS.md:360). */
const L = 2;

export type FencedLoadResult =
  | { complete: true; merged: MergedReadState }
  | { complete: false; merged: MergedReadState };

/**
 * Perform one full-state fenced enumeration for `pubkey`.
 *
 * Returns the merged read state from all collected events and whether the load
 * was proven complete per the NIP-RS §Full-State Load procedure. A
 * `complete: false` result carries a best-effort baseline for local display.
 */
export async function fencedEnumerationLoad(
  relay: RelayClient,
  pubkey: string,
): Promise<FencedLoadResult> {
  const baseFilter = {
    kinds: [KIND_READ_STATE],
    authors: [pubkey],
    limit: BAND_LIMIT,
  };

  // ── Step 1: Establish the fence BEFORE the first query ──────────────────
  // The fence must be established on the SAME connection as every subsequent
  // band query (NIP-RS.md:341-345). We track lapse via:
  //   (a) reconnect listener  — fires on any connection reset
  //   (b) generation checks   — before/after each fetchEvents call
  // If either signals a lapse, the load is potentially incomplete.
  const fenceEvents: RelayEvent[] = [];
  let lapsed = false;
  const startGeneration = relay.getConnectionGeneration();
  let unsubscribeFence: (() => Promise<void>) | null = null;
  const unsubscribeReconnect = relay.subscribeToReconnects(() => {
    lapsed = true;
  });

  try {
    unsubscribeFence = await relay.subscribeLive(baseFilter, (ev) => {
      fenceEvents.push(ev);
    });
    // Verify the subscribe itself didn't trigger a reconnect.
    if (relay.getConnectionGeneration() !== startGeneration) lapsed = true;
  } catch {
    unsubscribeReconnect();
    return emptyIncomplete();
  }

  // ── Step 2: Descending enumeration ──────────────────────────────────────
  let C = 0;
  let until: number | undefined;
  const bandEvents: RelayEvent[] = [];
  let complete = false;

  while (true) {
    if (lapsed) break;

    const filter = { ...baseFilter, ...(until !== undefined ? { until } : {}) };
    const genBefore = relay.getConnectionGeneration();
    let band: RelayEvent[];
    try {
      band = await relay.fetchEvents(filter);
    } catch {
      break;
    }
    if (relay.getConnectionGeneration() !== genBefore || lapsed) {
      break;
    }

    if (band.length === 0) {
      // Empty continuation — load proven complete.
      complete = true;
      break;
    }

    if (band.length > C) C = band.length;
    for (const ev of band) bandEvents.push(ev);

    // T = lowest created_at in this band (NIP-RS.md:350).
    let T = band[0].created_at;
    for (const ev of band) if (ev.created_at < T) T = ev.created_at;

    // ── Pinned window (NIP-RS.md:350-351) ───────────────────────────────
    if (lapsed) break;
    const genPinned = relay.getConnectionGeneration();
    let pinned: RelayEvent[];
    try {
      pinned = await relay.fetchEvents({ ...baseFilter, since: T, until: T });
    } catch {
      break;
    }
    if (relay.getConnectionGeneration() !== genPinned || lapsed) {
      break;
    }

    for (const ev of pinned) bandEvents.push(ev);
    if (pinned.length > C) C = pinned.length;

    if (pinned.length >= Math.max(C, L)) {
      // Pinned window not discharged — potentially incomplete (spec :351).
      break;
    }

    if (T === 0) {
      // T=0 exhausted: require a strictly-older empty continuation (spec :352).
      const genCont = relay.getConnectionGeneration();
      let cont: RelayEvent[];
      try {
        cont = await relay.fetchEvents({ ...baseFilter, until: 0 });
      } catch {
        break;
      }
      if (relay.getConnectionGeneration() !== genCont || lapsed) {
        break;
      }
      if (cont.length === 0) {
        complete = true;
      } else {
        for (const ev of cont) bandEvents.push(ev);
      }
      break;
    }

    until = T - 1;
  }

  // ── Delivery barrier (NIP-RS.md:343,353) ────────────────────────────────
  // Wait one EVENT_BATCH_MS tick: any fence events buffered in the relay
  // client's 16 ms dispatch batch will flush and invoke our callback before
  // we call unsubscribe and stop collecting.
  await new Promise<void>((r) => window.setTimeout(r, EVENT_BATCH_MS + 1));
  await unsubscribeFence?.();
  unsubscribeReconnect();

  const allEvents = [...bandEvents, ...fenceEvents];

  if (lapsed && !complete) {
    return buildResult(false, allEvents, pubkey);
  }

  // ── Coordinate deduplicate before merge (NIP-RS.md:348) ─────────────────
  const deduped = deduplicateByCoordinate(allEvents);
  const merged = await mergeReadStateEventsStructured(deduped, pubkey);
  return { complete, merged };
}

/**
 * Deduplicate events by `d` tag: retain the event with the greatest
 * `created_at`; break ties by the lexicographically lowest event id.
 * Prevents superseded coordinate versions from being merged as concurrent
 * replicas (NIP-RS.md:348).
 */
export function deduplicateByCoordinate(events: RelayEvent[]): RelayEvent[] {
  const best = new Map<string, RelayEvent>();
  for (const ev of events) {
    const dTag = ev.tags.find((t) => t[0] === "d")?.[1];
    if (!dTag || !isValidReadStateDTag(dTag)) continue;
    const existing = best.get(dTag);
    if (
      !existing ||
      ev.created_at > existing.created_at ||
      (ev.created_at === existing.created_at && ev.id < existing.id)
    ) {
      best.set(dTag, ev);
    }
  }
  return [...best.values()];
}

function emptyIncomplete(): FencedLoadResult {
  return {
    complete: false,
    merged: { frontiers: new Map(), overrides: new Map() },
  };
}

async function buildResult(
  complete: boolean,
  events: RelayEvent[],
  pubkey: string,
): Promise<FencedLoadResult> {
  const deduped = deduplicateByCoordinate(events);
  const merged = await mergeReadStateEventsStructured(deduped, pubkey);
  return { complete, merged };
}
