import assert from "node:assert/strict";
import test from "node:test";

import {
  extractHiddenDmIds,
  extractMemberChannelIds,
  fetchCommunityUnread,
  resolveObservedChannels,
} from "./communityUnreadObserver.ts";

const PUBKEY = "a".repeat(64);
const OTHER = "b".repeat(64);
const CHANNEL_ID = "channel-1";
const THREAD_ROOT = "c".repeat(64);
const THREAD_ROOT_2 = "d".repeat(64);

const EMPTY_RELATIONSHIPS = {
  participatedRootIds: new Set(),
  followedRootIds: new Set(),
  authoredRootIds: new Set(),
  mutedRootIds: new Set(),
};

function readRelationships(overrides = {}) {
  return () => ({ ...EMPTY_RELATIONSHIPS, ...overrides });
}

function event(overrides = {}) {
  return {
    id: overrides.id ?? `${Math.random()}`.padEnd(64, "0").slice(0, 64),
    pubkey: overrides.pubkey ?? OTHER,
    created_at: overrides.created_at ?? 100,
    kind: overrides.kind ?? 9,
    tags: overrides.tags ?? [],
    content: overrides.content ?? "",
    sig: overrides.sig ?? "sig",
  };
}

function relayFor(filters) {
  return {
    requests: [],
    async fetchEvents(filter) {
      this.requests.push(filter);
      return filters.shift()?.(filter) ?? [];
    },
  };
}

// Helper: encode a mutes payload as JSON (decryptMutes stub returns content as-is)
function mutesContent(mutedIds) {
  const channels = {};
  for (const id of mutedIds) {
    channels[id] = { muted: true, updatedAt: 1 };
  }
  return JSON.stringify({ version: 1, channels });
}

test("extractMemberChannelIds deduplicates d tags", () => {
  assert.deepEqual(
    extractMemberChannelIds([
      event({
        tags: [
          ["d", "one"],
          ["d", "two"],
        ],
      }),
      event({ tags: [["d", "one"]] }),
    ]),
    ["one", "two"],
  );
});

test("resolveObservedChannels uses latest metadata and archived flag", () => {
  assert.deepEqual(
    resolveObservedChannels(
      ["stream", "dm", "missing"],
      [
        event({
          created_at: 1,
          tags: [
            ["d", "dm"],
            ["t", "stream"],
          ],
        }),
        event({
          created_at: 2,
          tags: [
            ["d", "dm"],
            ["t", "dm"],
          ],
        }),
        event({
          tags: [
            ["d", "stream"],
            ["archived", "true"],
          ],
        }),
      ],
    ),
    [
      { id: "stream", channelType: "stream", archived: true },
      { id: "dm", channelType: "dm", archived: false },
      { id: "missing", channelType: "stream", archived: false },
    ],
  );
});

test("extractHiddenDmIds reads h tags from latest visibility snapshot", () => {
  assert.deepEqual(
    extractHiddenDmIds([
      event({ created_at: 1, tags: [["h", "old"]] }),
      event({
        created_at: 2,
        tags: [
          ["h", "new"],
          ["h", "other"],
        ],
      }),
    ]),
    new Set(["new", "other"]),
  );
});

test("fetchCommunityUnread returns dot and mention count without total unread count", async () => {
  const relay = relayFor([
    // 1. member events
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["p", PUBKEY],
        ],
      }),
    ],
    // 2. metadata events (parallel with visibility)
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["t", "stream"],
        ],
      }),
    ],
    // 3. visibility events (parallel with metadata)
    () => [],
    // 4. read-state events (parallel with mutes)
    () => [],
    // 5. mutes events (parallel with read-state)
    () => [],
    // 6. unread events
    () => [
      event({
        id: "unread".padEnd(64, "0"),
        created_at: 20,
        tags: [["h", CHANNEL_ID]],
      }),
    ],
    // 7. mention events
    () => [
      event({
        id: "mention".padEnd(64, "0"),
        created_at: 30,
        tags: [
          ["h", CHANNEL_ID],
          ["p", PUBKEY],
        ],
      }),
    ],
  ]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (value) => value,
    decryptMutes: async (value) => value,
    readThreadRelationships: readRelationships(),
  });

  assert.deepEqual(result, { hasUnread: true, mentionCount: 1 });
  assert.equal(relay.requests.at(-1)["#p"][0], PUBKEY);
});

