/**
 * AgentEditDialog.tsx — Merged agent edit surface (Phase 1).
 *
 * Collapses R1–R7 from the Phase 0 spec Artifact 2 onto a single dialog.
 * R8 (duplicate = create seed) and R9 (start-on-launch quick toggle) are
 * kept as separate paths and are not affected here.
 *
 * Architecture:
 *   For agents backed by a definition: opens AgentDefinitionDialog in
 *   edit mode, but intercepts onSubmit to run the Artifact 3 coordinator,
 *   which also writes any I-field diff (device policy setters: auto-restart,
 *   start-on-launch).
 *
 *   For unlinked agents: delegates to AgentDefinitionDialog with the agent's
 *   own fields, routed to updateManagedAgent by the coordinator (personaInput
 *   will be null; agentInput carries the diff).
 *
 * The coordinator implements:
 *   0. Validate (linked runtime availability, credential gate)
 *   1. Definition write (D-fields, only when changed and definition is editable)
 *   2. Instance write (I-fields, only when changed)
 *   3. Policy setters (auto-restart, start-on-launch, only on change)
 *   4. Settlement (re-fetch both stores, toast from observed state)
 *
 * S5 "Instances" vocabulary rename is deferred to Phase 3. Built-in agents
 * are fully editable (Artifact 1 corrected matrix).
 */

