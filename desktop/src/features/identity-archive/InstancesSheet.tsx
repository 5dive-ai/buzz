import * as React from "react";
import {
  Archive,
  ArchiveRestore,
  Loader2,
  MonitorOff,
  RefreshCw,
  Server,
  Wifi,
  WifiOff,
} from "lucide-react";

import {
  useArchiveIdentityMutation,
  useOwnedAgentInventoryQuery,
  useUnarchiveIdentityMutation,
} from "./hooks";
import { ArchiveConfirmDialog } from "@/features/profile/ui/ArchiveConfirmDialog";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { usePresenceQuery } from "@/features/presence/hooks";
import { truncatePubkey } from "@/shared/lib/pubkey";
import type {
  NipIaOwnerProof,
  OwnedAgentInstance,
  OwnedAgentInventorySnapshot,
} from "@/shared/api/tauriIdentityArchive";
import type { AgentPersona, PresenceLookup } from "@/shared/api/types";
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
  /** Presence lookup for all instances in the sheet. */
  presenceLookup: PresenceLookup;
  onOpenProfile: (pubkey: string) => void;
  onArchive: (pubkey: string) => void;
  onUnarchive: (pubkey: string) => void;
  archivePending: boolean;
  unarchivePending: boolean;
};

function InstanceRow({
  instance,
  archiveStateTrusted,
  presenceLookup,
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

  // "Not managed on this device" keys on local === null, NOT personaId === null.
  // A stale relay-only duplicate WITH a valid personaId receives the badge.
  // The badge stays visible even when archived (no isArchived gate).
  const isRelayOnly = instance.local === null;

  // Presence: "online" or "away" → online, "offline" or absent → offline.
  const presence = presenceLookup[instance.pubkey.toLowerCase()];
  const isOnline = presence === "online" || presence === "away";

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

      {/* Presence indicator — shown regardless of archive state */}
      <Badge
        className="shrink-0 gap-1"
        data-testid={`instance-presence-${instance.pubkey}`}
        variant="outline"
      >
        {isOnline ? (
          <>
            <Wifi className="h-3 w-3 text-green-500" />
            Online
          </>
        ) : (
          <>
            <WifiOff className="h-3 w-3 text-muted-foreground" />
            Offline
          </>
        )}
      </Badge>

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

      {/* "Not managed on this device" badge for relay-only instances.
          Keyed on local === null — stays visible even when archived. */}
      {isRelayOnly ? (
        <Badge
          className="shrink-0 gap-1"
          data-testid={`instance-relay-only-${instance.pubkey}`}
          variant="outline"
        >
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
   * The complete grouped inventory snapshot from the parent. The Sheet uses
   * `inventory.byPersonaId[persona.id]` as the authoritative instance list for
   * this persona — no secondary pubkey-set reconstruction needed.
   * `null` when the inventory is not yet loaded.
   */
  inventory: OwnedAgentInventorySnapshot | undefined;
  /** Open the exact-pubkey profile panel. */
  onOpenProfile: (pubkey: string) => void;
};

/**
 * Sheet showing the owner's relay inventory of agent instances (`kind:30177`)
 * scoped to the opener's persona via `inventory.byPersonaId[persona.id]`.
 *
 * - Rows show presence (online/offline) as a separate signal from local/relay status.
 * - "Relay only" badge keys on `local === null`, stays visible even when archived.
 * - Archive/Unarchive are offered only for `Verified` instances.
 * - Unknown archive trust shows a retry affordance; mutations are suppressed.
 * - Unknown-persona instances from the relay inventory render in a separate section.
 * - Tri-state badge is scoped to this surface — `useIsIdentityArchived` elsewhere is unchanged.
 */
export function InstancesSheet({
  open,
  onOpenChange,
  persona,
  inventory,
  onOpenProfile,
}: InstancesSheetProps) {
  const inventoryQuery = useOwnedAgentInventoryQuery(open);
  const archiveMutation = useArchiveIdentityMutation();
  const unarchiveMutation = useUnarchiveIdentityMutation();

  // Confirm dialog state.
  const [confirmArchivePubkey, setConfirmArchivePubkey] = React.useState<
    string | null
  >(null);

  // Use the parent-supplied snapshot when available; fall back to the Sheet's
  // own query result. This avoids a redundant fetch while keeping the Sheet
  // self-contained when opened standalone (e.g. from a future entry point).
  const effectiveData = inventory ?? inventoryQuery.data;
  const archiveStateTrusted = effectiveData?.archiveStateTrusted ?? false;

  // Instances for THIS persona only — from byPersonaId[persona.id].
  // The parent groups by persona_id parsed from kind:30177 content, so this
  // is the authoritative view: it includes relay-only instances (no local
  // agent) and excludes instances from other personas.
  const instances = React.useMemo(() => {
    if (!persona || !effectiveData) return [];
    return effectiveData.byPersonaId[persona.id] ?? [];
  }, [effectiveData, persona]);

  // Unknown-persona instances from the relay inventory (not from local ManagedAgent[]).
  const unknownInstances = React.useMemo(() => {
    if (!effectiveData) return [];
    return effectiveData.unknown ?? [];
  }, [effectiveData]);

  // Presence query over the merged pubkey set (persona instances + unknown).
  const allPubkeys = React.useMemo(
    () => [
      ...instances.map((i) => i.pubkey),
      ...unknownInstances.map((i) => i.pubkey),
    ],
    [instances, unknownInstances],
  );
  const presenceQuery = usePresenceQuery(allPubkeys, { enabled: open });
  const presenceLookup: PresenceLookup = presenceQuery.data ?? {};

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
  const isLoading = inventoryQuery.isLoading && !effectiveData;

  function renderRows(rows: OwnedAgentInstance[], trusted: boolean) {
    return rows.map((instance) => (
      <InstanceRow
        archivePending={archivePending}
        archiveStateTrusted={trusted}
        instance={instance}
        key={instance.pubkey}
        presenceLookup={presenceLookup}
        unarchivePending={unarchivePending}
        onArchive={handleArchive}
        onOpenProfile={onOpenProfile}
        onUnarchive={handleUnarchive}
      />
    ));
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent data-testid="instances-sheet" side="right">
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
            {isLoading ? (
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
            ) : !archiveStateTrusted && !isLoading ? (
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
                  {renderRows(instances, false)}
                </div>
              </div>
            ) : instances.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No instances found on this relay.
              </p>
            ) : (
              <div className="space-y-2">
                {renderRows(instances, archiveStateTrusted)}
              </div>
            )}

            {/* Unknown-persona instances from the relay inventory */}
            {unknownInstances.length > 0 ? (
              <div
                className="mt-4 space-y-2"
                data-testid="unknown-instances-section"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Unknown agents
                </p>
                {renderRows(unknownInstances, archiveStateTrusted)}
              </div>
            ) : null}
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