test("fetchCommunityUnread ignores self-authored and read thread/message events", async () => {
  const threadReply = event({
    id: "reply".padEnd(64, "0"),
    created_at: 50,
    tags: [
      ["h", CHANNEL_ID],
      ["e", THREAD_ROOT, "", "root"],
      ["e", "parent".padEnd(64, "0"), "", "reply"],
      ["p", PUBKEY],
    ],
  });
  const selfMention = event({
    id: "self".padEnd(64, "0"),
    pubkey: PUBKEY,
    created_at: 70,
    tags: [
      ["h", CHANNEL_ID],
      ["p", PUBKEY],
    ],
  });

  const relay = relayFor([
    // 1. member events
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["p", PUBKEY],
        ],
      }),
    ],
    // 2. metadata events (parallel with visibility)
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["t", "stream"],
        ],
      }),
    ],
    // 3. visibility events (parallel with metadata)
    () => [],
    // 4. read-state events (parallel with mutes)
    () => [
      event({
        pubkey: PUBKEY,
        created_at: 80,
        tags: [
          ["d", "read-state:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"],
          ["t", "read-state"],
        ],
        content: JSON.stringify({
          v: 1,
          client_id: "client",
          contexts: {
            [CHANNEL_ID]: 10,
            [`thread:${THREAD_ROOT}`]: 60,
          },
        }),
      }),
    ],
    // 5. mutes events (parallel with read-state)
    () => [],
    // 6. unread events
    () => [threadReply, selfMention],
    // 7. mention events
    () => [threadReply, selfMention],
  ]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (value) => value,
    decryptMutes: async (value) => value,
    readThreadRelationships: readRelationships(),
  });

  assert.deepEqual(result, { hasUnread: false, mentionCount: 0 });
});

test("fetchCommunityUnread excludes muted-only channel — returns hasUnread:false mentionCount:0", async () => {
  const MUTED_CHANNEL = "muted-channel-1";

  const relay = relayFor([
    // 1. member events — one muted channel
    () => [
      event({
        tags: [
          ["d", MUTED_CHANNEL],
          ["p", PUBKEY],
        ],
      }),
    ],
    // 2. metadata events (parallel with visibility)
    () => [
      event({
        tags: [
          ["d", MUTED_CHANNEL],
          ["t", "stream"],
        ],
      }),
    ],
    // 3. visibility events (parallel with metadata)
    () => [],
    // 4. read-state events (parallel with mutes)
    () => [],
    // 5. mutes events — MUTED_CHANNEL is muted
    () => [
      event({
        pubkey: PUBKEY,
        content: mutesContent([MUTED_CHANNEL]),
      }),
    ],
    // No per-channel fetches should follow — muted channel is skipped
  ]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (value) => value,
    decryptMutes: async (value) => value,
    readThreadRelationships: readRelationships(),
  });

  assert.deepEqual(result, { hasUnread: false, mentionCount: 0 });
});

test("fetchCommunityUnread counts unmuted channel but skips muted channel", async () => {
  const UNMUTED_CHANNEL = "channel-unmuted";
  const MUTED_CHANNEL = "channel-muted";

  const relay = relayFor([
    // 1. member events — two channels
    () => [
      event({
        tags: [
          ["d", UNMUTED_CHANNEL],
          ["d", MUTED_CHANNEL],
          ["p", PUBKEY],
        ],
      }),
    ],
    // 2. metadata events (parallel with visibility)
    () => [
      event({
        tags: [
          ["d", UNMUTED_CHANNEL],
          ["t", "stream"],
        ],
      }),
      event({
        tags: [
          ["d", MUTED_CHANNEL],
          ["t", "stream"],
        ],
      }),
    ],
    // 3. visibility events (parallel with metadata)
    () => [],
    // 4. read-state events (parallel with mutes)
    () => [],
    // 5. mutes events — only MUTED_CHANNEL is muted
    () => [
      event({
        pubkey: PUBKEY,
        content: mutesContent([MUTED_CHANNEL]),
      }),
    ],
    // 6. unread events for UNMUTED_CHANNEL (muted channel loop iteration never fires)
    () => [
      event({
        id: "unread".padEnd(64, "0"),
        created_at: 20,
        tags: [["h", UNMUTED_CHANNEL]],
      }),
    ],
    // 7. mention events for UNMUTED_CHANNEL
    () => [
      event({
        id: "mention".padEnd(64, "0"),
        created_at: 30,
        tags: [
          ["h", UNMUTED_CHANNEL],
          ["p", PUBKEY],
        ],
      }),
    ],
  ]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (value) => value,
    decryptMutes: async (value) => value,
    readThreadRelationships: readRelationships(),
  });

  assert.deepEqual(result, { hasUnread: true, mentionCount: 1 });
});

