/**
 * AgentEditMergedDialog — single merged edit surface for R1–R7.
 *
 * instance-with-definition → D + I + L sections on one form
 * instance-only            → I + L sections
 * definition-only          → D sections only
 *
 * Submit: emitAgentFormDiff → runAgentSaveCoordinator (observed-state settlement).
 * Submit logic extracted to useAgentEditMergedSubmit; section JSX to
 * AgentEditMergedDialogDSection / AgentEditMergedDialogInstanceSection.
 */

import * as React from "react";

import {
  useAcpRuntimesQuery,
  useBakedBuildEnvKeysQuery,
  usePersonasQuery,
  useStartManagedAgentMutation,
  useUpdateManagedAgentMutation,
  useUpdatePersonaMutation,
} from "@/features/agents/hooks";
import { useUpdatePersonaAndPublishMutation } from "@/features/agents/lib/usePersonaCatalogRelay";
import type { ManagedAgent, RespondToMode } from "@/shared/api/types";
import type { EditAgentFocusTarget } from "@/features/agents/openEditAgentEvent";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";

import {
  seedAgentFormModel,
  hasDefinitionContext,
  hasInstanceContext,
  isDefinitionReadOnly,
  editContextDefinition,
  editContextInstance,
  type AgentEditContext,
} from "./agentFormModel";
import { useAgentEditMergedSubmit } from "./useAgentEditMergedSubmit";
import { AgentEditMergedDSection } from "./AgentEditMergedDialogDSection";
import { AgentEditMergedInstanceSection } from "./AgentEditMergedDialogInstanceSection";
import {
  runtimeDropdownAction,
  usePendingHarnessSelection,
} from "./addCustomHarness";
import {
  AUTO_PROVIDER_DROPDOWN_VALUE,
  getDefaultPersonaRuntime,
  isMissingRequiredDropdownField,
  runtimeSupportsLlmProviderSelection,
} from "./agentConfigOptions";
import {
  selectionOnModelDropdownChange,
  selectionOnProviderDropdownChange,
  selectionOnRuntimeChange,
  type RuntimeModelProviderSelection,
} from "./runtimeModelProviderSelection";
import { AgentCreationPreview } from "./AgentCreationPreview";
import { useAgentAccessOwnerOnlyQuery } from "@/features/agents/useAgentAccessOwnerOnly";
import { isEditAgentProviderSaveValid } from "./personaRuntimeModel";
import type { EnvVarsValue } from "./EnvVarsEditor";
import { formatPersonaNamePoolText } from "./personaDialogState";
import { useAgentEditRuntimeState } from "./useAgentEditRuntimeState";

// ── Types / Component ────────────────────────────────────────────────────────

export type AgentEditMergedDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ctx: AgentEditContext;
  /** Optional field to focus when the dialog opens from a card deep-link. */
  initialFocus?: EditAgentFocusTarget;
  onUpdated?: (agent: ManagedAgent) => void;
  /**
   * Optional pre-save validator (R6 origin permission check).
   * Return a non-null string to abort with an error toast; return null to proceed.
   */
  onValidate?: () => string | null;
  /**
   * Optional initial-values override for definition fields (R6 review mode).
   */
  initialValueOverrides?: Partial<{
    displayName: string;
    systemPrompt: string;
    runtime: string | undefined;
    provider: string | undefined;
    model: string | undefined;
    respondTo: string | undefined;
  }>;
  /**
   * Definition admin actions (Definition admin section, Artifact 4).
   * These are optional — omit when the host doesn't support the action.
   */
  /**
   * Called to delete the definition (custom definition delete).
   * When provided, a "Delete agent" action renders in the definition admin section.
   */
  onDeleteDefinition?: () => void;
  /**
   * For built-in definitions: called to remove from My Agents (14a deactivate).
   * When provided and definition isBuiltIn, "Remove from My Agents" renders.
   */
  onRemoveFromMyAgents?: () => void;
  /**
   * Number of linked instances for blast-radius copy in the delete confirmation.
   * Only relevant when onDeleteDefinition is provided.
   */
  linkedInstanceCount?: number;
  /**
   * Whether the definition's identity is archived (14b). When true, an
   * "Archived" flair renders. Save does not unarchive.
   */
  isIdentityArchived?: boolean;
};

