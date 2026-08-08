/**
 * AgentEditDialog.tsx — Merged agent edit surface (Phase 1).
 *
 * Collapses R1–R7 from the Phase 0 spec Artifact 2 onto a single dialog.
 * R8 (duplicate = create seed) and R9 (start-on-launch quick toggle) are
 * kept as separate paths and are not affected here.
 *
 * Architecture:
 *   instance-with-definition or instance-only:
 *     → AgentInstanceEditDialog (all I/L fields, correct edit-agent-dialog
 *       testid, linked-runtime awareness, auto-restart setter, saved-while-
 *       stopped affordance).
 *
 *   definition-only (zero-instance definitions — R5 library card, R6 review):
 *     → AgentDefinitionDialog, wired through the Artifact 3 coordinator.
 *       Team-managed definitions render fields disabled with a "Managed by
 *       team" note (D-fields structurally unemittable per the spec).
 *
 * The Artifact 3 coordinator is invoked for the definition-only path only.
 * Instance paths use AgentInstanceEditDialog's own well-tested save path.
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
  useStartManagedAgentMutation,
  useUpdatePersonaMutation,
} from "@/features/agents/hooks";
import { useUpdatePersonaAndPublishMutation } from "@/features/agents/lib/usePersonaCatalogRelay";
import { runAgentSaveCoordinator } from "./agentSaveCoordinator";
import type { AgentEditContext } from "./agentFormModel";
export type { AgentEditContext };
import { isDefinitionReadOnly } from "./agentFormModel";
import type {
  AgentPersona,
  CreatePersonaInput,
  ManagedAgent,
  UpdatePersonaInput,
} from "@/shared/api/types";
import type { EditAgentFocusTarget } from "@/features/agents/openEditAgentEvent";
import type { AgentDefinitionSubmitOptions } from "./AgentDefinitionDialog";
import { AgentDefinitionDialog } from "./AgentDefinitionDialog";
import { AgentInstanceEditDialog } from "./AgentInstanceEditDialog";
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
   * Optional field to focus when the dialog opens from a card deep-link
   * (instance paths only — AgentInstanceEditDialog honors this).
   */
  initialFocus?: EditAgentFocusTarget;
  onUpdated?: (agent: ManagedAgent) => void;
  /**
   * Optional pre-save validator (R6 origin permission check).
   * Fires before the coordinator's step 0 on definition-only paths.
   * Return a non-null string to abort with an error toast; return null to proceed.
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
  initialFocus,
}: AgentEditDialogProps) {
  // ── Instance paths: delegate entirely to AgentInstanceEditDialog ──────────
  //
  // AgentInstanceEditDialog renders the full I+L field set (respondTo/allowlist,
  // parallelism, env vars, harness pin, auto-restart, start-on-launch, instance
  // name) and owns a well-tested save path. Route all instance-present contexts
  // here so no I/L field is accidentally omitted.
  if (ctx.kind === "instance-with-definition" || ctx.kind === "instance-only") {
    return (
      <AgentInstanceEditDialog
        agent={ctx.instance}
        initialFocus={initialFocus}
        open={open}
        onOpenChange={onOpenChange}
        onUpdated={onUpdated}
        // R4 back-door deleted: avatar lives on the merged surface (definition
        // section is visible in the profile panel when a definition exists).
        onEditLinkedPersona={undefined}
      />
    );
  }

  // ── Definition-only path: AgentDefinitionDialog + Artifact 3 coordinator ──
  return (
    <AgentEditDefinitionOnlyDialog
      ctx={ctx}
      open={open}
      onOpenChange={onOpenChange}
      onUpdated={onUpdated}
      onValidate={onValidate}
      initialValueOverrides={initialValueOverrides}
    />
  );
}

// ── Definition-only edit: coordinator-wired AgentDefinitionDialog ─────────────
//
// Separated into its own component so React hook ordering is stable across
// the instance/definition-only branch above. All hooks run unconditionally here.

function AgentEditDefinitionOnlyDialog({
  ctx,
  open,
  onOpenChange,
  // onUpdated is intentionally omitted: definition-only has no ManagedAgent to
  // return. Instance paths surface onUpdated via AgentInstanceEditDialog.
  onValidate,
  initialValueOverrides,
}: Omit<AgentEditDialogProps, "initialFocus" | "ctx"> & {
  ctx: Extract<AgentEditContext, { kind: "definition-only" }>;
}) {
  const queryClient = useQueryClient();
  const updatePersonaMutation = useUpdatePersonaMutation();
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

  const def = ctx.definition;
  const runtimes = runtimesQuery.data ?? [];
  const runtimeCatalogStatus = runtimesQuery.isLoading
    ? ("loading" as const)
    : runtimesQuery.isError
      ? ("error" as const)
      : ("ready" as const);

  // Team-managed: D-fields render disabled (structurally unemittable per spec).
  const defReadOnly = isDefinitionReadOnly(ctx);

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
    return {
      persona: personas.find((p) => p.id === def.id) ?? null,
      agent: null, // definition-only: no instance to settle
    };
  }

  // ── onSubmit ── called by AgentDefinitionDialog when the user clicks Save ─
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

    // Pre-save validation (e.g. R6 origin-permission check).
    if (onValidate) {
      const validationError = onValidate();
      if (validationError) {
        toast.error(validationError);
        return undefined;
      }
    }

    // Team-managed: D-fields are structurally unemittable; form renders read-only.
    // Guard here too so a misconfigured call path cannot bypass the UI gate.
    if (defReadOnly) {
      return undefined;
    }

    setSaveError(null);
    setIsSaving(true);

    try {
      const personaInput: UpdatePersonaInput = input;

      const success = await runAgentSaveCoordinator({
        ctx,
        personaInput,
        agentInput: null,
        policySets: [],
        publishCatalogUpdates: options.publishCatalogUpdates,
        runtimes: runtimes.length > 0 ? runtimes : undefined,
        updatePersona: (p) => updatePersonaMutation.mutateAsync(p),
        updatePersonaAndPublish: (p) =>
          updatePersonaAndPublishMutation.mutateAsync(p),
        updateManagedAgent: (_a) => {
          throw new Error("No instance in definition-only context");
        },
        setAutoRestart: (_pubkey, _value) => Promise.resolve(),
        setStartOnAppLaunch: (_pubkey, _value) => Promise.resolve(),
        refetchStores,
        onDone: () => onOpenChange(false),
        onSavedWhileStopped: (agent) => {
          // definition-only: no instance, but preserve the affordance contract
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

      if (!success) {
        setSaveError(
          new Error("Some changes may not have persisted. Reopen to retry."),
        );
      }
      // definition-only: no ManagedAgent to surface; onUpdated is not called.
      // Instance paths call onUpdated via AgentInstanceEditDialog directly.
    } finally {
      setIsSaving(false);
    }

    return undefined;
  }

  // ── Build initial values for AgentDefinitionDialog ─────────────────────────
  const baseDialogState = editPersonaDialogState(def);
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

  return (
    <AgentDefinitionDialog
      description={dialogState?.description ?? ""}
      error={saveError}
      initialValues={dialogState?.initialValues ?? null}
      isPending={isSaving}
      definitionReadOnly={defReadOnly}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      open={open}
      publishCatalogUpdatesOnSave={def.shared && !defReadOnly}
      runtimes={runtimes}
      runtimeCatalogStatus={runtimeCatalogStatus}
      submitLabel={dialogState?.submitLabel ?? "Save changes"}
      title={dialogState?.title ?? `Edit ${def.displayName}`}
    />
  );
}
