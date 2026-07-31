#!/bin/sh
// 2>/dev/null; LOADER="$(cd "$(dirname "$0")" && pwd)/ts-esm-loader.mjs"; exec node --experimental-strip-types --loader "$LOADER" "$0" "$@"
/**
 * Phase-2 differential harness — compare old buzzAgentConfig.ts effort logic with
 * the new generated modelCapabilities.ts interpreter over:
 *   1. The 36-entry effortTable.fixture.json (cross-boundary Rust/TS fixture)
 *   2. The 45-vector normative corpus (scripts/normative-corpus.json)
 *   3. The catalog-sample fixture (scripts/catalog-sample-fixture.json)
 *
 * Equality is required except for entries in the committed allowlist of intentional
 * F1 corrections (models.dev provider-capability reconciliations).
 *
 * Usage: node scripts/run-differential.mjs [--verbose]
 * Exits 0 on all-pass (modulo allowlist), 1 on unexpected divergence or unexercised allowlist entry.
 *
 * NOTE: The shebang bootstraps --experimental-strip-types and a custom ESM loader
 * (ts-esm-loader.mjs) that resolves extensionless relative TS imports. This is
 * required because buzzAgentConfig.ts (Phase 2b) imports modelCapabilities via a
 * bare specifier ("./modelCapabilities") that Node's strip-types runner cannot
 * otherwise resolve.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const VERBOSE = process.argv.includes("--verbose");

// ---------------------------------------------------------------------------
// Import both interpreters
// ---------------------------------------------------------------------------

// NEW: generated capability module
const { resolveModelCapabilities: resolveNew } = await import(
  join(repoRoot, "desktop", "src", "features", "agents", "ui", "modelCapabilities.ts")
);

// OLD: buzzAgentConfig.ts effort config
const { getProviderEffortConfig: getOldEffortConfig } = await import(
  join(repoRoot, "desktop", "src", "features", "agents", "ui", "buzzAgentConfig.ts")
);

// ---------------------------------------------------------------------------
// Intentional corrections allowlist (Phase 1 F1 reconciliations)
// Each entry: { provider, raw_model_id, reason }
// ---------------------------------------------------------------------------
const ALLOWLIST = [
  {
    provider: "databricks_v2",
    raw_model_id: "databricks-gpt-5-5",
    axes: ["supported_efforts"],
    reason: "Phase 1 ADOPT: models.dev d5a4974c advertises [low,medium,high]; old returns [none,low,medium,high,xhigh]",
  },
  {
    provider: "databricks_v2",
    raw_model_id: "databricks-gpt-5-4-mini",
    axes: ["supported_efforts"],
    reason: "Phase 1 ADOPT: models.dev advertises [low,medium,high]; old returns [none,low,medium,high,xhigh]",
  },
  {
    provider: "databricks_v2",
    raw_model_id: "databricks-gpt-5-4-nano",
    axes: ["supported_efforts"],
    reason: "Phase 1 ADOPT: models.dev advertises [low,medium,high]; old returns [none,low,medium,high,xhigh]",
  },
  {
    provider: "databricks_v2",
    raw_model_id: "databricks-gpt-5-6-sol",
    axes: ["supported_efforts"],
    reason: "Phase 1 ADOPT: models.dev advertises [low,medium,high,max]; old returns [none,low,medium,high,xhigh,max]",
  },
  {
    provider: "databricks_v2",
    raw_model_id: "goose-opus-5",
    axes: ["supported_efforts", "default_effort"],
    reason: "Phase 1 correction: 'opus' is a named DBv2 segment → anthropic-messages route; old config.rs disagreed with llm.rs (corpus note dbv2-goose-opus-5-is-anthropic). Generated adopts anthropic adaptive-xhigh capabilities consistent with the wire route.",
  },
];

// Track which allowlist entries are actually exercised (suppressed a divergence).
// Keyed as "provider:raw_model_id:axis".
const allowlistHits = new Set();

function isAllowlisted(provider, rawModelId, axis) {
  const entry = ALLOWLIST.find(
    (e) =>
      e.provider === provider &&
      e.raw_model_id === rawModelId &&
      e.axes.includes(axis),
  );
  if (entry) {
    allowlistHits.add(`${provider}:${rawModelId}:${axis}`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/**
 * Compare effort axes from both interpreters for one (provider, model) pair.
 * Returns array of divergence objects.
 */
