import type {
  MeshLiveView,
  MeshNodeStatus,
  MeshSnapshot,
} from "@/shared/api/tauriMesh";
import type { MeshShareToggleModel } from "./shareToggleState";
import { formatCapacityGb, plural } from "./meshCardModel";

/**
 * Pure projection for the sidebar Compute row.
 *
 * The row replaced a ~120px card with a single menu line, so it carries exactly
 * one signal: a coloured dot. Everything else moved into the popover.
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
 *   - `invite`   — there is compute here to tap into, and we are not in it
 *
 * They are visually distinct (invite is slower and slate; activity matches the
 * tone colour) so the same animation never means two things.
 */
export type MeshRowPulse = "none" | "activity" | "invite";

export type MeshRowModel = {
  tone: MeshRowTone;
  /** Accessible state sentence, used as the row tooltip. */
  tooltip: string;
  /**
   * Compact trailing figure, or null. Only shown when the switch is absent
   * (i.e. while sharing) so the two never compete for the same 256px.
   */
  badge: string | null;
  /** Show the Share switch. Hidden once sharing — stop lives in the popover. */
  showSwitch: boolean;
  /** Label for the switch, read by screen readers. */
  switchLabel: string;
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
}: {
  snapshot: MeshSnapshot | null;
  status: MeshNodeStatus | null;
  toggle: MeshShareToggleModel;
  view: MeshLiveView | null;
  pendingAction: "start" | "stop" | null;
  /** Work in flight on this node, inbound or outbound. */
  busyNow: boolean;
}): MeshRowModel {
  const shareLabel = "Share this computer's compute";

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
      showSwitch: false,
      switchLabel: shareLabel,
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
        showSwitch: false,
        switchLabel: "Stop sharing",
        pulse: "none",
      };
    }
    const gb = liveCapacityGb(view);
    const peerCount = view?.peers.length ?? 0;
    return {
      tone: "sharing",
      tooltip:
        peerCount > 0
          ? `Sharing compute · ${peerCount} ${plural(peerCount, "peer")}`
          : "Sharing compute · waiting for another device",
      // Capacity is the payoff for sharing, so it earns the badge slot the
      // switch vacates.
      badge: gb > 0 ? formatCapacityGb(gb) : null,
      showSwitch: false,
      switchLabel: "Stop sharing",
      pulse: busyNow ? "activity" : "none",
    };
  }

  if (toggle.isConsuming) {
    return {
      tone: "consuming",
      tooltip: "Using shared compute from the mesh",
      badge: null,
      // Deliberately still offered: a member may replace a client runtime with
      // a serve runtime at any time. Consuming is not a lock.
      showSwitch: true,
      switchLabel: shareLabel,
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
      showSwitch: true,
      switchLabel: shareLabel,
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
    badge: null,
    showSwitch: true,
    switchLabel: shareLabel,
    // The one state worth drawing the eye to unprompted: real capacity exists
    // and this machine is neither using nor adding to it.
    pulse: "invite",
  };
}