test("fetchCommunityUnread treats decryption failure as empty mutes set", async () => {
  const relay = relayFor([
    // 1. member events
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["p", PUBKEY],
        ],
      }),
    ],
    // 2. metadata events (parallel with visibility)
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["t", "stream"],
        ],
      }),
    ],
    // 3. visibility events (parallel with metadata)
    () => [],
    // 4. read-state events (parallel with mutes)
    () => [],
    // 5. mutes events — present but decryption will throw
    () => [
      event({
        pubkey: PUBKEY,
        content: "corrupted-ciphertext",
      }),
    ],
    // 6. unread events — channel is NOT muted (decryption failed → empty set)
    () => [
      event({
        id: "unread".padEnd(64, "0"),
        created_at: 20,
        tags: [["h", CHANNEL_ID]],
      }),
    ],
    // 7. mention events
    () => [],
  ]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (value) => value,
    decryptMutes: async () => {
      throw new Error("decryption failed");
    },
    readThreadRelationships: readRelationships(),
  });

  // Channel counted as if no mutes
  assert.deepEqual(result, { hasUnread: true, mentionCount: 0 });
});

test("fetchCommunityUnread treats absent mutes blob as empty mutes set", async () => {
  const relay = relayFor([
    // 1. member events
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["p", PUBKEY],
        ],
      }),
    ],
    // 2. metadata events (parallel with visibility)
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["t", "stream"],
        ],
      }),
    ],
    // 3. visibility events (parallel with metadata)
    () => [],
    // 4. read-state events (parallel with mutes)
    () => [],
    // 5. mutes events — none
    () => [],
    // 6. unread events
    () => [
      event({
        id: "unread".padEnd(64, "0"),
        created_at: 20,
        tags: [["h", CHANNEL_ID]],
      }),
    ],
    // 7. mention events
    () => [],
  ]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (value) => value,
    decryptMutes: async (value) => value,
    readThreadRelationships: readRelationships(),
  });

  assert.deepEqual(result, { hasUnread: true, mentionCount: 0 });
});

// ── Thread-relevance gate tests ────────────────────────────────────────────

function threadedReplyEvent(overrides = {}) {
  return event({
    id: overrides.id ?? "reply".padEnd(64, "0"),
    created_at: overrides.created_at ?? 20,
    pubkey: overrides.pubkey ?? OTHER,
    tags: [
      ["h", CHANNEL_ID],
      ["e", THREAD_ROOT_2, "", "root"],
      ["e", "parent".padEnd(64, "0"), "", "reply"],
      ...(overrides.extraTags ?? []),
    ],
    ...overrides,
  });
}

function baseRelay(unreadEvent, mutesPayload = null) {
  return relayFor([
    // 1. member events
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["p", PUBKEY],
        ],
      }),
    ],
    // 2. metadata events (parallel with visibility)
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["t", "stream"],
        ],
      }),
    ],
    // 3. visibility events (parallel with metadata)
    () => [],
    // 4. read-state events (parallel with mutes)
    () => [],
    // 5. mutes events
    () =>
      mutesPayload ? [event({ pubkey: PUBKEY, content: mutesPayload })] : [],
    // 6. unread events — the single event under test
    () => [unreadEvent],
    // 7. mention events
    () => [],
  ]);
}

test("fetchCommunityUnread threaded reply in untracked root → hasUnread:false", async () => {
  const relay = baseRelay(threadedReplyEvent());

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    // No root in any set → gate rejects the threaded reply
    readThreadRelationships: readRelationships(),
  });

  assert.deepEqual(result, { hasUnread: false, mentionCount: 0 });
});

test("fetchCommunityUnread threaded reply in participatedRootIds → hasUnread:true", async () => {
  const relay = baseRelay(threadedReplyEvent());

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    readThreadRelationships: readRelationships({
      participatedRootIds: new Set([THREAD_ROOT_2]),
    }),
  });

  assert.deepEqual(result, { hasUnread: true, mentionCount: 0 });
});

