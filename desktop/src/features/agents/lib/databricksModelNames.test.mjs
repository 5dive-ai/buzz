import assert from "node:assert/strict";
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
// Rust/TS parity: spot-check representative entries from the generated Rust slice
// The generator emits both files from the same source, so any key present in Rust
// must also be present in the TS Map with the same value.
// ---------------------------------------------------------------------------

test("DATABRICKS_MODEL_NAMES — parity spot-check: representative entries match Rust slice values", () => {
  const expected = [
    ["databricks-gpt-5-5", "GPT-5.5"],
    ["databricks-claude-opus-4-7", "Claude Opus 4.7"],
    ["databricks-gpt-oss-120b", "GPT OSS 120B"],
    ["databricks-claude-sonnet-4-5", "Claude Sonnet 4.5 (latest)"],
    ["databricks-gemini-2-5-flash", "Gemini 2.5 Flash"],
  ];
  for (const [id, name] of expected) {
    assert.equal(
      DATABRICKS_MODEL_NAMES.get(id),
      name,
      `TS registry entry for '${id}' must match Rust registry`,
    );
  }
});
