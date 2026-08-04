import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/shared/lib/cn";
import type { MeshSnapshotDevice } from "@/shared/api/tauriMesh";
import { formatCapacityGb, shortModelLabel } from "../meshCardModel";

/**
 * Compact contributor strip for the sidebar card.
 *
 * Deliberately NOT a network topology graph. The relay tells us which devices
 * are participating and what each advertises, but the published activity
 * counters are **node-local, not edge-attributed** — so drawing traffic moving
 * along a particular link would be fiction. Each device gets a dot; a dot
 * pulses only when that device is actually serving.
 *
 * Honest at every scale, including the common one:
 *   n=1  → a single dot plus "Waiting for another device"
 *   n=2+ → one dot per device, yours marked
 *   many → the first few dots plus a "+N" remainder
 */

const MAX_VISIBLE_DOTS = 8;

const STATE_DOT_CLASS: Record<MeshSnapshotDevice["state"], string> = {
  serving: "bg-emerald-500 dark:bg-emerald-400",
  loading: "bg-amber-500 dark:bg-amber-400",
  standby: "bg-muted-foreground/40",
  consuming: "bg-sky-500 dark:bg-sky-400",
};

function deviceTitle(device: MeshSnapshotDevice): string {
  const parts = [
    device.isSelf ? `${device.label} (this computer)` : device.label,
  ];
  if (device.capacityGb !== null) {
    parts.push(formatCapacityGb(device.capacityGb));
  }
  if (device.models.length > 0) {
    parts.push(shortModelLabel(device.models[0]));
  } else if (device.state === "standby") {
    parts.push("standing by");
  } else if (device.state === "consuming") {
    parts.push("using shared compute");
  }
  return parts.join(" · ");
}

export function MeshTopologyStrip({
  devices,
  showSoloHint,
}: {
  devices: MeshSnapshotDevice[];
  showSoloHint: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();

  if (devices.length === 0) {
    return null;
  }

  const visible = devices.slice(0, MAX_VISIBLE_DOTS);
  const remainder = devices.length - visible.length;

  return (
    <div
      className="mt-2 flex items-center gap-1.5"
      data-testid="mesh-topology-strip"
    >
      <div className="flex items-center gap-1">
        {visible.map((device, index) => {
          // Pulse only for devices genuinely serving. Reduced motion gets a
          // static dot rather than a slower animation.
          const isPulsing = device.state === "serving" && !shouldReduceMotion;
          return (
            <span
              className="relative flex h-2 w-2 items-center justify-center"
              key={device.deviceId ?? `${device.label}-${index}`}
              title={deviceTitle(device)}
            >
              {isPulsing ? (
                <motion.span
                  animate={{ opacity: [0.5, 0, 0.5], scale: [1, 2.1, 1] }}
                  className={cn(
                    "absolute h-2 w-2 rounded-full",
                    STATE_DOT_CLASS[device.state],
                  )}
                  transition={{
                    duration: 2.4,
                    ease: "easeInOut",
                    repeat: Number.POSITIVE_INFINITY,
                    // Stagger so a busy mesh breathes instead of strobing.
                    delay: index * 0.35,
                  }}
                />
              ) : null}
              <span
                className={cn(
                  "relative h-2 w-2 rounded-full",
                  STATE_DOT_CLASS[device.state],
                  // Mark this computer with a ring so "which one is me" needs
                  // no legend.
                  device.isSelf &&
                    "ring-2 ring-background ring-offset-1 ring-offset-foreground/30",
                )}
                data-mesh-device-state={device.state}
                data-mesh-device-self={device.isSelf ? "true" : undefined}
              />
            </span>
          );
        })}
        {remainder > 0 ? (
          <span className="ml-0.5 text-3xs font-medium text-muted-foreground">
            +{remainder}
          </span>
        ) : null}
      </div>

      {showSoloHint ? (
        <span className="truncate text-3xs text-muted-foreground">
          Waiting for another device
        </span>
      ) : null}
    </div>
  );
}