test("fetchCommunityUnread #p-mention reply in untracked root → hasUnread:true (mention overrides)", async () => {
  // A @mention of the user bypasses the follow/participation gate
  const relay = baseRelay(
    threadedReplyEvent({
      id: "mention-reply".padEnd(64, "0"),
      extraTags: [["p", PUBKEY]],
    }),
  );

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    readThreadRelationships: readRelationships(),
  });

  assert.deepEqual(result, { hasUnread: true, mentionCount: 0 });
});

test("fetchCommunityUnread top-level post → hasUnread:true (no thread gate)", async () => {
  // Top-level posts have no parentId — shouldNotifyForEvent returns true
  const relay = baseRelay(
    event({
      id: "toplevel".padEnd(64, "0"),
      created_at: 20,
      tags: [["h", CHANNEL_ID]],
    }),
  );

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    readThreadRelationships: readRelationships(),
  });

  assert.deepEqual(result, { hasUnread: true, mentionCount: 0 });
});

test("fetchCommunityUnread threaded reply whose root is in mutedRootIds → hasUnread:false", async () => {
  const relay = baseRelay(
    threadedReplyEvent({ id: "muted-reply".padEnd(64, "0") }),
  );

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    // Root is participated but also muted — mute wins
    readThreadRelationships: readRelationships({
      participatedRootIds: new Set([THREAD_ROOT_2]),
      mutedRootIds: new Set([THREAD_ROOT_2]),
    }),
  });

  assert.deepEqual(result, { hasUnread: false, mentionCount: 0 });
});

// ── Override register authoritative source tests ──────────────────────────

// A relay that serves one channel (CHANNEL_ID) as a member channel,
// with no read state and no incoming events.
function quietRelay() {
  return relayFor([
    // 1. member events
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["p", PUBKEY],
        ],
      }),
    ],
    // 2. metadata events (parallel with visibility)
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["t", "stream"],
        ],
      }),
    ],
    // 3. visibility events
    () => [],
    // 4. read-state events (parallel with mutes)
    () => [],
    // 5. mutes events
    () => [],
    // 6. unread events — none
    () => [],
    // 7. mention events — none
    () => [],
  ]);
}

// A relay that serves one channel (CHANNEL_ID) with a synced read marker at
// the given unix-second timestamp and no new incoming events.
function quietRelayWithReadState(readAtSeconds) {
  return relayFor([
    // 1. member events
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["p", PUBKEY],
        ],
      }),
    ],
    // 2. metadata events (parallel with visibility)
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["t", "stream"],
        ],
      }),
    ],
    // 3. visibility events
    () => [],
    // 4. read-state events (parallel with mutes)
    () => [
      event({
        pubkey: PUBKEY,
        created_at: 200,
        tags: [
          ["d", "read-state:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"],
          ["t", "read-state"],
        ],
        content: JSON.stringify({
          v: 1,
          client_id: "client",
          contexts: { [CHANNEL_ID]: readAtSeconds },
        }),
      }),
    ],
    // 5. mutes events
    () => [],
    // 6. unread events — none (marker covers everything)
    () => [],
    // 7. mention events — none
    () => [],
  ]);
}

test("fetchCommunityUnread stored active register lights rail (hasUnread:true)", async () => {
  // Authoritative source (a): stored register is active (S=1,C=0,B=0 with F=0).
  // The fetch returns no override events — stored register is the authority.
  const relay = quietRelay();
  // Active register: S=1, C=0, B=0 (baseline), frontier=0 → override_active = true
  const storedRegisters = new Map([[CHANNEL_ID, { s: 1, c: 0, b: 0 }]]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    readThreadRelationships: readRelationships(),
    readStoredRegisters: () => storedRegisters,
  });

  assert.deepEqual(result, { hasUnread: true, mentionCount: 0 });
});

test("fetchCommunityUnread stored tombstoned register does NOT light rail (hasUnread:false)", async () => {
  // Authoritative source (a): stored register is tombstoned (S=1,C=1 → S=C, inactive).
  // Local cache cannot contradict this — must not light the dot.
  const relay = quietRelay();
  // Tombstoned: S=1, C=1, B=0 → override_active = false (S > C fails: 1 > 1 = false)
  const storedRegisters = new Map([[CHANNEL_ID, { s: 1, c: 1, b: 0 }]]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    readThreadRelationships: readRelationships(),
    readStoredRegisters: () => storedRegisters,
  });

  assert.deepEqual(result, { hasUnread: false, mentionCount: 0 });
});

