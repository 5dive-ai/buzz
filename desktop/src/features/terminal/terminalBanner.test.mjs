import assert from "node:assert/strict";
import test from "node:test";

import { buildTerminalBanner } from "./terminalBanner.ts";

function layers(banner) {
  return new Map(
    ["field", "head", "bevel_hi", "bevel_lo"].map((layer) => [
      layer,
      banner.cells.flat().filter((cell) => cell.layer === layer),
    ]),
  );
}

test("builds the amended four-layer Buzz Term composite", () => {
  const banner = buildTerminalBanner(183, 69, 17 / 8.4);
  assert.ok(banner);
  const seen = layers(banner);
  for (const layer of seen.keys()) assert.ok(seen.get(layer).length > 0, layer);
  const head = seen.get("head");
  const sweep = head.map((cell) => cell.t);
  assert.equal(Math.min(...sweep), 0);
  assert.equal(Math.max(...sweep), 1);
  assert.ok(head.every((cell) => cell.layer === "head"));
  const { top, left, bottom, right } = banner.reserved;
  assert.equal(banner.cells[top][left].layer, "bevel_hi");
  assert.equal(banner.cells[bottom - 1][right - 1].layer, "bevel_lo");
  assert.match(
    seen
      .get("head")
      .map((cell) => cell.char)
      .join(""),
    /█/,
  );
});

test("emits complete hexagons only and fades per ray", () => {
  const banner = buildTerminalBanner(112, 46, 17 / 8.4);
  assert.ok(banner);
  const field = layers(banner).get("field");
  assert.equal(field.length % 8, 0);
  assert.ok(field.some((cell) => cell.t < 0.1));
  assert.ok(field.some((cell) => cell.t > 0.5));
});

test("safe mode replaces ambiguous frame rails without changing geometry", () => {
  const ink = buildTerminalBanner(183, 69, 17 / 8.4, false);
  const safe = buildTerminalBanner(183, 69, 17 / 8.4, true);
  assert.ok(ink && safe);
  assert.deepEqual(ink.reserved, safe.reserved);
  assert.ok(ink.cells.flat().some((cell) => cell.char === "▌"));
  assert.equal(
    safe.cells.flat().some((cell) => cell.char === "▌"),
    false,
  );
});

test("declines viewports too small for the complete wordmark", () => {
  assert.equal(buildTerminalBanner(40, 20, 17 / 8.4), null);
});