export function AgentEditMergedDialog({
  open,
  onOpenChange,
  ctx,
  initialFocus,
  onUpdated,
  onValidate,
  initialValueOverrides,
  onDeleteDefinition,
  onRemoveFromMyAgents,
  linkedInstanceCount = 0,
  isIdentityArchived = false,
}: AgentEditMergedDialogProps) {
  const def = editContextDefinition(ctx);
  const inst = editContextInstance(ctx);
  const showDef = hasDefinitionContext(ctx);
  const showInst = hasInstanceContext(ctx);
  const defReadOnly = isDefinitionReadOnly(ctx);

  // ── Queries / mutations ───────────────────────────────────────────────────
  const runtimesQuery = useAcpRuntimesQuery({ enabled: open });
  const runtimes = runtimesQuery.data ?? [];
  const runtimeCatalogStatus = runtimesQuery.isLoading
    ? ("loading" as const)
    : runtimesQuery.isError
      ? ("error" as const)
      : ("ready" as const);

  const updatePersonaMutation = useUpdatePersonaMutation();
  const updatePersonaAndPublishMutation =
    useUpdatePersonaAndPublishMutation(null);
  const updateMutation = useUpdateManagedAgentMutation();
  const startMutation = useStartManagedAgentMutation();

  const { data: bakedEnvKeys } = useBakedBuildEnvKeysQuery({ enabled: open });
  const { data: agentAccessOwnerOnly } = useAgentAccessOwnerOnlyQuery({
    enabled: open && showInst,
  });

  const personasQuery = usePersonasQuery();
  const linkedPersona = React.useMemo(
    () =>
      inst?.personaId
        ? (personasQuery.data?.find((p) => p.id === inst.personaId) ?? null)
        : null,
    [inst?.personaId, personasQuery.data],
  );

  // ── Form state — seeded from AgentFormModel ───────────────────────────────
  // D-fields
  const [displayName, setDisplayName] = React.useState("");
  const [avatarUrl, setAvatarUrl] = React.useState("");
  const [systemPrompt, setSystemPrompt] = React.useState("");
  const [namePoolText, setNamePoolText] = React.useState("");
  // Definition runtime (D-field) — separate from instance harness pin (I-field)
  const [definitionRuntimeId, setDefinitionRuntimeId] =
    React.useState("custom");
  // I-fields — harness pin state (I-section only, independent of D-runtime)
  const [selectedRuntimeId, setSelectedRuntimeId] = React.useState("custom");
  // LLM model/provider (shared between D and I sections; which store they target is context-dependent)
  const [model, setModel] = React.useState("");
  const [provider, setProvider] = React.useState("");
  const [isCustomModelEditing, setIsCustomModelEditing] = React.useState(false);
  const [isCustomProviderEditing, setIsCustomProviderEditing] =
    React.useState(false);
  const runtimeTouched = React.useRef(false);

  // I-fields
  const [instanceName, setInstanceName] = React.useState("");
  const [respondTo, setRespondTo] = React.useState<RespondToMode>(
    inst?.respondTo ?? "anyone",
  );
  const [respondToAllowlist, setRespondToAllowlist] = React.useState<string[]>(
    inst?.respondToAllowlist ?? [],
  );
  const [parallelism, setParallelism] = React.useState(
    String(inst?.parallelism ?? 1),
  );
  const [envVars, setEnvVars] = React.useState<EnvVarsValue>(
    def?.envVars ?? inst?.envVars ?? {},
  );
  const [instanceEnvVars, setInstanceEnvVars] = React.useState<EnvVarsValue>(
    inst?.envVars ?? {},
  );
  // Harness-pin (I-field)
  const [agentCommand, setAgentCommand] = React.useState(
    inst?.agentCommand ?? "",
  );
  const [inheritHarness, setInheritHarness] = React.useState(
    inst != null && inst.personaId != null && inst.agentCommandOverride == null,
  );
  const [agentArgs, setAgentArgs] = React.useState(
    inst?.agentArgs.join(",") ?? "",
  );
  const [acpCommand, setAcpCommand] = React.useState(inst?.acpCommand ?? "");
  const [originalAgentCommand, setOriginalAgentCommand] = React.useState(
    inst?.agentCommand ?? "",
  );

  // L-fields
  const [autoRestartOnConfigChange, setAutoRestartOnConfigChange] =
    React.useState(inst?.autoRestartOnConfigChange ?? false);
  const [startOnAppLaunch, setStartOnAppLaunch] = React.useState(
    inst?.startOnAppLaunch ?? false,
  );

  // UI state
  const [showAdvancedFields, setShowAdvancedFields] = React.useState(false);
  const [isAvatarUploadPending, setIsAvatarUploadPending] =
    React.useState(false);
  const [aiDefaultsOpen, setAiDefaultsOpen] = React.useState(false);
  const aiDefaultsTriggerRef = React.useRef<HTMLButtonElement>(null);
  const [isAddHarnessOpen, setIsAddHarnessOpen] = React.useState(false);
  // Track whether any D-field has been dirtied so the catalog publish affordance
  // activates only after the user makes a change (matching AgentDefinitionDialog).
  const [dFieldsDirty, setDFieldsDirty] = React.useState(false);

  // ── Seed form on open ─────────────────────────────────────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only re-seed on open/entity-switch
  React.useEffect(() => {
    if (!open) return;

    const seed = seedAgentFormModel(ctx);
    setDisplayName(seed.displayName);
    setAvatarUrl(seed.avatarUrl);
    setSystemPrompt(seed.systemPrompt);
    setNamePoolText(formatPersonaNamePoolText(seed.namePool ?? []));
    setModel(seed.model ?? "");
    setProvider(seed.provider ?? "");
    setIsCustomModelEditing(false);
    setIsCustomProviderEditing(false);
    setRespondTo((seed.respondTo ?? "anyone") as RespondToMode);
    setRespondToAllowlist(seed.respondToAllowlist);
    setParallelism(String(seed.parallelism ?? 1));
    setEnvVars(seed.envVars);
    setInstanceEnvVars(seed.instanceEnvVars ?? {});
    setInstanceName(seed.instanceName ?? "");
    setAutoRestartOnConfigChange(seed.autoRestartOnConfigChange ?? false);
    setStartOnAppLaunch(seed.startOnAppLaunch ?? false);
    setShowAdvancedFields(false);
    setIsAvatarUploadPending(false);
    runtimeTouched.current = false;

    // Seed definition runtime (D-field) from definition record.
    const defRuntimeId = def?.runtime?.trim() ?? "";
    setDefinitionRuntimeId(defRuntimeId || "custom");

    if (inst) {
      setAgentCommand(inst.agentCommand);
      setOriginalAgentCommand(inst.agentCommand);
      setInheritHarness(
        inst.personaId != null && inst.agentCommandOverride == null,
      );
      setAgentArgs(inst.agentArgs.join(","));
      setAcpCommand(inst.acpCommand);
      // I-harness pin: match instance agentCommand to catalog entry
      const matched =
        runtimes.find((r) => r.command?.trim() === inst.agentCommand.trim()) ??
        runtimes.find((r) => r.id === inst.agentCommand.trim());
      setSelectedRuntimeId(matched ? matched.id : "custom");
    } else if (def) {
      // definition-only: also seed I-harness selectedRuntimeId from definition for the
      // D-section dropdown (no instance, so both are the same)
      setSelectedRuntimeId(defRuntimeId || "custom");
    }

    // Apply any caller-supplied initial value overrides (R6 review mode).
    if (initialValueOverrides) {
      if (initialValueOverrides.displayName !== undefined)
        setDisplayName(initialValueOverrides.displayName);
      if (initialValueOverrides.systemPrompt !== undefined)
        setSystemPrompt(initialValueOverrides.systemPrompt);
      if (initialValueOverrides.model !== undefined)
        setModel(initialValueOverrides.model ?? "");
      if (initialValueOverrides.provider !== undefined)
        setProvider(initialValueOverrides.provider ?? "");
      if (initialValueOverrides.runtime !== undefined)
        setDefinitionRuntimeId(initialValueOverrides.runtime ?? "custom");
      // R6: carry agent-requested respondTo into definition-only form (IMPORTANT-4)
      if (initialValueOverrides.respondTo !== undefined)
        setRespondTo(
          (initialValueOverrides.respondTo ?? "anyone") as RespondToMode,
        );
    }
    setDFieldsDirty(false);
  }, [open, inst?.pubkey, def?.id]);

  // Auto-seed D-section runtime when the definition has no runtime configured
  // and the catalog has loaded. Matches AgentDefinitionDialog's auto-seed logic.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only re-seed when catalog loads or dialog opens
  React.useEffect(() => {
    if (
      !open ||
      !showDef ||
      runtimes.length === 0 ||
      definitionRuntimeId !== "custom" || // already set by the user or seed
      (def?.runtime?.trim() ?? "").length > 0 // definition already has a runtime
    )
      return;
    const defaultRuntime = getDefaultPersonaRuntime(runtimes);
    if (!defaultRuntime) return;
    setDefinitionRuntimeId(defaultRuntime.id);
  }, [open, runtimes.length, showDef]);

  // Re-derive runtime id when catalog loads
  React.useEffect(() => {
    if (!open || runtimeTouched.current || runtimes.length === 0 || !inst)
      return;
    const matched =
      runtimes.find((r) => r.command?.trim() === inst.agentCommand.trim()) ??
      runtimes.find((r) => r.id === inst.agentCommand.trim());
    if (matched) setSelectedRuntimeId(matched.id);
  }, [open, runtimes, inst?.agentCommand, inst]);

  // ── Runtime / model / provider machinery ──────────────────────────────────
  const {
    selectedRuntime,
    runtimeDropdownValue,
    defRuntimeDropdownValue,
    instanceRuntimeDropdownOptions,
    defRuntimeDropdownOptions,
    defBlankLabel,
    originalRuntimeSupportsProvider,
    prospectiveRuntimeId,
    prospectiveRuntime,
    llmProviderFieldVisible,
    inheritedSubmission,
    inheritedModelDefault,
    inheritedProviderDefault,
    inheritedEnvVarsForAdvanced,
    fileSatisfiedEnvKeys,
    requiredEnvKeyMissing,
    effectiveProvider,
    providerDropdownOptions,
    providerSelectValue,
    modelDropdownOptions,
    modelSelectValue,
    showCustomModelInput,
    modelStatusMessage,
    modelDiscoveryLoading,
    apiKeyValue,
    apiKeyIsInherited,
    apiKeyInheritedLabel,
    apiKeyIsRequired,
    topLevelSecretEnvVar,
    advancedRequiredEnvKeys,
  } = useAgentEditRuntimeState({
    open,
    showDef,
    showInst,
    runtimes,
    runtimeCatalogStatus,
    selectedRuntimeId,
    definitionRuntimeId,
    model,
    provider,
    isCustomModelEditing,
    isCustomProviderEditing,
    envVars,
    instanceEnvVars,
    inheritHarness,
    inst,
    linkedPersona,
    bakedEnvKeys,
    originalAgentCommand,
    setModel,
    setIsCustomModelEditing,
  });

  // ── Submit validity ────────────────────────────────────────────────────────
  const modelRequired = React.useMemo(
    () => isMissingRequiredDropdownField(undefined, model),
    [model],
  );
  const providerRequired = React.useMemo(
    () => isMissingRequiredDropdownField(undefined, provider),
    [provider],
  );

  const providerValid = isEditAgentProviderSaveValid({
    llmProviderFieldVisible,
    currentProvider: provider,
    originalProvider: showInst
      ? (inst?.provider ?? null)
      : (def?.provider ?? null),
    globalProvider: inheritedProviderDefault.value,
    originalRuntimeSupportsProvider: showInst
      ? originalRuntimeSupportsProvider
      : llmProviderFieldVisible, // for D-only: picker is visible → was already editable
  });

  const parsedParallelism = parseInt(parallelism, 10);

  // ── Submit hook (must come before canSubmit so isSaving is available) ─────
  const {
    isSaving,
    saveError,
    handleSubmit: _handleSubmit,
  } = useAgentEditMergedSubmit({
    ctx,
    displayName,
    avatarUrl,
    systemPrompt,
    namePoolText,
    model,
    provider,
    respondTo,
    respondToAllowlist,
    parallelism,
    parsedParallelism,
    envVars,
    instanceEnvVars,
    instanceName,
    autoRestartOnConfigChange,
    startOnAppLaunch: showInst ? startOnAppLaunch : undefined,
    definitionRuntimeId,
    selectedRuntimeId,
    inheritHarness,
    agentCommand,
    agentArgs,
    acpCommand,
    showInst,
    defReadOnly,
    inheritedSubmissionProvider: inheritedSubmission.provider ?? null,
    runtimes,
    updatePersona: (p) => updatePersonaMutation.mutateAsync(p),
    updatePersonaAndPublish: (p) =>
      updatePersonaAndPublishMutation.mutateAsync(p),
    updateManagedAgent: (input) => updateMutation.mutateAsync(input),
    startMutate: (pubkey, cbs) => startMutation.mutate(pubkey, cbs),
    onValidate,
    onOpenChange,
    onUpdated,
  });

  const canSubmit =
    !isSaving &&
    !isAvatarUploadPending &&
    displayName.trim().length > 0 &&
    providerValid &&
    (showInst
      ? !requiredEnvKeyMissing &&
        (parsedParallelism > 0 || parallelism === "") &&
        (selectedRuntimeId !== "custom" ||
          inheritHarness ||
          agentCommand.trim().length > 0)
      : true);

  // ── selection helpers ──────────────────────────────────────────────────────
  const selection: RuntimeModelProviderSelection = {
    provider,
    model,
    isCustomProviderEditing,
    isCustomModelEditing,
    envVars: showInst ? instanceEnvVars : envVars,
  };

  function applySelection(next: RuntimeModelProviderSelection) {
    setProvider(next.provider);
    setModel(next.model);
    setIsCustomProviderEditing(next.isCustomProviderEditing);
    setIsCustomModelEditing(next.isCustomModelEditing);
    if (showInst) {
      setInstanceEnvVars(next.envVars);
    } else {
      setEnvVars(next.envVars);
    }
  }

  // D-section runtime change (definition runtime, D-field)
  function handleDefinitionRuntimeChange(nextValue: string) {
    const action = runtimeDropdownAction(nextValue);
    if (action.kind === "add-custom-harness") {
      setIsAddHarnessOpen(true);
      return;
    }
    const nextRuntimeId = action.runtimeId;
    const previousRuntimeId = definitionRuntimeId;
    setDefinitionRuntimeId(nextRuntimeId || "custom");
    applySelection(
      selectionOnRuntimeChange(selection, {
        previousRuntime: previousRuntimeId,
        nextRuntime: nextRuntimeId,
        nextRuntimeCanChooseProvider:
          runtimeSupportsLlmProviderSelection(nextRuntimeId),
        lockedRuntimeReset: "full",
      }),
    );
  }

  // I-section runtime change (instance harness pin, I-field)
  function handleRuntimeDropdownChange(nextValue: string) {
    const action = runtimeDropdownAction(nextValue);
    if (action.kind === "add-custom-harness") {
      setIsAddHarnessOpen(true);
      return;
    }
    const nextRuntimeId = action.runtimeId;
    const previousRuntimeId = selectedRuntimeId;

    runtimeTouched.current = true;
    const nextRuntime = runtimes.find((r) => r.id === nextRuntimeId);
    const resolvedRuntimeId = nextRuntimeId || "custom";
    setSelectedRuntimeId(resolvedRuntimeId);
    if (resolvedRuntimeId === "custom" || nextRuntime?.command) {
      setInheritHarness(false);
    }
    if (nextRuntime?.command) {
      setAgentCommand(nextRuntime.command);
      setAgentArgs(nextRuntime.defaultArgs.join(","));
    }

    applySelection(
      selectionOnRuntimeChange(selection, {
        previousRuntime: previousRuntimeId,
        nextRuntime: nextRuntimeId,
        nextRuntimeCanChooseProvider:
          runtimeSupportsLlmProviderSelection(nextRuntimeId),
        lockedRuntimeReset: "full",
      }),
    );
  }

  const selectSavedHarness = usePendingHarnessSelection(
    runtimes,
    handleRuntimeDropdownChange,
    open,
  );

  function handleProviderDropdownChange(nextValue: string) {
    const nextProvider =
      nextValue === AUTO_PROVIDER_DROPDOWN_VALUE ? "" : nextValue;
    if (nextProvider === "relay-mesh" && selectedRuntimeId !== "buzz-agent") {
      handleRuntimeDropdownChange("buzz-agent");
    }
    const nextSelection = selectionOnProviderDropdownChange(selection, {
      runtime:
        nextProvider === "relay-mesh"
          ? "buzz-agent"
          : (selectedRuntime?.id ?? selectedRuntimeId),
      nextValue,
      clearModelWhenApiKeyMissing: !showInst,
    });
    applySelection({
      ...nextSelection,
      model: nextProvider === "relay-mesh" ? "auto" : nextSelection.model,
    });
  }

  function handleModelDropdownChange(nextValue: string) {
    applySelection(
      selectionOnModelDropdownChange(selection, {
        nextValue,
        clearKnownModelOnCustomEntry: !showInst,
        isModelCustom: false,
      }),
    );
  }

  // ── Focus target (R2) ──────────────────────────────────────────────────────
  const normalizedFieldFocusFiredRef = React.useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset guard on open/context-switch; pure ref mutation is correct
  React.useEffect(() => {
    normalizedFieldFocusFiredRef.current = false;
  }, [open, inst?.pubkey, def?.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — llmProviderFieldVisible is the availability signal; inst?.pubkey handles agent-switch
  React.useEffect(() => {
    if (!open || !initialFocus) return;
    if (initialFocus.type !== "normalized_field") return;
    if (normalizedFieldFocusFiredRef.current) return;
    const targetId =
      initialFocus.field === "provider"
        ? "edit-agent-llm-provider"
        : "edit-agent-model";
    const el = document.getElementById(targetId);
    if (!(el instanceof HTMLElement)) return;
    normalizedFieldFocusFiredRef.current = true;
    const id = requestAnimationFrame(() => {
      el.scrollIntoView({ block: "nearest" });
      el.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open, initialFocus, inst?.pubkey, llmProviderFieldVisible]);

  // ── Render ─────────────────────────────────────────────────────────────────
  function handleSubmit() {
    void _handleSubmit(canSubmit);
  }

  const previewLabel = displayName.trim() || "Agent name";
  const previewAvatarUrl = avatarUrl.trim() || null;

  const dialogTitle = inst
    ? `Edit ${inst.name}`
    : def
      ? `Edit ${def.displayName}`
      : "Edit agent";

  // Catalog publish affordance: only shown when the definition is shared
  // and the user has made at least one D-field change.
  const publishesCatalogUpdates = !!(
    def?.shared &&
    !defReadOnly &&
    dFieldsDirty
  );

  // Helper: wrap a D-section setter to also mark D-fields dirty.
  function dChange<T>(setter: (v: T) => void): (v: T) => void {
    return (v: T) => {
      setter(v);
      setDFieldsDirty(true);
    };
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!isSaving) onOpenChange(next);
      }}
      open={open}
    >
      <ChooserDialogContent
        className="max-w-3xl border-0"
        contentClassName="pt-3"
        data-testid="edit-agent-dialog"
        footerClassName="border-t-0 pt-0"
        headerClassName="pb-2"
        title={dialogTitle}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-3">
              {publishesCatalogUpdates ? (
                <p
                  className="max-w-sm text-xs text-muted-foreground"
                  data-testid="edit-agent-dialog-catalog-publish-notice"
                >
                  This agent is in the community catalog. Your changes will be
                  published when you save.
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                disabled={isSaving || isAvatarUploadPending}
                onClick={() => onOpenChange(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                data-testid="edit-agent-dialog-submit"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
                type="button"
              >
                {isSaving
                  ? "Saving..."
                  : publishesCatalogUpdates
                    ? "Save and publish"
                    : "Save changes"}
              </Button>
            </div>
          </div>
        }
      >
        <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          {/* ── Identity column: avatar + preview ────────────────────── */}
          <div className="flex flex-col items-center gap-2">
            {/* Row 2 contract: unlinked agent (instance-only) → avatar is read-only.
                Backend has no avatarUrl on UpdateManagedAgentInput, so editing is
                impossible. Show disabled avatar + tooltip explaining the gap. */}
            {!showDef ? (
              <div className="flex flex-col items-center gap-1">
                <AgentCreationPreview
                  avatarUrl={previewAvatarUrl}
                  disabled
                  label={previewLabel}
                  onClearAvatar={() => {}}
                  onUploadPendingChange={() => {}}
                  onSelectAvatar={() => {}}
                />
                <p className="text-xs text-muted-foreground text-center">
                  Avatar is shared identity — edit via the agent definition.
                </p>
              </div>
            ) : (
              <AgentCreationPreview
                avatarUrl={previewAvatarUrl}
                disabled={isSaving || isAvatarUploadPending || defReadOnly}
                label={previewLabel}
                onClearAvatar={() => setAvatarUrl("")}
                onUploadPendingChange={setIsAvatarUploadPending}
                onSelectAvatar={setAvatarUrl}
              />
            )}
          </div>

          {/* ── Main form column ──────────────────────────────────────── */}
          <div className="space-y-5">
            {/* Team-managed notice */}
            {defReadOnly && showDef ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="team-managed-notice"
              >
                Managed by team{def?.sourceTeam ? ` ${def.sourceTeam}` : ""}.
                Its configuration cannot be edited here.
              </p>
            ) : null}

            {/* Built-in notice */}
            {def?.isBuiltIn && !defReadOnly ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="builtin-notice"
              >
                Built-in agent — fully editable.
              </p>
            ) : null}

            {/* Identity-archived flair (14b) — fields remain editable; Save does not unarchive */}
            {isIdentityArchived && showDef ? (
              <p
                className="text-sm font-medium text-amber-600 dark:text-amber-400"
                data-testid="identity-archived-flair"
              >
                Archived — this agent's identity is archived on the relay. Save
                will update its profile but will not unarchive.
              </p>
            ) : null}

            {/* ── D-section: Identity + Behavior + Runtime ──────────── */}
            {showDef ? (
              <AgentEditMergedDSection
                defReadOnly={defReadOnly}
                isSaving={isSaving}
                displayName={displayName}
                onDisplayNameChange={dChange(setDisplayName)}
                systemPrompt={systemPrompt}
                onSystemPromptChange={dChange(setSystemPrompt)}
                namePoolText={namePoolText}
                onNamePoolTextChange={dChange(setNamePoolText)}
                envVars={envVars}
                onEnvVarsChange={dChange(setEnvVars)}
                runtimeCatalogStatus={runtimeCatalogStatus}
                runtimeDropdownValue={defRuntimeDropdownValue}
                defRuntimeDropdownOptions={defRuntimeDropdownOptions}
                defBlankLabel={defBlankLabel}
                onRuntimeChange={(v) => {
                  setDFieldsDirty(true);
                  handleDefinitionRuntimeChange(v);
                }}
                llmProviderFieldVisible={llmProviderFieldVisible}
                providerSelectValue={providerSelectValue}
                providerDropdownOptions={providerDropdownOptions}
                onProviderChange={(v) => {
                  setDFieldsDirty(true);
                  handleProviderDropdownChange(v);
                }}
                isCustomProviderEditing={isCustomProviderEditing}
                provider={provider}
                onProviderTextChange={dChange(setProvider)}
                modelSelectValue={modelSelectValue}
                modelDropdownOptions={modelDropdownOptions}
                onModelChange={(v) => {
                  setDFieldsDirty(true);
                  handleModelDropdownChange(v);
                }}
                modelDiscoveryLoading={modelDiscoveryLoading}
                showCustomModelInput={showCustomModelInput}
                model={model}
                onModelTextChange={dChange(setModel)}
                modelStatusMessage={modelStatusMessage}
              />
            ) : null}

            {/* ── I-section: Instance + Runtime (when instance present) ── */}
            {showInst && inst ? (
              <AgentEditMergedInstanceSection
                inst={inst}
                showDef={showDef}
                defReadOnly={defReadOnly}
                isSaving={isSaving}
                runtimeCatalogStatus={runtimeCatalogStatus}
                instanceName={instanceName}
                onInstanceNameChange={setInstanceName}
                respondTo={respondTo}
                respondToAllowlist={respondToAllowlist}
                onRespondToChange={setRespondTo}
                onAllowlistChange={setRespondToAllowlist}
                agentAccessOwnerOnly={agentAccessOwnerOnly}
                selectedRuntimeId={selectedRuntimeId}
                runtimeDropdownValue={runtimeDropdownValue}
                instanceRuntimeDropdownOptions={instanceRuntimeDropdownOptions}
                onRuntimeChange={handleRuntimeDropdownChange}
                selectedRuntime={selectedRuntime}
                inheritHarness={inheritHarness}
                agentCommand={agentCommand}
                onAgentCommandChange={setAgentCommand}
                isAddHarnessOpen={isAddHarnessOpen}
                onAddHarnessOpenChange={setIsAddHarnessOpen}
                onSelectSavedHarness={selectSavedHarness}
                llmProviderFieldVisible={llmProviderFieldVisible}
                providerSelectValue={providerSelectValue}
                providerDropdownOptions={providerDropdownOptions}
                onProviderChange={handleProviderDropdownChange}
                isCustomProviderEditing={isCustomProviderEditing}
                provider={provider}
                onProviderTextChange={setProvider}
                providerRequired={providerRequired}
                topLevelSecretEnvVar={topLevelSecretEnvVar}
                apiKeyValue={apiKeyValue}
                apiKeyIsInherited={apiKeyIsInherited}
                apiKeyInheritedLabel={apiKeyInheritedLabel}
                apiKeyIsRequired={apiKeyIsRequired}
                effectiveProvider={effectiveProvider}
                onApiKeyChange={(key, value) => {
                  setInstanceEnvVars((prev) => ({ ...prev, [key]: value }));
                }}
                modelSelectValue={modelSelectValue}
                modelDropdownOptions={modelDropdownOptions}
                onModelChange={handleModelDropdownChange}
                modelDiscoveryLoading={modelDiscoveryLoading}
                showCustomModelInput={showCustomModelInput}
                model={model}
                onModelTextChange={setModel}
                modelStatusMessage={modelStatusMessage}
                modelRequired={modelRequired}
                inheritedSubmission={inheritedSubmission}
                inheritedModelDefault={inheritedModelDefault}
                inheritedProviderDefault={inheritedProviderDefault}
                aiDefaultsOpen={aiDefaultsOpen}
                onAiDefaultsOpenChange={setAiDefaultsOpen}
                aiDefaultsTriggerRef={aiDefaultsTriggerRef}
                showAdvancedFields={showAdvancedFields}
                onShowAdvancedFieldsChange={setShowAdvancedFields}
                acpCommand={acpCommand}
                agentArgs={agentArgs}
                autoRestartOnConfigChange={autoRestartOnConfigChange}
                instanceEnvVars={instanceEnvVars}
                fileSatisfiedEnvKeys={fileSatisfiedEnvKeys}
                advancedRequiredEnvKeys={advancedRequiredEnvKeys}
                initialFocus={initialFocus}
                inheritedEnvVarsForAdvanced={inheritedEnvVarsForAdvanced}
                linkedPersona={linkedPersona}
                prospectiveRuntimeId={prospectiveRuntimeId}
                prospectiveRuntime={prospectiveRuntime}
                parallelism={parallelism}
                onAcpCommandChange={setAcpCommand}
                onAgentArgsChange={setAgentArgs}
                onAutoRestartChange={setAutoRestartOnConfigChange}
                onStartOnAppLaunchChange={setStartOnAppLaunch}
                onEnvVarsChange={setInstanceEnvVars}
                onInheritHarnessChange={setInheritHarness}
                onParallelismChange={setParallelism}
                startOnAppLaunch={startOnAppLaunch}
                systemPrompt={systemPrompt}
                onSystemPromptChange={setSystemPrompt}
              />
            ) : null}

            {/* Definition admin section (Artifact 4) — rendered when a definition exists */}
            {showDef && !defReadOnly && def ? (
              <div className="space-y-2 border-t pt-4">
                {/* Share action (row 15 — not shown for built-ins) */}
                {onDeleteDefinition && !def.isBuiltIn ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      Delete this agent and all{" "}
                      {linkedInstanceCount > 0
                        ? `${linkedInstanceCount} linked agent${linkedInstanceCount === 1 ? "" : "s"}`
                        : "linked agents"}
                      .
                    </span>
                    <Button
                      disabled={isSaving}
                      onClick={onDeleteDefinition}
                      type="button"
                      variant="destructive"
                    >
                      Delete agent
                    </Button>
                  </div>
                ) : null}
                {/* Built-in: Remove from My Agents (14a deactivate) */}
                {onRemoveFromMyAgents && def.isBuiltIn ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      Remove this built-in agent from My Agents.
                    </span>
                    <Button
                      disabled={isSaving}
                      onClick={onRemoveFromMyAgents}
                      type="button"
                      variant="outline"
                    >
                      Remove from My Agents
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Save error */}
            {saveError ? (
              <p className="text-sm text-destructive">{saveError.message}</p>
            ) : null}
          </div>
        </div>
      </ChooserDialogContent>
    </Dialog>
  );
}
