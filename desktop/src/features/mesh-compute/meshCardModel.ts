import type {
  MeshNodeStatus,
  MeshSnapshot,
  MeshSnapshotDevice,
} from "@/shared/api/tauriMesh";
import type { MeshShareToggleModel } from "./shareToggleState";

/**
 * Pure projection for the sidebar shared-compute card.
 *
 * The card has one job: make it obvious, at a glance, whether **this machine**
 * is giving compute, taking compute, or neither — and what the community has
 * to offer. Copy lives here (not in the component) so the wording is unit
 * tested and cannot drift between states.
 *
 * Two distinctions this model refuses to blur:
 *
 * 1. **Sharing vs consuming.** One mesh runtime slot serves both roles and both
 *    report `state:"running"`, so the role comes from `deriveMeshShareToggle`,
 *    never from `state` alone. Consuming must never read as sharing.
 * 2. **Unknown capacity vs zero capacity.** `sharedCapacityGb: null` means
 *    nobody reported a figure, so the headline drops the number rather than
 *    claiming "0 GB".
 */

/** Which role this machine is playing. Drives the card's accent + icon. */
export type MeshCardTone =
  | "idle"
  | "sharing"
  | "consuming"
  | "pending"
  | "failed";

export type MeshCardModel = {
  tone: MeshCardTone;
  /** Primary line — what is happening, from this machine's point of view. */
  headline: string;
  /** Secondary line — the community context, or the reason for a problem. */
  detail: string | null;
  /** Switch position. Reflects serve-mode occupancy only. */
  switchOn: boolean;
  switchDisabled: boolean;
  /** Accessible label for the switch, naming the consequence of flipping it. */
  switchLabel: string;
  /** Devices for the topology strip, sharing first. */
  devices: MeshSnapshotDevice[];
  /** True when the mesh has exactly one participant (the solo case). */
  isSolo: boolean;
  /** Whether to show the "waiting for another device" hint. */
  showSoloHint: boolean;
};

/**
 * Format shared memory for display. Whole numbers at 10GB+ (a "42 GB" mesh
 * reads better than "42.3 GB"); one decimal below that so a single small
 * machine still shows a meaningful figure.
 */
export function formatCapacityGb(gb: number): string {
  const rounded = gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10;
  return `${rounded} GB`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/**
 * The community headline: how much compute is actually available right now.
 *
 * Counts only devices advertising a routable model — the same standard routing
 * uses — so the number never promises capacity that cannot be reached. Never
 * says "total": the underlying query is capped at 100 members.
 */
export function describeMeshCapacity(snapshot: MeshSnapshot | null): string {
  if (!snapshot || snapshot.sharingDeviceCount === 0) {
    return "No compute shared yet";
  }
  const { sharingDeviceCount: count, sharedCapacityGb: gb } = snapshot;
  const devices = `${count} ${plural(count, "device")} sharing`;
  // Unknown capacity degrades to the device count rather than printing 0 GB.
  return gb === null ? devices : `${devices} · ${formatCapacityGb(gb)}`;
}

/** Short label for what is ready to run, or null when nothing is. */
export function describeReadyModels(
  snapshot: MeshSnapshot | null,
): string | null {
  const models = snapshot?.models ?? [];
  if (models.length === 0) {
    return null;
  }
  if (models.length === 1) {
    return `${shortModelLabel(models[0])} ready`;
  }
  return `${models.length} models ready`;
}

/**
 * Trim a model reference down to something that fits a 256px sidebar.
 * `unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M` → `Gemma 4 26B A4B`.
 */
export function shortModelLabel(modelRef: string): string {
  const basename = modelRef.split("/").at(-1) ?? modelRef;
  const withoutQuant = basename.replace(/[:-](?:GGUF|UD)?[:-]?Q\d.*$/i, "");
  const cleaned = withoutQuant
    .replace(/-GGUF.*$/i, "")
    .replace(/-it$/i, "")
    .replaceAll("-", " ")
    .trim();
  if (cleaned === "") {
    return basename;
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Project everything the card needs into one view model.
 *
 * Total: every input may be null (nothing fetched yet) and the result is still
 * renderable.
 */
export function deriveMeshCardModel({
  snapshot,
  status,
  toggle,
  pendingAction,
  canShare,
  activeConsumers,
}: {
  snapshot: MeshSnapshot | null;
  status: MeshNodeStatus | null;
  toggle: MeshShareToggleModel;
  pendingAction: "start" | "stop" | null;
  /** False when no model can be resolved yet (catalog still loading). */
  canShare: boolean;
  /** Another member is actively using this machine's compute right now. */
  activeConsumers: boolean;
}): MeshCardModel {
  const devices = snapshot?.devices ?? [];
  const participantCount = devices.length;
  const capacity = describeMeshCapacity(snapshot);
  const ready = describeReadyModels(snapshot);
  const isSolo = participantCount === 1;

  const base = {
    devices,
    isSolo,
    switchOn: toggle.isSharing,
    // A serve node can always be stopped. Anything else waits for a resolvable
    // model, and never lets an unknown occupant be replaced silently.
    switchDisabled:
      pendingAction !== null ||
      (toggle.isSharing
        ? false
        : toggle.slotOccupied && !toggle.isConsuming
          ? true
          : !canShare),
    switchLabel: toggle.isSharing
      ? "Stop sharing this computer's compute"
      : "Share this computer's compute",
  };

  if (pendingAction === "start") {
    return {
      ...base,
      tone: "pending",
      headline: "Starting to share…",
      detail: "Loading the model. This can take a moment.",
      showSoloHint: false,
    };
  }
  if (pendingAction === "stop") {
    return {
      ...base,
      tone: "pending",
      headline: "Stopping…",
      detail: null,
      showSoloHint: false,
    };
  }

  // Consuming: this machine is TAKING compute, not giving it. Say so plainly —
  // the switch is off here and that must not read as "nothing is happening".
  if (toggle.isConsuming) {
    const peer = devices.find(
      (device) => !device.isSelf && device.state === "serving",
    );
    return {
      ...base,
      tone: "consuming",
      headline: "Using shared compute",
      detail: peer
        ? `Running on ${peer.label}. Turn on to share this computer too.`
        : "Running on another member's computer.",
      showSoloHint: false,
    };
  }

  if (toggle.isSharing) {
    const health = status?.health;
    if (health && health.status !== "ok") {
      return {
        ...base,
        tone: "failed",
        headline: "Sharing needs attention",
        detail:
          health.reason ?? "The shared compute runtime reported a problem.",
        showSoloHint: false,
      };
    }
    // A serve node with no advertised model yet is warming up, not serving.
    const selfDevice = devices.find((device) => device.isSelf);
    if (selfDevice?.state === "loading" || status?.state === "starting") {
      return {
        ...base,
        tone: "pending",
        headline: "Starting to share…",
        detail: "Loading the model. This can take a moment.",
        showSoloHint: false,
      };
    }
    const model = status?.modelName ?? status?.modelId;
    return {
      ...base,
      tone: "sharing",
      headline: activeConsumers
        ? "Sharing · in use now"
        : "Sharing this computer",
      detail: model ? `${shortModelLabel(model)} · ${capacity}` : capacity,
      showSoloHint: isSolo,
    };
  }

  // Idle: the invitation. Lead with what the community already has, because
  // that is the reason to join — not with a description of the mechanism.
  return {
    ...base,
    tone: "idle",
    headline: capacity,
    detail: ready ?? "Turn on to let members run agents on this computer.",
    showSoloHint: false,
  };
}
