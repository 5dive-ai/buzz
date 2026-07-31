import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeOverrideGroup,
  escapeFrontierKey,
  isOverrideActive,
  isOverrideKey,
  isValidReadStateDTag,
  mergeOverrideRegisters,
  OV_B_PREFIX,
  OV_C_PREFIX,
  OV_S_PREFIX,
  parseContexts,
  sanitizeContexts,
  unescapeFrontierKey,
} from "./readStateFormat.ts";

import {
  computeOverrideLiveness,
  mergeOverrideRegisterMaps,
  mergeReadStateEventsStructured,
  parseReadStateEvent,
} from "./readStateSnapshot.ts";

// ---------------------------------------------------------------------------
// Helpers for event-level integration tests
// ---------------------------------------------------------------------------

// Valid 32-lowercase-hex slot IDs per NIP-RS spec :55/:68.
const SLOT_A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const SLOT_B = "1234567890abcdef1234567890abcdef";

/**
 * Build a minimal fake RelayEvent whose content decrypts to a ReadStateBlob
 * JSON string.  The decrypt function is provided by the caller so no real
 * NIP-44 crypto is needed in tests.
 */
function makeEvent(pubkey, dTagSlot, blobContexts) {
  const blob = { v: 1, client_id: "test-client", contexts: blobContexts };
  const plaintext = JSON.stringify(blob);
  return {
    event: {
      id: "a".repeat(64),
      pubkey,
      created_at: 1_000_000,
      kind: 30078,
      tags: [
        ["d", `read-state:${dTagSlot}`],
        ["t", "read-state"],
      ],
      content: plaintext,
      sig: "b".repeat(128),
    },
    // decrypt ignores ciphertext, just returns the plaintext for this fake event
    decrypt: async () => plaintext,
  };
}

/**
 * Drive a single fake event through parseReadStateEvent.
 */
async function parseFakeEvent(pubkey, dTagSlot, blobContexts) {
  const { event, decrypt } = makeEvent(pubkey, dTagSlot, blobContexts);
  return parseReadStateEvent(event, pubkey, decrypt);
}

/**
 * Drive a list of fake events through mergeReadStateEventsStructured.
 * Each item is { dTagSlot, blobContexts }.
 */
async function mergeFakeEvents(pubkey, specs) {
  const events = [];
  const decryptMap = new Map();

  for (const { dTagSlot, blobContexts } of specs) {
    const { event, decrypt } = makeEvent(pubkey, dTagSlot, blobContexts);
    events.push(event);
    decryptMap.set(event.content, decrypt);
  }

  // single decrypt that dispatches by content
  const decrypt = (ciphertext) => decryptMap.get(ciphertext)(ciphertext);
  return mergeReadStateEventsStructured(events, pubkey, decrypt);
}

// ---------------------------------------------------------------------------
// escapeFrontierKey / unescapeFrontierKey
// ---------------------------------------------------------------------------

test("escapeFrontierKey_normalCtx_passesThrough", () => {
  assert.equal(escapeFrontierKey("some-channel-uuid"), "some-channel-uuid");
});

test("escapeFrontierKey_ovPrefix_prepentsEsc", () => {
  assert.equal(escapeFrontierKey("ov_s:evil"), "esc:ov_s:evil");
});

test("escapeFrontierKey_escPrefix_prepentsEsc", () => {
  assert.equal(escapeFrontierKey("esc:foo"), "esc:esc:foo");
});

test("escapeFrontierKey_ovStem_prepentsEsc", () => {
  assert.equal(escapeFrontierKey("ov_c:something"), "esc:ov_c:something");
});

test("unescapeFrontierKey_noEscPrefix_passesThrough", () => {
  assert.equal(unescapeFrontierKey("some-channel-uuid"), "some-channel-uuid");
});

test("unescapeFrontierKey_singleEscPrefix_strips", () => {
  assert.equal(unescapeFrontierKey("esc:ov_s:evil"), "ov_s:evil");
});

test("unescapeFrontierKey_doubleEscPrefix_stripsExactlyOne", () => {
  // Must NOT strip more than one esc: prefix per spec.
  assert.equal(unescapeFrontierKey("esc:esc:foo"), "esc:foo");
});

test("escape_then_unescape_isIdentity", () => {
  const raw = "ov_s:tricky";
  assert.equal(unescapeFrontierKey(escapeFrontierKey(raw)), raw);
});

test("escape_then_unescape_isIdentity_escPrefixed", () => {
  const raw = "esc:already-escaped";
  assert.equal(unescapeFrontierKey(escapeFrontierKey(raw)), raw);
});

test("escape_then_unescape_isIdentity_normalCtx", () => {
  const raw = "msg:deadbeef";
  assert.equal(unescapeFrontierKey(escapeFrontierKey(raw)), raw);
});

// ---------------------------------------------------------------------------
// isOverrideKey
// ---------------------------------------------------------------------------

test("isOverrideKey_ovS_returnsTrue", () => {
  assert.equal(isOverrideKey("ov_s:ctx"), true);
});

test("isOverrideKey_ovC_returnsTrue", () => {
  assert.equal(isOverrideKey("ov_c:ctx"), true);
});

test("isOverrideKey_ovB_returnsTrue", () => {
  assert.equal(isOverrideKey("ov_b:ctx"), true);
});

test("isOverrideKey_frontierKey_returnsFalse", () => {
  assert.equal(isOverrideKey("some-channel"), false);
});

test("isOverrideKey_escapedKey_returnsFalse", () => {
  // esc:ov_s:… is a FRONTIER key, not an override key.
  assert.equal(isOverrideKey("esc:ov_s:ctx"), false);
});

// ---------------------------------------------------------------------------
// isOverrideActive — liveness predicate
// ---------------------------------------------------------------------------

test("isOverrideActive_liveOverride_returnsTrue", () => {
  // S=2, C=1, B=100, F=50 → S>0 ∧ F<=B ∧ S>C
  assert.equal(isOverrideActive({ s: 2, c: 1, b: 100 }, 50), true);
});

test("isOverrideActive_virginRegister_returnsFalse", () => {
  assert.equal(isOverrideActive({ s: 0, c: 0, b: 0 }, 0), false);
});

test("isOverrideActive_frontierExceedsBaseline_returnsFalse", () => {
  // Frontier advance dominates: F=200 > B=100
  assert.equal(isOverrideActive({ s: 1, c: 0, b: 100 }, 200), false);
});

test("isOverrideActive_frontierEqualsBaseline_returnsTrue", () => {
  // F <= B (equals case): still active
  assert.equal(isOverrideActive({ s: 1, c: 0, b: 100 }, 100), true);
});

test("isOverrideActive_clearWinsTie_returnsFalse", () => {
  // S == C with S > 0 → clear-wins: inactive
  assert.equal(isOverrideActive({ s: 1, c: 1, b: 100 }, 50), false);
});

test("isOverrideActive_clearCounter_exceedsSet_returnsFalse", () => {
  assert.equal(isOverrideActive({ s: 1, c: 2, b: 100 }, 50), false);
});

test("isOverrideActive_tombstoneFloor_returnsFalse", () => {
  // Tombstone floor shape: s=0, c=k, b=0
  assert.equal(isOverrideActive({ s: 0, c: 5, b: 0 }, 0), false);
});

