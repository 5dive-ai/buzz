import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DATABRICKS_MODEL_NAMES } from "./databricksModelNames.ts";
import {
  resolveModelLabel,
  formatAgentModelLabel,
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
    /<DropdownMenuRadioItem[\s\S]*?\{resolveModelLabel\(model\.id, model\.name\)\}/,
    "dropdown rows must resolve labels through resolveModelLabel, not raw model.name/model.id",
  );
});
