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
  partitionOverrideGroups,
  sanitizeContexts,
  unescapeFrontierKey,
} from "./readStateFormat.ts";

import {
  extractOverrideRegisters,
  mergeOverrideRegisterMaps,
} from "./readStateSnapshot.ts";

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
// partitionOverrideGroups — group-first validation
// ---------------------------------------------------------------------------

test("partitionOverrideGroups_liveGroup_validates", () => {
  const raw = {
    "channel:x": 1000,
    "ov_s:channel:x": 1,
    "ov_c:channel:x": 0,
    "ov_b:channel:x": 900,
  };
  const { overrides, nonOverride } = partitionOverrideGroups(raw);
  assert.equal(overrides.size, 1);
  const group = overrides.get("channel:x");
  assert.equal(group?.kind, "live");
  assert.deepEqual(group?.reg, { s: 1, c: 0, b: 900 });
  assert.deepEqual(nonOverride, { "channel:x": 1000 });
});

test("partitionOverrideGroups_tombstoneFloor_validates", () => {
  const raw = {
    "channel:x": 1000,
    "ov_c:channel:x": 5,
  };
  const { overrides, nonOverride } = partitionOverrideGroups(raw);
  assert.equal(overrides.size, 1);
  const group = overrides.get("channel:x");
  assert.equal(group?.kind, "floor");
  assert.equal(group?.c, 5);
  assert.deepEqual(nonOverride, { "channel:x": 1000 });
});

test("partitionOverrideGroups_partialGroup_droppedFrontierRetained", () => {
  // Only ov_s without ov_c and ov_b → partial group → rejected
  const raw = {
    "channel:x": 1000,
    "ov_s:channel:x": 1,
  };
  const { overrides, nonOverride } = partitionOverrideGroups(raw);
  assert.equal(overrides.size, 0); // group rejected
  assert.deepEqual(nonOverride, { "channel:x": 1000 }); // frontier retained
});

test("partitionOverrideGroups_sConly_droppedFrontierRetained", () => {
  // ov_s + ov_c but no ov_b → partial group
  const raw = {
    "channel:x": 1000,
    "ov_s:channel:x": 1,
    "ov_c:channel:x": 0,
  };
  const { overrides, nonOverride } = partitionOverrideGroups(raw);
  assert.equal(overrides.size, 0);
  assert.deepEqual(nonOverride, { "channel:x": 1000 });
});

test("partitionOverrideGroups_invalidValue_groupDropped", () => {
  // ov_s has non-integer value → invalid → whole group dropped
  const raw = {
    "channel:x": 1000,
    "ov_s:channel:x": "not-a-number",
    "ov_c:channel:x": 0,
    "ov_b:channel:x": 900,
  };
  const { overrides, nonOverride } = partitionOverrideGroups(raw);
  assert.equal(overrides.size, 0);
  assert.deepEqual(nonOverride, { "channel:x": 1000 });
});

test("partitionOverrideGroups_negativeValue_groupDropped", () => {
  const raw = {
    "channel:x": 1000,
    "ov_s:channel:x": -1,
    "ov_c:channel:x": 0,
    "ov_b:channel:x": 900,
  };
  const { overrides, nonOverride } = partitionOverrideGroups(raw);
  assert.equal(overrides.size, 0);
  assert.deepEqual(nonOverride, { "channel:x": 1000 });
});

test("partitionOverrideGroups_ovCInvalidValue_tombstoneDropped", () => {
  // Tombstone floor with non-integer c
  const raw = {
    "channel:x": 1000,
    "ov_c:channel:x": 1.5,
  };
  const { overrides, nonOverride } = partitionOverrideGroups(raw);
  assert.equal(overrides.size, 0);
  assert.deepEqual(nonOverride, { "channel:x": 1000 });
});

test("partitionOverrideGroups_multipleContexts_allValidated", () => {
  const raw = {
    "ch:a": 100,
    "ov_s:ch:a": 1,
    "ov_c:ch:a": 0,
    "ov_b:ch:a": 90,
    "ch:b": 200,
    "ov_c:ch:b": 3, // tombstone floor for ch:b
    "ch:c": 300,
    "ov_s:ch:c": 1, // partial — only s, no c/b → rejected
  };
  const { overrides, nonOverride } = partitionOverrideGroups(raw);
  assert.equal(overrides.size, 2); // ch:a and ch:b, ch:c rejected
  assert.equal(overrides.get("ch:a")?.kind, "live");
  assert.equal(overrides.get("ch:b")?.kind, "floor");
  assert.equal(overrides.has("ch:c"), false);
  // Frontier entries all retained
  assert.equal(nonOverride["ch:a"], 100);
  assert.equal(nonOverride["ch:b"], 200);
  assert.equal(nonOverride["ch:c"], 300);
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
  // esc: prefixed frontier keys must pass through unchanged
  const raw = { "esc:ov_s:suspicious-ctx": 1000 };
  const result = sanitizeContexts(raw);
  assert.equal(result["esc:ov_s:suspicious-ctx"], 1000);
});

