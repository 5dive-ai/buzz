import { Cpu, LoaderCircle } from "lucide-react";

import { Switch } from "@/shared/ui/switch";
import { cn } from "@/shared/lib/cn";
import type { useMeshComputeState } from "../hooks/useMeshComputeState";

export function MeshComputeShareBanner({
  communityName,
  mesh,
}: {
  communityName: string;
  mesh: ReturnType<typeof useMeshComputeState>;
}) {
  const {
    error,
    modelToShare,
    pendingAction,
    shareSwitchChecked,
    status,
    toggle,
    setSharing,
  } = mesh;
  const busy = pendingAction !== null;
  const statusCopy = shareStatusCopy({
    communityName,
    modelToShare,
    pendingAction,
    statusModel: status?.modelName ?? status?.modelId ?? null,
    isConsuming: toggle.isConsuming,
    isSharing: toggle.isSharing,
  });

  return (
    <section
      className="rounded-2xl border border-border/70 bg-muted/15 px-4 py-3.5"
      data-testid="compute-share-banner"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background",
            toggle.isSharing && "border-foreground/30",
          )}
        >
          {busy ? (
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Cpu className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <label
            className="text-sm font-semibold"
            htmlFor="compute-share-banner-toggle"
          >
            Share this machine
          </label>
          <p
            className="mt-0.5 truncate text-xs text-muted-foreground"
            data-testid="compute-share-banner-status"
            title={statusCopy}
          >
            {statusCopy}
          </p>
        </div>
        <Switch
          checked={shareSwitchChecked}
          data-testid="compute-share-banner-toggle"
          disabled={busy || (!toggle.isSharing && !modelToShare)}
          id="compute-share-banner-toggle"
          onCheckedChange={setSharing}
        />
      </div>
      {error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function shareStatusCopy({
  communityName,
  isConsuming,
  isSharing,
  modelToShare,
  pendingAction,
  statusModel,
}: {
  communityName: string;
  isConsuming: boolean;
  isSharing: boolean;
  modelToShare: string | null;
  pendingAction: "start" | "stop" | null;
  statusModel: string | null;
}): string {
  if (pendingAction === "start") {
    return `Preparing ${statusModel ?? modelToShare ?? "a model"} for ${communityName}…`;
  }
  if (pendingAction === "stop") return "Stopping shared compute…";
  if (isSharing) {
    return `${statusModel ?? modelToShare ?? "A model"} is available to ${communityName}`;
  }
  if (isConsuming) {
    return "Using another member’s compute; turn this on to contribute instead";
  }
  if (modelToShare) {
    return `${modelToShare} is ready to contribute to ${communityName}`;
  }
  return "Choose a model in Settings before sharing";
}
