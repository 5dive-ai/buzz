import { Archive, Loader2, Server } from "lucide-react";

import { useOwnedAgentInventoryQuery } from "./hooks";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";
import type { OwnedAgentInstance } from "@/shared/api/tauriIdentityArchive";

// Maximum live (non-archived) instances allowed per NIP-IA §Start-Control.
// A third instance must not be minted — this guard is a UI affordance only;
// the relay enforces authority on every request.
const MAX_LIVE_INSTANCES = 2;

type InstanceRowProps = {
  instance: OwnedAgentInstance;
};

function InstanceRow({ instance }: InstanceRowProps) {
  const label = instance.displayName ?? truncatePubkey(instance.pubkey);
  const isArchived = instance.archiveState.isArchived;

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5"
      data-testid={`instance-row-${instance.pubkey}`}
    >
      {instance.picture ? (
        <ProfileAvatar
          avatarUrl={instance.picture}
          className="h-8 w-8 shrink-0 border border-border/50"
          iconClassName="h-4 w-4"
          label={label}
        />
      ) : (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground border border-border/50">
          {label.slice(0, 2).toUpperCase()}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-5">{label}</p>
        <p className="truncate text-xs text-muted-foreground font-mono">
          {truncatePubkey(instance.pubkey)}
        </p>
      </div>
      {isArchived === true ? (
        <Badge className="shrink-0 gap-1" variant="secondary">
          <Archive className="h-3 w-3" />
          Archived
        </Badge>
      ) : isArchived === null ? // Snapshot not loaded — defer tri-state badge
      null : null}
    </div>
  );
}

type InstancesSheetProps = {
  /** Whether the sheet is open. */
  open: boolean;
  /** Called when the sheet open state changes. */
  onOpenChange: (open: boolean) => void;
  /**
   * Called when the user requests to start a new instance. The caller is
   * responsible for the actual start flow; this sheet only gates whether the
   * action is offered.
   *
   * @supplementary Playwright assertion target: "start-instance-button".
   */
  onStartNewInstance?: () => void;
};

/**
 * Sheet showing the owner's relay inventory of agent instances (`kind:30177`).
 * Tri-state archive badges are scoped to this surface — `useIsIdentityArchived`
 * callers elsewhere are unchanged.
 *
 * Start-control safeguard: the "Start new instance" button is disabled when
 * two or more non-archived instances already exist, preventing a 3rd live
 * instance from being minted.
 */
export function InstancesSheet({
  open,
  onOpenChange,
  onStartNewInstance,
}: InstancesSheetProps) {
  // Fetch only when the sheet is open to avoid background polling.
  const inventoryQuery = useOwnedAgentInventoryQuery(open);

  const instances = inventoryQuery.data?.instances ?? [];
  const liveCount = instances.filter(
    (i) => i.archiveState.isArchived !== true,
  ).length;
  // Start-control safeguard: suppress the button when already at the limit.
  // `archiveStateTrusted === false` means the snapshot didn't load — we fail
  // open (allow start) since a false-negative is safer than a false-positive
  // block, and the relay enforces the authority check server-side anyway.
  const archiveStateTrusted = inventoryQuery.data?.archiveStateTrusted ?? false;
  const atLimit = archiveStateTrusted && liveCount >= MAX_LIVE_INSTANCES;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            Instances
            {instances.length > 0 ? (
              <Badge className="ml-1" variant="secondary">
                {instances.length}
              </Badge>
            ) : null}
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-2 overflow-y-auto">
          {inventoryQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : inventoryQuery.isError ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {inventoryQuery.error instanceof Error
                ? inventoryQuery.error.message
                : "Failed to load instances"}
            </p>
          ) : instances.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No instances found on this relay.
            </p>
          ) : (
            instances.map((instance) => (
              <InstanceRow key={instance.pubkey} instance={instance} />
            ))
          )}
        </div>

        {onStartNewInstance ? (
          <div className="mt-4">
            <Button
              className="w-full"
              data-testid="start-instance-button"
              disabled={atLimit || inventoryQuery.isLoading}
              onClick={onStartNewInstance}
              variant="outline"
            >
              {atLimit
                ? `Limit reached (${MAX_LIVE_INSTANCES} active)`
                : "Start new instance"}
            </Button>
            {atLimit ? (
              <p className="mt-2 text-center text-xs text-muted-foreground">
                Archive an existing instance to start a new one.
              </p>
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
