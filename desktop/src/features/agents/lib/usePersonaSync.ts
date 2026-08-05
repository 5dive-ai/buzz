import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import { reconcileInboundPersonaEvent } from "@/shared/api/tauriPersonas";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_DELETION,
  KIND_MANAGED_AGENT,
  KIND_PERSONA,
  KIND_PRIVATE_MANAGED_AGENT,
  KIND_TEAM,
} from "@/shared/constants/kinds";

// Persona/team/managed-agent projections (upserts) plus kind:5 NIP-09
// deletions, so a tombstone published by another device also removes the
// local record here.
const PERSONA_SYNC_KINDS = [
  KIND_PERSONA,
  KIND_TEAM,
  KIND_MANAGED_AGENT,
  KIND_PRIVATE_MANAGED_AGENT,
  KIND_DELETION,
];
const COMPATIBILITY_SYNC_KINDS = [
  KIND_PERSONA,
  KIND_TEAM,
  KIND_MANAGED_AGENT,
  KIND_DELETION,
];
const HYDRATION_PAGE_SIZE = 1_000;

async function fetchAllPersonaSyncEvents(
  pubkey: string,
  kinds: number[],
): Promise<RelayEvent[]> {
  const byId = new Map<string, RelayEvent>();
  let until: number | undefined;
  while (true) {
    const page = await relayClient.fetchEvents({
      kinds,
      authors: [pubkey],
      limit: HYDRATION_PAGE_SIZE,
      ...(until === undefined ? {} : { until }),
    });
    const sizeBefore = byId.size;
    let oldestCreatedAt = Number.POSITIVE_INFINITY;
    for (const event of page) {
      byId.set(event.id, event);
      oldestCreatedAt = Math.min(oldestCreatedAt, event.created_at);
    }
    if (page.length < HYDRATION_PAGE_SIZE || byId.size === sizeBefore) break;
    until = oldestCreatedAt;
  }
  return [...byId.values()];
}

export async function hydratePersonaSync(
  pubkey: string,
  relayUrl: string,
  onCancelled: () => boolean = () => false,
): Promise<void> {
  // Keep PMA heads in their own writer-backed REQ. They must neither compete
  // with compatibility events for one LIMIT nor come from a stale replica when
  // Welcome provisioning uses the result to decide whether to mint an identity.
  const [privateHeads, compatibilityEvents] = await Promise.all([
    fetchAllPersonaSyncEvents(pubkey, [KIND_PRIVATE_MANAGED_AGENT]),
    fetchAllPersonaSyncEvents(pubkey, COMPATIBILITY_SYNC_KINDS),
  ]);
  const events = [...privateHeads, ...compatibilityEvents];
  for (const event of events) {
    if (onCancelled()) return;
    if (event.pubkey !== pubkey) continue;
    await reconcileInboundPersonaEvent(JSON.stringify(event), relayUrl);
  }
}

// Start the persona/team/agent/deletion sync for `pubkey` on `relayUrl`:
// one-shot backfill of existing heads + tombstones, then a live subscription.
// Returns a disposer that closes the live subscription. Extracted from the hook
// so the wiring is unit-testable without a React renderer (see
// `usePersonaSync.test.mjs`).
//
// `relayUrl` is the community this subscription is bound to, and every reconcile
// carries it as the event's arrival relay. Capturing it here — rather than
// letting the backend read whichever workspace is active when the reconcile runs
// — is what keeps an in-flight event out of the next community's scoped store.
export function startPersonaSync(
  pubkey: string,
  relayUrl: string,
  onCancelled: () => boolean,
): () => Promise<void> {
  const reconcile = (event: RelayEvent) => {
    if (event.pubkey !== pubkey) return;
    void reconcileInboundPersonaEvent(JSON.stringify(event), relayUrl).catch(
      (error) => {
        console.warn("[usePersonaSync] reconcile failed:", error);
      },
    );
  };

  // One-shot backfill of existing heads + tombstones (closes the fresh-start
  // gap that live-only subscription + reconnect-replay cannot recover).
  void hydratePersonaSync(pubkey, relayUrl, onCancelled).catch((error) => {
    console.warn("[usePersonaSync] backfill failed:", error);
  });

  let unsub: (() => Promise<void>) | null = null;
  void relayClient
    .subscribeLive(
      { kinds: PERSONA_SYNC_KINDS, authors: [pubkey], limit: 0 },
      reconcile,
    )
    .then((dispose) => {
      if (onCancelled()) {
        void dispose();
      } else {
        unsub = dispose;
      }
    });

  return async () => {
    if (unsub) await unsub();
  };
}

// Subscribes to this device's own persona/team/agent projection + deletion
// events and patches each into the local store. The subscription is keyed on
// the active pubkey and relay: an identity or community switch re-runs the
// effect, whose cleanup closes the old subscription before a new one opens on
// the new filter — so no stale-coordinate subscription survives, and every
// reconcile is attributed to the community it was subscribed to.
//
// A fresh device that comes online AFTER another already published gets no
// history from a live-only subscription: relayClient's replayLiveSubscriptions
// only replays from a since-cursor that is undefined until the first live
// event arrives. So `startPersonaSync` does an explicit one-shot history fetch
// up front and feeds each event through the same reconcile path.
export function usePersonaSync(
  pubkey: string | undefined,
  relayUrl: string | undefined,
): void {
  React.useEffect(() => {
    if (!pubkey || !relayUrl) return;
    let cancelled = false;
    const dispose = startPersonaSync(pubkey, relayUrl, () => cancelled);
    return () => {
      cancelled = true;
      void dispose();
    };
  }, [pubkey, relayUrl]);
}
