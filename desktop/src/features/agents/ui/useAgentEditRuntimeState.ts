/**
 * useAgentEditRuntimeState — runtime/model/provider computed state for the
 * merged agent edit surface.
 *
 * Extracted from AgentEditMergedDialog to keep that file within the 1000-line
 * desktop size gate. Contains all the React.useMemo/useEffect that derives
 * dropdown options, model discovery, provider gate, and credential state.
 */

import * as React from "react";

import { useAgentDialogDefaults } from "./useAgentDialogDefaults";
import { useProviderApiKeyFieldState } from "./providerApiKeyFieldState";
import { useRequiredCredentialState } from "./useRequiredCredentialState";
import {
  getBakedProviderInheritLabel,
  getBakedModelInheritLabel,
} from "./bakedEnvHelpers";
import { ADD_CUSTOM_HARNESS_OPTION } from "./addCustomHarness";
import {
  AUTO_PROVIDER_DROPDOWN_VALUE,
  BLOCK_BUILD_HIDDEN_PROVIDER_IDS,
  CUSTOM_PROVIDER_DROPDOWN_VALUE,
  formatRuntimeOptionLabel,
  getDefaultPersonaRuntime,
  getPersonaProviderOptions,
  NO_RUNTIME_DROPDOWN_VALUE,
  buildPersonaRuntimeDropdownOptions,
  runtimeSupportsLlmProviderSelection,
  shouldClearKnownModelForSelectionScope,
  sortPersonaRuntimes,
  type PersonaDropdownOption,
  getProviderApiKeyEnvVar,
  getDefaultLlmModelLabel,
} from "./agentConfigOptions";
import {
  MODEL_DISCOVERY_LOADING_VALUE,
  usePersonaModelDiscovery,
} from "./usePersonaModelDiscovery";
import {
  modelDropdownOptions as buildModelDropdownOptions,
  relayMeshModelPickerState,
} from "./relayMeshModelPicker";
import { resolveModelFieldStatusMessage } from "./agentConfigControls";
import { resolveInheritedRuntimeSubmission } from "./personaRuntimeModel";
import { useRuntimeFileConfigQuery } from "../hooks";
import type { AcpRuntimeCatalogEntry, ManagedAgent } from "@/shared/api/types";
import type { AgentPersona } from "@/shared/api/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentEditRuntimeStateInputs = {
  open: boolean;
  showDef: boolean;
  showInst: boolean;
  runtimes: AcpRuntimeCatalogEntry[];
  runtimeCatalogStatus: "loading" | "error" | "ready";
  selectedRuntimeId: string;
  definitionRuntimeId: string;
  model: string;
  provider: string;
  isCustomModelEditing: boolean;
  isCustomProviderEditing: boolean;
  envVars: Record<string, string>;
  instanceEnvVars: Record<string, string>;
  inheritHarness: boolean;
  inst: ManagedAgent | null;
  def: AgentPersona | null;
  linkedPersona: AgentPersona | null;
  bakedEnvKeys: string[] | undefined;
  originalAgentCommand: string;
  setModel: (v: string) => void;
  setIsCustomModelEditing: (v: boolean) => void;
};

