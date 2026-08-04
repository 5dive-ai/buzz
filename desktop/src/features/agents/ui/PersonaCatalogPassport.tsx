import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { CopyPlus, IdCard } from "lucide-react";

import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import { countCatalogRepublishers } from "@/features/agents/lib/personaAdoption";
import { usePersonaCatalogQuery } from "@/features/agents/lib/usePersonaCatalogRelay";
import { useCommunities } from "@/features/communities/useCommunities";
import { useAgentPassportBadges } from "@/features/passport/hooks/useAgentPassportBadges";
import { PassportBadgeList } from "@/features/passport/ui/PassportBadges";
import {
  AgentCrewList,
  type CrewAgent,
} from "@/features/passport/ui/PassportRecordSections";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { AgentPersona } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";

/**
 * The passport record for a catalog entry: the agents running this persona
 * in the community, the commendations the first of them has earned, and the
 * publisher's own passport. A persona is a definition — its trust record
 * lives on the people and agents behind it, so this section is what turns
 * "Add agent" from a leap of faith into a look at the track record.
 *
 * Deployed agents are resolved from verifiable relay data: the viewer's own
 * managed agents link by persona id; any community member's agent matches
 * when its name comes from the persona's display name or name pool. Names
 * are a heuristic, so instances operated by the entry's publisher rank
 * first.
 */
