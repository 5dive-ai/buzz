import { databricksModelName } from "./databricksModelNames";

/**
 * Returns a human-readable model label for an agent or persona, falling back to
 * "Auto" when no model is set (empty or whitespace-only).
 *
 * For known Databricks managed endpoints the registry-curated name is returned
 * (e.g. "databricks-gpt-5-5" → "GPT-5.5"). Unknown or custom endpoint IDs are
 * returned unchanged — no heuristic string mangling.
 */
export function formatAgentModelLabel(model: string | null | undefined) {
  const trimmed = model?.trim();
  if (!trimmed) return "Auto";
  return databricksModelName(trimmed);
}
