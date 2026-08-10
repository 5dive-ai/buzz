/**
 * AgentEditMergedDialogDSection.tsx — Definition-field section for the merged edit surface.
 *
 * Renders agent name, system prompt, name pool, D-env vars, and (for all definition
 * contexts) runtime, LLM provider, and model. Team-managed fields render read-only.
 *
 * When showInstancePresent is false (definition-only context), also renders the
 * D-owned access/allowlist and parallelism controls (rows 9–10, Artifact 4).
 *
 * Extracted from AgentEditMergedDialog to satisfy the desktop file-size gate.
 */

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { Button } from "@/shared/ui/button";
import type { RespondToMode } from "@/shared/api/types";

import {
  PERSONA_FIELD_CONTROL_CLASS,
  PERSONA_FIELD_SHELL_CLASS,
  PERSONA_LABEL_OPTIONAL_CLASS,
  type PersonaDropdownOption,
} from "./agentConfigOptions";
import { AgentHarnessField } from "./AgentHarnessField";
import { PersonaDropdownField } from "./PersonaDropdownField";
import { PersonaModelCombobox } from "./PersonaModelCombobox";
import { EnvVarsEditor, type EnvVarsValue } from "./EnvVarsEditor";
import { OwnerOnlyAccessField } from "./OwnerOnlyAccessField";
import type { AgentFormModel } from "./agentFormModel";

const advancedFieldsTransition = { duration: 0.18, ease: "easeInOut" } as const;

// ── Props ─────────────────────────────────────────────────────────────────────

