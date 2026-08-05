import * as React from "react";
import {
  Archive,
  ArchiveRestore,
  Loader2,
  MonitorOff,
  RefreshCw,
  Server,
} from "lucide-react";

import {
  useArchiveIdentityMutation,
  useOwnedAgentInventoryQuery,
  useUnarchiveIdentityMutation,
} from "./hooks";
import { ArchiveConfirmDialog } from "@/features/profile/ui/ArchiveConfirmDialog";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { truncatePubkey } from "@/shared/lib/pubkey";
import type {
  NipIaOwnerProof,
  OwnedAgentInstance,
} from "@/shared/api/tauriIdentityArchive";
import type { AgentPersona } from "@/shared/api/types";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Whether the NipIaOwnerProof allows archive/unarchive mutations. */
function canMutate(proof: NipIaOwnerProof): boolean {
  return proof.result === "verified";
}

// ── Instance row ──────────────────────────────────────────────────────────────

type InstanceRowProps = {
  instance: OwnedAgentInstance;
  archiveStateTrusted: boolean;
  /** Whether this instance's pubkey is managed locally (i.e. in the local agents list). */
  isManagedLocally: boolean;
  onOpenProfile: (pubkey: string) => void;
  onArchive: (pubkey: string) => void;
  onUnarchive: (pubkey: string) => void;
  archivePending: boolean;
  unarchivePending: boolean;
};

function InstanceRow({
  instance,
  archiveStateTrusted,
  isManagedLocally,
  onOpenProfile,
  onArchive,
  onUnarchive,
  archivePending,
  unarchivePending,
}: InstanceRowProps) {
  const label = instance.displayName ?? truncatePubkey(instance.pubkey);
  const isArchived = instance.archiveState.isArchived;
  const archiveTrustUnknown = !archiveStateTrusted;
  const canAct = canMutate(instance.nipIaOwnerProof) && !archiveTrustUnknown;
  const isPending = archivePending || unarchivePending;

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5"
      data-testid={`instance-row-${instance.pubkey}`}
    >
      <button
        aria-label={`Open profile for ${label}`}
        className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/50 bg-muted text-xs font-semibold text-muted-foreground transition-opacity hover:opacity-80"
        onClick={() => onOpenProfile(instance.pubkey)}
        type="button"
      >
        {instance.picture ? (
          <ProfileAvatar
            avatarUrl={instance.picture}
            className="h-8 w-8"
            iconClassName="h-4 w-4"
            label={label}
          />
        ) : (
          label.slice(0, 2).toUpperCase()
        )}
      </button>

      <div className="min-w-0 flex-1">
        <button
          className="block w-full cursor-pointer text-left hover:underline"
          onClick={() => onOpenProfile(instance.pubkey)}
          type="button"
        >
          <p className="truncate text-sm font-medium leading-5">{label}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {truncatePubkey(instance.pubkey)}
          </p>
        </button>
      </div>

      {/* Archive state badge — only when trusted */}
      {archiveTrustUnknown ? (
        <Badge className="shrink-0" variant="outline">
          Unknown
        </Badge>
      ) : isArchived === true ? (
        <Badge className="shrink-0 gap-1" variant="secondary">
          <Archive className="h-3 w-3" />
          Archived
        </Badge>
      ) : null}

      {/* "Not managed on this device" badge when no local agent exists */}
      {!isManagedLocally && !isArchived ? (
        <Badge className="shrink-0 gap-1" variant="outline">
          <MonitorOff className="h-3 w-3" />
          Relay only
        </Badge>
      ) : null}

      {/* Archive / Unarchive action — gated by ownership proof and trust */}
      {canAct && !archiveTrustUnknown ? (
        isArchived === true ? (
          <Button
            aria-label={`Unarchive ${label}`}
            className="shrink-0"
            data-testid={`unarchive-instance-${instance.pubkey}`}
            disabled={isPending}
            onClick={() => onUnarchive(instance.pubkey)}
            size="sm"
            variant="outline"
          >
            <ArchiveRestore className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            aria-label={`Archive ${label}`}
            className="shrink-0"
            data-testid={`archive-instance-${instance.pubkey}`}
            disabled={isPending}
            onClick={() => onArchive(instance.pubkey)}
            size="sm"
            variant="outline"
          >
            <Archive className="h-3.5 w-3.5" />
          </Button>
        )
      ) : null}
    </div>
  );
}

// ── Sheet ─────────────────────────────────────────────────────────────────────

type InstancesSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The persona whose instances to display. Filters by persona coordinate. */
  persona: AgentPersona | null;
  /**
   * Lowercase-hex pubkeys of local agents associated with the persona.
   * Instances whose pubkey is in this set are marked as locally managed.
   * Instances NOT in this set are marked "Relay only" (not on this device).
   */
  personaAgentPubkeys: ReadonlySet<string>;
  /** Open the exact-pubkey profile panel. */
  onOpenProfile: (pubkey: string) => void;
};