test("isOverrideActive_uint32Max_liveOverride_returnsTrue", () => {
  // Boundary: S at uint32 max, C one less, B at max, F at zero
  const UINT32_MAX = 4294967295;
  assert.equal(
    isOverrideActive({ s: UINT32_MAX, c: UINT32_MAX - 1, b: UINT32_MAX }, 0),
    true,
  );
});

test("isOverrideActive_uint32Max_zeroFrontier_tile_returnsFalse", () => {
  // S == C at max → clear-wins
  const UINT32_MAX = 4294967295;
  assert.equal(
    isOverrideActive({ s: UINT32_MAX, c: UINT32_MAX, b: 1 }, 0),
    false,
  );
});

// ---------------------------------------------------------------------------
// mergeOverrideRegisters — componentwise max()
// ---------------------------------------------------------------------------

test("mergeOverrideRegisters_takesMaxPerComponent", () => {
  const a = { s: 3, c: 1, b: 50 };
  const b = { s: 1, c: 4, b: 80 };
  assert.deepEqual(mergeOverrideRegisters(a, b), { s: 3, c: 4, b: 80 });
});

test("mergeOverrideRegisters_commutative", () => {
  const a = { s: 5, c: 2, b: 10 };
  const b = { s: 2, c: 7, b: 30 };
  assert.deepEqual(mergeOverrideRegisters(a, b), mergeOverrideRegisters(b, a));
});

test("mergeOverrideRegisters_idempotent", () => {
  const a = { s: 3, c: 3, b: 100 };
  assert.deepEqual(mergeOverrideRegisters(a, a), a);
});

test("mergeOverrideRegisters_associative", () => {
  const a = { s: 1, c: 0, b: 10 };
  const b = { s: 0, c: 2, b: 20 };
  const c = { s: 3, c: 1, b: 5 };
  assert.deepEqual(
    mergeOverrideRegisters(mergeOverrideRegisters(a, b), c),
    mergeOverrideRegisters(a, mergeOverrideRegisters(b, c)),
  );
});

test("mergeOverrideRegisters_zeroBoundary_idempotent", () => {
  const zero = { s: 0, c: 0, b: 0 };
  assert.deepEqual(mergeOverrideRegisters(zero, zero), zero);
});

test("mergeOverrideRegisters_uint32Max_idempotent", () => {
  const UINT32_MAX = 4294967295;
  const max = { s: UINT32_MAX, c: UINT32_MAX, b: UINT32_MAX };
  assert.deepEqual(mergeOverrideRegisters(max, max), max);
});

test("mergeOverrideRegisters_uint32Max_commutative", () => {
  const UINT32_MAX = 4294967295;
  const a = { s: UINT32_MAX, c: 0, b: UINT32_MAX };
  const b = { s: 0, c: UINT32_MAX, b: 0 };
  assert.deepEqual(mergeOverrideRegisters(a, b), mergeOverrideRegisters(b, a));
  assert.deepEqual(mergeOverrideRegisters(a, b), {
    s: UINT32_MAX,
    c: UINT32_MAX,
    b: UINT32_MAX,
  });
});

// ---------------------------------------------------------------------------
// encodeOverrideGroup — canonical wire encoding
// ---------------------------------------------------------------------------

test("encodeOverrideGroup_virginRegister_returnsEmpty", () => {
  const patch = encodeOverrideGroup("ctx", { s: 0, c: 0, b: 0 }, 0);
  assert.deepEqual(patch, {});
});

test("encodeOverrideGroup_liveOverride_returnsThreeKeys", () => {
  const patch = encodeOverrideGroup("ctx", { s: 2, c: 1, b: 100 }, 50);
  assert.deepEqual(patch, {
    [`${OV_S_PREFIX}ctx`]: 2,
    [`${OV_C_PREFIX}ctx`]: 1,
    [`${OV_B_PREFIX}ctx`]: 100,
  });
});

test("encodeOverrideGroup_deadOverride_returnsOnlyOvC", () => {
  // Dead: S=1, C=2 (clear-wins) → tombstone floor ov_c = max(1,2) = 2
  const patch = encodeOverrideGroup("ctx", { s: 1, c: 2, b: 100 }, 50);
  assert.deepEqual(patch, { [`${OV_C_PREFIX}ctx`]: 2 });
});

test("encodeOverrideGroup_tieRegister_returnsOnlyOvC", () => {
  // Tie S==C → clear-wins → tombstone floor
  const patch = encodeOverrideGroup("ctx", { s: 3, c: 3, b: 100 }, 50);
  assert.deepEqual(patch, { [`${OV_C_PREFIX}ctx`]: 3 });
});

test("encodeOverrideGroup_frontierDominated_returnsOnlyOvC", () => {
  // Frontier past baseline: live rule fails → tombstone floor
  const patch = encodeOverrideGroup("ctx", { s: 1, c: 0, b: 100 }, 200);
  assert.deepEqual(patch, { [`${OV_C_PREFIX}ctx`]: 1 });
});

test("encodeOverrideGroup_tombstoneFloorShape_returnsOnlyOvC", () => {
  // Pre-compacted floor: s=0, c=5, b=0 → dead → tombstone max(0,5)=5
  const patch = encodeOverrideGroup("ctx", { s: 0, c: 5, b: 0 }, 0);
  assert.deepEqual(patch, { [`${OV_C_PREFIX}ctx`]: 5 });
});

// ---------------------------------------------------------------------------
// parseContexts — structured decode (group-first validation, unescape, 256-byte)
// ---------------------------------------------------------------------------

// ── accepted shapes ─────────────────────────────────────────────────────────

test("parseContexts_liveGroup_populatesBothMaps", () => {
  const raw = {
    "channel:x": 1000,
    "ov_s:channel:x": 1,
    "ov_c:channel:x": 0,
    "ov_b:channel:x": 900,
  };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("channel:x"), 1000);
  assert.deepEqual(overrides.get("channel:x"), { s: 1, c: 0, b: 900 });
  assert.equal(overrides.size, 1);
  // No ov_* keys in frontiers
  assert.equal(frontiers.has("ov_s:channel:x"), false);
});

test("parseContexts_tombstoneFloor_populatesBothMaps", () => {
  const raw = {
    "channel:x": 1000,
    "ov_c:channel:x": 5,
  };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("channel:x"), 1000);
  assert.deepEqual(overrides.get("channel:x"), { s: 0, c: 5, b: 0 });
  assert.equal(overrides.size, 1);
});

test("parseContexts_normalFrontierOnly_noOverrides", () => {
  const raw = {
    "ch:normal": 5000,
    "msg:abc": 3000,
    "thread:def": 2000,
  };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:normal"), 5000);
  assert.equal(frontiers.get("msg:abc"), 3000);
  assert.equal(frontiers.get("thread:def"), 2000);
  assert.equal(overrides.size, 0);
});

test("parseContexts_escapedFrontierKey_unescapedInFrontiers", () => {
  // Wire key esc:ov_s:evil → raw ctx ov_s:evil
  const raw = { "esc:ov_s:evil": 777 };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ov_s:evil"), 777);
  assert.equal(frontiers.has("esc:ov_s:evil"), false);
  assert.equal(overrides.size, 0);
});