import * as React from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import {
  managedAgentsQueryKey,
  personasQueryKey,
  useAcpRuntimesQuery,
  useSetManagedAgentAutoRestartMutation,
  useSetManagedAgentStartOnAppLaunchMutation,
  useUpdateManagedAgentMutation,
  useUpdatePersonaMutation,
  useStartManagedAgentMutation,
} from "@/features/agents/hooks";
import { useUpdatePersonaAndPublishMutation } from "@/features/agents/lib/usePersonaCatalogRelay";
import { runAgentSaveCoordinator } from "./agentSaveCoordinator";
import type { AgentEditContext } from "./agentFormModel";
export type { AgentEditContext };
import type {
  AgentPersona,
  CreatePersonaInput,
  ManagedAgent,
  UpdatePersonaInput,
} from "@/shared/api/types";
import type { EditAgentFocusTarget } from "@/features/agents/openEditAgentEvent";
import type { AgentDefinitionSubmitOptions } from "./AgentDefinitionDialog";
import { AgentDefinitionDialog } from "./AgentDefinitionDialog";
import { editPersonaDialogState } from "./personaDialogState";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentEditDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Edit context: which entity or entities to edit.
   */
  ctx: AgentEditContext;
  /**
   * Optional field to focus when the dialog opens from a card deep-link.
   */
  initialFocus?: EditAgentFocusTarget;
  onUpdated?: (agent: ManagedAgent) => void;
  /**
   * Optional pre-save validator (R6 origin permission check).
   * Called before the coordinator's step 0. Return a non-null string to abort
   * with an error toast; return null to proceed.
   */
  onValidate?: () => string | null;
  /**
   * Optional initial-values override for the definition fields. When provided,
   * these values are merged into the seeded form (used in R6 review mode to
   * pre-fill agent-requested changes for user approval).
   */
  initialValueOverrides?: Partial<{
    displayName: string;
    systemPrompt: string;
    runtime: string | undefined;
    provider: string | undefined;
    model: string | undefined;
  }>;
};

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentEditDialog({
  ctx,
  open,
  onOpenChange,
  onUpdated,
  onValidate,
  initialValueOverrides,
}: AgentEditDialogProps) {
  const queryClient = useQueryClient();
  const updatePersonaMutation = useUpdatePersonaMutation();
  const updateManagedAgentMutation = useUpdateManagedAgentMutation();
  const setAutoRestartMutation = useSetManagedAgentAutoRestartMutation();
  const setStartOnAppLaunchMutation =
    useSetManagedAgentStartOnAppLaunchMutation();
  const startMutation = useStartManagedAgentMutation();
  const runtimesQuery = useAcpRuntimesQuery({ enabled: open });

  // Community id is required for publish-aware mutations; null → non-catalog edit.
  const updatePersonaAndPublishMutation =
    useUpdatePersonaAndPublishMutation(null);

  const [isSaving, setIsSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<Error | null>(null);

  // Reset error on open
  React.useEffect(() => {
    if (open) setSaveError(null);
  }, [open]);

  const def = ctx.kind !== "instance-only" ? ctx.definition : null;
  const inst = ctx.kind !== "definition-only" ? ctx.instance : null;
  const runtimes = runtimesQuery.data ?? [];
  const runtimeCatalogStatus = runtimesQuery.isLoading
    ? ("loading" as const)
    : runtimesQuery.isError
      ? ("error" as const)
      : ("ready" as const);

  // ── Settlement helper ──────────────────────────────────────────────────────
  async function refetchStores(): Promise<{
    persona: AgentPersona | null;
    agent: ManagedAgent | null;
  }> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: personasQueryKey }),
      queryClient.invalidateQueries({ queryKey: managedAgentsQueryKey }),
    ]);
    const personas =
      queryClient.getQueryData<AgentPersona[]>(personasQueryKey) ?? [];
    const agents =
      queryClient.getQueryData<ManagedAgent[]>(managedAgentsQueryKey) ?? [];
    return {
      persona: def ? (personas.find((p) => p.id === def.id) ?? null) : null,
      agent: inst
        ? (agents.find((a) => a.pubkey === inst.pubkey) ?? null)
        : null,
    };
  }

  // ── onSubmit ── called by AgentDefinitionDialog when the user clicks Save ─
  //
  // `input` is the UpdatePersonaInput computed by AgentDefinitionDialog.
  // For instance-with-definition contexts, the coordinator:
  //   1. Writes the definition (personaInput = input)
  //   2. Writes the instance diff (agentInput = null — D-field changes propagate
  //      live per the matrix; row 1/8 materializations are dropped)
  //   3. Runs policy setters (auto-restart/start-on-launch if changed)
  //
  // For instance-only contexts, the definition dialog's input represents the
  // instance state, so the coordinator routes it to agentInput instead.
  async function handleSubmit(
    input: CreatePersonaInput | UpdatePersonaInput,
    options: AgentDefinitionSubmitOptions,
  ): Promise<unknown> {
    // AgentEditDialog is always in edit mode — the input will always be an
    // UpdatePersonaInput. If for any reason a CreatePersonaInput arrives
    // (e.g. dialog misconfiguration), bail out safely.
    if (!("id" in input)) {
      console.error(
        "[AgentEditDialog] Received CreatePersonaInput in edit mode — ignoring.",
      );
      return undefined;
    }
    const updateInput: UpdatePersonaInput = input;

    // Pre-save validation (e.g. R6 origin-permission check).
    if (onValidate) {
      const validationError = onValidate();
      if (validationError) {
        toast.error(validationError);
        return undefined;
      }
    }

    setSaveError(null);
    setIsSaving(true);

    try {
      // Build coordinator inputs
      const personaInput: UpdatePersonaInput | null =
        def !== null ? updateInput : null;

      // Compute I-field policy diff from current instance state.
      // The dialog does not expose per-instance auto-restart/start-on-launch
      // from AgentDefinitionDialog state directly — those are L-fields handled
      // via dedicated setters. For Phase 1, policy setters are triggered only
      // if the instance has changed these values (which means they must be
      // surfaced elsewhere — Phase 1 defers in-form policy toggles to Phase 2;
      // the setter mechanism is wired and ready here). No policySets for now.
      const policySets: Parameters<
        typeof runAgentSaveCoordinator
      >[0]["policySets"] = [];

      const success = await runAgentSaveCoordinator({
        ctx,
        personaInput,
        agentInput: null,
        policySets,
        publishCatalogUpdates: options.publishCatalogUpdates,
        runtimes: runtimes.length > 0 ? runtimes : undefined,
        updatePersona: (p) => updatePersonaMutation.mutateAsync(p),
        updatePersonaAndPublish: (p) =>
          updatePersonaAndPublishMutation.mutateAsync(p),
        updateManagedAgent: (a) => updateManagedAgentMutation.mutateAsync(a),
        setAutoRestart: (pubkey, value) =>
          setAutoRestartMutation.mutateAsync({
            pubkey,
            autoRestartOnConfigChange: value,
          }),
        setStartOnAppLaunch: (pubkey, value) =>
          setStartOnAppLaunchMutation.mutateAsync({
            pubkey,
            startOnAppLaunch: value,
          }),
        refetchStores,
        onDone: () => onOpenChange(false),
        onSavedWhileStopped: (agent) => {
          const savedName = agent.name;
          toast(`${savedName} saved while stopped.`, {
            action: {
              label: "Start now",
              onClick: () => {
                startMutation.mutate(agent.pubkey, {
                  onSuccess: () => toast.success(`${savedName} started.`),
                  onError: (err) =>
                    toast.error(
                      err instanceof Error
                        ? `${savedName} failed to start: ${err.message}`
                        : `${savedName} failed to start.`,
                    ),
                });
              },
            },
          });
        },
      });

      if (success) {
        const agents =
          queryClient.getQueryData<ManagedAgent[]>(managedAgentsQueryKey) ?? [];
        const updated = inst
          ? (agents.find((a) => a.pubkey === inst.pubkey) ?? undefined)
          : undefined;
        if (updated) onUpdated?.(updated);
      } else {
        setSaveError(
          new Error("Some changes may not have persisted. Reopen to retry."),
        );
      }
    } finally {
      setIsSaving(false);
    }

    return undefined;
  }

  // ── Build initial values for AgentDefinitionDialog ─────────────────────────
  //
  // Always seed from the definition when one is present — that is the
  // authoritative source for D-fields. editPersonaDialogState() handles the
  // round-trip of namePool/envVars/behavior that prevents accidental clears.
  // initialValueOverrides are applied on top for R6 review mode (agent-requested
  // field changes pre-filled for user approval).
  const baseDialogState = def ? editPersonaDialogState(def) : null;
  const dialogState =
    baseDialogState && initialValueOverrides
      ? {
          ...baseDialogState,
          initialValues: {
            ...baseDialogState.initialValues,
            ...initialValueOverrides,
          },
        }
      : baseDialogState;
  const initialValues =
    dialogState?.initialValues ??
    (inst
      ? {
          // Instance-only fallback: no definition present, expose instance
          // fields so the user can edit them.
          displayName: inst.name,
          avatarUrl: inst.avatarUrl ?? "",
          systemPrompt: inst.systemPrompt ?? "",
          runtime: undefined,
          model: inst.model ?? undefined,
          provider: inst.provider ?? undefined,
          envVars: inst.envVars ?? {},
          behavior:
            inst.respondTo != null
              ? {
                  respondTo: inst.respondTo,
                  respondToAllowlist:
                    inst.respondTo === "allowlist"
                      ? inst.respondToAllowlist
                      : undefined,
                  parallelism: inst.parallelism ?? undefined,
                }
              : undefined,
        }
      : null);

  const title =
    dialogState?.title ?? (inst ? `Edit ${inst.name}` : "Edit agent");

  return (
    <AgentDefinitionDialog
      description={dialogState?.description ?? ""}
      error={saveError}
      initialValues={initialValues}
      isPending={isSaving}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      open={open}
      publishCatalogUpdatesOnSave={def?.shared ?? false}
      runtimes={runtimes}
      runtimeCatalogStatus={runtimeCatalogStatus}
      submitLabel={dialogState?.submitLabel ?? "Save changes"}
      title={title}
    />
  );
}
