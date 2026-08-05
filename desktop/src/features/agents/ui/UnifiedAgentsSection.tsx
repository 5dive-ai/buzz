import * as React from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Server } from "lucide-react";

import { resolveAgentCardModelLabel } from "@/features/agents/lib/agentCardModelLabel";
import { friendlyAgentLastError } from "@/features/agents/lib/friendlyAgentLastError";
import { isManagedAgentActive } from "@/features/agents/lib/managedAgentControlActions";
import { InstancesSheet } from "@/features/identity-archive/InstancesSheet";
import { useOwnedAgentInventoryQuery } from "@/features/identity-archive/hooks";
import { useUserProfileQuery } from "@/features/profile/hooks";
import type { AgentPersona, ManagedAgent } from "@/shared/api/types";
import type { ProfilePanelOpenOptions } from "@/shared/context/ProfilePanelContext";
import { useFeedbackToasts } from "@/shared/hooks/useToastEffect";
import { useFileImportZone } from "@/shared/hooks/useFileImportZone";
import { Badge } from "@/shared/ui/badge";
import { RestartDiffBadge } from "./RestartDiffBadge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { IdentityCardSkeleton } from "@/shared/ui/identity-card-skeleton";
import { AgentIdentityCard } from "./AgentIdentityCard";
import { AgentRuntimeAvatarControl } from "./AgentRuntimeAvatarControl";
import { CreateIdentityCard } from "./CreateIdentityCard";
import { PersonaActionsMenu } from "./PersonaActionsMenu";
import { buildUnifiedGroups, pickProfileAgent } from "./unifiedAgentGroups";

type UnifiedAgentsSectionProps = {
  defaultModel: string;
  actionErrorMessage: string | null;
  actionNoticeMessage: string | null;
  agents: ManagedAgent[];
  agentsError: Error | null;
  isActionPending: boolean;
  isAgentsLoading: boolean;
  startingAgentPubkey: string | null;
  startingPersonaIds: ReadonlySet<string>;
  onOpenAgentProfile: (
    pubkey: string,
    options?: ProfilePanelOpenOptions,
  ) => void;
  onOpenPersonaProfile: (persona: AgentPersona) => void;
  onStartAgent: (pubkey: string) => void;
  onStartPersona: (persona: AgentPersona) => void;
  personas: AgentPersona[];
  personasError: Error | null;
  personaFeedbackErrorMessage: string | null;
  personaFeedbackNoticeMessage: string | null;
  isPersonasLoading: boolean;
  isPersonasPending: boolean;
  onCreatePersona: () => void;
  onDiscoverPersonas: () => void;
  onDuplicatePersona: (persona: AgentPersona) => void;
  onEditPersona: (persona: AgentPersona) => void;
  onSharePersona: (
    persona: AgentPersona,
    linkedAgent: ManagedAgent | undefined,
    effectiveAvatarUrl: string | null,
  ) => void;
  onDeactivatePersona: (persona: AgentPersona) => void;
  onDeletePersona: (persona: AgentPersona) => void;
  onImportSnapshotFile: (fileBytes: number[], fileName: string) => void;
};

const AGENT_CARD_COLUMN_CLASS = "w-full";
export const AGENT_CARD_GRID_COLUMNS_CLASS =
  "grid-cols-[repeat(auto-fill,minmax(220px,240px))]";
export const IDENTITY_CARD_GRID_CLASS = `${AGENT_CARD_COLUMN_CLASS} ${AGENT_CARD_GRID_COLUMNS_CLASS} grid justify-start gap-3 [@container(max-width:40rem)]:justify-center`;