test("parseContexts_doubleEscapedFrontierKey_stripsOneEsc", () => {
  // Wire key esc:esc:foo → raw ctx esc:foo
  const raw = { "esc:esc:foo": 888 };
  const { frontiers } = parseContexts(raw);
  assert.equal(frontiers.get("esc:foo"), 888);
  assert.equal(frontiers.has("esc:esc:foo"), false);
});

// ── partial-group rejection matrix (every illegal subset) ───────────────────

test("parseContexts_sOnly_droppedFrontierRetained", () => {
  const raw = { "ch:x": 100, "ov_s:ch:x": 1 };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:x"), 100);
  assert.equal(overrides.has("ch:x"), false);
});

test("parseContexts_bOnly_droppedFrontierRetained", () => {
  const raw = { "ch:x": 100, "ov_b:ch:x": 50 };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:x"), 100);
  assert.equal(overrides.has("ch:x"), false);
});

test("parseContexts_sConly_droppedFrontierRetained", () => {
  const raw = { "ch:x": 100, "ov_s:ch:x": 1, "ov_c:ch:x": 0 };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:x"), 100);
  assert.equal(overrides.has("ch:x"), false);
});

test("parseContexts_sBonly_droppedFrontierRetained", () => {
  const raw = { "ch:x": 100, "ov_s:ch:x": 1, "ov_b:ch:x": 50 };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:x"), 100);
  assert.equal(overrides.has("ch:x"), false);
});

test("parseContexts_cBonly_droppedFrontierRetained", () => {
  const raw = { "ch:x": 100, "ov_c:ch:x": 2, "ov_b:ch:x": 50 };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:x"), 100);
  assert.equal(overrides.has("ch:x"), false);
});

// ── invalid sibling at each position ────────────────────────────────────────

test("parseContexts_invalidS_liveGroupDropped", () => {
  const raw = {
    "ch:x": 100,
    "ov_s:ch:x": "not-a-number",
    "ov_c:ch:x": 0,
    "ov_b:ch:x": 50,
  };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:x"), 100);
  assert.equal(overrides.has("ch:x"), false);
});

test("parseContexts_invalidC_liveGroupDropped", () => {
  const raw = {
    "ch:x": 100,
    "ov_s:ch:x": 1,
    "ov_c:ch:x": 1.5,
    "ov_b:ch:x": 50,
  };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:x"), 100);
  assert.equal(overrides.has("ch:x"), false);
});

test("parseContexts_invalidB_liveGroupDropped", () => {
  const raw = { "ch:x": 100, "ov_s:ch:x": 1, "ov_c:ch:x": 0, "ov_b:ch:x": -1 };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:x"), 100);
  assert.equal(overrides.has("ch:x"), false);
});

test("parseContexts_uint32Overflow_liveGroupDropped", () => {
  const raw = {
    "ch:x": 100,
    "ov_s:ch:x": 4294967296,
    "ov_c:ch:x": 0,
    "ov_b:ch:x": 50,
  };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:x"), 100);
  assert.equal(overrides.has("ch:x"), false);
});

test("parseContexts_invalidC_tombstoneDropped", () => {
  const raw = { "ch:x": 100, "ov_c:ch:x": -5 };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:x"), 100);
  assert.equal(overrides.has("ch:x"), false);
});

// ── uint32 boundary values accepted ─────────────────────────────────────────

test("parseContexts_uint32Zero_acceptedInLiveGroup", () => {
  const raw = { "ch:x": 0, "ov_s:ch:x": 0, "ov_c:ch:x": 0, "ov_b:ch:x": 0 };
  const { overrides } = parseContexts(raw);
  assert.deepEqual(overrides.get("ch:x"), { s: 0, c: 0, b: 0 });
});

test("parseContexts_uint32Max_acceptedInLiveGroup", () => {
  const UINT32_MAX = 4294967295;
  const raw = {
    "ch:x": UINT32_MAX,
    "ov_s:ch:x": UINT32_MAX,
    "ov_c:ch:x": UINT32_MAX,
    "ov_b:ch:x": UINT32_MAX,
  };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(frontiers.get("ch:x"), UINT32_MAX);
  assert.deepEqual(overrides.get("ch:x"), {
    s: UINT32_MAX,
    c: UINT32_MAX,
    b: UINT32_MAX,
  });
});

test("parseContexts_uint32Max_acceptedInTombstone", () => {
  const UINT32_MAX = 4294967295;
  const raw = { "ch:x": 0, "ov_c:ch:x": UINT32_MAX };
  const { overrides } = parseContexts(raw);
  assert.deepEqual(overrides.get("ch:x"), { s: 0, c: UINT32_MAX, b: 0 });
});

// ── 256-byte key-length enforcement ─────────────────────────────────────────

// Build a string of exactly N UTF-8 bytes (ASCII, so length == byte count).
function asciiOfBytes(n) {
  return "a".repeat(n);
}

test("parseContexts_frontierKey256Bytes_accepted", () => {
  // ov_s: prefix is 5 bytes; a 251-byte suffix yields a 256-byte wire key.
  const suffix251 = asciiOfBytes(251);
  const raw = { [suffix251]: 42 };
  const { frontiers } = parseContexts(raw);
  assert.equal(frontiers.get(suffix251), 42);
});

test("parseContexts_frontierKey257Bytes_dropped", () => {
  const suffix257 = asciiOfBytes(257);
  const raw = { [suffix257]: 42 }; // 257 bytes — exceeds 256
  const { frontiers } = parseContexts(raw);
  assert.equal(frontiers.has(suffix257), false);
});

test("parseContexts_liveGroupSiblingKey256Bytes_accepted", () => {
  // ov_s: is 5 bytes; suffix of 251 bytes → wire key exactly 256 bytes.
  const suffix251 = asciiOfBytes(251);
  const raw = {
    [suffix251]: 10,
    [`${OV_S_PREFIX}${suffix251}`]: 1,
    [`${OV_C_PREFIX}${suffix251}`]: 0,
    [`${OV_B_PREFIX}${suffix251}`]: 9,
  };
  const { overrides } = parseContexts(raw);
  assert.deepEqual(overrides.get(suffix251), { s: 1, c: 0, b: 9 });
});

test("parseContexts_liveGroupSiblingKey257Bytes_groupDropped", () => {
  // ov_s: is 5 bytes; suffix of 252 bytes → wire key 257 bytes — drops group.
  const suffix252 = asciiOfBytes(252);
  const raw = {
    [suffix252]: 10, // frontier key also 252 bytes — also dropped
    [`${OV_S_PREFIX}${suffix252}`]: 1,
    [`${OV_C_PREFIX}${suffix252}`]: 0,
    [`${OV_B_PREFIX}${suffix252}`]: 9,
  };
  const { overrides } = parseContexts(raw);
  assert.equal(overrides.has(suffix252), false);
});

