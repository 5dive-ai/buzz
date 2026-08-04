import { motion, useReducedMotion } from "motion/react";

import type { MeshPeer } from "@/shared/api/tauriMesh";
import { cn } from "@/shared/lib/cn";
import { formatCapacityGb, shortModelLabel } from "../meshCardModel";

/**
 * Radial mesh field: this computer at the centre, live peers around it.
 *
 * ## One source of truth
 *
 * Every node drawn here comes from the runtime's own gossip view, so a node is
 * on screen because we are *connected to it right now*. This deliberately does
 * not overlay relay status notes (valid for 120s, so they outlive the node that
 * wrote them) or community roster members who never started a node. Mixing
 * those in meant refereeing disagreements between sources and produced a graph
 * showing devices gossip already knew were gone.
 *
 * ## What the geometry claims
 *
 * A spoke means **"connected to you"** — and that much is true, because this is
 * our own adjacency. Nothing is animated *along* a spoke: the activity counters
 * are node-local rather than edge-attributed, so a packet gliding down a chosen
 * link would be invented.
 *
 * The centre pulses on this node's own inflight work, which we hold directly.
 * Peers pulse only on the state they publish about themselves, never on
 * inferred traffic.
 */

const CENTER = 60;
const RADIUS = 42;

const STATE_FILL: Record<MeshPeer["state"], string> = {
  serving: "fill-emerald-500 dark:fill-emerald-400",
  loading: "fill-amber-500 dark:fill-amber-400",
  standby: "fill-muted-foreground/40",
  consuming: "fill-sky-500 dark:fill-sky-400",
};

function pointOnRing(index: number, count: number): { x: number; y: number } {
  // Start at the top and go clockwise; -90° puts the first node at 12 o'clock.
  const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
  return {
    x: CENTER + Math.cos(angle) * RADIUS,
    y: CENTER + Math.sin(angle) * RADIUS,
  };
}

function peerTitle(peer: MeshPeer): string {
  const parts = [peer.label];
  if (peer.capacityGb !== null) {
    parts.push(formatCapacityGb(peer.capacityGb));
  } else if (peer.state === "consuming") {
    parts.push("using shared compute");
  }
  if (peer.models.length > 0) {
    parts.push(shortModelLabel(peer.models[0]));
  }
  if (peer.rttMs !== null) {
    parts.push(`${peer.rttMs}ms`);
  }
  return parts.join(" · ");
}

export function MeshTopologyRadial({
  peers,
  selfCapacityGb,
  isSharing,
  busyNow,
}: {
  peers: MeshPeer[];
  selfCapacityGb: number | null;
  /** Whether this machine is contributing, which sets the centre's colour. */
  isSharing: boolean;
  /** This node has inference in flight — the only honest live signal. */
  busyNow: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();

  // Resolve geometry and keys up front so render maps over identities rather
  // than array positions.
  const nodes = peers.map((peer, index) => ({
    peer,
    pulseDelay: index * 0.35,
    ...pointOnRing(index, peers.length),
  }));

  const selfTitle = [
    "This computer",
    isSharing && selfCapacityGb !== null
      ? formatCapacityGb(selfCapacityGb)
      : null,
    isSharing ? null : "not sharing",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col items-center">
      <svg
        aria-label="Mesh peers connected to this computer"
        className="h-[120px] w-[120px]"
        role="img"
        viewBox="0 0 120 120"
      >
        {/* Adjacency, not traffic — see the file comment. */}
        <g>
          {nodes.map((node) => (
            <line
              className="stroke-border"
              key={`spoke-${node.peer.id}`}
              strokeWidth={0.75}
              x1={CENTER}
              x2={node.x}
              y1={CENTER}
              y2={node.y}
            />
          ))}
        </g>

        {nodes.map(({ peer, pulseDelay, x, y }) => {
          const isPulsing = peer.state === "serving" && !shouldReduceMotion;
          return (
            <g key={peer.id}>
              <title>{peerTitle(peer)}</title>
              {isPulsing ? (
                <motion.circle
                  animate={{ opacity: [0.45, 0, 0.45], scale: [1, 2.2, 1] }}
                  className={STATE_FILL[peer.state]}
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
                className={STATE_FILL[peer.state]}
                cx={x}
                cy={y}
                data-mesh-peer-state={peer.state}
                r={4}
              />
            </g>
          );
        })}

        {/* This computer. The only node whose activity we can honestly animate,
            because inflight is our own counter. */}
        <g>
          <title>{selfTitle}</title>
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
              isSharing
                ? "fill-emerald-500 dark:fill-emerald-400"
                : "fill-sky-500 dark:fill-sky-400",
            )}
            cx={CENTER}
            cy={CENTER}
            data-mesh-self="true"
            r={6}
            strokeWidth={1.5}
          />
        </g>
      </svg>
    </div>
  );
}
