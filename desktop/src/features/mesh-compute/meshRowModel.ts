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
  /** Row label. */
  label: string;
  /** Accessible state sentence, used as the row tooltip. */
  tooltip: string;
  /**
   * Compact trailing figure, or null when no capacity is known anywhere.
   *
   * Shown in every state that has a number, not just while sharing. When this
   * machine is outside the mesh the figure *is* the invitation: a real number
   * argues for joining better than any exhortation, and unlike a nudge there is
   * nothing to dismiss.
   *
   * When the mesh is empty there is no figure, so the slot carries the word
   * "Share" — the row would otherwise be inert with nothing explaining why.
   */
  badge: string | null;
  /**
   * Invitation text, or null.
   *
   * Only set in the cold state — no capacity anywhere, nothing running. There
   * is no number to show and no status to report, so without words the row is
   * inert and unexplained. Every other state has a figure or a tone that speaks
   * for itself, and a permanent nudge beside them would become furniture.
   */
  callToAction: string | null;
  /**
   * Why the dot moves, if it does. Never decorative: a still dot is a real
   * statement that there is nothing to act on and nothing happening.
   */
  pulse: MeshRowPulse;
};

/** One name in every state. Two variants was the source of drift, and "Buzz"
 * adds nothing inside Buzz. */
const LABEL = "MeshLLM";

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
      label: LABEL,
      tooltip:
        pendingAction === "stop" ? "Stopping sharing…" : "Starting to share…",
      badge: null,
      callToAction: null,
      pulse: "none",
    };
  }

  if (toggle.isSharing) {
    const health = status?.health;
    if (health && health.status !== "ok") {
      return {
        tone: "failed",
        label: LABEL,
        tooltip: "Sharing failed — open for details",
        badge: null,
        callToAction: null,
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
        label: LABEL,
        tooltip: "Sharing compute · no agent is using it yet",
        badge,
        callToAction: null,
        pulse: "invite",
      };
    }
    return {
      tone: "sharing",
      label: LABEL,
      tooltip:
        peerCount > 0
          ? `Sharing compute · ${peerCount} ${plural(peerCount, "peer")}`
          : "Sharing compute · waiting for another device",
      badge,
      callToAction: null,
      pulse: busyNow ? "activity" : "none",
    };
  }

  if (toggle.isConsuming) {
    const gb = liveCapacityGb(view);
    return {
      tone: "consuming",
      label: LABEL,
      tooltip: "Using shared compute from the mesh",
      badge: gb > 0 ? formatCapacityGb(gb) : null,
      callToAction: null,
      pulse: busyNow ? "activity" : "none",
    };
  }

  // Not participating. The relay snapshot is the only view, and the only thing
  // that distinguishes "there is a mesh to join" from "there is nothing here".
  const count = snapshot?.sharingDeviceCount ?? 0;
  if (!snapshot) {
    // Not asked yet. No figure, no prompt: a call to action based on no data
    // would appear for one poll and retract, which reads as a glitch.
    return {
      tone: "unknown",
      label: LABEL,
      tooltip: "Checking for shared compute…",
      badge: null,
      // Nothing offered from no data: a prompt that appears for one poll and
      // retracts reads as a glitch, not a suggestion.
      callToAction: null,
      pulse: "none",
    };
  }
  if (count === 0) {
    // An empty mesh is the one state with nothing to show and nothing
    // happening, so without a prompt the row is inert and unexplained. The
    // action is real — you can be the first to share — so the badge slot
    // carries the word instead of a figure.
    //
    // Static, not throbbing. A community that never uses the mesh would
    // otherwise animate forever, and permanent motion earns nothing but
    // annoyance. The invite throb stays reserved for capacity that exists.
    return {
      tone: "unknown",
      label: LABEL,
      tooltip: "No shared compute yet — share this computer to start the mesh",
      badge: null,
      callToAction: "Share your compute",
      pulse: "none",
    };
  }
  const gb = snapshot.sharedCapacityGb;
  return {
    tone: "available",
    label: LABEL,
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
    callToAction: null,
    pulse: "invite",
  };
}
