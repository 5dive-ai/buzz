import * as React from "react";
import { Cpu, Loader2, TriangleAlert, Download, Share2 } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { Switch } from "@/shared/ui/switch";
import { cn } from "@/shared/lib/cn";
import { meshStartNode, meshStopNode } from "@/shared/api/tauriMesh";
import type { MeshModelCatalog } from "@/shared/api/tauriMesh";
import { meshModelCatalog } from "@/shared/api/tauriMesh";

import { useMeshNodeStatus } from "../hooks/useMeshNodeStatus";
import { useMeshServingUsage } from "../hooks/useMeshServingUsage";
import { useMeshSnapshot } from "../hooks/useMeshSnapshot";
import { deriveMeshShareToggle } from "../shareToggleState";
import { deriveMeshCardModel, type MeshCardTone } from "../meshCardModel";
import { MeshTopologyStrip } from "./MeshTopologyStrip";

/**
 * Sidebar shared-compute card.
 *
 * Answers three questions at a glance, which is the whole reason it exists:
 *   - Am I sharing this computer?      → switch on, "Sharing this computer"
 *   - Am I using someone else's?       → switch off, "Using shared compute"
 *   - What does the community have?    → "3 devices sharing · 42 GB"
 *
 * Deliberately NOT a model picker. Turning it on shares the hardware-appropriate
 * curated recommendation (`catalog.recommended`); choosing a specific model,
 * capping memory, and future split controls stay in Settings → Compute.
 *
 * Own file rather than living in `AppSidebar.tsx`, which sits at 999/1000 lines
 * against `desktop/scripts/check-file-sizes.mjs`.
 */

const TONE_ICON: Record<MeshCardTone, React.ReactNode> = {
  idle: <Share2 aria-hidden className="h-4 w-4" />,
  sharing: <Cpu aria-hidden className="h-4 w-4" />,
  consuming: <Download aria-hidden className="h-4 w-4" />,
  pending: <Loader2 aria-hidden className="h-4 w-4 animate-spin" />,
  failed: <TriangleAlert aria-hidden className="h-4 w-4" />,
};

// Accent per role. Sharing (giving) and consuming (taking) must be
// distinguishable at a glance, not just by wording.
const TONE_ICON_CLASS: Record<MeshCardTone, string> = {
  idle: "text-muted-foreground",
  sharing: "text-emerald-600 dark:text-emerald-400",
  consuming: "text-sky-600 dark:text-sky-400",
  pending: "text-muted-foreground",
  failed: "text-destructive",
};

const TONE_RING_CLASS: Record<MeshCardTone, string> = {
  idle: "border-border/70 bg-background/70 dark:bg-background/50",
  sharing:
    "border-emerald-500/30 bg-emerald-500/[0.06] dark:border-emerald-400/25 dark:bg-emerald-400/[0.07]",
  consuming:
    "border-sky-500/30 bg-sky-500/[0.06] dark:border-sky-400/25 dark:bg-sky-400/[0.07]",
  pending: "border-border/70 bg-background/70 dark:bg-background/50",
  failed: "border-destructive/40 bg-destructive/[0.06]",
};