test("parseContexts_tombstoneFloorKey256Bytes_accepted", () => {
  // ov_c: is 5 bytes; suffix of 251 bytes → wire key exactly 256 bytes.
  const suffix251 = asciiOfBytes(251);
  const raw = {
    [suffix251]: 0,
    [`${OV_C_PREFIX}${suffix251}`]: 3,
  };
  const { overrides } = parseContexts(raw);
  assert.deepEqual(overrides.get(suffix251), { s: 0, c: 3, b: 0 });
});

test("parseContexts_tombstoneFloorKey257Bytes_groupDropped", () => {
  // ov_c: is 5 bytes; suffix of 252 bytes → wire key 257 bytes — drops group.
  const suffix252 = asciiOfBytes(252);
  const raw = {
    [suffix252]: 0,
    [`${OV_C_PREFIX}${suffix252}`]: 3,
  };
  const { overrides } = parseContexts(raw);
  assert.equal(overrides.has(suffix252), false);
});

test("parseContexts_multibyteSuffix_keyLengthCheckedInBytes", () => {
  // A 2-byte UTF-8 char (e.g. 'é') counts as 2 bytes toward the 256 limit.
  // suffix of 127 × 'é' = 254 bytes; ov_c: (5) + 254 = 259 → over limit.
  const multiSuffix = "\u00e9".repeat(127); // 127 × 2 bytes = 254 bytes
  const raw = {
    [multiSuffix]: 0,
    [`${OV_C_PREFIX}${multiSuffix}`]: 7,
  };
  const { overrides } = parseContexts(raw);
  assert.equal(overrides.has(multiSuffix), false);
});

test("parseContexts_multibyteSuffix_justUnder256_accepted", () => {
  // 'é' × 125 = 250 bytes; ov_c: (5) + 250 = 255 → under limit.
  const multiSuffix = "\u00e9".repeat(125); // 125 × 2 = 250 bytes
  const raw = {
    [multiSuffix]: 0,
    [`${OV_C_PREFIX}${multiSuffix}`]: 7,
  };
  const { overrides } = parseContexts(raw);
  assert.deepEqual(overrides.get(multiSuffix), { s: 0, c: 7, b: 0 });
});

// ── reserved-ID collision witness (Thufir finding 1) ────────────────────────

test("parseContexts_reservedIdCollision_frontierAndOverrideUseDistinctNamespaces", () => {
  // Raw context `ov_s:evil` has its frontier published under `esc:ov_s:evil`
  // (as a publisher-aware client would do).  It also has a live register for
  // raw context `ov_s:evil` (suffix = `evil` for the ov_* keys).
  // Raw context `evil` independently has its own frontier and override.
  const raw = {
    "esc:ov_s:evil": 7, // frontier for raw ctx `ov_s:evil`
    "ov_s:evil": 3, // set counter for raw ctx `evil`
    "ov_c:evil": 1,
    "ov_b:evil": 6,
    evil: 100, // frontier for raw ctx `evil`
    "ov_s:regular": 2, // set counter for raw ctx `regular`
    "ov_c:regular": 0,
    "ov_b:regular": 50,
    regular: 40,
  };
  const { frontiers, overrides } = parseContexts(raw);

  // frontier for raw ctx `ov_s:evil` must be 7 (unescaped from `esc:ov_s:evil`)
  assert.equal(
    frontiers.get("ov_s:evil"),
    7,
    "frontier for ctx ov_s:evil must be 7",
  );
  // frontier for raw ctx `evil` must be 100
  assert.equal(frontiers.get("evil"), 100, "frontier for ctx evil must be 100");
  // override for raw ctx `evil` comes from `ov_s:evil`/`ov_c:evil`/`ov_b:evil` (suffix=`evil`)
  assert.deepEqual(
    overrides.get("evil"),
    { s: 3, c: 1, b: 6 },
    "override for ctx evil",
  );
  // override for raw ctx `regular`
  assert.deepEqual(
    overrides.get("regular"),
    { s: 2, c: 0, b: 50 },
    "override for ctx regular",
  );
  // No `ov_s:evil` in frontiers as an override key — but `ov_s:evil` IS a raw ctx ID with frontier 7
  assert.equal(
    frontiers.get("ov_s:evil"),
    7,
    "ov_s:evil raw ctx has frontier 7",
  );
  // No `esc:ov_s:evil` in frontiers (was unescaped)
  assert.equal(
    frontiers.has("esc:ov_s:evil"),
    false,
    "escaped wire key must not appear in frontiers",
  );
  // liveness evaluation uses consistent namespaces
  const evilReg = overrides.get("evil");
  const evilFrontier = frontiers.get("evil") ?? 0;
  // s=3, c=1, b=6, f=100 → F(100) > B(6) → inactive
  assert.equal(
    isOverrideActive(evilReg, evilFrontier),
    false,
    "evil override inactive because frontier(100) > baseline(6)",
  );

  const regularReg = overrides.get("regular");
  const regularFrontier = frontiers.get("regular") ?? 0;
  // s=2, c=0, b=50, f=40 → S>0 ∧ F(40)<=B(50) ∧ S(2)>C(0) → active
  assert.equal(
    isOverrideActive(regularReg, regularFrontier),
    true,
    "regular override active: F(40) <= B(50), S(2) > C(0)",
  );
});

// ── multiple contexts in one blob ────────────────────────────────────────────

test("parseContexts_multipleContexts_allProcessedCorrectly", () => {
  const raw = {
    "ch:a": 100,
    "ov_s:ch:a": 1,
    "ov_c:ch:a": 0,
    "ov_b:ch:a": 90,
    "ch:b": 200,
    "ov_c:ch:b": 3, // tombstone floor
    "ch:c": 300,
    "ov_s:ch:c": 1, // partial — only s, no c/b → rejected
  };
  const { frontiers, overrides } = parseContexts(raw);
  assert.equal(overrides.get("ch:a")?.s, 1);
  assert.deepEqual(overrides.get("ch:b"), { s: 0, c: 3, b: 0 });
  assert.equal(overrides.has("ch:c"), false);
  assert.equal(frontiers.get("ch:a"), 100);
  assert.equal(frontiers.get("ch:b"), 200);
  assert.equal(frontiers.get("ch:c"), 300);
});

// ---------------------------------------------------------------------------
// sanitizeContexts — end-to-end with override group validation
// ---------------------------------------------------------------------------

test("sanitizeContexts_liveGroup_passesThrough", () => {
  const raw = {
    "channel:x": 1000,
    "ov_s:channel:x": 1,
    "ov_c:channel:x": 0,
    "ov_b:channel:x": 900,
  };
  const result = sanitizeContexts(raw);
  assert.equal(result["channel:x"], 1000);
  assert.equal(result[`${OV_S_PREFIX}channel:x`], 1);
  assert.equal(result[`${OV_C_PREFIX}channel:x`], 0);
  assert.equal(result[`${OV_B_PREFIX}channel:x`], 900);
});

test("sanitizeContexts_tombstoneFloor_passesThrough", () => {
  const raw = {
    "channel:x": 1000,
    "ov_c:channel:x": 5,
  };
  const result = sanitizeContexts(raw);
  assert.equal(result["channel:x"], 1000);
  assert.equal(result[`${OV_C_PREFIX}channel:x`], 5);
  assert.equal(result[`${OV_S_PREFIX}channel:x`], undefined);
  assert.equal(result[`${OV_B_PREFIX}channel:x`], undefined);
});