export type AgentEditMergedDSectionProps = {
  /**
   * Per-field editability, resolved from the ownership map (`fieldEditable`
   * bound to the edit context). A D-owned field is read-only when the
   * definition is team-managed; this is the single authority for enabling and
   * disabling every control below — no section-level `defReadOnly` boolean.
   */
  fieldEditable: (field: keyof AgentFormModel) => boolean;
  isSaving: boolean;
  // Identity
  displayName: string;
  onDisplayNameChange: (value: string) => void;
  // Behavior
  systemPrompt: string;
  onSystemPromptChange: (value: string) => void;
  // Definition admin: name pool (D-field, must round-trip)
  namePoolText: string;
  onNamePoolTextChange: (value: string) => void;
  // Definition env vars (D-field, row 8 — separate from instance overlay)
  envVars: EnvVarsValue;
  onEnvVarsChange: (value: EnvVarsValue) => void;
  // Runtime (definition runtime D-field — shown for all definition contexts)
  runtimeCatalogStatus: "loading" | "error" | "ready";
  runtimeDropdownValue: string;
  defRuntimeDropdownOptions: PersonaDropdownOption[];
  defBlankLabel: string;
  onRuntimeChange: (value: string) => void;
  // LLM provider (D-field)
  llmProviderFieldVisible: boolean;
  providerSelectValue: string;
  providerDropdownOptions: PersonaDropdownOption[];
  onProviderChange: (value: string) => void;
  isCustomProviderEditing: boolean;
  provider: string;
  onProviderTextChange: (value: string) => void;
  // Model (D-field)
  modelSelectValue: string;
  modelDropdownOptions: PersonaDropdownOption[];
  onModelChange: (value: string) => void;
  modelDiscoveryLoading: boolean;
  showCustomModelInput: boolean;
  model: string;
  onModelTextChange: (value: string) => void;
  modelStatusMessage: string | null;
  /**
   * When false (definition-only context, no instance), renders the D-owned
   * access/allowlist and parallelism controls (rows 9–10, Artifact 4).
   * When true (instance is present), access/parallelism are I-owned and
   * rendered in AgentEditMergedDialogInstanceSection.
   */
  showInstancePresent: boolean;
  // D-owned access/parallelism (shown when !showInstancePresent)
  respondTo: RespondToMode | null;
  respondToAllowlist: string[];
  onRespondToChange: (value: RespondToMode) => void;
  onAllowlistChange: (value: string[]) => void;
  agentAccessOwnerOnly: boolean | undefined;
  parallelism: string;
  onParallelismChange: (value: string) => void;
};

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentEditMergedDSection({
  fieldEditable,
  isSaving,
  displayName,
  onDisplayNameChange,
  systemPrompt,
  onSystemPromptChange,
  namePoolText,
  onNamePoolTextChange,
  envVars,
  onEnvVarsChange,
  runtimeCatalogStatus,
  runtimeDropdownValue,
  defRuntimeDropdownOptions,
  defBlankLabel,
  onRuntimeChange,
  llmProviderFieldVisible,
  providerSelectValue,
  providerDropdownOptions,
  onProviderChange,
  isCustomProviderEditing,
  provider,
  onProviderTextChange,
  modelSelectValue,
  modelDropdownOptions,
  onModelChange,
  modelDiscoveryLoading,
  showCustomModelInput,
  model,
  onModelTextChange,
  modelStatusMessage,
  showInstancePresent,
  respondTo,
  respondToAllowlist,
  onRespondToChange,
  onAllowlistChange,
  agentAccessOwnerOnly,
  parallelism,
  onParallelismChange,
}: AgentEditMergedDSectionProps) {
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  return (
    <>
      {/* Agent name */}
      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="edit-agent-display-name"
        >
          Agent name
        </label>
        <div
          className={cn(
            "flex min-h-11 items-center px-3",
            PERSONA_FIELD_SHELL_CLASS,
          )}
        >
          <Input
            autoCorrect="off"
            className={cn(
              "h-8 px-0 py-0 leading-6",
              PERSONA_FIELD_CONTROL_CLASS,
            )}
            disabled={isSaving || !fieldEditable("displayName")}
            id="edit-agent-display-name"
            onChange={(e) => onDisplayNameChange(e.target.value)}
            placeholder="Agent name"
            value={displayName}
          />
        </div>
      </div>

      {/* System prompt */}
      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="edit-agent-system-prompt"
        >
          Agent instructions
        </label>
        <div className={PERSONA_FIELD_SHELL_CLASS}>
          <Textarea
            className={cn(
              "min-h-40 resize-y px-3 py-3 leading-5",
              PERSONA_FIELD_CONTROL_CLASS,
            )}
            disabled={isSaving || !fieldEditable("systemPrompt")}
            id="edit-agent-system-prompt"
            onChange={(e) => onSystemPromptChange(e.target.value)}
            placeholder="Describe what this agent should do."
            value={systemPrompt}
          />
        </div>
      </div>

      {/* Runtime (harness) — D-field, shown for all definition contexts */}
      <AgentHarnessField
        disabled={
          isSaving ||
          runtimeCatalogStatus === "loading" ||
          !fieldEditable("runtime")
        }
        onValueChange={onRuntimeChange}
        options={defRuntimeDropdownOptions}
        placeholder={defBlankLabel}
        value={runtimeDropdownValue}
        warning={null}
      />

      {/* LLM provider — D-field */}
      {llmProviderFieldVisible ? (
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="edit-agent-llm-provider"
          >
            LLM provider
            <span className={PERSONA_LABEL_OPTIONAL_CLASS}>Optional</span>
          </label>
          <PersonaDropdownField
            disabled={isSaving || !fieldEditable("provider")}
            id="edit-agent-llm-provider"
            onValueChange={onProviderChange}
            options={providerDropdownOptions}
            placeholder="Default (auto)"
            value={providerSelectValue}
          />
          {isCustomProviderEditing ? (
            <div
              className={cn(
                "mt-2 flex min-h-11 items-center px-3",
                PERSONA_FIELD_SHELL_CLASS,
              )}
            >
              <Input
                aria-label="Custom provider ID"
                autoCorrect="off"
                className={cn(
                  "h-8 px-0 py-0 leading-6",
                  PERSONA_FIELD_CONTROL_CLASS,
                )}
                disabled={isSaving || !fieldEditable("provider")}
                id="edit-agent-custom-provider"
                onChange={(e) => onProviderTextChange(e.target.value)}
                placeholder="Custom provider ID"
                value={provider}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Model — D-field */}
      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="edit-agent-model"
        >
          Model
          <span className={PERSONA_LABEL_OPTIONAL_CLASS}>Optional</span>
        </label>
        <PersonaModelCombobox
          disabled={
            isSaving || modelDiscoveryLoading || !fieldEditable("model")
          }
          id="edit-agent-model"
          onValueChange={onModelChange}
          options={modelDropdownOptions}
          placeholder="Default model"
          value={modelSelectValue}
        />
        {showCustomModelInput ? (
          <div
            className={cn(
              "mt-2 flex min-h-11 items-center px-3",
              PERSONA_FIELD_SHELL_CLASS,
            )}
          >
            <Input
              aria-label="Custom model ID"
              autoCorrect="off"
              className={cn(
                "h-8 px-0 py-0 leading-6",
                PERSONA_FIELD_CONTROL_CLASS,
              )}
              disabled={isSaving || !fieldEditable("model")}
              id="edit-agent-custom-model"
              onChange={(e) => onModelTextChange(e.target.value)}
              placeholder="Custom model ID"
              value={model}
            />
          </div>
        ) : null}
        {modelStatusMessage ? (
          <p className="text-xs text-muted-foreground">{modelStatusMessage}</p>
        ) : null}
      </div>

      {/* D-owned access/parallelism (rows 9–10, Artifact 4) — rendered only in
          definition-only context (no instance). When an instance is present,
          access/parallelism are I-owned and rendered in the I-section. */}
      {!showInstancePresent ? (
        <>
          <OwnerOnlyAccessField
            accessLocked={agentAccessOwnerOnly === true}
            allowlist={respondToAllowlist}
            disabled={isSaving || !fieldEditable("respondTo")}
            // Definition-only default is owner-only (matches PersonaAdvancedFields
            // and the backend default). Rendering an unset respondTo as "anyone"
            // would show open access where owner-only is in force.
            mode={(respondTo ?? "owner-only") as RespondToMode}
            onAllowlistChange={onAllowlistChange}
            onModeChange={onRespondToChange}
          />
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="edit-agent-parallelism"
            >
              Parallelism
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                Optional
              </span>
            </label>
            <div className="flex min-h-11 items-center rounded-lg border border-input bg-input/30 px-3">
              <input
                className="h-8 w-full bg-transparent px-0 py-0 text-sm leading-6 outline-none placeholder:text-muted-foreground"
                disabled={isSaving || !fieldEditable("parallelism")}
                id="edit-agent-parallelism"
                inputMode="numeric"
                min={1}
                onChange={(e) => onParallelismChange(e.target.value)}
                placeholder="Default (1)"
                type="number"
                value={parallelism}
              />
            </div>
          </div>
        </>
      ) : null}

      {/* Advanced section toggle (name pool + D-env vars) */}
      <div className="space-y-2">
        <Button
          className="flex items-center gap-1 px-0 text-sm text-muted-foreground hover:text-foreground"
          disabled={isSaving || !fieldEditable("namePool")}
          onClick={() => setShowAdvanced((v) => !v)}
          type="button"
          variant="ghost"
        >
          Advanced
        </Button>
        <AnimatePresence initial={false}>
          {showAdvanced ? (
            <motion.div
              animate={{ height: "auto", opacity: 1, scale: 1 }}
              className="origin-top overflow-hidden space-y-4"
              exit={{ height: 0, opacity: 0, scale: 0.98 }}
              initial={{ height: 0, opacity: 0, scale: 0.98 }}
              key="d-advanced-fields"
              transition={advancedFieldsTransition}
            >
              {/* Name pool — D-field */}
              <div className="space-y-1.5">
                <label
                  className="text-sm font-medium text-foreground"
                  htmlFor="edit-agent-name-pool"
                >
                  Name pool
                  <span className={PERSONA_LABEL_OPTIONAL_CLASS}>Optional</span>
                </label>
                <div className={PERSONA_FIELD_SHELL_CLASS}>
                  <Textarea
                    className={cn(
                      "min-h-20 resize-y px-3 py-3 leading-5",
                      PERSONA_FIELD_CONTROL_CLASS,
                    )}
                    disabled={isSaving || !fieldEditable("namePool")}
                    id="edit-agent-name-pool"
                    onChange={(e) => onNamePoolTextChange(e.target.value)}
                    placeholder={"Alice\nBob\nCarol"}
                    value={namePoolText}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  One name per line. Linked agents draw from this pool at spawn.
                </p>
              </div>

              {/* Definition env vars — D-field (row 8) */}
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-foreground">
                  Environment variables
                  <span className={PERSONA_LABEL_OPTIONAL_CLASS}>Optional</span>
                </p>
                <EnvVarsEditor
                  disabled={isSaving || !fieldEditable("envVars")}
                  onChange={onEnvVarsChange}
                  value={envVars}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </>
  );
}
