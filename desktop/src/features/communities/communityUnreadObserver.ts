import { makeRootIdStore } from "@/features/channels/unreadRootIdStore";
import { DM_NOTIFIABLE_EVENT_KINDS } from "@/features/channels/isDmNotifiableKind";
import { mergeReadStateEventsStructured } from "@/features/channels/readState/readStateSnapshot";
import {
  isOverrideActive,
  maxReadAt,
  msgContextKey,
  type OverrideRegister,
} from "@/features/channels/readState/readStateFormat";
import { readStoredReadState } from "@/features/channels/readState/readStateStorage";
import { deduplicateByCoordinate } from "@/features/channels/readState/readStateFencedLoader";
import {
  getThreadReference,
  isBroadcastReply,
} from "@/features/messages/lib/threading";
import { shouldNotifyForEvent } from "@/features/notifications/lib/shouldNotify";
import {
  mutedChannelIdsFromStore,
  parseMutePayload,
} from "@/features/sidebar/lib/channelMutesStorage";
import type { Community } from "@/features/communities/types";
import { withReadOnlyRelayClient } from "@/shared/api/readOnlyRelayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { nip44DecryptFromSelf } from "@/shared/api/tauri";
import type { ChannelType, RelayEvent } from "@/shared/api/types";
import {
  CHANNEL_MESSAGE_EVENT_KINDS,
  HOME_MENTION_EVENT_KINDS,
  KIND_CHANNEL_MUTES,
  KIND_DM_VISIBILITY,
  KIND_READ_STATE,
} from "@/shared/constants/kinds";

const KIND_NIP29_GROUP_METADATA = 39000;
const KIND_NIP29_GROUP_MEMBERS = 39002;

// Stores for thread-relationship sets. Keyed by pubkey only (no relay/community),
// so they read correctly from the same origin regardless of which community is active.
const participationStore = makeRootIdStore("buzz-thread-participation.v1");
const authoredStore = makeRootIdStore("buzz-thread-authored.v1");
const mutedRootsStore = makeRootIdStore("buzz-thread-muted.v1");
const FOLLOWS_STORAGE_KEY_PREFIX = "buzz-thread-follows.v1";

export type ThreadRelationships = {
  participatedRootIds: ReadonlySet<string>;
  followedRootIds: ReadonlySet<string>;
  authoredRootIds: ReadonlySet<string>;
  mutedRootIds: ReadonlySet<string>;
};

function readFollowedRootIds(pubkey: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(
      `${FOLLOWS_STORAGE_KEY_PREFIX}:${pubkey}`,
    );
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const ids = new Set<string>();
    for (const entry of parsed) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.rootId === "string"
      ) {
        ids.add(entry.rootId);
      }
    }
    return ids;
  } catch {
    return new Set();
  }
}

function defaultReadThreadRelationships(pubkey: string): ThreadRelationships {
  return {
    participatedRootIds: participationStore.read(pubkey),
    followedRootIds: readFollowedRootIds(pubkey),
    authoredRootIds: authoredStore.read(pubkey),
    mutedRootIds: mutedRootsStore.read(pubkey),
  };
}

const MEMBER_CHANNEL_LIMIT = 1000;
const METADATA_LIMIT = 1000;
const UNREAD_EXISTENCE_LIMIT = 50;
const MENTION_COUNT_LIMIT = 100;
const READ_STATE_FETCH_LIMIT = 500;

export type CommunityUnreadObserverResult = {
  hasUnread: boolean;
  mentionCount: number;
};

type CommunityUnreadRelay = {
  fetchEvents(filter: RelaySubscriptionFilter): Promise<RelayEvent[]>;
};

type ObservedChannel = {
  id: string;
  channelType: ChannelType;
  archived: boolean;
};

/**
 * List the channels this pubkey is a member of on the observed relay,
 * excluding archived channels and hidden DMs — the same visibility set the
 * unread poll and "mark all as read" must agree on.
 */
export async function fetchObservedChannels(
  client: CommunityUnreadRelay,
  pubkey: string,
): Promise<ObservedChannel[]> {
  const memberEvents = await client.fetchEvents({
    kinds: [KIND_NIP29_GROUP_MEMBERS],
    "#p": [pubkey],
    limit: MEMBER_CHANNEL_LIMIT,
  });
  const channelIds = extractMemberChannelIds(memberEvents);
  if (channelIds.length === 0) {
    return [];
  }

  const [metadataEvents, visibilityEvents] = await Promise.all([
    client.fetchEvents({
      kinds: [KIND_NIP29_GROUP_METADATA],
      "#d": channelIds,
      limit: METADATA_LIMIT,
    }),
    client.fetchEvents({
      kinds: [KIND_DM_VISIBILITY],
      "#p": [pubkey],
      limit: 1,
    }),
  ]);

  const hiddenDmIds = extractHiddenDmIds(visibilityEvents);
  return resolveObservedChannels(channelIds, metadataEvents).filter(
    (channel) =>
      !channel.archived &&
      (channel.channelType !== "dm" || !hiddenDmIds.has(channel.id)),
  );
}