function compareEffortAxes(provider, model) {
  const newResult = resolveNew(provider, model);
  const oldResult = getOldEffortConfig(provider, model);

  const divergences = [];

  // supported_efforts
  const newEfforts = newResult.supportedEfforts ?? [];
  const oldEfforts = oldResult?.validValues ?? [];
  if (JSON.stringify(newEfforts) !== JSON.stringify(oldEfforts)) {
    if (!isAllowlisted(provider, model, "supported_efforts")) {
      divergences.push({
        axis: "supported_efforts",
        old: oldEfforts,
        new: newEfforts,
      });
    }
  }

  // default_effort
  const newDefault = newResult.defaultEffort ?? null;
  const oldDefault = oldResult?.defaultValue ?? null;
  if (newDefault !== oldDefault) {
    if (!isAllowlisted(provider, model, "default_effort")) {
      divergences.push({
        axis: "default_effort",
        old: oldDefault,
        new: newDefault,
      });
    }
  }

  return divergences;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

let totalChecks = 0;
let totalDivergences = 0;

function runCheck(label, provider, model) {
  totalChecks++;
  const divs = compareEffortAxes(provider, model);
  if (divs.length > 0) {
    totalDivergences += divs.length;
    for (const d of divs) {
      console.error(
        `DIVERGE  [${label}] provider=${provider} model=${model} axis=${d.axis}\n` +
          `         old: ${JSON.stringify(d.old)}\n` +
          `         new: ${JSON.stringify(d.new)}`,
      );
    }
  } else if (VERBOSE) {
    console.log(`OK       [${label}] provider=${provider} model=${model}`);
  }
}

// 1. effortTable.fixture.json
console.log("--- effortTable.fixture.json ---");
const fixture = JSON.parse(
  readFileSync(
    join(repoRoot, "desktop", "src", "features", "agents", "ui", "effortTable.fixture.json"),
    "utf8",
  ),
);
for (const entry of fixture) {
  if (!entry.provider) continue;
  runCheck("fixture", entry.provider, entry.model ?? "");
}

// 2. normative-corpus.json (effort axes only)
console.log("--- normative-corpus.json ---");
const corpus = JSON.parse(
  readFileSync(join(repoRoot, "scripts", "normative-corpus.json"), "utf8"),
);
for (const entry of corpus) {
  if (entry._group) continue;
  if (!entry.provider || !entry.expect) continue;
  if (!entry.expect.supported_efforts && !entry.expect.default_effort) continue;
  runCheck("corpus", entry.provider, entry.raw_model_id ?? "");
}

// 3. catalog-sample-fixture.json (exact records from pinned models.dev payload)
console.log("--- catalog-sample-fixture.json ---");
const catalogFixture = JSON.parse(
  readFileSync(join(repoRoot, "scripts", "catalog-sample-fixture.json"), "utf8"),
);
for (const ep of catalogFixture.endpoints ?? []) {
  if (!ep.name) continue;
  // All catalog endpoints are databricks_v2 provider
  runCheck("catalog-sample", "databricks_v2", ep.name);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// Count total allowlist axis slots expected to be hit
const totalAllowlistSlots = ALLOWLIST.reduce((n, e) => n + e.axes.length, 0);
const allowlistHitCount = allowlistHits.size;

// Detect stale allowlist entries (declared but never actually suppressed a divergence)
const staleEntries = [];
for (const entry of ALLOWLIST) {
  for (const axis of entry.axes) {
    const key = `${entry.provider}:${entry.raw_model_id}:${axis}`;
    if (!allowlistHits.has(key)) {
      staleEntries.push({ ...entry, axis });
    }
  }
}

console.log(
  `\nDifferential: ${totalChecks} checks, ${totalDivergences} unexpected divergences, ${allowlistHitCount}/${totalAllowlistSlots} allowlist slots exercised`,
);

if (staleEntries.length > 0) {
  for (const e of staleEntries) {
    console.error(
      `STALE_ALLOWLIST  provider=${e.provider} model=${e.raw_model_id} axis=${e.axis} — entry never fired; remove or update it`,
    );
  }
}

if (totalDivergences > 0) {
  console.error(
    `FAIL: ${totalDivergences} unexpected divergence(s) — see output above`,
  );
  process.exit(1);
} else if (staleEntries.length > 0) {
  console.error(
    `FAIL: ${staleEntries.length} stale allowlist entry(ies) — entries that never suppress a divergence mask future regressions`,
  );
  process.exit(1);
} else {
  console.log("PASS: old and new effort logic agree on all non-allowlisted entries");
}
