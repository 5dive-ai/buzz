/**
 * Adoption signals for a catalog persona, derived from what the relay can
 * actually show. Adding an entry to your library is a local-only write, so
 * true duplication counts don't exist on the relay — but a member who adds a
 * persona and then re-shares their copy publishes a second catalog head with
 * the same definition. Counting those re-publications gives an honest lower
 * bound on how many times the persona has been duplicated.
 */

import type { PersonaCatalogPublication } from "@/features/agents/lib/personaCatalogRelay";

/**
 * The identity of a persona definition for adoption matching: its operating
 * prompt when it has one (whitespace-insensitive), otherwise its display name.
 * Copies keep the source prompt verbatim, so this is the strongest signal a
 * publication descends from the same definition.
 */
export function personaDefinitionFingerprint(definition: {
  displayName: string;
  systemPrompt: string;
}): string {
  const prompt = definition.systemPrompt.replace(/\s+/gu, " ").trim();
  if (prompt.length > 0) {
    return `prompt:${prompt.toLowerCase()}`;
  }
  return `name:${definition.displayName.trim().toLowerCase()}`;
}

/**
 * Distinct members other than the publisher who have re-published this
 * persona's definition to the community catalog. A lower bound on adoption:
 * members who added the persona but never re-shared their copy stay
 * invisible.
 */
export function countCatalogRepublishers(
  publications: readonly PersonaCatalogPublication[],
  entry: {
    displayName: string;
    systemPrompt: string;
    publisherPubkey: string | null;
  },
): number {
  const fingerprint = personaDefinitionFingerprint(entry);
  const publisher = entry.publisherPubkey?.toLowerCase() ?? null;
  const republishers = new Set<string>();
  for (const publication of publications) {
    const owner = publication.ownerPubkey.toLowerCase();
    if (owner === publisher) {
      continue;
    }
    if (
      personaDefinitionFingerprint({
        displayName: publication.agent.displayName,
        systemPrompt: publication.agent.systemPrompt,
      }) === fingerprint
    ) {
      republishers.add(owner);
    }
  }
  return republishers.size;
}