test("sanitizeContexts_partialGroup_droppedFrontierRetained", () => {
  // Partial group rejected; frontier entry kept
  const raw = {
    "channel:x": 1000,
    "ov_s:channel:x": 1,
  };
  const result = sanitizeContexts(raw);
  assert.equal(result["channel:x"], 1000);
  assert.equal(result[`${OV_S_PREFIX}channel:x`], undefined);
});

test("sanitizeContexts_liveGroupSiblingKeyTooLong_groupDropped", () => {
  // ov_s: (5 bytes) + suffix of 252 bytes = 257 bytes wire key → drop group
  const suffix252 = asciiOfBytes(252);
  const raw = {
    [suffix252]: 10,
    [`${OV_S_PREFIX}${suffix252}`]: 1,
    [`${OV_C_PREFIX}${suffix252}`]: 0,
    [`${OV_B_PREFIX}${suffix252}`]: 9,
  };
  const result = sanitizeContexts(raw);
  assert.equal(result[`${OV_S_PREFIX}${suffix252}`], undefined);
  assert.equal(result[`${OV_C_PREFIX}${suffix252}`], undefined);
});

test("sanitizeContexts_tombstoneKeyTooLong_groupDropped", () => {
  const suffix252 = asciiOfBytes(252);
  const raw = { [suffix252]: 0, [`${OV_C_PREFIX}${suffix252}`]: 3 };
  const result = sanitizeContexts(raw);
  assert.equal(result[`${OV_C_PREFIX}${suffix252}`], undefined);
});

test("sanitizeContexts_normalEntriesUnaffected", () => {
  const raw = {
    "ch:normal": 5000,
    "msg:abc": 3000,
    "thread:def": 2000,
  };
  const result = sanitizeContexts(raw);
  assert.equal(result["ch:normal"], 5000);
  assert.equal(result["msg:abc"], 3000);
  assert.equal(result["thread:def"], 2000);
});

test("sanitizeContexts_invalidFrontierEntry_dropped", () => {
  const raw = {
    "good:key": 100,
    "bad:key": "not-a-number",
  };
  const result = sanitizeContexts(raw);
  assert.equal(result["good:key"], 100);
  assert.equal(result["bad:key"], undefined);
});

test("sanitizeContexts_escapedFrontierKey_passesThrough", () => {
  // esc: prefixed frontier keys must pass through unchanged in the flat map
  const raw = { "esc:ov_s:suspicious-ctx": 1000 };
  const result = sanitizeContexts(raw);
  assert.equal(result["esc:ov_s:suspicious-ctx"], 1000);
});

// ---------------------------------------------------------------------------
// mergeOverrideRegisterMaps — across multiple blobs
// ---------------------------------------------------------------------------

test("mergeOverrideRegisterMaps_twoMaps_takesComponentwiseMax", () => {
  const a = new Map([["ctx", { s: 3, c: 1, b: 50 }]]);
  const b = new Map([["ctx", { s: 1, c: 4, b: 80 }]]);
  const merged = mergeOverrideRegisterMaps(a, b);
  assert.deepEqual(merged.get("ctx"), { s: 3, c: 4, b: 80 });
});

test("mergeOverrideRegisterMaps_disjointContexts_bothPresent", () => {
  const a = new Map([["ctx:A", { s: 1, c: 0, b: 10 }]]);
  const b = new Map([["ctx:B", { s: 0, c: 2, b: 0 }]]);
  const merged = mergeOverrideRegisterMaps(a, b);
  assert.equal(merged.size, 2);
  assert.deepEqual(merged.get("ctx:A"), { s: 1, c: 0, b: 10 });
  assert.deepEqual(merged.get("ctx:B"), { s: 0, c: 2, b: 0 });
});

test("mergeOverrideRegisterMaps_emptyMaps_returnsEmpty", () => {
  const merged = mergeOverrideRegisterMaps(new Map(), new Map());
  assert.equal(merged.size, 0);
});

test("mergeOverrideRegisterMaps_singleMap_isIdentity", () => {
  const m = new Map([["ctx", { s: 2, c: 1, b: 50 }]]);
  const merged = mergeOverrideRegisterMaps(m);
  assert.deepEqual(merged.get("ctx"), { s: 2, c: 1, b: 50 });
});

test("mergeOverrideRegisterMaps_threeWayMerge_takesGlobalMax", () => {
  const a = new Map([["ctx", { s: 5, c: 0, b: 10 }]]);
  const b = new Map([["ctx", { s: 1, c: 3, b: 20 }]]);
  const c = new Map([["ctx", { s: 2, c: 1, b: 30 }]]);
  const merged = mergeOverrideRegisterMaps(a, b, c);
  assert.deepEqual(merged.get("ctx"), { s: 5, c: 3, b: 30 });
});

test("mergeOverrideRegisterMaps_uint32Max_commutative", () => {
  const UINT32_MAX = 4294967295;
  const a = new Map([["ctx", { s: UINT32_MAX, c: 0, b: UINT32_MAX }]]);
  const b = new Map([["ctx", { s: 0, c: UINT32_MAX, b: 0 }]]);
  const ab = mergeOverrideRegisterMaps(a, b);
  const ba = mergeOverrideRegisterMaps(b, a);
  assert.deepEqual(ab.get("ctx"), ba.get("ctx"));
  assert.deepEqual(ab.get("ctx"), {
    s: UINT32_MAX,
    c: UINT32_MAX,
    b: UINT32_MAX,
  });
});

// ---------------------------------------------------------------------------
// Round-trip: encodeOverrideGroup → parseContexts produces original register
// ---------------------------------------------------------------------------

test("roundTrip_liveRegister_survivesEncodeAndParse", () => {
  const reg = { s: 2, c: 1, b: 100 };
  const frontier = 50;
  const rawCtx = "channel-uuid-1234";

  const patch = encodeOverrideGroup(rawCtx, reg, frontier);
  const rawContexts = { [rawCtx]: frontier, ...patch };
  const { frontiers, overrides } = parseContexts(rawContexts);

  assert.equal(frontiers.get(rawCtx), frontier);
  assert.deepEqual(overrides.get(rawCtx), reg);
});

test("roundTrip_tombstoneFloor_survivesEncodeAndParse", () => {
  const reg = { s: 0, c: 5, b: 0 };
  const frontier = 0;
  const rawCtx = "channel-uuid-5678";

  const patch = encodeOverrideGroup(rawCtx, reg, frontier);
  const rawContexts = { [rawCtx]: frontier, ...patch };
  const { frontiers, overrides } = parseContexts(rawContexts);

  assert.equal(frontiers.get(rawCtx), frontier);
  assert.deepEqual(overrides.get(rawCtx), { s: 0, c: 5, b: 0 });
});

test("roundTrip_virginRegister_omittedFromWire", () => {
  const reg = { s: 0, c: 0, b: 0 };
  const rawCtx = "channel-uuid-virgin";

  const patch = encodeOverrideGroup(rawCtx, reg, 0);
  assert.deepEqual(patch, {});
  const rawContexts = { [rawCtx]: 0 };
  const { frontiers, overrides } = parseContexts(rawContexts);
  assert.equal(frontiers.get(rawCtx), 0);
  assert.equal(overrides.has(rawCtx), false);
});

