import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeOverrideGroup,
  escapeFrontierKey,
  isOverrideActive,
  isOverrideKey,
  mergeOverrideRegisters,
  OV_B_PREFIX,
  OV_C_PREFIX,
  OV_S_PREFIX,
  parseContexts,
  sanitizeContexts,
  unescapeFrontierKey,
} from "./readStateFormat.ts";

import { mergeOverrideRegisterMaps } from "./readStateSnapshot.ts";

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
