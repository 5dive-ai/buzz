import type {
  MeshLiveView,
  MeshNodeStatus,
  MeshSnapshot,
} from "@/shared/api/tauriMesh";
import type { MeshShareToggleModel } from "./shareToggleState";
import { formatCapacityGb, plural } from "./meshCardModel";

/**
 * Pure projection for the sidebar Community mesh row.
 *
 * The row replaced a ~120px card with a single menu line, so it carries two
 * signals only: a coloured dot and a capacity figure. Every control lives in
 * the popover.
 *
 * ## Why "not participating" is two states, not one
 *
 * Grey would conflate "nobody is sharing anything" with "there is 115 GB here
 * and you simply have not joined" — and the second is the whole reason to look
 * at this row. They are distinguishable without any probe: `mesh_snapshot`
 * reads other members' relay status notes and needs no local runtime, so we
 * know the pool exists while our own node is off.
 *
 * `unknown` therefore means *no capacity known* (nothing published, or not
 * fetched yet), and `available` means *capacity exists and we are outside it*.
 */
export type MeshRowTone =
  /** Nothing published by anyone, or the snapshot has not landed yet. */
  | "unknown"
  /** The community has capacity; this machine is not in the mesh. */
  | "available"
  /** Serving: this machine contributes compute. */
  | "sharing"
  /** Client only: this machine uses someone else's compute. */
  | "consuming"
  /** A start/stop is in flight, or the node is loading a model. */
  | "starting"
  /** The runtime occupies the slot but reports unhealthy. */
  | "failed";

/**
 * Why the dot is moving, not merely whether.
 *
 * Two different facts want motion, and collapsing them into one boolean would
 * make a throb ambiguous:
 *
 *   - `activity` — real work is in flight on this node right now
 *   - `invite`   — there is something worth doing, and nothing is happening
 *
 * They are visually distinct (invite breathes slowly; activity uses the quick
 * stock ping) so the same animation never means two things.
 *
 * `invite` covers two situations that share one meaning — "act here":
 *   - capacity exists and this machine is outside it
 *   - this machine shares, but no agent is set up to use the mesh
 *
 * The second deliberately does **not** get its own colour. Blue already means
 * *consuming*, i.e. taking from the mesh; sharing-with-no-consumer is the
 * opposite, so painting it blue would make blue meaningless. The dot keeps
 * saying what state we are in (green: sharing, truthfully) while the throb says
 * there is an action worth taking, and the tooltip names which.
 */
export type MeshRowPulse = "none" | "activity" | "invite";

export type MeshRowModel = {
  tone: MeshRowTone;
  /** Accessible state sentence, used as the row tooltip. */
  tooltip: string;
  /**
   * Compact trailing figure, or null when no capacity is known anywhere.
   *
   * Shown in every state that has a number, not just while sharing. When this
   * machine is outside the mesh the figure *is* the invitation: a real number
   * argues for joining better than any exhortation, and unlike a nudge there is
   * nothing to dismiss.
   */
  badge: string | null;
  /**
   * Why the dot moves, if it does. Never decorative: a still dot is a real
   * statement that there is nothing to act on and nothing happening.
   */
  pulse: MeshRowPulse;
};

/** Live pool capacity: this machine plus every peer that reports a figure. */
function liveCapacityGb(view: MeshLiveView | null): number {
  if (!view?.connected) return 0;
  return [
    view.selfCapacityGb ?? 0,
    ...view.peers.map((peer) => peer.capacityGb ?? 0),
  ].reduce((total, gb) => total + gb, 0);
}

export function deriveMeshRowModel({
  snapshot,
  status,
  toggle,
  view,
  pendingAction,
  busyNow,
  hasMeshAgent,
}: {
  snapshot: MeshSnapshot | null;
  status: MeshNodeStatus | null;
  toggle: MeshShareToggleModel;
  view: MeshLiveView | null;
  pendingAction: "start" | "stop" | null;
  /** Work in flight on this node, inbound or outbound. */
  busyNow: boolean;
  /**
   * Any agent resolves to the shared-compute provider.
   *
   * `undefined` while the agent list is loading — treated as "assume set up",
   * so a slow query never throbs a nudge that then vanishes.
   */
  hasMeshAgent: boolean | undefined;
}): MeshRowModel {
  // A start/stop in flight outranks everything: the tone must not claim a
  // steady state while the runtime is mid-transition.
  if (
    pendingAction !== null ||
    (toggle.isSharing && status?.state === "starting")
  ) {
    return {
      tone: "starting",
      tooltip:
        pendingAction === "stop" ? "Stopping sharing…" : "Starting to share…",
      badge: null,
      pulse: "none",
    };
  }

  if (toggle.isSharing) {
    const health = status?.health;
    if (health && health.status !== "ok") {
      return {
        tone: "failed",
        tooltip: "Sharing failed — open for details",
        badge: null,
        pulse: "none",
      };
    }
    const gb = liveCapacityGb(view);
    const peerCount = view?.peers.length ?? 0;
    const badge = gb > 0 ? formatCapacityGb(gb) : null;
    // Sharing compute nothing can use is a dead end, and the row is where it
    // would go unnoticed. Green stays — we really are sharing — but the throb
    // says there is a step left, and only once the agent list has actually
    // resolved.
    if (hasMeshAgent === false) {
      return {
        tone: "sharing",
        tooltip: "Sharing compute · no agent is using it yet",
        badge,
        pulse: "invite",
      };
    }
    return {
      tone: "sharing",
      tooltip:
        peerCount > 0
          ? `Sharing compute · ${peerCount} ${plural(peerCount, "peer")}`
          : "Sharing compute · waiting for another device",
      badge,
      pulse: busyNow ? "activity" : "none",
    };
  }

  if (toggle.isConsuming) {
    const gb = liveCapacityGb(view);
    return {
      tone: "consuming",
      tooltip: "Using shared compute from the mesh",
      badge: gb > 0 ? formatCapacityGb(gb) : null,
      pulse: busyNow ? "activity" : "none",
    };
  }

  // Not participating. The relay snapshot is the only view, and the only thing
  // that distinguishes "there is a mesh to join" from "there is nothing here".
  const count = snapshot?.sharingDeviceCount ?? 0;
  if (!snapshot || count === 0) {
    return {
      tone: "unknown",
      tooltip: snapshot
        ? "No shared compute in this community yet"
        : "Checking for shared compute…",
      badge: null,
      pulse: "none",
    };
  }
  const gb = snapshot.sharedCapacityGb;
  return {
    tone: "available",
    tooltip:
      gb === null
        ? `Shared compute available · ${count} ${plural(count, "device")}`
        : `${formatCapacityGb(gb)} of shared compute available`,
    // Unknown capacity degrades to a device count rather than printing 0 GB — a
    // count still says "there is something here", which is the job.
    badge:
      gb === null
        ? `${count} ${plural(count, "device")}`
        : formatCapacityGb(gb),
    pulse: "invite",
  };
}
