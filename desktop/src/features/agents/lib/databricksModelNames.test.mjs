import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DATABRICKS_MODEL_NAMES } from "./databricksModelNames.ts";
import {
  resolveModelLabel,
  formatAgentModelLabel,
  canonicalizeProvider,
} from "./formatAgentModelLabel.ts";

// ---------------------------------------------------------------------------
// resolveModelLabel — known IDs → curated names
// ---------------------------------------------------------------------------

test("resolveModelLabel — known managed endpoint returns curated name", () => {
  assert.equal(resolveModelLabel("databricks-gpt-5-5"), "GPT-5.5");
  assert.equal(
    resolveModelLabel("databricks-claude-opus-4-7"),
    "Claude Opus 4.7",
  );
  assert.equal(resolveModelLabel("databricks-gpt-oss-120b"), "GPT OSS 120B");
});

// ---------------------------------------------------------------------------
// resolveModelLabel — unknown/custom IDs must pass through unchanged
// ---------------------------------------------------------------------------

test("resolveModelLabel — unknown custom endpoint returns raw ID unchanged", () => {
  assert.equal(
    resolveModelLabel("databricks-team-2025-01"),
    "databricks-team-2025-01",
  );
  assert.equal(
    resolveModelLabel("databricks-finance-2025-01-30"),
    "databricks-finance-2025-01-30",
  );
  assert.equal(
    resolveModelLabel("some-custom-workspace-model"),
    "some-custom-workspace-model",
  );
});

// ---------------------------------------------------------------------------
// resolveModelLabel — Object.prototype key hole: must not resolve through prototype
// ---------------------------------------------------------------------------

test("resolveModelLabel — 'constructor' passes through as raw ID", () => {
  assert.equal(resolveModelLabel("constructor"), "constructor");
});

test("resolveModelLabel — '__proto__' passes through as raw ID", () => {
  assert.equal(resolveModelLabel("__proto__"), "__proto__");
});

test("resolveModelLabel — 'toString' passes through as raw ID", () => {
  assert.equal(resolveModelLabel("toString"), "toString");
});

test("resolveModelLabel — 'hasOwnProperty' passes through as raw ID", () => {
  assert.equal(resolveModelLabel("hasOwnProperty"), "hasOwnProperty");
});

// ---------------------------------------------------------------------------
// resolveModelLabel — discovered name takes precedence over registry and raw ID
// ---------------------------------------------------------------------------

test("resolveModelLabel — nonblank discoveredName wins over registry entry", () => {
  // Even for a known registry ID, a nonblank discovered name wins (tier 1).
  assert.equal(
    resolveModelLabel("databricks-gpt-5-5", "My Custom Name"),
    "My Custom Name",
  );
});

test("resolveModelLabel — nonblank discoveredName wins over unknown raw ID", () => {
  assert.equal(
    resolveModelLabel("databricks-team-2025-01", "Team Model"),
    "Team Model",
  );
});

test("resolveModelLabel — blank/null discoveredName falls back to registry then raw ID", () => {
  assert.equal(resolveModelLabel("databricks-gpt-5-5", null), "GPT-5.5");
  assert.equal(resolveModelLabel("databricks-gpt-5-5", ""), "GPT-5.5");
  assert.equal(resolveModelLabel("databricks-gpt-5-5", "   "), "GPT-5.5");
  assert.equal(
    resolveModelLabel("databricks-team-2025-01", null),
    "databricks-team-2025-01",
  );
});

test("resolveModelLabel — empty id returns empty string", () => {
  assert.equal(resolveModelLabel(""), "");
});

// ---------------------------------------------------------------------------
// formatAgentModelLabel — null/empty → "Auto", non-empty → resolveModelLabel
// ---------------------------------------------------------------------------

test("formatAgentModelLabel — null or empty returns Auto", () => {
  assert.equal(formatAgentModelLabel(null), "Auto");
  assert.equal(formatAgentModelLabel(""), "Auto");
  assert.equal(formatAgentModelLabel("   "), "Auto");
});

test("formatAgentModelLabel — known Databricks ID returns curated name", () => {
  assert.equal(formatAgentModelLabel("databricks-gpt-5-5"), "GPT-5.5");
});

test("formatAgentModelLabel — unknown custom Databricks ID returns raw ID unchanged", () => {
  assert.equal(
    formatAgentModelLabel("databricks-team-2025-01"),
    "databricks-team-2025-01",
  );
});

// ---------------------------------------------------------------------------
// DATABRICKS_MODEL_NAMES Map — structural invariants
// ---------------------------------------------------------------------------

test("DATABRICKS_MODEL_NAMES — registry is non-empty and all entries are valid", () => {
  assert.ok(DATABRICKS_MODEL_NAMES.size > 0, "registry must not be empty");
  for (const [id, name] of DATABRICKS_MODEL_NAMES.entries()) {
    assert.ok(
      id.startsWith("databricks-"),
      `ID ${id} must start with 'databricks-'`,
    );
    assert.ok(name.length > 0, `name for ${id} must be non-empty`);
    assert.notEqual(name, id, `curated name for ${id} must differ from raw ID`);
  }
});

test("DATABRICKS_MODEL_NAMES — is a Map (not a plain object — prototype-key safety)", () => {
  assert.ok(
    DATABRICKS_MODEL_NAMES instanceof Map,
    "must be a Map, not a plain object",
  );
});

// ---------------------------------------------------------------------------
// Rust/TS parity: every entry in the committed Rust slice must appear in the TS
// Map with the same value, and neither side may carry an entry the other lacks.
// The generator emits both files from one models.dev fetch, so any divergence
// means a hand-edit or a half-committed regenerate.
// ---------------------------------------------------------------------------

