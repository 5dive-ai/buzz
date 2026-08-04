import type { AgentPersona } from "@/shared/api/types";

/**
 * Which agents are set up to run on Buzz shared compute.
 *
 * A persona points at the mesh by carrying `provider === "relay-mesh"` — the
 * same id the backend gates mesh model discovery on
 * (`managed_agents::RELAY_MESH_PROVIDER_ID`), so this asks the persistent
 * record rather than inferring intent from a model string.
 *
 * The point is a call to action: sharing compute that no agent can use is a
 * dead end, and the card is where someone would notice. So the card needs to
 * know not just *whether* mesh agents exist but whether the whole setup is
 * inert — capacity with no consumer, or a consumer with no capacity.
 */

/** The provider id a persona carries when it runs on shared compute. */
export const RELAY_MESH_PROVIDER_ID = "relay-mesh";

export type MeshAgentSummary = {
  /** Agents configured to run on shared compute. */
  count: number;
  /** Display names, for naming one specifically. Sorted for stable copy. */
  names: string[];
  /** True when at least one such agent exists. */
  hasAny: boolean;
};

export function summarizeMeshAgents(
  personas: AgentPersona[] | undefined,
): MeshAgentSummary {
  const matching = (personas ?? []).filter(
    (persona) => persona.provider?.trim() === RELAY_MESH_PROVIDER_ID,
  );
  const names = matching
    .map((persona) => persona.displayName)
    .sort((a, b) => a.localeCompare(b));
  return { count: matching.length, names, hasAny: matching.length > 0 };
}

/**
 * Whether a given persona runs on shared compute.
 *
 * Used to decorate an agent wherever it appears, so "this one is running on the
 * mesh" is legible without opening its config.
 */
export function usesMeshCompute(
  persona: Pick<AgentPersona, "provider"> | null | undefined,
): boolean {
  return persona?.provider?.trim() === RELAY_MESH_PROVIDER_ID;
}

/**
 * The card's call to action, or null when none is warranted.
 *
 * Deliberately silent in the common case. A nudge that appears every time the
 * card renders becomes furniture, so this only speaks when the setup is
 * genuinely incomplete in a way the person can act on:
 *
 *   - sharing (or capacity exists) but no agent can use it → offer to make one
 *   - an agent exists but nothing is shared anywhere       → offer to share
 *
 * Returns null while the picture is still unknown (`personas === undefined`),
 * because prompting someone to create an agent they may already have is worse
 * than staying quiet for a moment.
 */
export type MeshCallToAction =
  | { kind: "createAgent"; label: string }
  | { kind: "none" };

export function deriveMeshCallToAction({
  personas,
  isSharing,
  meshHasCapacity,
}: {
  personas: AgentPersona[] | undefined;
  isSharing: boolean;
  /** Anyone in the community is sharing, including this machine. */
  meshHasCapacity: boolean;
}): MeshCallToAction {
  // Unknown yet — say nothing rather than nudge toward a duplicate.
  if (personas === undefined) {
    return { kind: "none" };
  }
  if (summarizeMeshAgents(personas).hasAny) {
    return { kind: "none" };
  }
  // Compute with no consumer is the dead end worth naming. Only prompt when
  // there is actually capacity to use — telling someone to build an agent for
  // a mesh with nothing in it just moves the dead end.
  if (isSharing || meshHasCapacity) {
    return { kind: "createAgent", label: "Set up an agent to use it" };
  }
  return { kind: "none" };
}
