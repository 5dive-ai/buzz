import type { MeshServingUsage, MeshSnapshot } from "@/shared/api/tauriMesh";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { POPOVER_SHADOW_STYLE } from "@/shared/ui/popoverSurface";
import { deriveMeshDetailModel } from "../meshDetailModel";
import { MeshTopologyRadial } from "./MeshTopologyRadial";

/**
 * The mesh detail popover, anchored to the sidebar card.
 *
 * Anchored rather than a centred dialog: this is a glance, not a task. It sits
 * beside the thing it explains, and dismisses on outside click.
 *
 * Every figure here is one this machine can actually vouch for. In particular
 * there is no "N requests served for others" line, because mesh-llm exposes no
 * inbound counter — only a soft hint when the pool is live. See
 * `meshDetailModel.ts` for the full constraint.
 */
export function MeshDetailPopover({
  children,
  snapshot,
  usage,
  isSharing,
  onOpenComputeSettings,
}: {
  children: React.ReactNode;
  snapshot: MeshSnapshot | null;
  usage: MeshServingUsage | null;
  isSharing: boolean;
  onOpenComputeSettings?: () => void;
}) {
  const model = deriveMeshDetailModel({ snapshot, usage, isSharing });

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64"
        data-testid="mesh-detail-popover"
        side="top"
        style={POPOVER_SHADOW_STYLE}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <p className="text-sm font-semibold leading-tight">
              {model.capacityLabel ?? "Mesh capacity"}
            </p>
            <p
              className="text-2xs text-muted-foreground"
              data-testid="mesh-detail-participation"
            >
              {model.participationLabel}
            </p>
          </div>

          <MeshTopologyRadial
            busyNow={model.busyNow}
            devices={snapshot?.devices ?? []}
            ghostCount={model.ghostCount}
          />

          <div className="flex flex-col gap-1">
            {model.activityLabel ? (
              <div className="flex items-center gap-1.5">
                {model.busyNow ? (
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute h-1.5 w-1.5 animate-ping rounded-full bg-emerald-500 motion-reduce:animate-none dark:bg-emerald-400" />
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" />
                  </span>
                ) : null}
                <p
                  className="text-2xs text-muted-foreground"
                  data-testid="mesh-detail-activity"
                >
                  {model.activityLabel}
                </p>
              </div>
            ) : null}

            {model.originLabel ? (
              <p
                className="text-2xs text-muted-foreground"
                data-testid="mesh-detail-origin"
              >
                {model.originLabel}
              </p>
            ) : null}

            {model.modelCount > 0 ? (
              <p className="text-2xs text-muted-foreground">
                {model.modelCount === 1
                  ? "1 model ready"
                  : `${model.modelCount} models ready`}
              </p>
            ) : null}
          </div>

          {model.ghostCount > 0 ? (
            <p className="border-border/60 border-t pt-2 text-2xs leading-snug text-muted-foreground">
              {model.ghostCount === 1
                ? "1 member isn't sharing yet."
                : `${model.ghostCount} members aren't sharing yet.`}
            </p>
          ) : null}

          {onOpenComputeSettings ? (
            <button
              className="-mb-1 self-start text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onOpenComputeSettings}
              type="button"
            >
              Compute settings
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