export async function pollCommunityUnread(
  community: Community,
  pubkey: string,
): Promise<CommunityUnreadObserverResult> {
  return withReadOnlyRelayClient(community.relayUrl, (client) =>
    fetchCommunityUnread({ client, pubkey }),
  );
}

export async function fetchCommunityUnread(args: {
  client: CommunityUnreadRelay;
  pubkey: string;
  nowSeconds?: number;
  decryptReadState?: (ciphertext: string) => Promise<string>;
  decryptMutes?: (ciphertext: string) => Promise<string>;
  readThreadRelationships?: (pubkey: string) => ThreadRelationships;
  /** Authoritative source (a): persisted override register projection. Defaults
   *  to `readStoredReadState(pubkey).overrideRegisters`. Inject for tests. */
  readStoredRegisters?: (
    pubkey: string,
  ) => ReadonlyMap<string, OverrideRegister>;
}): Promise<CommunityUnreadObserverResult> {
  const { client, pubkey } = args;
  const normalizedPubkey = pubkey.toLowerCase();
  const decryptMutes = args.decryptMutes ?? nip44DecryptFromSelf;
  const readRelationships =
    args.readThreadRelationships ?? defaultReadThreadRelationships;
  const getStoredRegisters =
    args.readStoredRegisters ??
    ((pk: string) => {
      try {
        return readStoredReadState(pk).overrideRegisters;
      } catch {
        return new Map<string, OverrideRegister>();
      }
    });

  const channels = await fetchObservedChannels(client, pubkey);
  if (channels.length === 0) {
    return { hasUnread: false, mentionCount: 0 };
  }

  const [readStateEvents, mutesEvents] = await Promise.all([
    // Override state is exempt from finite-horizon fetching: a register may be
    // older than seven days and must not be missed. Tag-free, no `since` filter.
    client.fetchEvents({
      kinds: [KIND_READ_STATE],
      authors: [pubkey],
      limit: READ_STATE_FETCH_LIMIT,
    }),
    client.fetchEvents({
      kinds: [KIND_CHANNEL_MUTES],
      authors: [pubkey],
      "#d": ["channel-mutes"],
      limit: 1,
    }),
  ]);

  // Authoritative source (b): coordinate-deduped registers decoded from fetched
  // events. deduplicateByCoordinate retains greatest created_at, lowest id.
  const readState = await mergeReadStateEventsStructured(
    deduplicateByCoordinate(readStateEvents),
    pubkey,
    args.decryptReadState,
  );

  // Authoritative source (a): persisted full-state projection from the manager's
  // last complete load. Merge with source (b): max() per field, so a register
  // present in only one source is retained.
  const storedRegisters = getStoredRegisters(normalizedPubkey);
  const mergedOverrides = new Map<string, OverrideRegister>(
    readState.overrides,
  );
  for (const [rawCtx, stored] of storedRegisters) {
    const fetched = mergedOverrides.get(rawCtx);
    if (!fetched) {
      mergedOverrides.set(rawCtx, stored);
    } else {
      mergedOverrides.set(rawCtx, {
        s: Math.max(fetched.s, stored.s),
        c: Math.max(fetched.c, stored.c),
        b: Math.max(fetched.b, stored.b),
      });
    }
  }

  let mutedIds = new Set<string>();
  if (mutesEvents.length > 0) {
    try {
      const plaintext = await decryptMutes(mutesEvents[0].content);
      const store = parseMutePayload(JSON.parse(plaintext));
      if (store) {
        mutedIds = mutedChannelIdsFromStore(store);
      }
    } catch {
      // decryption failure → treat as empty mutes set
    }
  }

  const {
    participatedRootIds,
    followedRootIds,
    authoredRootIds,
    mutedRootIds,
  } = readRelationships(normalizedPubkey);

  let hasUnread = false;
  let mentionCount = 0;

  for (const channel of channels) {
    if (mutedIds.has(channel.id)) continue;

    // Compute readAt from the merged frontiers.
    const readAt = readState.frontiers.get(channel.id) ?? null;

    // Override liveness: evaluate the merged authoritative register.
    // "No register in fetched events" is ambiguity, not absence — the local
    // cache is NOT a fallback verdict source here.
    if (!hasUnread) {
      const reg = mergedOverrides.get(channel.id);
      if (reg !== undefined && isOverrideActive(reg, readAt ?? 0)) {
        hasUnread = true;
      }
    }

    const since = readAt === null ? 0 : readAt + 1;
    const kinds = unreadKindsForChannel(channel.channelType);

    const unreadEventsPromise: Promise<RelayEvent[]> = hasUnread
      ? Promise.resolve([])
      : client.fetchEvents({
          kinds,
          "#h": [channel.id],
          since,
          limit: UNREAD_EXISTENCE_LIMIT,
        });
    const mentionEventsPromise: Promise<RelayEvent[]> = client.fetchEvents({
      kinds: [...HOME_MENTION_EVENT_KINDS],
      "#h": [channel.id],
      "#p": [pubkey],
      since,
      limit: MENTION_COUNT_LIMIT,
    });

    const [unreadEvents, mentionEvents] = await Promise.all([
      unreadEventsPromise,
      mentionEventsPromise,
    ]);

    if (!hasUnread) {
      hasUnread = unreadEvents.some(
        (event) =>
          isUnreadExternalEvent(
            event,
            readState.frontiers,
            readAt,
            normalizedPubkey,
          ) &&
          shouldNotifyForEvent(event, normalizedPubkey, {
            participatedRootIds,
            followedRootIds,
            authoredRootIds,
            mutedRootIds,
            mutedChannelIds: mutedIds,
            channelId: channel.id,
          }),
      );
    }

    mentionCount += mentionEvents.filter((event) =>
      isUnreadExternalEvent(
        event,
        readState.frontiers,
        readAt,
        normalizedPubkey,
      ),
    ).length;
  }

  return { hasUnread: hasUnread || mentionCount > 0, mentionCount };
}