export function SidebarMeshComputeCard({
  className,
  onOpenComputeSettings,
  onOpenDetail,
}: {
  className?: string;
  onOpenComputeSettings?: () => void;
  /** Open the full mesh view (topology, capacity, per-device detail). */
  onOpenDetail?: () => void;
}) {
  const shouldReduceMotion = useReducedMotion();
  const { status, refresh: refreshStatus } = useMeshNodeStatus();
  const [catalog, setCatalog] = React.useState<MeshModelCatalog | null>(null);
  const [pendingAction, setPendingAction] = React.useState<
    "start" | "stop" | null
  >(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  // Bumping this re-queries the community snapshot right after a local
  // transition, instead of waiting out the 30s poll.
  const [snapshotNonce, setSnapshotNonce] = React.useState(0);

  const { snapshot, error: snapshotError } = useMeshSnapshot({
    refreshKey: snapshotNonce,
  });

  const toggle = deriveMeshShareToggle(status);
  // Poll whenever a runtime slot is occupied, not just when sharing: a
  // consuming node also has inflight work worth showing.
  const usage = useMeshServingUsage(toggle.isSharing || toggle.isConsuming);
  // `inflight` is the only honest "working" signal: mesh-llm's routing metrics
  // are all OUTBOUND (incremented by this node's own ingress), so a remote/
  // endpoint attempt means this machine is CONSUMING, not being consumed.
  // Reading them as "someone is using my compute" is exactly backwards.
  const busyNow = (usage?.inflight ?? 0) > 0;
  const requestsRouted = usage?.requestsServed ?? 0;

  // One-shot catalog fetch: the card needs the hardware-appropriate
  // recommendation so the switch can start sharing without a model picker.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const value = await meshModelCatalog();
        if (!cancelled) setCatalog(value);
      } catch {
        // Non-fatal: the switch stays disabled and Settings still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-check the community view whenever the local lifecycle settles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the local lifecycle fields are intentional triggers, not values read in the body — a settled start/stop should refresh the community view immediately
  React.useEffect(() => {
    setSnapshotNonce((current) => current + 1);
  }, [status?.state, status?.mode]);

  const recommended = catalog?.recommended ?? null;
  const model = deriveMeshCardModel({
    snapshot,
    status,
    toggle,
    pendingAction,
    canShare: Boolean(recommended),
    busyNow,
    requestsRouted,
  });

  async function handleToggle(next: boolean) {
    // Never let this switch tear down a consume session. The switch is already
    // disabled while consuming, but status can be stale between polls.
    if (!next && !toggle.isSharing) {
      return;
    }
    setActionError(null);
    setPendingAction(next ? "start" : "stop");
    try {
      if (next) {
        if (!recommended) {
          throw new Error("No suitable model for this computer yet");
        }
        await meshStartNode({ mode: "serve", modelId: recommended });
      } else {
        await meshStopNode();
      }
      refreshStatus();
      setSnapshotNonce((current) => current + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingAction(null);
    }
  }

  // A transport failure is worth showing; an empty mesh is not an error and is
  // already expressed by the headline ("No mesh capacity yet").
  const errorText = actionError ?? snapshotError;

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={cn("w-full group-data-[collapsible=icon]:hidden", className)}
      data-testid="sidebar-mesh-compute-card"
      initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
      transition={
        shouldReduceMotion
          ? { duration: 0.08 }
          : { duration: 0.24, ease: [0.22, 1, 0.36, 1] }
      }
    >
      <div
        className={cn(
          "rounded-xl border px-3 py-2.5 shadow-xs transition-colors duration-200",
          TONE_RING_CLASS[model.tone],
        )}
        data-mesh-tone={model.tone}
      >
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center",
              TONE_ICON_CLASS[model.tone],
            )}
          >
            {TONE_ICON[model.tone]}
          </span>

          {/*
            Clickable region is the text block, not the whole card: wrapping the
            Switch in a button would nest interactive elements.
          */}
          <button
            className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
            data-testid="mesh-card-open-detail"
            disabled={!onOpenDetail}
            onClick={onOpenDetail}
            type="button"
          >
            <p
              className="truncate text-sm font-semibold leading-tight"
              data-testid="mesh-card-headline"
            >
              {model.headline}
            </p>
            {model.detail ? (
              <p
                className="mt-0.5 line-clamp-2 text-2xs leading-snug text-muted-foreground"
                data-testid="mesh-card-detail"
              >
                {model.detail}
              </p>
            ) : null}
          </button>

          <Switch
            aria-label={model.switchLabel}
            checked={model.switchOn}
            className="mt-0.5 shrink-0"
            data-testid="mesh-card-share-toggle"
            disabled={model.switchDisabled}
            onCheckedChange={handleToggle}
          />
        </div>

        <MeshTopologyStrip
          devices={model.devices}
          showSoloHint={model.showSoloHint}
        />

        {errorText ? (
          <p
            className="mt-2 line-clamp-2 text-2xs leading-snug text-destructive"
            data-testid="mesh-card-error"
          >
            {errorText}
          </p>
        ) : null}

        {onOpenComputeSettings ? (
          <button
            className="mt-2 text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="mesh-card-advanced-link"
            onClick={onOpenComputeSettings}
            type="button"
          >
            Compute settings
          </button>
        ) : null}
      </div>
    </motion.div>
  );
}