test("roundTrip_escapedRawCtx_survivesEncodeAndParse", () => {
  // A raw context ID that starts with ov_: publisher escapes frontier key.
  // encodeOverrideGroup does NOT escape the raw ctx suffix in ov_* keys —
  // the spec says ov_* keys use the raw suffix.  The frontier key is
  // published escaped (esc:ov_s:raw) by the publisher — simulate that here.
  const rawCtx = "ov_s:tricky";
  const reg = { s: 1, c: 0, b: 10 };
  const frontier = 8;

  // Publisher encodes: override keys use raw suffix, frontier key is escaped.
  const patch = encodeOverrideGroup(rawCtx, reg, frontier);
  // patch has ov_s:ov_s:tricky, ov_c:ov_s:tricky, ov_b:ov_s:tricky
  const rawContexts = {
    [`esc:${rawCtx}`]: frontier, // frontier published escaped
    ...patch,
  };
  const { frontiers, overrides } = parseContexts(rawContexts);

  // After unescape: frontier keyed by raw ctx `ov_s:tricky`
  assert.equal(frontiers.get(rawCtx), frontier);
  // Override keyed by suffix after `ov_s:` → `ov_s:tricky`
  assert.deepEqual(overrides.get(rawCtx), reg);
  // liveness evaluation uses the same raw key for both
  const ov = overrides.get(rawCtx);
  const f = frontiers.get(rawCtx) ?? 0;
  // s=1, c=0, b=10, f=8 → S>0 ∧ F(8)<=B(10) ∧ S(1)>C(0) → active
  assert.equal(isOverrideActive(ov, f), true);
});

// ---------------------------------------------------------------------------
// Exact 256/257-byte boundary for live AND floor shapes (multibyte UTF-8)
// ---------------------------------------------------------------------------
//
// Thufir pass-2 finding: multibyte cases covered only the floor shape and
// skipped the exact 256/257-byte boundary.  These tests use 2-byte UTF-8
// chars ('é' = 0xC3 0xA9) to verify byte-counting at the exact limit.
//
// For ov_c: (5 bytes), the suffix must be at most 251 bytes.
//   - 'é' × 125 = 250 bytes → wire key 255 bytes → accepted
//   - 'é' × 126 = 252 bytes → wire key 257 bytes → rejected
//   - 'é' ×   1 at 251 bytes remainder = 251 bytes — we can't hit exactly 256
//     with 2-byte chars alone (256-5=251, odd for 2-byte chars), so we combine:
//   - 'é' × 125 + 'a' × 1 = 251 bytes → wire key 256 bytes → accepted (exact boundary)
//   - 'é' × 125 + 'a' × 2 = 252 bytes → wire key 257 bytes → rejected (one over)

test("parseContexts_tombstoneFloor_multibyte_exactly256Bytes_accepted", () => {
  // 'é' × 125 = 250 bytes, + 'a' = 251 bytes suffix → wire key exactly 256 bytes.
  const suffix = "\u00e9".repeat(125) + "a";
  const raw = {
    [suffix]: 0,
    [`${OV_C_PREFIX}${suffix}`]: 7,
  };
  const { overrides } = parseContexts(raw);
  assert.deepEqual(overrides.get(suffix), { s: 0, c: 7, b: 0 });
});

test("parseContexts_tombstoneFloor_multibyte_exactly257Bytes_dropped", () => {
  // 'é' × 125 = 250 bytes, + 'aa' = 252 bytes suffix → wire key exactly 257 bytes.
  const suffix = "\u00e9".repeat(125) + "aa";
  const raw = {
    [suffix]: 0,
    [`${OV_C_PREFIX}${suffix}`]: 7,
  };
  const { overrides } = parseContexts(raw);
  assert.equal(overrides.has(suffix), false);
});

test("parseContexts_liveGroup_multibyte_exactly256Bytes_accepted", () => {
  // Same suffix construction: 'é' × 125 + 'a' = 251 bytes → ov_s: wire key 256 bytes.
  const suffix = "\u00e9".repeat(125) + "a";
  const raw = {
    [suffix]: 10,
    [`${OV_S_PREFIX}${suffix}`]: 2,
    [`${OV_C_PREFIX}${suffix}`]: 1,
    [`${OV_B_PREFIX}${suffix}`]: 9,
  };
  const { overrides } = parseContexts(raw);
  assert.deepEqual(overrides.get(suffix), { s: 2, c: 1, b: 9 });
});

test("parseContexts_liveGroup_multibyte_exactly257Bytes_dropped", () => {
  // 'é' × 125 + 'aa' = 252 bytes → ov_s: wire key 257 bytes → group dropped.
  const suffix = "\u00e9".repeat(125) + "aa";
  const raw = {
    [suffix]: 10,
    [`${OV_S_PREFIX}${suffix}`]: 2,
    [`${OV_C_PREFIX}${suffix}`]: 1,
    [`${OV_B_PREFIX}${suffix}`]: 9,
  };
  const { overrides } = parseContexts(raw);
  assert.equal(overrides.has(suffix), false);
});

// ---------------------------------------------------------------------------
// Event-level integration tests via parseReadStateEvent + mergeReadStateEventsStructured
// ---------------------------------------------------------------------------

test("parseReadStateEvent_singleEvent_frontierAndOverrideBothPresent", async () => {
  const pubkey = "c".repeat(64);
  const parsed = await parseFakeEvent(pubkey, SLOT_A, {
    "ch:alpha": 5000,
    "ov_s:ch:alpha": 2,
    "ov_c:ch:alpha": 1,
    "ov_b:ch:alpha": 4800,
  });

  assert.ok(parsed !== null);
  assert.equal(parsed.contexts.frontiers.get("ch:alpha"), 5000);
  assert.deepEqual(parsed.contexts.overrides.get("ch:alpha"), {
    s: 2,
    c: 1,
    b: 4800,
  });
});

test("mergeReadStateEventsStructured_twoBlobs_mergesBothFrontiersAndRegisters", async () => {
  const pubkey = "d".repeat(64);
  // Blob 1: ch:alpha frontier=5000, register s=2/c=1/b=4800
  // Blob 2: ch:alpha frontier=6000, register s=3/c=1/b=5500 (higher frontier, higher S+B)
  const merged = await mergeFakeEvents(pubkey, [
    {
      dTagSlot: SLOT_A,
      blobContexts: {
        "ch:alpha": 5000,
        "ov_s:ch:alpha": 2,
        "ov_c:ch:alpha": 1,
        "ov_b:ch:alpha": 4800,
      },
    },
    {
      dTagSlot: SLOT_B,
      blobContexts: {
        "ch:alpha": 6000,
        "ov_s:ch:alpha": 3,
        "ov_c:ch:alpha": 1,
        "ov_b:ch:alpha": 5500,
      },
    },
  ]);

  // Frontier: max(5000, 6000) = 6000
  assert.equal(merged.frontiers.get("ch:alpha"), 6000);
  // Register: componentwise max(s=2,3)=3, max(c=1,1)=1, max(b=4800,5500)=5500
  assert.deepEqual(merged.overrides.get("ch:alpha"), { s: 3, c: 1, b: 5500 });
});