export function extractMemberChannelIds(events: RelayEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    for (const tag of event.tags) {
      if (tag[0] === "d" && tag[1]) {
        ids.add(tag[1]);
      }
    }
  }
  return [...ids];
}

export function resolveObservedChannels(
  channelIds: string[],
  metadataEvents: RelayEvent[],
): ObservedChannel[] {
  const latestMetadata = new Map<string, RelayEvent>();
  for (const event of metadataEvents) {
    const channelId = tagValue(event, "d");
    if (!channelId) continue;
    const existing = latestMetadata.get(channelId);
    if (!existing || event.created_at > existing.created_at) {
      latestMetadata.set(channelId, event);
    }
  }

  return channelIds.map((id) => {
    const metadata = latestMetadata.get(id);
    const typeTag = metadata ? tagValue(metadata, "t") : null;
    return {
      id,
      channelType: toChannelType(typeTag),
      archived:
        metadata?.tags.some(
          (tag) => tag[0] === "archived" && tag[1] === "true",
        ) ?? false,
    };
  });
}

export function extractHiddenDmIds(events: RelayEvent[]): Set<string> {
  const latest = events.reduce<RelayEvent | null>(
    (current, event) =>
      current === null || event.created_at > current.created_at
        ? event
        : current,
    null,
  );
  return new Set(
    (latest?.tags ?? [])
      .filter((tag) => tag[0] === "h" && tag[1])
      .map((tag) => tag[1]),
  );
}

function unreadKindsForChannel(channelType: ChannelType): number[] {
  return channelType === "dm"
    ? [...DM_NOTIFIABLE_EVENT_KINDS]
    : [...CHANNEL_MESSAGE_EVENT_KINDS];
}

function isUnreadExternalEvent(
  event: RelayEvent,
  readState: ReadonlyMap<string, number>,
  channelReadAt: number | null,
  normalizedPubkey: string,
): boolean {
  if (event.pubkey.toLowerCase() === normalizedPubkey) return false;

  const rootId = isBroadcastReply(event.tags)
    ? null
    : getThreadReference(event.tags).rootId;
  const readAt = maxReadAt(
    channelReadAt,
    readState.get(msgContextKey(event.id)) ?? null,
    rootId === null ? null : (readState.get(`thread:${rootId}`) ?? null),
  );

  return readAt === null || event.created_at > readAt;
}

function tagValue(event: RelayEvent, name: string): string | null {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

function toChannelType(value: string | null): ChannelType {
  return value === "forum" || value === "dm" ? value : "stream";
}