test("fetchCommunityUnread old active register beyond horizon still lights rail", async () => {
  // An active register that is older than the 7-day horizon must still light
  // the rail. The fetch is tag-free and has no `since`, so it returns no
  // events here, but the stored projection (authoritative source a) is used.
  const relay = quietRelay();
  const VERY_OLD_FRONTIER = 1; // far beyond any 7-day horizon
  // S=1, C=0, B=VERY_OLD_FRONTIER, and frontier=VERY_OLD_FRONTIER → active
  const storedRegisters = new Map([
    [CHANNEL_ID, { s: 1, c: 0, b: VERY_OLD_FRONTIER }],
  ]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100 + 7 * 24 * 3600 + 1, // past the old 7-day cutoff
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    readThreadRelationships: readRelationships(),
    readStoredRegisters: () => storedRegisters,
  });

  assert.deepEqual(result, { hasUnread: true, mentionCount: 0 });
});

test("fetchCommunityUnread no stored register and empty fetch → falls through to relay gate", async () => {
  // No stored registers, no override event fetched, but a real unread event exists.
  const relay = relayFor([
    // 1. member events
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["p", PUBKEY],
        ],
      }),
    ],
    // 2. metadata
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["t", "stream"],
        ],
      }),
    ],
    // 3. visibility
    () => [],
    // 4. read-state — empty
    () => [],
    // 5. mutes
    () => [],
    // 6. unread events — one real unread
    () => [
      event({
        id: "real-unread".padEnd(64, "0"),
        created_at: 20,
        tags: [["h", CHANNEL_ID]],
      }),
    ],
    // 7. mention events
    () => [],
  ]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    readThreadRelationships: readRelationships(),
    readStoredRegisters: () => new Map(), // no stored registers
  });

  assert.deepEqual(result, { hasUnread: true, mentionCount: 0 });
});

test("fetchCommunityUnread channel not in member list → hasUnread:false", async () => {
  // No members — register lookup is never reached.
  const relay = relayFor([
    () => [], // member events empty
  ]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    readThreadRelationships: readRelationships(),
    readStoredRegisters: () => new Map([[CHANNEL_ID, { s: 1, c: 0, b: 0 }]]),
  });

  assert.deepEqual(result, { hasUnread: false, mentionCount: 0 });
});

test("fetchCommunityUnread active register muted channel → hasUnread:false", async () => {
  // Override is active, but the channel is muted — mute wins.
  const relay = relayFor([
    // 1. member events
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["p", PUBKEY],
        ],
      }),
    ],
    // 2. metadata
    () => [
      event({
        tags: [
          ["d", CHANNEL_ID],
          ["t", "stream"],
        ],
      }),
    ],
    // 3. visibility
    () => [],
    // 4. read-state
    () => [],
    // 5. mutes — CHANNEL_ID is muted
    () => [
      event({
        pubkey: PUBKEY,
        content: mutesContent([CHANNEL_ID]),
      }),
    ],
    // No per-channel fetches expected — muted channel is skipped
  ]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 100,
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    readThreadRelationships: readRelationships(),
    // Active register, but channel is muted — mute wins
    readStoredRegisters: () => new Map([[CHANNEL_ID, { s: 1, c: 0, b: 0 }]]),
  });

  assert.deepEqual(result, { hasUnread: false, mentionCount: 0 });
});

test("fetchCommunityUnread frontier advance deactivates stored register → hasUnread:false", async () => {
  // Register: S=1, C=0, B=50 (active only when F<=50).
  // Fetched frontier: 100 > 50 → override_active = false.
  const relay = quietRelayWithReadState(100);
  // B=50 means active only when F<=50; fetched frontier is 100 → inactive
  const storedRegisters = new Map([[CHANNEL_ID, { s: 1, c: 0, b: 50 }]]);

  const result = await fetchCommunityUnread({
    client: relay,
    pubkey: PUBKEY,
    nowSeconds: 200,
    decryptReadState: async (v) => v,
    decryptMutes: async (v) => v,
    readThreadRelationships: readRelationships(),
    readStoredRegisters: () => storedRegisters,
  });

  assert.deepEqual(result, { hasUnread: false, mentionCount: 0 });
});
