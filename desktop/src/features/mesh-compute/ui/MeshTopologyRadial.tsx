import { motion, useReducedMotion } from "motion/react";

import type { MeshSnapshotDevice } from "@/shared/api/tauriMesh";
import { cn } from "@/shared/lib/cn";
import { formatCapacityGb, shortModelLabel } from "../meshCardModel";

/**
 * Radial mesh field for the detail popover: this computer at the centre,
 * participating devices around it, unshared members as ghosts.
 *
 * ## What the geometry does and does not claim
 *
 * The spokes mean **"in the same mesh as you"** — nothing more. The relay
 * snapshot carries no adjacency: it tells us who is participating and what each
 * advertises, but not who is connected to whom, and the activity counters are
 * node-local rather than edge-attributed. So a spoke is a membership line, and
 * **nothing is ever animated along one** — a packet gliding down a chosen edge
 * would be invented data.
 *
 * What *is* animated is the centre: this node's own inflight work. That is a
 * fact we hold directly. Peers pulse only on their own published `serving`
 * state, never on inferred traffic.
 *
 * Ghosts are members with no published status note. They are drawn dashed, with
 * no capacity and no label, because a member who never starts a node discloses
 * no hardware — by design. Their contribution to the picture is a count, and
 * they exist here to make joining feel like joining something, not to imply
 * capacity nobody offered.
 */

const CENTER = 60;
const RADIUS = 42;
const GHOST_RADIUS = 54;
/** Beyond this, ghosts collapse into a count so the ring stays legible. */
const MAX_GHOST_DOTS = 10;

const STATE_FILL: Record<MeshSnapshotDevice["state"], string> = {
  serving: "fill-emerald-500 dark:fill-emerald-400",
  loading: "fill-amber-500 dark:fill-amber-400",
  standby: "fill-muted-foreground/40",
  consuming: "fill-sky-500 dark:fill-sky-400",
};

function pointOnRing(
  index: number,
  count: number,
  radius: number,
): { x: number; y: number } {
  // Start at the top and go clockwise; -90° puts the first node at 12 o'clock.
  const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
  return {
    x: CENTER + Math.cos(angle) * radius,
    y: CENTER + Math.sin(angle) * radius,
  };
}

function deviceTitle(device: MeshSnapshotDevice): string {
  const parts = [device.isSelf ? `${device.label} (you)` : device.label];
  if (device.capacityGb !== null) {
    parts.push(formatCapacityGb(device.capacityGb));
  }
  if (device.models.length > 0) {
    parts.push(shortModelLabel(device.models[0]));
  }
  return parts.join(" · ");
}

export function MeshTopologyRadial({
  devices,
  ghostCount,
  busyNow,
}: {
  devices: MeshSnapshotDevice[];
  ghostCount: number;
  /** This node has inference in flight — the only honest live signal. */
  busyNow: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();

  const self = devices.find((device) => device.isSelf);
  const others = devices.filter((device) => !device.isSelf);
  const ghostDots = Math.min(ghostCount, MAX_GHOST_DOTS);
  const ghostOverflow = ghostCount - ghostDots;

  // Ghosts sit on an outer ring, offset half a step so they interleave with
  // real devices rather than hiding behind them.
  const ghostOffset = others.length > 0 ? 0.5 : 0;

  // Resolve geometry and keys up front. Peers key on device identity; ghosts
  // have none to key on (a member with no status note publishes nothing), so
  // their ring slot is the key, named explicitly rather than taken from a
  // render-time array index.
  const peerNodes = others.map((device, index) => ({
    device,
    key: device.deviceId ?? `${device.label}-${index}`,
    pulseDelay: index * 0.35,
    ...pointOnRing(index, others.length, RADIUS),
  }));

  const ghostNodes = Array.from({ length: ghostDots }, (_, slot) => ({
    key: `ghost-slot-${slot}`,
    ...pointOnRing(
      slot + ghostOffset,
      Math.max(ghostDots, others.length),
      GHOST_RADIUS,
    ),
  }));

  return (
    <div className="flex flex-col items-center">
      <svg
        aria-label="Mesh participants"
        className="h-[120px] w-[120px]"
        role="img"
        viewBox="0 0 120 120"
      >
        {/* Membership spokes. Not traffic — see the file comment. */}
        <g>
          {peerNodes.map((node) => (
            <line
              className="stroke-border"
              key={`spoke-${node.key}`}
              strokeWidth={0.75}
              x1={CENTER}
              x2={node.x}
              y1={CENTER}
              y2={node.y}
            />
          ))}
          {ghostNodes.map((node) => (
            <line
              className="stroke-border/40"
              key={`spoke-${node.key}`}
              strokeDasharray="2 3"
              strokeWidth={0.5}
              x1={CENTER}
              x2={node.x}
              y1={CENTER}
              y2={node.y}
            />
          ))}
        </g>

        {/* Ghost members: dashed, unlabelled, no capacity claimed. */}
        {ghostNodes.map((node) => (
          <circle
            className="fill-transparent stroke-muted-foreground/30"
            cx={node.x}
            cy={node.y}
            data-mesh-ghost="true"
            key={node.key}
            r={2.5}
            strokeDasharray="1.5 1.5"
            strokeWidth={0.75}
          />
        ))}

        {/* Participating peers. Pulse reflects their own published state. */}
        {peerNodes.map(({ device, key, pulseDelay, x, y }) => {
          const isPulsing = device.state === "serving" && !shouldReduceMotion;
          return (
            <g key={`node-${key}`}>
              <title>{deviceTitle(device)}</title>
              {isPulsing ? (
                <motion.circle
                  animate={{ opacity: [0.45, 0, 0.45], scale: [1, 2.2, 1] }}
                  className={STATE_FILL[device.state]}
                  cx={x}
                  cy={y}
                  r={4}
                  style={{ transformOrigin: `${x}px ${y}px` }}
                  transition={{
                    delay: pulseDelay,
                    duration: 2.4,
                    ease: "easeInOut",
                    repeat: Number.POSITIVE_INFINITY,
                  }}
                />
              ) : null}
              <circle
                className={STATE_FILL[device.state]}
                cx={x}
                cy={y}
                data-mesh-device-state={device.state}
                r={4}
              />
            </g>
          );
        })}

        {/* This computer, at the centre. The only node whose activity we can
            honestly animate, because inflight is our own counter. */}
        <g>
          <title>
            {self ? deviceTitle(self) : "This computer (not participating)"}
          </title>
          {busyNow && !shouldReduceMotion ? (
            <motion.circle
              animate={{ opacity: [0.5, 0, 0.5], scale: [1, 2.4, 1] }}
              className="fill-emerald-500 dark:fill-emerald-400"
              cx={CENTER}
              cy={CENTER}
              r={6}
              style={{ transformOrigin: `${CENTER}px ${CENTER}px` }}
              transition={{
                duration: 1.4,
                ease: "easeInOut",
                repeat: Number.POSITIVE_INFINITY,
              }}
            />
          ) : null}
          <circle
            className={cn(
              "stroke-background",
              self ? STATE_FILL[self.state] : "fill-muted-foreground/30",
            )}
            cx={CENTER}
            cy={CENTER}
            data-mesh-self="true"
            data-mesh-self-state={self?.state ?? "absent"}
            r={6}
            strokeWidth={1.5}
          />
        </g>
      </svg>

      {ghostOverflow > 0 ? (
        <span className="text-3xs text-muted-foreground">
          +{ghostOverflow} more not sharing
        </span>
      ) : null}
    </div>
  );
}
