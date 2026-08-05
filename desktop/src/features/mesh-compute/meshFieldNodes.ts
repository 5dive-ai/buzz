import type { MeshLiveView, MeshSnapshot } from "@/shared/api/tauriMesh";
import type { MeshFieldNode } from "./ui/MeshRadarField";

/**
 * Nodes for the radar field, from whichever source this machine actually has.
 *
 * ## Why two sources
 *
 * A running node knows its peers through live gossip: present means reachable
 * *now*, and each carries an RTT. With no node there is no gossip — but the
 * community's shared compute is still knowable, because `mesh_snapshot` reads
 * other members' relay status notes and needs no local runtime. So the field
 * renders either way, and the earlier "turn on sharing to see who's on the
 * mesh" was simply wrong.
 *
 * The two are not equivalent, and the difference is not cosmetic:
 *
 *   - **live**: reachable now, RTT known, adjacency to us is real
 *   - **relay**: last known within 120s, no RTT, adjacency unknown
 *
 * So relay nodes get no RTT (they land mid-band rather than faking proximity),
 * the caller draws no spokes when we have not joined, and the caption names
 * which view is on screen. Never dress last-known state as live.
 */

export type MeshFieldSource = "live" | "relay" | "none";

export type MeshFieldModel = {
  nodes: MeshFieldNode[];
  source: MeshFieldSource;
  /** True when this machine is part of the mesh being drawn. */
  selfParticipating: boolean;
  selfCapacityGb: number | null;
  /**
   * Community members with no published status note.
   *
   * A count only. A member who never started a node has disclosed no hardware,
   * so ghosts never contribute capacity — they are the invitation, not a total.
   */
  ghostCount: number;
  /** Caption naming the source, or null when there is nothing to qualify. */
  caption: string | null;
};

export function deriveMeshFieldModel({
  view,
  snapshot,
}: {
  view: MeshLiveView | null;
  snapshot: MeshSnapshot | null;
}): MeshFieldModel {
  const ghostCount = Math.max(
    0,
    (snapshot?.memberCount ?? 0) - (snapshot?.sharingDeviceCount ?? 0),
  );

  // A local runtime is the better source whenever it exists: it is the only one
  // that can vouch for reachability.
  if (view?.connected) {
    return {
      nodes: view.peers.map((peer) => ({
        id: peer.id,
        state: peer.state,
        capacityGb: peer.capacityGb,
        rttMs: peer.rttMs,
      })),
      source: "live",
      selfParticipating: true,
      selfCapacityGb: view.selfCapacityGb,
      ghostCount,
      caption:
        view.peers.length === 0
          ? "Connected · waiting for another device"
          : null,
    };
  }

  // No runtime. Other members' status notes are all we have — and they are
  // enough to show that a pool exists and roughly how big it is.
  const devices = (snapshot?.devices ?? []).filter((device) => !device.isSelf);
  if (devices.length === 0) {
    return {
      nodes: [],
      source: "none",
      selfParticipating: false,
      selfCapacityGb: null,
      ghostCount,
      caption: null,
    };
  }
  return {
    nodes: devices.map((device, index) => ({
      // Status notes may omit a device id; the ring slot keeps keys stable
      // enough for the per-node animation phase.
      id: device.deviceId ?? `relay:${index}`,
      state: device.state,
      capacityGb: device.capacityGb,
      // Deliberately null: notes carry no RTT, and inventing one would place a
      // node at a distance that means nothing.
      rttMs: null,
    })),
    source: "relay",
    selfParticipating: false,
    selfCapacityGb: null,
    ghostCount,
    caption: "Last reported by the community · join to see live detail",
  };
}