export function PersonaCatalogPassport({
  onBeforeNavigate,
  persona,
}: {
  onBeforeNavigate: () => void;
  persona: AgentPersona;
}) {
  const identityQuery = useIdentityQuery();
  const selfPubkey = identityQuery.data?.pubkey?.toLowerCase() ?? null;
  // Catalog entries name their publisher; local/built-in personas are the
  // viewer's own.
  const publisherPubkey =
    persona.catalogSource?.ownerPubkey.toLowerCase() ?? selfPubkey;

  const relayAgentsQuery = useRelayAgentsQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const profilePubkeys = React.useMemo(
    () => [
      ...(relayAgentsQuery.data ?? []).map((agent) => agent.pubkey),
      ...(publisherPubkey ? [publisherPubkey] : []),
    ],
    [publisherPubkey, relayAgentsQuery.data],
  );
  const profilesQuery = useUsersBatchQuery(profilePubkeys);

  const deployedAgents = React.useMemo<CrewAgent[]>(() => {
    const matches = new Map<string, CrewAgent & { publisherRun: boolean }>();
    const candidateNames = new Set(
      [persona.displayName, ...persona.namePool]
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    );

    // Anyone who adds a catalog persona runs their own copy under their own
    // key, so any relay agent named from the persona's pool counts as a
    // deployment — not just the publisher's.
    for (const agent of relayAgentsQuery.data ?? []) {
      const summary = profilesQuery.data?.profiles[agent.pubkey.toLowerCase()];
      const displayName = summary?.displayName?.trim() || agent.name;
      if (
        candidateNames.has(displayName.toLowerCase()) ||
        candidateNames.has(agent.name.trim().toLowerCase())
      ) {
        matches.set(agent.pubkey.toLowerCase(), {
          avatarUrl: summary?.avatarUrl ?? null,
          name: displayName,
          pubkey: agent.pubkey,
          publisherRun: summary?.ownerPubkey?.toLowerCase() === publisherPubkey,
        });
      }
    }

    // The viewer's own managed agents carry an explicit persona link — no
    // name heuristic needed.
    for (const agent of managedAgentsQuery.data ?? []) {
      if (agent.personaId !== persona.id) {
        continue;
      }
      const key = agent.pubkey.toLowerCase();
      if (!matches.has(key)) {
        matches.set(key, {
          avatarUrl: agent.avatarUrl,
          name: agent.name,
          publisherRun: publisherPubkey === selfPubkey,
          pubkey: agent.pubkey,
        });
      }
    }

    // Name matches are a heuristic, so the publisher's own instances — the
    // strongest provenance — come first and get the badge spotlight.
    return [...matches.values()]
      .sort(
        (left, right) =>
          Number(right.publisherRun) - Number(left.publisherRun) ||
          left.name.localeCompare(right.name),
      )
      .map(({ publisherRun: _publisherRun, ...agent }) => agent);
  }, [
    managedAgentsQuery.data,
    persona.displayName,
    persona.id,
    persona.namePool,
    profilesQuery.data,
    publisherPubkey,
    relayAgentsQuery.data,
    selfPubkey,
  ]);

  const firstAgent = deployedAgents[0] ?? null;
  const { badges } = useAgentPassportBadges(firstAgent?.pubkey ?? null);

  // Adoption: members who added this persona and re-shared their copy publish
  // a second catalog head with the same definition. Adds that were never
  // re-shared are local-only, so this is an honest lower bound — and
  // cross-server runs are invisible from a single relay entirely.
  const { activeCommunity } = useCommunities();
  const catalogQuery = usePersonaCatalogQuery(activeCommunity?.id ?? null);
  const republisherCount = React.useMemo(
    () =>
      countCatalogRepublishers(catalogQuery.data ?? [], {
        displayName: persona.displayName,
        publisherPubkey,
        systemPrompt: persona.systemPrompt,
      }),
    [
      catalogQuery.data,
      persona.displayName,
      persona.systemPrompt,
      publisherPubkey,
    ],
  );

  const navigate = useNavigate();
  const openPassport = React.useCallback(
    (pubkey: string) => {
      onBeforeNavigate();
      void navigate({ search: { pubkey }, to: "/passport" });
    },
    [navigate, onBeforeNavigate],
  );

  const publisherSummary = publisherPubkey
    ? profilesQuery.data?.profiles[publisherPubkey]
    : undefined;
  const publisherName =
    publisherSummary?.displayName?.trim() ||
    publisherSummary?.name?.trim() ||
    null;
  const publisherLabel =
    publisherPubkey === selfPubkey
      ? "your"
      : publisherName
        ? `${publisherName}’s`
        : "publisher";

  const isResolving = relayAgentsQuery.isLoading || profilesQuery.isLoading;

  return (
    <div
      className="min-w-0 max-w-full pt-3"
      data-testid="persona-catalog-passport"
    >
      <p className="text-base font-semibold text-foreground">Passport</p>
      {isResolving ? (
        <Skeleton className="mt-3 h-14 w-64 rounded-xl" />
      ) : (
        <div className="mt-3 space-y-4">
          {firstAgent ? (
            <>
              <div className="space-y-2">
                <p className="text-3xs font-medium tracking-[0.25em] text-muted-foreground uppercase">
                  Running in this community
                </p>
                <AgentCrewList
                  agents={deployedAgents}
                  onOpenPassport={openPassport}
                />
              </div>
              {badges.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-3xs font-medium tracking-[0.25em] text-muted-foreground uppercase">
                    {deployedAgents.length > 1
                      ? `Commendations · ${firstAgent.name}`
                      : "Commendations"}
                  </p>
                  <PassportBadgeList badges={badges} />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No commendations on record yet — badges appear as this agent
                  ships work.
                </p>
              )}
            </>
          ) : (
            <p
              className="text-sm text-muted-foreground"
              data-testid="persona-catalog-passport-empty"
            >
              No agent is running this persona in this community right now. Its
              record — merged pull requests, reviews, and commendations —
              appears here once one is.
            </p>
          )}
          {republisherCount > 0 ? (
            <p
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="persona-catalog-adoption"
            >
              <CopyPlus className="h-3.5 w-3.5 shrink-0" />
              Duplicated by {republisherCount} other{" "}
              {republisherCount === 1 ? "member" : "members"} — re-shared to
              this community’s catalog.
            </p>
          ) : null}
          {publisherPubkey ? (
            <div>
              <Button
                className="text-muted-foreground hover:text-foreground"
                data-testid="persona-catalog-publisher-passport"
                onClick={() => openPassport(publisherPubkey)}
                size="sm"
                variant="ghost"
              >
                <IdCard className="mr-2 h-3.5 w-3.5" />
                View {publisherLabel} passport
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