/**
 * Sheet showing the owner's relay inventory of agent instances (`kind:30177`)
 * scoped to the opener's persona.
 *
 * - Rows link to the exact-pubkey profile panel.
 * - Archive/Unarchive are offered only for `Verified` instances.
 * - Unknown archive trust shows a retry affordance; mutations are suppressed.
 * - Tri-state badge is scoped to this surface — `useIsIdentityArchived` elsewhere is unchanged.
 * - "Relay only" marker for instances without a matching local agent.
 */
export function InstancesSheet({
  open,
  onOpenChange,
  persona,
  personaAgentPubkeys,
  onOpenProfile,
}: InstancesSheetProps) {
  const inventoryQuery = useOwnedAgentInventoryQuery(open);
  const archiveMutation = useArchiveIdentityMutation();
  const unarchiveMutation = useUnarchiveIdentityMutation();

  // Confirm dialog state.
  const [confirmArchivePubkey, setConfirmArchivePubkey] = React.useState<
    string | null
  >(null);

  const allInstances = inventoryQuery.data?.instances ?? [];
  const archiveStateTrusted = inventoryQuery.data?.archiveStateTrusted ?? false;

  // Filter by persona's agent pubkeys when a persona is provided.
  // When the persona has known agent pubkeys, show only instances whose pubkey
  // appears in that set plus any relay-only instances (not managed on this device
  // but owned by the same user). When no persona is provided, show all instances.
  const instances = React.useMemo(() => {
    if (!persona || personaAgentPubkeys.size === 0) return allInstances;
    // Show instances for this persona's known pubkeys, plus any relay-only
    // instances that aren't matched to any local agent (orphaned relay instances).
    return allInstances.filter((i) =>
      personaAgentPubkeys.has(i.pubkey.toLowerCase()),
    );
  }, [allInstances, persona, personaAgentPubkeys]);

  function handleArchive(pubkey: string) {
    setConfirmArchivePubkey(pubkey);
  }

  function handleConfirmArchive() {
    if (!confirmArchivePubkey) return;
    archiveMutation.mutate({ targetPubkey: confirmArchivePubkey });
    setConfirmArchivePubkey(null);
  }

  function handleUnarchive(pubkey: string) {
    unarchiveMutation.mutate({ targetPubkey: pubkey });
  }

  const archivePending = archiveMutation.isPending;
  const unarchivePending = unarchiveMutation.isPending;

  return (
    <>
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
              <div className="space-y-2">
                <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {inventoryQuery.error instanceof Error
                    ? inventoryQuery.error.message
                    : "Failed to load instances"}
                </p>
                <Button
                  className="w-full"
                  onClick={() => inventoryQuery.refetch()}
                  size="sm"
                  variant="outline"
                >
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Retry
                </Button>
              </div>
            ) : !archiveStateTrusted && !inventoryQuery.isLoading ? (
              <div className="space-y-2">
                <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning-foreground">
                  Archive status could not be verified from the relay. Archive
                  and unarchive actions are disabled until the relay state is
                  confirmed.
                </p>
                <Button
                  className="w-full"
                  onClick={() => inventoryQuery.refetch()}
                  size="sm"
                  variant="outline"
                >
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  Retry
                </Button>
                {/* Still render instances for inspection, but with mutations suppressed */}
                <div className="mt-2 space-y-2">
                  {instances.map((instance) => (
                    <InstanceRow
                      archivePending={archivePending}
                      archiveStateTrusted={false}
                      instance={instance}
                      isManagedLocally={personaAgentPubkeys.has(
                        instance.pubkey.toLowerCase(),
                      )}
                      key={instance.pubkey}
                      unarchivePending={unarchivePending}
                      onArchive={handleArchive}
                      onOpenProfile={onOpenProfile}
                      onUnarchive={handleUnarchive}
                    />
                  ))}
                </div>
              </div>
            ) : instances.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No instances found on this relay.
              </p>
            ) : (
              instances.map((instance) => (
                <InstanceRow
                  archivePending={archivePending}
                  archiveStateTrusted={archiveStateTrusted}
                  instance={instance}
                  isManagedLocally={personaAgentPubkeys.has(
                    instance.pubkey.toLowerCase(),
                  )}
                  key={instance.pubkey}
                  unarchivePending={unarchivePending}
                  onArchive={handleArchive}
                  onOpenProfile={onOpenProfile}
                  onUnarchive={handleUnarchive}
                />
              ))
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Archive confirmation dialog — rendered outside Sheet to avoid z-index issues */}
      <ArchiveConfirmDialog
        isBot
        isPending={archivePending}
        open={confirmArchivePubkey !== null}
        onConfirm={handleConfirmArchive}
        onOpenChange={(o) => {
          if (!o) setConfirmArchivePubkey(null);
        }}
      />
    </>
  );
}
