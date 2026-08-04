import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Activity, Copy, UserRound } from "lucide-react";
import { toast } from "sonner";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  useAgentMemoryQuery,
  useIsManagedAgent,
} from "@/features/agent-memory/hooks";
import { useAgentWorking } from "@/features/agents/agentWorkingSignal";
import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import { useOpenAgentActivity } from "@/features/agents/useOpenAgentActivity";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { computeAgentBadges } from "@/features/passport/lib/badges";
import {
  loadTravelLog,
  normalizeRelayUrl,
} from "@/features/passport/lib/travelLog";
import { PassportBadgeList } from "@/features/passport/ui/PassportBadges";
import {
  AgentCrewList,
  type CrewAgent,
  EmptyRecord,
  FollowingStrip,
  formatStampDate,
  NoteRecordList,
  PassportStamp,
  RecordSection,
  StampPage,
} from "@/features/passport/ui/PassportRecordSections";
import {
  useProjectsQuery,
  useProjectsWorkItemsQuery,
} from "@/features/projects/hooks";
import {
  useContactListQuery,
  useUserProfileQuery,
  useUsersBatchQuery,
} from "@/features/profile/hooks";
import { PassportCard } from "@/features/profile/ui/PassportCard";
import {
  useMyNotesQuery,
  usePulseReactionsQuery,
} from "@/features/pulse/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { writeTextToClipboard } from "@/shared/lib/clipboard";
import { safeNpub } from "@/shared/lib/nostrUtils";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";

const RECENT_NOTES_SHOWN = 6;

type PassportScreenProps = {
  /** Holder pubkey from the route search; omitted = the viewer's own passport. */
  pubkey?: string;
};

/**
 * The Passport main screen: the identity card as the hero, next to the
 * holder's record of travel — communities and channels rendered as collected
 * stamps, plus notes and the follow list. Depth is honest to access: the
 * viewer sees more for themselves and for agents they operate (memories,
 * activity), and only the public record for everyone else.
 */
