import type {
  MeshLiveView,
  MeshServingUsage,
  MeshSnapshot,
} from "@/shared/api/tauriMesh";
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
 * Every figure here is one this machine can actually vouch for. Peers come from
 * live gossip, so a node shown is a node we are connected to — not a relay note
 * that may have outlived its writer. Inbound work has no counter, so it is
 * inferred by elimination and only named when that inference holds. See
 * `meshDetailModel.ts` and `meshActivity.ts`.
 */
export function MeshDetailPopover({
  children,
  view,
  snapshot,
  usage,
  isSharing,
  inboundWork,
  onOpenComputeSettings,
}: {
  children: React.ReactNode;
  /** Live gossip view — the source for the topology. */
  view: MeshLiveView | null;
  /** Relay snapshot, used only when no local runtime exists. */
  snapshot: MeshSnapshot | null;
  usage: MeshServingUsage | null;
  isSharing: boolean;
  inboundWork: boolean;
  onOpenComputeSettings?: () => void;
}) {
  const model = deriveMeshDetailModel({
    view,
    snapshot,
    usage,
    isSharing,
    inboundWork,
  });

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

          {model.connected ? (
            <MeshTopologyRadial
              busyNow={model.busyNow}
              isSharing={isSharing}
              peers={view?.peers ?? []}
              selfCapacityGb={view?.selfCapacityGb ?? null}
            />
          ) : null}

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

          {model.connected ? null : (
            <p className="border-border/60 border-t pt-2 text-2xs leading-snug text-muted-foreground">
              Turn on sharing to see who's on the mesh.
            </p>
          )}

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