export function UnifiedAgentsSection(props: UnifiedAgentsSectionProps) {
  const {
    actionErrorMessage,
    actionNoticeMessage,
    defaultModel,
    agents,
    agentsError,
    isActionPending,
    isAgentsLoading,
    startingAgentPubkey,
    startingPersonaIds,
    onOpenAgentProfile,
    onOpenPersonaProfile,
    onStartAgent,
    onStartPersona,
    personas,
    personasError,
    personaFeedbackErrorMessage,
    personaFeedbackNoticeMessage,
    isPersonasLoading,
    isPersonasPending,
    onCreatePersona,
    onDiscoverPersonas,
    onDuplicatePersona,
    onEditPersona,
    onSharePersona,
    onDeactivatePersona,
    onDeletePersona,
    onImportSnapshotFile,
  } = props;

  const { groups, ungrouped, unknown } = React.useMemo(
    () => buildUnifiedGroups(personas, agents),
    [personas, agents],
  );
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  // Instances Sheet state: track the persona that opened the sheet.
  const [instancesSheetPersona, setInstancesSheetPersona] =
    React.useState<AgentPersona | null>(null);
  const instancesSheetOpen = instancesSheetPersona !== null;

  // Pre-fetch the inventory so the start-control safeguard can consult it
  // without a per-card fetch. Enabled when the section is visible (agents loaded).
  const inventoryQuery = useOwnedAgentInventoryQuery(!isAgentsLoading);
  const {
    fileInputRef,
    isDragOver,
    dropHandlers,
    handleFileChange,
    openFilePicker,
  } = useFileImportZone({ onImportFile: onImportSnapshotFile });

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /**
   * Start-control safeguard (Finding 4): before starting a new instance,
   * check the relay inventory for THIS persona's instances only (byPersonaId).
   * If inventory is loading/untrusted OR there is already an active
   * (non-archived) relay instance for this persona, open the Sheet instead
   * of blindly minting a new one.
   */
  function handleStartPersonaWithSafeguard(persona: AgentPersona) {
    const inventory = inventoryQuery.data;
    // If inventory hasn't loaded yet or isn't trusted, show the Sheet so the
    // user can decide with full information rather than risking a 3rd instance.
    if (!inventory?.archiveStateTrusted) {
      openInstancesSheet(persona);
      return;
    }
    // Count active (non-archived) relay instances for THIS persona only.
    const personaInstances = inventory.byPersonaId[persona.id] ?? [];
    const activeRelayInstances = personaInstances.filter(
      (i) => i.archiveState.isArchived !== true,
    );
    if (activeRelayInstances.length >= 1) {
      // There is at least one active relay instance for this persona; open the
      // Sheet to let the user inspect and decide rather than minting a duplicate.
      openInstancesSheet(persona);
      return;
    }
    // Safe to start — no active relay instance found for this persona.
    onStartPersona(persona);
  }

  /**
   * Open the Instances Sheet for `persona`.
   */
  function openInstancesSheet(persona: AgentPersona) {
    setInstancesSheetPersona(persona);
  }

  useFeedbackToasts(actionNoticeMessage, actionErrorMessage);
  useFeedbackToasts(personaFeedbackNoticeMessage, personaFeedbackErrorMessage);
  const isLoading = isAgentsLoading || isPersonasLoading;

  return (
    <section
      className="relative space-y-4"
      data-testid="agents-library-personas"
      {...dropHandlers}
    >
      {isDragOver ? (
        <div className="pointer-events-none absolute -inset-1 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-background/80 backdrop-blur-sm">
          <p className="text-sm font-medium text-primary">
            Drop .agent.json or .agent.png to import
          </p>
        </div>
      ) : null}

      <input
        accept=".agent.json,.agent.png"
        className="hidden"
        onChange={handleFileChange}
        ref={fileInputRef}
        type="file"
      />

      {isLoading ? <LoadingSkeleton /> : null}

      {!isLoading ? (
        <div className="space-y-3" data-testid="unified-agents-groups">
          <div className={IDENTITY_CARD_GRID_CLASS}>
            {groups.map((group) => {
              const profileAgent = pickProfileAgent(group.agents);
              // Count relay instances for THIS persona from the grouped view model.
              const personaInstances =
                inventoryQuery.data?.byPersonaId[group.persona.id] ?? [];
              const relayInstanceCount = personaInstances.length;
              // Card-level instances indicator id for aria-controls.
              const instancesButtonId = `instances-sheet-${group.persona.id}`;
              return (
                <AgentPersonaCard
                  actions={(effectiveAvatarUrl, isEffectiveAvatarLoading) => (
                    <div className="flex items-center gap-1">
                      {/* Card-level focusable Instances action (Finding 3) */}
                      {relayInstanceCount > 1 ||
                      (profileAgent == null && relayInstanceCount >= 1) ? (
                        <button
                          aria-controls="instances-sheet"
                          aria-expanded={
                            instancesSheetOpen &&
                            instancesSheetPersona?.id === group.persona.id
                          }
                          aria-label={`Instances (${relayInstanceCount})`}
                          className="flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          id={instancesButtonId}
                          onClick={() => openInstancesSheet(group.persona)}
                          type="button"
                        >
                          <Server className="h-3.5 w-3.5" />
                          {relayInstanceCount}
                        </button>
                      ) : null}
                      <PersonaActionsMenu
                        isActionPending={
                          isActionPending || isEffectiveAvatarLoading
                        }
                        isPending={isPersonasPending}
                        persona={group.persona}
                        linkedAgent={profileAgent}
                        onDeactivate={onDeactivatePersona}
                        onDelete={onDeletePersona}
                        onDuplicate={onDuplicatePersona}
                        onEdit={onEditPersona}
                        onShare={(persona, linkedAgent) =>
                          onSharePersona(
                            persona,
                            linkedAgent,
                            effectiveAvatarUrl,
                          )
                        }
                        onViewInstances={
                          relayInstanceCount > 0
                            ? (p) => openInstancesSheet(p)
                            : undefined
                        }
                      />
                    </div>
                  )}
                  agent={profileAgent}
                  defaultModel={defaultModel}
                  key={group.persona.id}
                  persona={group.persona}
                  startingAgentPubkey={startingAgentPubkey}
                  startingPersonaIds={startingPersonaIds}
                  onOpenAgentProfile={onOpenAgentProfile}
                  onOpenPersonaProfile={onOpenPersonaProfile}
                  onStartAgent={onStartAgent}
                  onStartPersona={handleStartPersonaWithSafeguard}
                />
              );
            })}
            <NewAgentCard
              isPending={isPersonasPending}
              onCreate={onCreatePersona}
              onDiscover={onDiscoverPersonas}
              onImport={openFilePicker}
            />
          </div>

          {unknown.length > 0 ? (
            <CollapsibleAgentGroup
              agents={unknown}
              collapsed={collapsed}
              defaultModel={defaultModel}
              groupKey="__unknown__"
              label="Unknown agents"
              startingAgentPubkey={startingAgentPubkey}
              onToggle={toggle}
              onOpenAgentProfile={onOpenAgentProfile}
              onStartAgent={onStartAgent}
            />
          ) : null}
          {ungrouped.length > 0 ? (
            <CollapsibleAgentGroup
              agents={ungrouped}
              collapsed={collapsed}
              defaultModel={defaultModel}
              groupKey="__ungrouped__"
              label="Custom agents"
              startingAgentPubkey={startingAgentPubkey}
              onToggle={toggle}
              onOpenAgentProfile={onOpenAgentProfile}
              onStartAgent={onStartAgent}
            />
          ) : null}
        </div>
      ) : null}

      {agentsError ? (
        <p
          className={`${AGENT_CARD_COLUMN_CLASS} rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive`}
        >
          {agentsError.message}
        </p>
      ) : null}
      {personasError ? (
        <p
          className={`${AGENT_CARD_COLUMN_CLASS} rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive`}
        >
          {personasError.message}
        </p>
      ) : null}

      <InstancesSheet
        open={instancesSheetOpen}
        persona={instancesSheetPersona}
        inventory={inventoryQuery.data}
        onOpenChange={(o) => {
          if (!o) setInstancesSheetPersona(null);
        }}
        onOpenProfile={onOpenAgentProfile}
      />
    </section>
  );
}

