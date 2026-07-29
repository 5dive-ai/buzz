import { DATABRICKS_MODEL_NAMES } from "./databricksModelNames";

/**
 * Resolves a human-readable label for a model, following the three-tier
 * precedence documented in AGENTS.md:
 *
 *   1. Nonblank discovered/API name (e.g. from AgentModelInfo.name)
 *   2. Registry lookup by ID (models.dev-seeded Databricks table)
 *   3. Raw ID unchanged
 *
 * Returns the empty string when both id and discoveredName are blank.
 * Use formatAgentModelLabel() when a null/empty id should render "Auto".
 */
export function resolveModelLabel(
  id: string,
  discoveredName?: string | null | undefined,
): string {
  const trimmedName = discoveredName?.trim();
  if (trimmedName) return trimmedName;
  const trimmedId = id.trim();
  if (!trimmedId) return "";
  return DATABRICKS_MODEL_NAMES.get(trimmedId) ?? trimmedId;
}

/**
 * Returns a human-readable model label for an agent or persona, falling back
 * to "Auto" when no model is set (empty or whitespace-only).
 *
 * For known Databricks managed endpoints the registry-curated name is returned
 * (e.g. "databricks-gpt-5-5" → "GPT-5.5"). Unknown or custom endpoint IDs are
 * returned unchanged — no heuristic string mangling.
 */
export function formatAgentModelLabel(model: string | null | undefined) {
  const trimmed = model?.trim();
  if (!trimmed) return "Auto";
  return resolveModelLabel(trimmed);
}