test("mergeReadStateEventsStructured_twoBlobs_livenessProperly_evaluated", async () => {
  const pubkey = "e".repeat(64);
  // Blob 1: ch:beta frontier=100, register s=1/c=0/b=90 (live: F(100)>B(90)? no, F=100>B=90 → inactive)
  // Blob 2: ch:beta frontier=80,  register s=1/c=0/b=95 (adds: B=95 > F from blob2, but merges)
  // After merge: frontier=max(100,80)=100, register s=1/c=0/b=max(90,95)=95
  // Liveness: S(1)>0, F(100)>B(95) → inactive (frontier exceeded baseline)
  const merged = await mergeFakeEvents(pubkey, [
    {
      dTagSlot: SLOT_A,
      blobContexts: {
        "ch:beta": 100,
        "ov_s:ch:beta": 1,
        "ov_c:ch:beta": 0,
        "ov_b:ch:beta": 90,
      },
    },
    {
      dTagSlot: SLOT_B,
      blobContexts: {
        "ch:beta": 80,
        "ov_s:ch:beta": 1,
        "ov_c:ch:beta": 0,
        "ov_b:ch:beta": 95,
      },
    },
  ]);

  assert.equal(merged.frontiers.get("ch:beta"), 100);
  assert.deepEqual(merged.overrides.get("ch:beta"), { s: 1, c: 0, b: 95 });

  const liveness = computeOverrideLiveness(
    merged,
    "ch:beta",
    merged.frontiers.get("ch:beta") ?? 0,
  );
  // F(100) > B(95) → inactive
  assert.equal(liveness.active, false);
  assert.equal(liveness.frontier, 100);
});

test("mergeReadStateEventsStructured_twoBlobs_livenessActive_afterMerge", async () => {
  const pubkey = "f".repeat(64);
  // Blob 1: ch:gamma frontier=50, register s=1/c=0/b=60 (live in blob1: F(50)<=B(60))
  // Blob 2: ch:gamma frontier=55, tombstone floor ov_c=1 only (adds c=max(0,1)=1)
  // After merge: frontier=max(50,55)=55, register s=1/c=1/b=60
  // Liveness: S(1)>0, F(55)<=B(60), but S(1)>C(1)? NO: S==C tie → clear-wins → inactive
  // To make it active: blob2 has floor ov_c=0, so no C increase
  // Adjust: blob2 gives frontier=55, no override keys → c stays 0
  // After merge: frontier=55, s=1/c=0/b=60
  // Liveness: S(1)>0, F(55)<=B(60), S(1)>C(0) → active
  const merged = await mergeFakeEvents(pubkey, [
    {
      dTagSlot: SLOT_A,
      blobContexts: {
        "ch:gamma": 50,
        "ov_s:ch:gamma": 1,
        "ov_c:ch:gamma": 0,
        "ov_b:ch:gamma": 60,
      },
    },
    {
      dTagSlot: SLOT_B,
      blobContexts: {
        "ch:gamma": 55, // just the frontier, no override keys
      },
    },
  ]);

  assert.equal(merged.frontiers.get("ch:gamma"), 55);
  assert.deepEqual(merged.overrides.get("ch:gamma"), { s: 1, c: 0, b: 60 });

  const liveness = computeOverrideLiveness(
    merged,
    "ch:gamma",
    merged.frontiers.get("ch:gamma") ?? 0,
  );
  // S(1)>0, F(55)<=B(60), S(1)>C(0) → active
  assert.equal(liveness.active, true);
  assert.equal(liveness.frontier, 55);
});

test("mergeReadStateEventsStructured_unknownPubkey_returnsEmpty", async () => {
  const pubkey = "aa".repeat(32);
  const wrongPubkey = "bb".repeat(32);
  const { event, decrypt } = makeEvent(pubkey, SLOT_A, { "ch:x": 100 });
  // Pass event but query with wrong pubkey — parseReadStateEvent returns null for each
  const merged = await mergeReadStateEventsStructured(
    [event],
    wrongPubkey,
    decrypt,
  );
  assert.equal(merged.frontiers.size, 0);
  assert.equal(merged.overrides.size, 0);
});

// ── Complete collision witness through event-level merge path ────────────────
//
// Wire layout:
//   raw ctx `ov_s:evil`  → frontier at esc:ov_s:evil=7; register via ov_s:ov_s:evil/ov_c:ov_s:evil/ov_b:ov_s:evil
//   raw ctx `evil`       → frontier at evil=100; register via ov_s:evil/ov_c:evil/ov_b:evil
//
// Both reside in a single blob (slot1).  A second blob (slot2) adds higher
// frontier/register values for `evil` to exercise cross-event merge.
// After merge both contexts remain in their own namespaces.

test("mergeReadStateEventsStructured_fullCollisionWitness_distinctNamespaces", async () => {
  const pubkey = "ab".repeat(32);

  const merged = await mergeFakeEvents(pubkey, [
    {
      dTagSlot: SLOT_A,
      blobContexts: {
        // raw ctx `ov_s:evil`: frontier published escaped; register uses raw suffix
        "esc:ov_s:evil": 7,
        "ov_s:ov_s:evil": 1,
        "ov_c:ov_s:evil": 0,
        "ov_b:ov_s:evil": 6,
        // raw ctx `evil`: plain frontier + plain register
        evil: 100,
        "ov_s:evil": 3,
        "ov_c:evil": 1,
        "ov_b:evil": 90,
      },
    },
    {
      dTagSlot: SLOT_B,
      blobContexts: {
        // second device advances `evil` frontier and register
        evil: 120,
        "ov_s:evil": 4,
        "ov_c:evil": 2,
        "ov_b:evil": 110,
      },
    },
  ]);

  // frontier for raw ctx `ov_s:evil` = 7 (from esc:ov_s:evil, unescaped at decode)
  assert.equal(
    merged.frontiers.get("ov_s:evil"),
    7,
    "frontier for ctx ov_s:evil must be 7",
  );

  // frontier for raw ctx `evil` = max(100, 120) = 120
  assert.equal(
    merged.frontiers.get("evil"),
    120,
    "frontier for ctx evil must be 120",
  );

  // register for raw ctx `ov_s:evil` (suffix `ov_s:evil` from `ov_s:ov_s:evil`)
  assert.deepEqual(
    merged.overrides.get("ov_s:evil"),
    { s: 1, c: 0, b: 6 },
    "override for ctx ov_s:evil",
  );

  // register for raw ctx `evil` (suffix `evil` from `ov_s:evil` etc.)
  // merged componentwise: s=max(3,4)=4, c=max(1,2)=2, b=max(90,110)=110
  assert.deepEqual(
    merged.overrides.get("evil"),
    { s: 4, c: 2, b: 110 },
    "override for ctx evil must be merged max across both blobs",
  );

  // Liveness for `ov_s:evil`: F(7), s=1, c=0, b=6 → F(7)>B(6) → inactive
  const ovsEvilLiveness = computeOverrideLiveness(
    merged,
    "ov_s:evil",
    merged.frontiers.get("ov_s:evil") ?? 0,
  );
  assert.equal(
    ovsEvilLiveness.active,
    false,
    "ov_s:evil: F(7)>B(6) → inactive",
  );
  assert.equal(ovsEvilLiveness.frontier, 7);

  // Liveness for `evil`: F(120), s=4, c=2, b=110 → F(120)>B(110) → inactive
  const evilLiveness = computeOverrideLiveness(
    merged,
    "evil",
    merged.frontiers.get("evil") ?? 0,
  );
  assert.equal(evilLiveness.active, false, "evil: F(120)>B(110) → inactive");
  assert.equal(evilLiveness.frontier, 120);

  // Wire keys never polluted: no `esc:` key survives in frontiers map
  assert.equal(merged.frontiers.has("esc:ov_s:evil"), false);
});