/**
 * Parses `(id, name)` pairs out of the generated Rust slice. rustfmt wraps
 * long tuples across lines, so the source is matched as one string rather
 * than line by line.
 */
function parseRustRegistry(source) {
  const body = source.slice(
    source.indexOf("&[", source.indexOf("DATABRICKS_MODEL_NAMES")),
  );
  const pair = /\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,?\s*\)/g;
  const unescapeRust = (value) => value.replace(/\\(["\\])/g, "$1");
  return new Map(
    [...body.matchAll(pair)].map(([, id, name]) => [
      unescapeRust(id),
      unescapeRust(name),
    ]),
  );
}

test("DATABRICKS_MODEL_NAMES — full-table parity with the committed Rust registry", () => {
  const rustEntries = parseRustRegistry(
    readFileSync(
      new URL(
        "../../../../../crates/buzz-agent/src/databricks_model_names.rs",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  assert.ok(rustEntries.size > 0, "Rust registry parsed as empty — bad parse");
  assert.deepEqual(
    [...DATABRICKS_MODEL_NAMES.entries()].sort(),
    [...rustEntries.entries()].sort(),
    "TS and Rust registries must be identical — rerun scripts/generate-databricks-model-names.py and commit both files",
  );
});

// ---------------------------------------------------------------------------
// Resolver universality: every surface that renders a model label must go
// through resolveModelLabel. The ModelPicker dropdown rows live inside a Radix
// portal that renders nothing under renderToStaticMarkup (verified: even with
// forceMount the markup is ""), so the callsite is pinned at the source level
// — the same approach motion.test.mjs uses for CSS it cannot execute.
// ---------------------------------------------------------------------------

test("ModelPicker — discovered rows render through resolveModelLabel", () => {
  const source = readFileSync(
    new URL("../ui/ModelPicker.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /<DropdownMenuRadioItem[\s\S]*?\{resolveModelLabel\(model\.id, model\.name, agent\.provider\)\}/,
    "dropdown rows must resolve labels through resolveModelLabel with provider, not raw model.name/model.id",
  );
});

// ---------------------------------------------------------------------------
// P3-B: provider-scoped label resolution (Thufir pass-2 finding 2)
// ---------------------------------------------------------------------------

test("resolveModelLabel — provider-scoped miss returns raw ID, not Databricks registry name", () => {
  // "databricks-gemini-3-pro" is in DATABRICKS_MODEL_NAMES as "Gemini 3 Pro Preview".
  // When provider="anthropic", the generated lookup misses → must return raw ID.
  const result = resolveModelLabel(
    "databricks-gemini-3-pro",
    null,
    "anthropic",
  );
  assert.notEqual(
    result,
    "Gemini 3 Pro Preview",
    "must not leak Databricks registry label",
  );
  assert.equal(result, "databricks-gemini-3-pro");
});

test("resolveModelLabel — openai provider scoped miss returns raw ID", () => {
  const result = resolveModelLabel("databricks-gemini-3-pro", null, "openai");
  assert.equal(result, "databricks-gemini-3-pro");
});

test("resolveModelLabel — providerless call still returns unscoped registry label", () => {
  // No provider: the unscoped DATABRICKS_MODEL_NAMES map is reachable.
  const result = resolveModelLabel("databricks-gemini-3-pro", null, undefined);
  // The unscoped map should have a curated name for this ID.
  assert.ok(
    DATABRICKS_MODEL_NAMES.has("databricks-gemini-3-pro"),
    "databricks-gemini-3-pro must be in DATABRICKS_MODEL_NAMES for this test to be valid",
  );
  assert.equal(result, DATABRICKS_MODEL_NAMES.get("databricks-gemini-3-pro"));
  assert.notEqual(result, "databricks-gemini-3-pro");
});

test("resolveModelLabel — null provider treated as providerless (uses unscoped registry)", () => {
  const result = resolveModelLabel("databricks-gemini-3-pro", null, null);
  assert.equal(result, DATABRICKS_MODEL_NAMES.get("databricks-gemini-3-pro"));
});

test("resolveModelLabel — provider case-insensitivity: 'Anthropic' same as 'anthropic'", () => {
  const lower = resolveModelLabel("databricks-gemini-3-pro", null, "anthropic");
  const upper = resolveModelLabel("databricks-gemini-3-pro", null, "Anthropic");
  assert.equal(lower, upper);
  assert.equal(lower, "databricks-gemini-3-pro");
});

// ---------------------------------------------------------------------------
// P3-B: canonicalizeProvider — alias normalization
// ---------------------------------------------------------------------------

test("canonicalizeProvider — databricks-v2 (hyphen) maps to databricks_v2 (underscore)", () => {
  assert.equal(canonicalizeProvider("databricks-v2"), "databricks_v2");
});

test("canonicalizeProvider — uppercase DATABRICKS-V2 also normalizes to databricks_v2", () => {
  assert.equal(canonicalizeProvider("DATABRICKS-V2"), "databricks_v2");
});

test("canonicalizeProvider — databricks_v2 passes through unchanged", () => {
  assert.equal(canonicalizeProvider("databricks_v2"), "databricks_v2");
});

test("canonicalizeProvider — anthropic lowercases and trims", () => {
  assert.equal(canonicalizeProvider("  Anthropic  "), "anthropic");
});

test("canonicalizeProvider — unknown alias passes through lowercased", () => {
  assert.equal(canonicalizeProvider("OpenAI"), "openai");
});
