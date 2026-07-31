import {
  DATABRICKS_MODEL_NAMES,
  resolveModelCapabilities,
} from "../ui/modelCapabilities.ts";

/**
 * Resolves a human-readable label for a model, following the three-tier
 * precedence documented in AGENTS.md:
 *
 *   1. Nonblank discovered/API name (e.g. from AgentModelInfo.name)
 *   2. Registry lookup by ID — provider-qualified exact record first (when
 *      `provider` is supplied), then unscoped DATABRICKS_MODEL_NAMES map
 *   3. Raw ID unchanged
 *
 * Returns the empty string when both id and discoveredName are blank.
 * Use formatAgentModelLabel() when a null/empty id should render "Auto".
 */
export function resolveModelLabel(
  id: string,
  discoveredName?: string | null | undefined,
  provider?: string | null | undefined,
): string {
  const trimmedName = discoveredName?.trim();
  if (trimmedName) return trimmedName;
  const trimmedId = id.trim();
  if (!trimmedId) return "";
  // Provider-qualified exact record (registry_label tier, provider-scoped).
  if (provider) {
    const trimmedProvider = provider.trim();
    if (trimmedProvider) {
      const registryLabel = resolveModelCapabilities(
        trimmedProvider,
        trimmedId,
      ).registryLabel;
      if (registryLabel) return registryLabel;
    }
  }
  // Unscoped registry map (handles legacy/provider-unknown persisted IDs).
  return DATABRICKS_MODEL_NAMES.get(trimmedId) ?? trimmedId;
}

/**
 * Returns a human-readable model label for an agent or persona, falling back
 * to "Auto" when no model is set (empty or whitespace-only).
 *
 * For known Databricks managed endpoints the registry-curated name is returned
 * (e.g. "databricks-gpt-5-5" → "GPT-5.5"). Unknown or custom endpoint IDs are
 * returned unchanged — no heuristic string mangling.
 *
 * Pass `provider` when the inference provider is known to get a provider-qualified
 * registry label (e.g. exact records in the generated manifest take priority).
 */
export function formatAgentModelLabel(
  model: string | null | undefined,
  provider?: string | null | undefined,
) {
  const trimmed = model?.trim();
  if (!trimmed) return "Auto";
  return resolveModelLabel(trimmed, null, provider);
}