export function PassportScreen({
  pubkey: pubkeyFromSearch,
}: PassportScreenProps) {
  const identityQuery = useIdentityQuery();
  const selfPubkey = identityQuery.data?.pubkey ?? null;
  const pubkey = pubkeyFromSearch ?? selfPubkey;
  const pubkeyLower = pubkey?.toLowerCase() ?? null;
  const isSelf =
    pubkeyLower !== null && pubkeyLower === selfPubkey?.toLowerCase();

  const profileQuery = useUserProfileQuery(pubkey ?? undefined);
  const profile = profileQuery.data;
  const summaryQuery = useUsersBatchQuery(pubkey ? [pubkey] : []);
  const summary = pubkeyLower
    ? summaryQuery.data?.profiles[pubkeyLower]
    : undefined;

  const relayAgentsQuery = useRelayAgentsQuery();
  const managedAgentsQuery = useManagedAgentsQuery();
  const relayAgent = relayAgentsQuery.data?.find(
    (agent) => agent.pubkey.toLowerCase() === pubkeyLower,
  );
  const managedAgent = managedAgentsQuery.data?.find(
    (agent) => agent.pubkey.toLowerCase() === pubkeyLower,
  );
  const isAgent = Boolean(
    relayAgent ??
      managedAgent ??
      (summary?.isAgent || profile?.ownerPubkey != null),
  );
  const isLocallyManaged = useIsManagedAgent(isAgent ? pubkey : null);
  const viewerIsOwner =
    isAgent &&
    (isLocallyManaged === true ||
      (profile?.ownerPubkey != null &&
        profile.ownerPubkey.toLowerCase() === selfPubkey?.toLowerCase()));

  // Record sources. Channel membership is derived from the viewer's channel
  // list, so private rooms only ever appear to viewers already in them.
  const { activeCommunity, communities } = useCommunities();
  const channelsQuery = useChannelsQuery();
  const notesQuery = useMyNotesQuery(pubkey ?? undefined);
  const contactsQuery = useContactListQuery(pubkey ?? undefined);
  const memoryQuery = useAgentMemoryQuery(pubkey, { enabled: viewerIsOwner });
  const { canOpenAgentActivity, openAgentActivity } = useOpenAgentActivity();
  const { goChannel } = useAppNavigation();

  const memberChannels = React.useMemo(() => {
    const links = new Map<string, { id: string; name: string }>();
    relayAgent?.channels.forEach((name, index) => {
      const id = relayAgent.channelIds[index] ?? name;
      links.set(id, { id, name });
    });
    for (const channel of channelsQuery.data ?? []) {
      if (channel.channelType === "dm") {
        continue;
      }
      const isMember = channel.memberPubkeys.some(
        (memberPubkey) => memberPubkey.toLowerCase() === pubkeyLower,
      );
      if (isMember) {
        links.set(channel.id, { id: channel.id, name: channel.name });
      }
    }
    return [...links.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }, [channelsQuery.data, pubkeyLower, relayAgent]);

  // Visas: servers you are on now (saved communities) plus servers you have
  // been on before (persistent travel log), shown as expired stamps. Both are
  // local-device records, so this page only exists on your own passport.
  const visas = React.useMemo(() => {
    if (!isSelf) {
      return [];
    }
    const savedRelays = new Set(
      communities.map((community) => normalizeRelayUrl(community.relayUrl)),
    );
    const current = communities.map((community) => ({
      departed: false,
      key: community.id,
      subtitle: `since ${formatStampDate(new Date(community.addedAt))}`,
      title: community.name,
    }));
    const departed = loadTravelLog()
      .filter((entry) => !savedRelays.has(normalizeRelayUrl(entry.relayUrl)))
      .map((entry) => ({
        departed: true,
        key: `departed-${normalizeRelayUrl(entry.relayUrl)}`,
        subtitle: `departed ${formatStampDate(new Date(entry.lastVisitedAt))}`,
        title: entry.name,
      }));
    return [...current, ...departed];
  }, [communities, isSelf]);

  const contactPubkeys = React.useMemo(
    () => contactsQuery.data?.contacts.map((contact) => contact.pubkey) ?? [],
    [contactsQuery.data],
  );
  const contactProfilesQuery = useUsersBatchQuery(contactPubkeys.slice(0, 12));

  // Agents operating under the holder's identity. Relay agents declare their
  // owner publicly (kind-0 ownerPubkey), so this works on anyone's passport;
  // locally managed agents are the viewer's own custody and merge in only on
  // the self passport.
  const agentPubkeys = React.useMemo(
    () => (relayAgentsQuery.data ?? []).map((agent) => agent.pubkey),
    [relayAgentsQuery.data],
  );
  const agentProfilesQuery = useUsersBatchQuery(agentPubkeys);
  const ownedAgents = React.useMemo<CrewAgent[]>(() => {
    if (!pubkeyLower || isAgent) {
      return [];
    }
    const agents = new Map<string, CrewAgent>();
    for (const agent of relayAgentsQuery.data ?? []) {
      const summary =
        agentProfilesQuery.data?.profiles[agent.pubkey.toLowerCase()];
      if (summary?.ownerPubkey?.toLowerCase() === pubkeyLower) {
        agents.set(agent.pubkey.toLowerCase(), {
          avatarUrl: summary.avatarUrl ?? null,
          name: summary.displayName?.trim() || agent.name,
          pubkey: agent.pubkey,
        });
      }
    }
    if (isSelf) {
      for (const agent of managedAgentsQuery.data ?? []) {
        const key = agent.pubkey.toLowerCase();
        if (!agents.has(key)) {
          agents.set(key, {
            avatarUrl: agent.avatarUrl,
            name: agent.name,
            pubkey: agent.pubkey,
          });
        }
      }
    }
    return [...agents.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }, [
    agentProfilesQuery.data,
    isAgent,
    isSelf,
    managedAgentsQuery.data,
    pubkeyLower,
    relayAgentsQuery.data,
  ]);

  const navigate = useNavigate();
  const openAgentPassport = React.useCallback(
    (agentPubkey: string) => {
      void navigate({ search: { pubkey: agentPubkey }, to: "/passport" });
    },
    [navigate],
  );

  // Card fields, resolved the same way the passport dialog resolves them.
  const displayName =
    profile?.displayName?.trim() ||
    (pubkey ? truncatePubkey(pubkey) : "Unknown");
  const ownerProfileQuery = useUserProfileQuery(
    profile?.ownerPubkey ?? undefined,
  );
  const operatorName = profile?.ownerPubkey
    ? ownerProfileQuery.data?.nip05Handle?.trim() ||
      ownerProfileQuery.data?.displayName?.trim() ||
      truncatePubkey(profile.ownerPubkey)
    : null;
  const npub = pubkey ? (safeNpub(pubkey) ?? pubkey) : null;

  const notes = notesQuery.data?.notes.slice(0, RECENT_NOTES_SHOWN) ?? [];
  const memoryCount = memoryQuery.data
    ? memoryQuery.data.memories.length + (memoryQuery.data.core ? 1 : 0)
    : null;

  // Badge inputs: computed from the same record the rest of the page shows.
  const allNotes = React.useMemo(
    () => notesQuery.data?.notes ?? [],
    [notesQuery.data],
  );
  const noteIds = React.useMemo(
    () => allNotes.map((note) => note.id),
    [allNotes],
  );
  const reactionsQuery = usePulseReactionsQuery(isAgent ? noteIds : []);
  const activeTurnCount = useAgentWorking(isAgent ? pubkey : null).channels
    .length;

  // Craft signals: the agent's engineering record, read from signed NIP-34
  // git events across every project in the community. Only agent passports
  // pay for the work-items fetch.
  const projectsQuery = useProjectsQuery();
  const workItemsProjects = React.useMemo(
    () => (isAgent ? (projectsQuery.data ?? []) : []),
    [isAgent, projectsQuery.data],
  );
  const workItemsQuery = useProjectsWorkItemsQuery(workItemsProjects);
  const craft = React.useMemo(() => {
    const counts = {
      closedPrCount: 0,
      issuesOpenedCount: 0,
      mergedPrCount: 0,
      repoCount: 0,
      reviewCount: 0,
    };
    const workItems = workItemsQuery.data;
    if (!pubkeyLower || !workItems) {
      return counts;
    }
    const repos = new Set<string>();
    for (const { project, pullRequest } of workItems.pullRequests.items) {
      if (pullRequest.author.toLowerCase() === pubkeyLower) {
        repos.add(project.id);
        if (pullRequest.status === "Merged") {
          counts.mergedPrCount += 1;
        } else if (pullRequest.status === "Closed") {
          counts.closedPrCount += 1;
        }
        continue;
      }
      // Reviews only count on other authors' PRs, and only comments that
      // carry review weight (decisions and inline code comments).
      for (const comment of pullRequest.comments) {
        if (
          comment.author.toLowerCase() === pubkeyLower &&
          (comment.isApproval ||
            comment.isChangeRequest ||
            comment.isInlineComment)
        ) {
          counts.reviewCount += 1;
          repos.add(project.id);
        }
      }
    }
    for (const { issue, project } of workItems.issues.items) {
      if (issue.author.toLowerCase() === pubkeyLower) {
        counts.issuesOpenedCount += 1;
        repos.add(project.id);
      }
    }
    counts.repoCount = repos.size;
    return counts;
  }, [pubkeyLower, workItemsQuery.data]);
  const badges = React.useMemo(() => {
    if (!isAgent) {
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
    isAgent,
    memberChannels.length,
    memoryCount,
    profile,
    reactionsQuery.data,
  ]);
  const recordLoading =
    channelsQuery.isLoading || notesQuery.isLoading || contactsQuery.isLoading;
  const hasAgentRecord =
    viewerIsOwner && (managedAgent !== undefined || memoryCount !== null);
  const recordIsEmpty =
    !recordLoading &&
    memberChannels.length === 0 &&
    notes.length === 0 &&
    contactPubkeys.length === 0 &&
    ownedAgents.length === 0 &&
    !isSelf &&
    !hasAgentRecord;

  const copyKey = async () => {
    if (!npub) {
      return;
    }
    await writeTextToClipboard(npub);
    toast.success("Identity key copied.");
  };

  if (!pubkey) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-start justify-center overflow-y-auto p-10">
        <Skeleton className="h-96 w-80 rounded-3xl" />
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      data-testid="passport-screen"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pb-16 pt-10 sm:px-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Passport</h1>
          <p className="text-sm text-muted-foreground">
            {isSelf
              ? "Your portable identity and its record of travel across communities."
              : `${displayName}'s portable identity — the record shows what is visible to you.`}
          </p>
        </header>

        <div className="grid gap-10 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          {/* The card column stays pinned while the record scrolls. */}
          <div className="flex flex-col items-center gap-3 lg:sticky lg:top-6 lg:self-start">
            <PassportCard
              avatarUrl={profile?.avatarUrl ?? null}
              communityName={activeCommunity?.name ?? null}
              displayName={displayName}
              handle={profile?.nip05Handle ?? null}
              isAgent={isAgent}
              operatorName={operatorName}
              pubkey={pubkey}
            />
            <div className="flex items-center gap-1">
              <Button
                className="text-muted-foreground hover:text-foreground"
                data-testid="passport-screen-copy-key"
                onClick={() => void copyKey()}
                size="sm"
                variant="ghost"
              >
                <Copy className="mr-2 h-3.5 w-3.5" />
                Copy identity key
              </Button>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-8">
            {badges.length > 0 ? (
              <RecordSection
                label="Commendations · Badges"
                trailing={`${badges.length}`}
              >
                <PassportBadgeList badges={badges} />
              </RecordSection>
            ) : null}

            {visas.length > 0 ? (
              <RecordSection
                label="Visas · Servers"
                trailing={`${visas.length}`}
              >
                <StampPage>
                  {visas.map((visa, index) => (
                    <PassportStamp
                      index={index}
                      key={visa.key}
                      muted={visa.departed}
                      subtitle={visa.subtitle}
                      testId="passport-community-stamp"
                      title={visa.title}
                    />
                  ))}
                </StampPage>
              </RecordSection>
            ) : null}

            {memberChannels.length > 0 ? (
              <RecordSection
                label="Stamps · Channels"
                trailing={`${memberChannels.length}`}
              >
                <StampPage>
                  {memberChannels.map((channel, index) => (
                    <PassportStamp
                      index={index + 2}
                      key={channel.id}
                      onClick={() => void goChannel(channel.id)}
                      testId="passport-channel-stamp"
                      title={`#${channel.name}`}
                    />
                  ))}
                </StampPage>
              </RecordSection>
            ) : null}

            {ownedAgents.length > 0 ? (
              <RecordSection
                label="Operates · Agents"
                trailing={`${ownedAgents.length}`}
              >
                <AgentCrewList
                  agents={ownedAgents}
                  onOpenPassport={openAgentPassport}
                />
              </RecordSection>
            ) : null}

            {hasAgentRecord ? (
              <RecordSection label="Agent record · Operator only">
                <div className="flex flex-col gap-3">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                    {managedAgent ? (
                      <>
                        <AgentRecordField label="Status">
                          {managedAgent.status}
                        </AgentRecordField>
                        <AgentRecordField label="Harness">
                          {managedAgent.runtime ?? managedAgent.agentCommand}
                        </AgentRecordField>
                        {managedAgent.model ? (
                          <AgentRecordField label="Model">
                            {managedAgent.model}
                          </AgentRecordField>
                        ) : null}
                      </>
                    ) : null}
                    {memoryCount !== null ? (
                      <AgentRecordField label="Memories">
                        {memoryCount}
                      </AgentRecordField>
                    ) : null}
                  </dl>
                  {canOpenAgentActivity(pubkey) ? (
                    <div>
                      <Button
                        data-testid="passport-open-activity"
                        onClick={() => openAgentActivity(pubkey)}
                        size="sm"
                        variant="outline"
                      >
                        <Activity className="mr-2 h-3.5 w-3.5" />
                        Open activity log
                      </Button>
                    </div>
                  ) : null}
                </div>
              </RecordSection>
            ) : null}

            {notes.length > 0 ? (
              <RecordSection label="Log · Recent notes">
                <NoteRecordList notes={notes} />
              </RecordSection>
            ) : null}

            {contactPubkeys.length > 0 ? (
              <RecordSection
                label="Traveling with · Following"
                trailing={`${contactPubkeys.length}`}
              >
                <FollowingStrip
                  contactPubkeys={contactPubkeys}
                  profiles={contactProfilesQuery.data?.profiles ?? {}}
                />
              </RecordSection>
            ) : null}

            {recordLoading && memberChannels.length === 0 ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-3/4 rounded-xl" />
              </div>
            ) : null}
            {recordIsEmpty ? <EmptyRecord displayName={displayName} /> : null}

            {!isSelf && !viewerIsOwner ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <UserRound
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0"
                />
                You are viewing the public record. Holders and their operators
                see the full history — memories, activity, and communities.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentRecordField({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-3xs font-medium tracking-[0.25em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="truncate text-sm font-medium text-foreground/90">
        {children}
      </dd>
    </div>
  );
}