// ---------------------------------------------------------------------------
// extractOverrideRegisters — from sanitized flat map
// ---------------------------------------------------------------------------

test("extractOverrideRegisters_liveGroup_reconstructsRegister", () => {
  const contexts = new Map([
    ["channel:x", 1000],
    [`${OV_S_PREFIX}channel:x`, 2],
    [`${OV_C_PREFIX}channel:x`, 1],
    [`${OV_B_PREFIX}channel:x`, 900],
  ]);
  const regs = extractOverrideRegisters(contexts);
  assert.equal(regs.size, 1);
  assert.deepEqual(regs.get("channel:x"), { s: 2, c: 1, b: 900 });
});

test("extractOverrideRegisters_tombstoneFloor_reconstructsRegister", () => {
  const contexts = new Map([
    ["channel:x", 1000],
    [`${OV_C_PREFIX}channel:x`, 5],
  ]);
  const regs = extractOverrideRegisters(contexts);
  assert.equal(regs.size, 1);
  // Floor shape: s=0, c=5, b=0
  assert.deepEqual(regs.get("channel:x"), { s: 0, c: 5, b: 0 });
});

test("extractOverrideRegisters_noOverrideKeys_returnsEmptyMap", () => {
  const contexts = new Map([["channel:x", 1000]]);
  const regs = extractOverrideRegisters(contexts);
  assert.equal(regs.size, 0);
});

test("extractOverrideRegisters_acceptsPlainRecord", () => {
  const contexts = {
    "channel:x": 1000,
    [`${OV_S_PREFIX}channel:x`]: 1,
    [`${OV_C_PREFIX}channel:x`]: 0,
    [`${OV_B_PREFIX}channel:x`]: 900,
  };
  const regs = extractOverrideRegisters(contexts);
  assert.deepEqual(regs.get("channel:x"), { s: 1, c: 0, b: 900 });
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

// ---------------------------------------------------------------------------
// Round-trip: encode → sanitize → extract produces original register
// ---------------------------------------------------------------------------

test("roundTrip_liveRegister_survivesEncodeAndExtract", () => {
  const reg = { s: 2, c: 1, b: 100 };
  const frontier = 50;
  const rawCtx = "channel-uuid-1234";

  // Encode (as a publisher would)
  const patch = encodeOverrideGroup(rawCtx, reg, frontier);
  // Simulate inclusion in a blob's contexts map (add frontier entry too)
  const rawContexts = { [rawCtx]: frontier, ...patch };
  // Sanitize (as a receiver would)
  const sanitized = sanitizeContexts(rawContexts);
  // Extract registers
  const regs = extractOverrideRegisters(sanitized);

  assert.deepEqual(regs.get(rawCtx), reg);
});

test("roundTrip_tombstoneFloor_survivesEncodeAndExtract", () => {
  // A dead register compacts to tombstone floor on encode
  const reg = { s: 0, c: 5, b: 0 }; // already a floor shape
  const frontier = 0;
  const rawCtx = "channel-uuid-5678";

  const patch = encodeOverrideGroup(rawCtx, reg, frontier);
  const rawContexts = { [rawCtx]: frontier, ...patch };
  const sanitized = sanitizeContexts(rawContexts);
  const regs = extractOverrideRegisters(sanitized);

  // Floor is s=0, c=5, b=0
  assert.deepEqual(regs.get(rawCtx), { s: 0, c: 5, b: 0 });
});

test("roundTrip_virginRegister_omittedFromWire", () => {
  const reg = { s: 0, c: 0, b: 0 };
  const frontier = 0;
  const rawCtx = "channel-uuid-virgin";

  const patch = encodeOverrideGroup(rawCtx, reg, frontier);
  assert.deepEqual(patch, {}); // nothing emitted
  const rawContexts = { [rawCtx]: frontier };
  const sanitized = sanitizeContexts(rawContexts);
  const regs = extractOverrideRegisters(sanitized);
  assert.equal(regs.has(rawCtx), false);
});
