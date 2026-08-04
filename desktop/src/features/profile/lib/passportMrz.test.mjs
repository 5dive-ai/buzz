import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPassportMrz,
  mrzName,
  PASSPORT_MRZ_LINE_LENGTH,
  passportDocumentCode,
} from "./passportMrz.ts";

const NPUB = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";

test("document code distinguishes people from agents", () => {
  assert.equal(passportDocumentCode(false), "P");
  assert.equal(passportDocumentCode(true), "A");
});

test("mrzName uses surname<<given convention and MRZ charset", () => {
  assert.equal(mrzName("Tyler"), "TYLER");
  assert.equal(mrzName("Johnny Apple Seed"), "JOHNNY<<APPLE<SEED");
  assert.equal(mrzName("Zoë O'Brien"), "ZOE<<OBRIEN");
  assert.equal(mrzName("  "), "");
});

test("buildPassportMrz emits three fixed-width lines carrying the full npub", () => {
  const lines = buildPassportMrz({
    displayName: "Johnny Appleseed",
    isAgent: false,
    npub: NPUB,
  });

  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.equal(line.length, PASSPORT_MRZ_LINE_LENGTH);
    assert.match(line, /^[A-Z0-9<]+$/);
  }
  assert.ok(lines[0].startsWith("P<BUZJOHNNY<<APPLESEED"));

  // The npub survives round-trip: strip filler, lowercase, rejoin.
  const key = (lines[1] + lines[2]).replaceAll("<", "").toLowerCase();
  assert.equal(key, NPUB);
});

test("agent passports lead with the A document code", () => {
  const [nameLine] = buildPassportMrz({
    displayName: "Nest Keeper",
    isAgent: true,
    npub: NPUB,
  });
  assert.ok(nameLine.startsWith("A<BUZNEST<<KEEPER"));
});

test("overlong names truncate to the line width instead of overflowing", () => {
  const [nameLine] = buildPassportMrz({
    displayName: "A".repeat(80),
    isAgent: false,
    npub: NPUB,
  });
  assert.equal(nameLine.length, PASSPORT_MRZ_LINE_LENGTH);
});