function AgentPersonaCard({
  actions,
  agent,
  defaultModel,
  persona,
  startingAgentPubkey,
  startingPersonaIds,
  onOpenAgentProfile,
  onOpenPersonaProfile,
  onStartAgent,
  onStartPersona,
}: {
  actions?: (
    effectiveAvatarUrl: string | null,
    isEffectiveAvatarLoading: boolean,
  ) => React.ReactNode;
  agent: ManagedAgent | undefined;
  defaultModel: string;
  persona: AgentPersona;
  startingAgentPubkey: string | null;
  startingPersonaIds: ReadonlySet<string>;
  onOpenAgentProfile: (
    pubkey: string,
    options?: ProfilePanelOpenOptions,
  ) => void;
  onOpenPersonaProfile: (persona: AgentPersona) => void;
  onStartAgent: (pubkey: string) => void;
  onStartPersona: (persona: AgentPersona) => void;
}) {
  const title = persona.displayName;
  const modelLabel = resolveAgentCardModelLabel({
    agent,
    personaModel: persona.model,
    defaultModel,
  });
  const isActive = agent ? isManagedAgentActive(agent) : false;
  const profileQuery = useUserProfileQuery(agent?.pubkey);
  const avatarUrl = agent
    ? firstAvatarUrl(persona.avatarUrl, profileQuery.data?.avatarUrl)
    : persona.avatarUrl;
  const friendlyError = agent
    ? friendlyAgentLastError(agent.lastError, agent.lastErrorCode)?.copy
    : null;
  const opensRuntimeTab = Boolean(agent && friendlyError && !isActive);

  return (
    <AgentIdentityCard
      actions={actions?.(
        avatarUrl,
        Boolean(agent && !persona.avatarUrl && profileQuery.isPending),
      )}
      ariaLabel={`${title} agent profile`}
      avatar={
        agent ? (
          <AgentRuntimeAvatarControl
            activeTestId={`agent-runtime-active-${agent.pubkey}`}
            avatarUrl={avatarUrl}
            errorLabel={friendlyError}
            errorTestId={`agent-runtime-error-${agent.pubkey}`}
            isActive={isActive}
            isStarting={startingAgentPubkey === agent.pubkey}
            label={title}
            startTestId={`agent-runtime-start-${agent.pubkey}`}
            onOpenError={() => {
              onOpenAgentProfile(agent.pubkey, { tab: "runtime" });
            }}
            onStart={() => onStartAgent(agent.pubkey)}
          />
        ) : (
          <AgentRuntimeAvatarControl
            activeTestId={`persona-runtime-active-${persona.id}`}
            avatarUrl={avatarUrl}
            isActive={false}
            isStarting={startingPersonaIds.has(persona.id)}
            label={title}
            startTestId={`persona-runtime-start-${persona.id}`}
            onStart={() => onStartPersona(persona)}
          />
        )
      }
      avatarUrl={avatarUrl}
      dataTestId={`persona-agent-row-${persona.id}`}
      label={title}
      modelLabel={modelLabel}
      onClick={() => {
        if (agent) {
          onOpenAgentProfile(
            agent.pubkey,
            opensRuntimeTab ? { tab: "runtime" } : undefined,
          );
          return;
        }
        onOpenPersonaProfile(persona);
      }}
      statusBadge={
        agent?.personaOrphaned ? (
          <Badge className="gap-1" variant="warning">
            <AlertTriangle className="h-3 w-3" />
            Configuration missing
          </Badge>
        ) : agent?.needsRestart ? (
          <RestartDiffBadge
            autoRestartEnabled={agent.autoRestartOnConfigChange}
            restartDiff={agent.restartDiff}
          />
        ) : null
      }
    />
  );
}