export type AgentEditRuntimeStateResult = {
  sortedRuntimes: AcpRuntimeCatalogEntry[];
  selectedRuntime: AcpRuntimeCatalogEntry | undefined;
  runtimeDropdownValue: string;
  defRuntimeDropdownValue: string;
  instanceRuntimeDropdownOptions: PersonaDropdownOption[];
  defRuntimeDropdownOptions: PersonaDropdownOption[];
  defBlankLabel: string;
  originalRuntimeSupportsProvider: boolean;
  prospectiveRuntimeId: string;
  prospectiveRuntime: AcpRuntimeCatalogEntry | undefined;
  llmProviderFieldVisible: boolean;
  inheritedEnvVars: Record<string, string>;
  inheritedSubmission: {
    model: string | null;
    provider: string | null;
    envVars: Record<string, string>;
  };
  globalConfig: { env_vars: Record<string, string> };
  inheritedModelDefault: import("./bakedEnvHelpers").InheritedDefault;
  inheritedProviderDefault: import("./bakedEnvHelpers").InheritedDefault;
  inheritedEnvVarsForAdvanced: Record<string, string>;
  requiredEnvKeys: string[];
  fileSatisfiedEnvKeys: string[];
  requiredEnvKeyMissing: boolean;
  effectiveProvider: string;
  providerDropdownOptions: PersonaDropdownOption[];
  providerSelectValue: string;
  modelDropdownOptions: PersonaDropdownOption[];
  modelSelectValue: string;
  showCustomModelInput: boolean;
  modelStatusMessage: string | null;
  providerApiKeyEnvVar: string | null;
  apiKeyValue: string;
  apiKeyIsInherited: boolean;
  apiKeyInheritedLabel: string;
  apiKeyIsRequired: boolean;
  topLevelSecretEnvVar: string | null;
  advancedRequiredEnvKeys: readonly string[];
  /** True while model discovery is in progress (drives model dropdown disabled state). */
  modelDiscoveryLoading: boolean;
  /**
   * True when the definition has no runtime but has a saved model/provider,
   * making the provider/model picker editable without a runtime selection.
   * Matches AgentDefinitionDialog's blankRuntimeModelProviderEditable contract.
   */
  blankRuntimeModelProviderEditable: boolean;
};

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAgentEditRuntimeState({
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
  def,
  linkedPersona,
  bakedEnvKeys,
  originalAgentCommand,
  setModel,
  setIsCustomModelEditing,
}: AgentEditRuntimeStateInputs): AgentEditRuntimeStateResult {
  const sortedRuntimes = React.useMemo(
    () => sortPersonaRuntimes(runtimes),
    [runtimes],
  );
  const selectedRuntime = runtimes.find((r) => r.id === selectedRuntimeId);
  const runtimeDropdownValue = selectedRuntimeId || NO_RUNTIME_DROPDOWN_VALUE;
  const defRuntimeDropdownValue =
    definitionRuntimeId || NO_RUNTIME_DROPDOWN_VALUE;

  const instanceRuntimeDropdownOptions: PersonaDropdownOption[] =
    React.useMemo(() => {
      const options: PersonaDropdownOption[] = [
        ...sortedRuntimes.map((r) => ({
          label: formatRuntimeOptionLabel(r),
          value: r.id,
        })),
        { label: "Custom command", value: "custom" },
      ];
      if (
        selectedRuntimeId &&
        selectedRuntimeId !== "custom" &&
        !options.some((o) => o.value === selectedRuntimeId)
      ) {
        options.push({
          label: `${selectedRuntimeId} (current)`,
          value: selectedRuntimeId,
        });
      }
      options.push(ADD_CUSTOM_HARNESS_OPTION);
      return options;
    }, [sortedRuntimes, selectedRuntimeId]);

  const {
    blankRuntimeOptionLabel: defBlankLabel,
    runtimeDropdownOptions: defRuntimeDropdownOptions,
  } = React.useMemo(() => {
    const result = buildPersonaRuntimeDropdownOptions({
      defaultRuntimeId: getDefaultPersonaRuntime(runtimes)?.id,
      isCreateMode: false,
      runtime: definitionRuntimeId === "custom" ? "" : definitionRuntimeId,
      runtimes,
      runtimesLoading: runtimeCatalogStatus === "loading",
    });
    result.runtimeDropdownOptions.push(ADD_CUSTOM_HARNESS_OPTION);
    return result;
  }, [runtimes, runtimeCatalogStatus, definitionRuntimeId]);

  const originalRuntimeSupportsProvider = React.useMemo(() => {
    if (!inst) return false;
    const originalCommand = originalAgentCommand.trim();
    const matched =
      runtimes.find((r) => r.command?.trim() === originalCommand) ??
      runtimes.find((r) => r.id === originalCommand);
    return runtimeSupportsLlmProviderSelection(matched?.id ?? "");
  }, [runtimes, originalAgentCommand, inst]);

  const prospectiveRuntimeId = React.useMemo(() => {
    if (!inst) return selectedRuntimeId || "";
    if (!inheritHarness) return selectedRuntime?.id ?? selectedRuntimeId;
    const personaRuntimeId = linkedPersona?.runtime?.trim();
    if (personaRuntimeId) {
      return (
        runtimes.find((r) => r.id === personaRuntimeId)?.id ?? personaRuntimeId
      );
    }
    return (
      runtimes.find((r) => r.command?.trim() === inst.agentCommand.trim())
        ?.id ??
      runtimes.find((r) => r.id === inst.agentCommand.trim())?.id ??
      getDefaultPersonaRuntime(runtimes)?.id ??
      ""
    );
  }, [
    inheritHarness,
    linkedPersona?.runtime,
    runtimes,
    inst?.agentCommand,
    selectedRuntime?.id,
    selectedRuntimeId,
    inst,
  ]);

  const llmProviderFieldVisible = React.useMemo(() => {
    // In linked context (showDef && showInst), the D-section provider/model
    // picker is driven by the definition's runtime (definitionRuntimeId), not by
    // the instance's harness pin (prospectiveRuntimeId). Using prospectiveRuntimeId
    // here would make the D-section picker visible whenever the instance's
    // agentCommand matches a provider-supporting runtime, even if the definition
    // has no runtime configured — a phantom provider field exposure.
    // Instance-only context (showInst && !showDef) correctly uses prospectiveRuntimeId
    // because the instance's harness is the only runtime in scope.
    // D-only context falls through to definitionRuntimeId via selectedRuntimeId (they equal).
    const activeRuntimeId =
      showInst && !showDef ? prospectiveRuntimeId : definitionRuntimeId;

    if (runtimeSupportsLlmProviderSelection(activeRuntimeId)) return true;

    // blankRuntimeModelProviderEditable: for an edit context (not create), when the
    // definition has no runtime configured but already has a saved model or provider,
    // expose the provider/model picker so the user can edit the existing values.
    // This matches AgentDefinitionDialog's `initialModelProviderEditableWithoutRuntime`
    // contract introduced in commit 87dc4dccba — restoring the capability that was
    // accidentally dropped when test-11 was rewritten.
    if (showDef && activeRuntimeId === "custom") {
      // The outer guard already means this is a runtime-less definition, so
      // expose the picker as soon as there is a saved model or provider to edit.
      const hasSavedModelOrProvider =
        (linkedPersona?.model ?? def?.model ?? "").trim().length > 0 ||
        (linkedPersona?.provider ?? def?.provider ?? "").trim().length > 0;
      if (hasSavedModelOrProvider) return true;
    }

    return false;
  }, [
    showInst,
    showDef,
    prospectiveRuntimeId,
    definitionRuntimeId,
    linkedPersona,
    def,
  ]);
  const prospectiveRuntime = runtimes.find(
    (r) => r.id === prospectiveRuntimeId,
  );

  const inheritedEnvVars = linkedPersona?.envVars ?? {};
  const inheritedSubmission = React.useMemo(() => {
    if (!inst)
      return { provider: provider || null, model: model || null, envVars };
    return resolveInheritedRuntimeSubmission({
      inheritHarness,
      agentWasHarnessPinned: inst.agentCommandOverride != null,
      provider,
      personaProvider: linkedPersona?.provider ?? "",
      model,
      personaModel: linkedPersona?.model ?? null,
      envVars: showDef ? envVars : instanceEnvVars,
      personaEnvVars: inheritedEnvVars,
    });
  }, [
    inheritHarness,
    inst,
    linkedPersona,
    provider,
    model,
    envVars,
    instanceEnvVars,
    inheritedEnvVars,
    showDef,
  ]);

  const {
    globalConfig,
    inheritedDefaults: {
      provider: inheritedProviderDefault,
      model: inheritedModelDefault,
    },
    inheritedEnvVars: inheritedEnvVarsForAdvanced,
  } = useAgentDialogDefaults({ inheritedEnvVars, open });

  const { requiredEnvKeys, fileSatisfiedEnvKeys, requiredEnvKeyMissing } =
    useRequiredCredentialState({
      open: open && showInst,
      prospectiveRuntimeId,
      provider: inheritedSubmission.provider ?? "",
      globalProvider: inheritedProviderDefault.value,
      envVars: inheritedSubmission.envVars,
      globalEnvVars: globalConfig.env_vars,
      personaEnvVars: inheritHarness ? inheritedEnvVars : undefined,
    });

  useRuntimeFileConfigQuery(
    showInst ? prospectiveRuntimeId : selectedRuntimeId,
    { enabled: open },
  );

  const effectiveProvider =
    (inheritedSubmission.provider ?? "").trim() ||
    inheritedProviderDefault.value;
  const providerForDiscovery = llmProviderFieldVisible ? effectiveProvider : "";
  const envVarsForDiscovery = React.useMemo(
    () => ({ ...globalConfig.env_vars, ...inheritedSubmission.envVars }),
    [globalConfig.env_vars, inheritedSubmission.envVars],
  );

  const {
    discoveredModelOptions,
    modelDiscoveryLoading,
    modelDiscoveryStatus,
  } = usePersonaModelDiscovery({
    envVars: envVarsForDiscovery,
    isCustomProviderEditing,
    modelFieldVisible: true,
    open,
    provider: providerForDiscovery,
    selectedRuntime: showInst ? prospectiveRuntime : selectedRuntime,
  });

  const hideProviderIds = React.useMemo(
    () =>
      (bakedEnvKeys ?? []).includes("BUZZ_AGENT_PROVIDER")
        ? BLOCK_BUILD_HIDDEN_PROVIDER_IDS
        : new Set<string>(),
    [bakedEnvKeys],
  );

  const providerOptions = getPersonaProviderOptions(
    provider.trim(),
    showInst ? (selectedRuntime?.id ?? "") : selectedRuntimeId,
    inheritedProviderDefault.source === "global"
      ? inheritedProviderDefault.value
      : "",
    hideProviderIds,
  );
  const providerSelectValue = isCustomProviderEditing
    ? CUSTOM_PROVIDER_DROPDOWN_VALUE
    : provider.trim() || AUTO_PROVIDER_DROPDOWN_VALUE;
  const providerDropdownOptions: PersonaDropdownOption[] = [
    ...providerOptions.map((opt) => ({
      label:
        opt.id === "" && inheritedProviderDefault.source === "build"
          ? getBakedProviderInheritLabel(
              inheritedProviderDefault.value,
              providerOptions,
            )
          : opt.label,
      value: opt.id || AUTO_PROVIDER_DROPDOWN_VALUE,
    })),
    { label: "Custom provider...", value: CUSTOM_PROVIDER_DROPDOWN_VALUE },
  ];

  const {
    isRelayMesh,
    options: effectiveModelOptions,
    selectValue: modelSelectValue,
    showCustomInput: showCustomModelInput,
  } = relayMeshModelPickerState({
    discoveredOptions: discoveredModelOptions,
    fallbackOptions: [
      { id: "", label: resolveInheritedModelLabel(inheritedModelDefault) },
    ],
    isCustomEditing: isCustomModelEditing,
    model,
    provider: providerForDiscovery,
  });

  const modelDropdownOptions = buildModelDropdownOptions({
    allowCustom: !isRelayMesh,
    globalModel: isRelayMesh ? undefined : inheritedModelDefault.value,
    globalModelLabel: isRelayMesh
      ? undefined
      : resolveInheritedModelLabel(inheritedModelDefault),
    loading: modelDiscoveryLoading && discoveredModelOptions === null,
    loadingValue: MODEL_DISCOVERY_LOADING_VALUE,
    options: effectiveModelOptions,
  });

  const modelStatusMessage = resolveModelFieldStatusMessage({
    discoveredModelOptions,
    loading: modelDiscoveryLoading,
    status: modelDiscoveryStatus,
  });

  const providerApiKeyEnvVar = getProviderApiKeyEnvVar(effectiveProvider);
  const personaSatisfied =
    providerApiKeyEnvVar != null &&
    !(providerApiKeyEnvVar in (showInst ? instanceEnvVars : envVars)) &&
    (inheritedEnvVars[providerApiKeyEnvVar] ?? "").length > 0;
  const apiKeyFieldState = useProviderApiKeyFieldState({
    bakedEnvKeys,
    effectiveEnvVars: inheritedSubmission.envVars,
    envVars: showInst ? instanceEnvVars : envVars,
    fileSatisfiedEnvKeys,
    globalEnvVars: globalConfig.env_vars,
    personaSatisfied,
    provider: effectiveProvider,
    requiredEnvKeys,
  });
  const {
    advancedRequiredEnvKeys,
    inheritedLabel: apiKeyInheritedLabel,
    isInherited: apiKeyIsInherited,
    isRequired: apiKeyIsRequired,
    secretEnvVar: topLevelSecretEnvVar,
    value: apiKeyValue,
  } = apiKeyFieldState;

  // Clear model when provider scope changes
  React.useEffect(() => {
    if (
      !open ||
      isCustomModelEditing ||
      !shouldClearKnownModelForSelectionScope({
        model,
        provider: providerForDiscovery,
        runtime: showInst ? prospectiveRuntimeId : selectedRuntimeId,
      })
    )
      return;
    setModel("");
    setIsCustomModelEditing(false);
  }, [
    isCustomModelEditing,
    model,
    open,
    providerForDiscovery,
    selectedRuntimeId,
    prospectiveRuntimeId,
    showInst,
    setModel,
    setIsCustomModelEditing,
  ]);

  return {
    sortedRuntimes,
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
    inheritedEnvVars,
    inheritedSubmission,
    globalConfig,
    inheritedModelDefault,
    inheritedProviderDefault,
    inheritedEnvVarsForAdvanced,
    requiredEnvKeys,
    fileSatisfiedEnvKeys,
    requiredEnvKeyMissing,
    effectiveProvider,
    providerDropdownOptions,
    providerSelectValue,
    modelDropdownOptions,
    modelSelectValue,
    showCustomModelInput,
    modelStatusMessage,
    providerApiKeyEnvVar,
    apiKeyValue,
    apiKeyIsInherited,
    apiKeyInheritedLabel,
    apiKeyIsRequired,
    topLevelSecretEnvVar,
    advancedRequiredEnvKeys,
    modelDiscoveryLoading,
    blankRuntimeModelProviderEditable:
      showDef &&
      definitionRuntimeId === "custom" &&
      ((linkedPersona?.model ?? def?.model ?? "").trim().length > 0 ||
        (linkedPersona?.provider ?? def?.provider ?? "").trim().length > 0),
  };
}

function resolveInheritedModelLabel(
  inherited: import("./bakedEnvHelpers").InheritedDefault,
): string {
  const model = inherited.value;
  if (!model) return "Default model";
  if (inherited.source === "build") return getBakedModelInheritLabel(model);
  if (inherited.source === "global") return getDefaultLlmModelLabel(model);
  return `Default (${model})`;
}
