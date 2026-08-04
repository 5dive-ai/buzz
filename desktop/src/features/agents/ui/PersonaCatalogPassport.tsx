import * as React from "react";
import { useNavigate } from "@tanstack/react-router";

import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import { useAgentPassportBadges } from "@/features/passport/hooks/useAgentPassportBadges";
import { PassportBadgeList } from "@/features/passport/ui/PassportBadges";
import {
  AgentCrewList,
  type CrewAgent,
} from "@/features/passport/ui/PassportRecordSections";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { AgentPersona } from "@/shared/api/types";
import { Skeleton } from "@/shared/ui/skeleton";

/**
 * The passport record for a catalog entry: the live agents running this
 * persona in the community, and the commendations the first of them has
 * earned. A persona is a definition — its trust record lives on the deployed
 * agents, so this section is what turns "Add agent" from a leap of faith into
 * a look at the track record.
 *
 * Deployed agents are resolved from verifiable relay data: the viewer's own
 * managed agents link by persona id; other members' agents match when their
 * declared operator is the entry's publisher and their name comes from the
 * persona's name pool.
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
  // viewer's own, so their agents declare the viewer as operator.
  const publisherPubkey =
    persona.catalogSource?.ownerPubkey.toLowerCase() ?? selfPubkey;

  const relayAgentsQuery = useRelayAgentsQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const agentPubkeys = React.useMemo(
    () => (relayAgentsQuery.data ?? []).map((agent) => agent.pubkey),
    [relayAgentsQuery.data],
  );
  const agentProfilesQuery = useUsersBatchQuery(agentPubkeys);

  const deployedAgents = React.useMemo<CrewAgent[]>(() => {
    const matches = new Map<string, CrewAgent>();
    const candidateNames = new Set(
      [persona.displayName, ...persona.namePool]
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    );

    for (const agent of relayAgentsQuery.data ?? []) {
      const summary =
        agentProfilesQuery.data?.profiles[agent.pubkey.toLowerCase()];
      const declaredOwner = summary?.ownerPubkey?.toLowerCase() ?? null;
      if (!publisherPubkey || declaredOwner !== publisherPubkey) {
        continue;
      }
      const displayName = summary?.displayName?.trim() || agent.name;
      if (
        candidateNames.has(displayName.toLowerCase()) ||
        candidateNames.has(agent.name.trim().toLowerCase())
      ) {
        matches.set(agent.pubkey.toLowerCase(), {
          avatarUrl: summary?.avatarUrl ?? null,
          name: displayName,
          pubkey: agent.pubkey,
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
          pubkey: agent.pubkey,
        });
      }
    }

    return [...matches.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }, [
    agentProfilesQuery.data,
    managedAgentsQuery.data,
    persona.displayName,
    persona.id,
    persona.namePool,
    publisherPubkey,
    relayAgentsQuery.data,
  ]);

  const firstAgent = deployedAgents[0] ?? null;
  const { badges } = useAgentPassportBadges(firstAgent?.pubkey ?? null);

  const navigate = useNavigate();
  const openPassport = React.useCallback(
    (pubkey: string) => {
      onBeforeNavigate();
      void navigate({ search: { pubkey }, to: "/passport" });
    },
    [navigate, onBeforeNavigate],
  );

  const isResolving =
    relayAgentsQuery.isLoading || agentProfilesQuery.isLoading;

  return (
    <div
      className="min-w-0 max-w-full pt-3"
      data-testid="persona-catalog-passport"
    >
      <p className="text-base font-semibold text-foreground">Passport</p>
      {isResolving ? (
        <Skeleton className="mt-3 h-14 w-64 rounded-xl" />
      ) : firstAgent ? (
        <div className="mt-3 space-y-4">
          <AgentCrewList
            agents={deployedAgents}
            onOpenPassport={openPassport}
          />
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
              No commendations on record yet — badges appear as this agent ships
              work.
            </p>
          )}
        </div>
      ) : (
        <p
          className="mt-1 text-sm text-muted-foreground"
          data-testid="persona-catalog-passport-empty"
        >
          No deployed agent found for this persona in this community yet. Its
          passport record — merged pull requests, reviews, and commendations —
          starts once one is running.
        </p>
      )}
    </div>
  );
}