function StandaloneAgentCard({
  agent,
  defaultModel,
  startingAgentPubkey,
  onOpenAgentProfile,
  onStartAgent,
}: {
  agent: ManagedAgent;
  defaultModel: string;
  startingAgentPubkey: string | null;
  onOpenAgentProfile: (
    pubkey: string,
    options?: ProfilePanelOpenOptions,
  ) => void;
  onStartAgent: (pubkey: string) => void;
}) {
  const title = agent.name;
  const profileQuery = useUserProfileQuery(agent.pubkey);
  const friendlyError = friendlyAgentLastError(
    agent.lastError,
    agent.lastErrorCode,
  )?.copy;
  const isActive = isManagedAgentActive(agent);
  const opensRuntimeTab = Boolean(friendlyError && !isActive);

  return (
    <AgentIdentityCard
      ariaLabel={`${title} agent profile`}
      avatar={
        <AgentRuntimeAvatarControl
          activeTestId={`agent-runtime-active-${agent.pubkey}`}
          avatarUrl={profileQuery.data?.avatarUrl}
          errorLabel={friendlyError}
          errorTestId={`agent-runtime-error-${agent.pubkey}`}
          isActive={isActive}
          isStarting={startingAgentPubkey === agent.pubkey}
          label={title}
          startTestId={`agent-runtime-start-${agent.pubkey}`}
          onOpenError={() => {
            onOpenAgentProfile(agent.pubkey, { tab: "runtime" });
          }}
          onStart={() => onStartAgent(agent.pubkey)}
        />
      }
      avatarUrl={profileQuery.data?.avatarUrl}
      dataTestId={`managed-agent-${agent.pubkey}`}
      label={title}
      modelLabel={resolveAgentCardModelLabel({
        agent,
        personaModel: null,
        defaultModel,
      })}
      onClick={() => {
        onOpenAgentProfile(
          agent.pubkey,
          opensRuntimeTab ? { tab: "runtime" } : undefined,
        );
      }}
      statusBadge={
        agent.personaOrphaned ? (
          <Badge className="gap-1" variant="warning">
            <AlertTriangle className="h-3 w-3" />
            Configuration missing
          </Badge>
        ) : agent.needsRestart ? (
          <RestartDiffBadge
            autoRestartEnabled={agent.autoRestartOnConfigChange}
            restartDiff={agent.restartDiff}
          />
        ) : null
      }
    />
  );
}

