import * as React from "react";

import {
  useAgentMemoryQuery,
  useIsManagedAgent,
} from "@/features/agent-memory/hooks";
import { useAgentWorking } from "@/features/agents/agentWorkingSignal";
import { useRelayAgentsQuery } from "@/features/agents/hooks";
import { useChannelsQuery } from "@/features/channels/hooks";
import {
  computeAgentBadges,
  type PassportBadge,
} from "@/features/passport/lib/badges";
import { countCraftSignals } from "@/features/passport/lib/craftSignals";
import { resolveHolderChannels } from "@/features/passport/lib/holderChannels";
import { useUserProfileQuery } from "@/features/profile/hooks";
import {
  useProjectsQuery,
  useProjectsWorkItemsQuery,
} from "@/features/projects/hooks";
import {
  useMyNotesQuery,
  usePulseReactionsQuery,
} from "@/features/pulse/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";

export type AgentPassportBadges = {
  badges: PassportBadge[];
  /** Engram count; null when the viewer cannot see the agent's memories. */
  memoryCount: number | null;
  /** Whether the current identity operates this agent. */
  viewerIsOwner: boolean;
};

/**
 * The commendations an agent has earned, computed from the same verifiable
 * record the passport screen shows: profile provenance, signed NIP-34 git
 * events (craft), authored notes, reactions received, channel memberships,
 * and owner-visible memories. Pass `null` to disable (non-agent holders).
 */
export function useAgentPassportBadges(
  pubkey: string | null,
): AgentPassportBadges {
  const pubkeyLower = pubkey?.toLowerCase() ?? null;
  const identityQuery = useIdentityQuery();
  const selfPubkey = identityQuery.data?.pubkey ?? null;

  const profileQuery = useUserProfileQuery(pubkey ?? undefined);
  const profile = profileQuery.data;
  const relayAgentsQuery = useRelayAgentsQuery();
  const relayAgent = relayAgentsQuery.data?.find(
    (agent) => agent.pubkey.toLowerCase() === pubkeyLower,
  );
  const channelsQuery = useChannelsQuery();
  const memberChannels = React.useMemo(
    () => resolveHolderChannels(channelsQuery.data, relayAgent, pubkeyLower),
    [channelsQuery.data, pubkeyLower, relayAgent],
  );

  const isLocallyManaged = useIsManagedAgent(pubkey);
  const viewerIsOwner =
    pubkey !== null &&
    (isLocallyManaged === true ||
      (profile?.ownerPubkey != null &&
        profile.ownerPubkey.toLowerCase() === selfPubkey?.toLowerCase()));
  const memoryQuery = useAgentMemoryQuery(pubkey, { enabled: viewerIsOwner });
  const memoryCount = memoryQuery.data
    ? memoryQuery.data.memories.length + (memoryQuery.data.core ? 1 : 0)
    : null;

  const notesQuery = useMyNotesQuery(pubkey ?? undefined);
  const allNotes = React.useMemo(
    () => notesQuery.data?.notes ?? [],
    [notesQuery.data],
  );
  const noteIds = React.useMemo(
    () => allNotes.map((note) => note.id),
    [allNotes],
  );
  const reactionsQuery = usePulseReactionsQuery(pubkey ? noteIds : []);
  const activeTurnCount = useAgentWorking(pubkey).channels.length;

  // Craft signals: the agent's engineering record, read from signed NIP-34
  // git events across every project in the community. Only enabled callers
  // pay for the work-items fetch.
  const projectsQuery = useProjectsQuery();
  const workItemsProjects = React.useMemo(
    () => (pubkey ? (projectsQuery.data ?? []) : []),
    [projectsQuery.data, pubkey],
  );
  const workItemsQuery = useProjectsWorkItemsQuery(workItemsProjects);
  const craft = React.useMemo(
    () => countCraftSignals(workItemsQuery.data, pubkeyLower),
    [pubkeyLower, workItemsQuery.data],
  );

  const badges = React.useMemo(() => {
    if (!pubkey) {
      return [];
    }
    let reactionCount = 0;
    for (const state of reactionsQuery.data?.values() ?? []) {
      reactionCount += state.count;
    }
    return computeAgentBadges({
      ...craft,
      activeTurnCount,
      channelCount: memberChannels.length,
      firstSeenAt:
        allNotes.length > 0
          ? Math.min(...allNotes.map((note) => note.createdAt))
          : null,
      hasAbout: Boolean(profile?.about?.trim()),
      hasAvatar: Boolean(profile?.avatarUrl),
      hasHandle: Boolean(profile?.nip05Handle?.trim()),
      hasName: Boolean(profile?.displayName?.trim()),
      hasOwner: profile?.ownerPubkey != null,
      memoryCount,
      noteCount: allNotes.length,
      reactionCount,
    });
  }, [
    activeTurnCount,
    allNotes,
    craft,
    memberChannels.length,
    memoryCount,
    profile,
    pubkey,
    reactionsQuery.data,
  ]);

  return { badges, memoryCount, viewerIsOwner };
}
