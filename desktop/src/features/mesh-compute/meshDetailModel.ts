import type { MeshServingUsage, MeshSnapshot } from "@/shared/api/tauriMesh";

/**
 * Pure projection for the mesh detail popover.
 *
 * The popover answers three questions the 256px card cannot:
 *   1. How big is the pool, and how much of the community is in it?
 *   2. Is the spice flowing — is work actually happening right now?
 *   3. Am I running on someone else's machine, or my own?
 *
 * The hard constraint this file exists to encode: **mesh-llm exposes no inbound
 * counter.** `routing_metrics` is incremented only by this node's own OpenAI
 * ingress, so every number available describes work *this machine dispatched*.
 * Nothing can prove another member consumed our compute. So:
 *
 *   - "I used someone else's machine"  → provable (`remotelyServed`)
 *   - "my own GPU did the work"        → provable (`locallyServed`)
 *   - "someone used MY machine"        → NOT provable, only ever hinted
 *
 * `inflight` is the one live signal, and it does not say who the work is for.
 * That is why the busy state is worded "working" and never "someone is using
 * your compute".
 */

/** Ghost = a community member with no published status note. */
export type MeshDetailModel = {
  /** e.g. "115 GB" — pool capacity, or null when nobody reported a figure. */
  capacityLabel: string | null;
  /** e.g. "2 of 12 members sharing". */
  participationLabel: string;
  /** Members with no status note at all. Count only — never GB. */
  ghostCount: number;
  /** True when inference is in flight on this node right now. */
  busyNow: boolean;
  /**
   * Live activity phrase, or null when idle. Deliberately vague about *who*:
   * the counters cannot attribute inbound work.
   */
  activityLabel: string | null;
  /** Where this machine's completed requests actually ran. */
  originLabel: string | null;
  /** Distinct models ready across the pool. */
  modelCount: number;
};

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/**
 * Where this machine's work ran — the honest "am I borrowing someone's GPU"
 * line.
 *
 * `remotelyServed` counts *completed* requests a peer answered for us, so it is
 * a fact about our own consumption, not a guess. Returns null before any
 * request completes rather than claiming "0 remote".
 */
export function describeRequestOrigin(
  usage: MeshServingUsage | null,
): string | null {
  if (!usage) {
    return null;
  }
  const remote = usage.remotelyServed + usage.endpointServed;
  const total = usage.locallyServed + remote;
  if (total === 0) {
    return null;
  }
  if (remote === 0) {
    return `${total} ${plural(total, "request")} · all on this computer`;
  }
  if (usage.locallyServed === 0) {
    return `${remote} ${plural(remote, "request")} · all on shared compute`;
  }
  return `${remote} of ${total} requests on shared compute`;
}

/**
 * The live "spice is flowing" phrase.
 *
 * Wording is intentionally agent-agnostic: `inflight` counts work in flight on
 * this node without distinguishing a local agent from a remote member, so this
 * may never assert that someone else is using this machine.
 */
export function describeActivity(
  usage: MeshServingUsage | null,
  isSharing: boolean,
): string | null {
  const inflight = usage?.inflight ?? 0;
  if (inflight > 0) {
    return `${inflight} ${plural(inflight, "request")} in flight`;
  }
  if (!usage) {
    return null;
  }
  // Sharing with a warm runtime and no traffic is a real, distinct state:
  // ready, but nothing has asked yet.
  if (isSharing && usage.requestsServed === 0) {
    return "Ready · no requests yet";
  }
  return null;
}

export function deriveMeshDetailModel({
  snapshot,
  usage,
  isSharing,
}: {
  snapshot: MeshSnapshot | null;
  usage: MeshServingUsage | null;
  isSharing: boolean;
}): MeshDetailModel {
  const devices = snapshot?.devices ?? [];
  const sharing = snapshot?.sharingDeviceCount ?? 0;
  const members = snapshot?.memberCount ?? 0;
  // Members who published nothing. Clamped at 0: a device may report without
  // appearing in a stale roster page, and a negative ghost count is nonsense.
  const ghostCount = Math.max(0, members - devices.length);
  const capacityGb = snapshot?.sharedCapacityGb ?? null;

  return {
    capacityLabel:
      capacityGb === null
        ? null
        : `${capacityGb >= 10 ? Math.round(capacityGb) : Math.round(capacityGb * 10) / 10} GB`,
    participationLabel:
      members === 0
        ? `${sharing} ${plural(sharing, "device")} sharing`
        : `${sharing} of ${members} ${plural(members, "member")} sharing`,
    ghostCount,
    busyNow: (usage?.inflight ?? 0) > 0,
    activityLabel: describeActivity(usage, isSharing),
    originLabel: describeRequestOrigin(usage),
    modelCount: snapshot?.models.length ?? 0,
  };
}