function firstAvatarUrl(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function NewAgentCard({
  isPending,
  onCreate,
  onDiscover,
  onImport,
}: {
  isPending: boolean;
  onCreate: () => void;
  onDiscover: () => void;
  onImport: () => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <CreateIdentityCard ariaLabel="New agent" dataTestId="new-agent-card" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuItem disabled={isPending} onClick={onCreate}>
          Create agent
        </DropdownMenuItem>
        <DropdownMenuItem disabled={isPending} onClick={onDiscover}>
          Discover agents
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="import-agent-snapshot-menu-item"
          disabled={isPending}
          onClick={onImport}
        >
          Import
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LoadingSkeleton() {
  return (
    <div className={IDENTITY_CARD_GRID_CLASS}>
      <IdentityCardSkeleton
        footerSubtitleWidthClass="w-14"
        footerTitleWidthClass="w-24"
      />
      <IdentityCardSkeleton
        footerSubtitleWidthClass="w-20"
        footerTitleWidthClass="w-32"
      />
      <IdentityCardSkeleton
        footerSubtitleWidthClass="w-16"
        footerTitleWidthClass="w-28"
      />
    </div>
  );
}

function CollapsibleAgentGroup({
  groupKey,
  label,
  agents,
  collapsed,
  defaultModel,
  startingAgentPubkey,
  onToggle,
  onOpenAgentProfile,
  onStartAgent,
}: {
  groupKey: string;
  label: string;
  agents: ManagedAgent[];
  collapsed: ReadonlySet<string>;
  defaultModel: string;
  startingAgentPubkey: string | null;
  onToggle: (key: string) => void;
  onOpenAgentProfile: (
    pubkey: string,
    options?: ProfilePanelOpenOptions,
  ) => void;
  onStartAgent: (pubkey: string) => void;
}) {
  const isCollapsed = collapsed.has(groupKey);
  return (
    <div className={`${AGENT_CARD_COLUMN_CLASS} space-y-2`}>
      <button
        className="group flex items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted/50"
        onClick={() => onToggle(groupKey)}
        type="button"
      >
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">({agents.length})</span>
      </button>
      {!isCollapsed ? (
        <div className={IDENTITY_CARD_GRID_CLASS}>
          {agents.map((agent) => (
            <StandaloneAgentCard
              agent={agent}
              defaultModel={defaultModel}
              key={agent.pubkey}
              startingAgentPubkey={startingAgentPubkey}
              onOpenAgentProfile={onOpenAgentProfile}
              onStartAgent={onStartAgent}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