// ---------------------------------------------------------------------------
// isValidReadStateDTag — spec-conformant d-tag validation (NIP-RS :55/:68)
// ---------------------------------------------------------------------------

test("isValidReadStateDTag_valid32HexSlot_returnsTrue", () => {
  assert.equal(
    isValidReadStateDTag("read-state:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"),
    true,
  );
});

test("isValidReadStateDTag_uppercaseHex_returnsFalse", () => {
  // Uppercase letters are NOT valid — spec requires [0-9a-f]{32} only.
  assert.equal(
    isValidReadStateDTag("read-state:A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6"),
    false,
  );
});

test("isValidReadStateDTag_nonHexChars_returnsFalse", () => {
  // 'g' and 'z' are not hexadecimal.
  assert.equal(
    isValidReadStateDTag("read-state:gggggggggggggggggggggggggggggggg"),
    false,
  );
});

test("isValidReadStateDTag_31HexChars_returnsFalse", () => {
  // One char short — must be exactly 32.
  assert.equal(isValidReadStateDTag("read-state:" + "a".repeat(31)), false);
});

test("isValidReadStateDTag_33HexChars_returnsFalse", () => {
  // One char over — must be exactly 32.
  assert.equal(isValidReadStateDTag("read-state:" + "a".repeat(33)), false);
});

test("isValidReadStateDTag_missingPrefix_returnsFalse", () => {
  assert.equal(isValidReadStateDTag("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"), false);
});

test("isValidReadStateDTag_emptySlot_returnsFalse", () => {
  assert.equal(isValidReadStateDTag("read-state:"), false);
});

test("isValidReadStateDTag_undefined_returnsFalse", () => {
  assert.equal(isValidReadStateDTag(undefined), false);
});

test("isValidReadStateDTag_legacySlot1_returnsFalse", () => {
  // Non-conforming opaque slot names that were used in test fixtures before
  // this fix must now be correctly rejected.
  assert.equal(isValidReadStateDTag("read-state:slot1"), false);
});

// ---------------------------------------------------------------------------
// decodeContexts — __proto__ context ID survives in both projections
// ---------------------------------------------------------------------------

test("decodeContexts_protoContextId_survivesBothProjections", () => {
  // JSON.parse produces an object whose `__proto__` key is handled as a
  // regular property by V8's JSON parser (it sets the value but does NOT
  // change the prototype chain).  Without a null-prototype `wire` dict,
  // assigning `wire[wireKey] = value` where wireKey === "__proto__" is a
  // no-op (it modifies Object.prototype, not the object itself), so the
  // flat projection silently loses the context while the `frontiers` Map
  // retains it — the two claimed-equivalent views disagree.
  //
  // With `Object.create(null)` for `wire`, the assignment becomes an
  // own-property write and both projections agree.
  const raw = JSON.parse('{"__proto__":7,"normal":8}');

  // Structured projection via parseContexts.
  const { frontiers } = parseContexts(raw);

  // Flat projection via sanitizeContexts.
  const wire = sanitizeContexts(raw);

  // frontiers Map must contain __proto__ with value 7.
  assert.equal(frontiers.get("__proto__"), 7, "__proto__ must be in frontiers");
  assert.equal(frontiers.get("normal"), 8, "normal must be in frontiers");

  // wire must have __proto__ as an own property with value 7 — NOT inherited.
  assert.equal(
    Object.hasOwn(wire, "__proto__"),
    true,
    "__proto__ must be an own property of wire",
  );
  assert.equal(wire.__proto__, 7, "__proto__ wire value must be 7");
  assert.equal(wire.normal, 8, "normal wire value must be 8");
});

// ---------------------------------------------------------------------------
// computeOverrideLiveness — hierarchical effective-frontier witness
// (NIP-RS :169-196/:510-514)
// ---------------------------------------------------------------------------

test("computeOverrideLiveness_hierarchicalFrontier_overrideBecomesInactive", async () => {
  // Wire state:
  //   channel ctx: frontier=100
  //   thread ctx:  frontier=50, register s=1/c=0/b=60
  //
  // Thread own frontier: 50 → override would be active (F(50)<=B(60), S(1)>C(0)).
  // Effective frontier applying hierarchical rule:
  //   effective(thread) = max(merged[thread], merged[channel]) = max(50, 100) = 100
  // With F_eff=100 > B(60) → override is INACTIVE.
  //
  // A caller that reads merged.frontiers.get("thread") and passes only 50
  // would incorrectly see the override as active.  This test verifies that
  // passing the correct effective frontier (100) gives the right answer.
  const pubkey = "e1".repeat(32);
  const channelCtx = "aabbccdd-channel-uuid";
  const threadCtx =
    "thread:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

  const merged = await mergeFakeEvents(pubkey, [
    {
      dTagSlot: SLOT_A,
      blobContexts: {
        [channelCtx]: 100,
        [threadCtx]: 50,
        [`ov_s:${threadCtx}`]: 1,
        [`ov_c:${threadCtx}`]: 0,
        [`ov_b:${threadCtx}`]: 60,
      },
    },
  ]);

  assert.equal(merged.frontiers.get(channelCtx), 100);
  assert.equal(merged.frontiers.get(threadCtx), 50);
  assert.deepEqual(merged.overrides.get(threadCtx), { s: 1, c: 0, b: 60 });

  // Own frontier only — this would INCORRECTLY show active.
  const ownFrontierLiveness = computeOverrideLiveness(
    merged,
    threadCtx,
    merged.frontiers.get(threadCtx) ?? 0,
  );
  assert.equal(
    ownFrontierLiveness.active,
    true,
    "with own frontier F(50)<=B(60) the override looks active",
  );

  // Hierarchical effective frontier — correct answer is INACTIVE.
  const channelFrontier = merged.frontiers.get(channelCtx) ?? 0;
  const threadFrontier = merged.frontiers.get(threadCtx) ?? 0;
  const effectiveFrontier = Math.max(threadFrontier, channelFrontier);
  assert.equal(effectiveFrontier, 100);

  const hierarchicalLiveness = computeOverrideLiveness(
    merged,
    threadCtx,
    effectiveFrontier,
  );
  assert.equal(
    hierarchicalLiveness.active,
    false,
    "with effective frontier F(100)>B(60) the override is correctly inactive",
  );
  assert.equal(hierarchicalLiveness.frontier, 100);
});
