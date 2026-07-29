import assert from "node:assert/strict";
import test from "node:test";

import {
  databricksModelName,
  DATABRICKS_MODEL_NAMES,
} from "./databricksModelNames.ts";

test("databricksModelName — known managed endpoint returns curated name", () => {
  assert.equal(databricksModelName("databricks-gpt-5-5"), "GPT-5.5");
  assert.equal(
    databricksModelName("databricks-claude-opus-4-7"),
    "Claude Opus 4.7",
  );
  assert.equal(databricksModelName("databricks-gpt-oss-120b"), "GPT OSS 120B");
});

test("databricksModelName — unknown custom endpoint returns raw ID unchanged", () => {
  // A workspace-specific or date-stamped endpoint that isn't in the registry
  // must never be guessed — return it verbatim.
  assert.equal(
    databricksModelName("databricks-team-2025-01"),
    "databricks-team-2025-01",
  );
  assert.equal(
    databricksModelName("databricks-finance-2025-01-30"),
    "databricks-finance-2025-01-30",
  );
  assert.equal(
    databricksModelName("some-custom-workspace-model"),
    "some-custom-workspace-model",
  );
});

test("databricksModelName — empty string returns empty string", () => {
  assert.equal(databricksModelName(""), "");
});

test("DATABRICKS_MODEL_NAMES — registry is non-empty and all values are non-empty strings", () => {
  const entries = Object.entries(DATABRICKS_MODEL_NAMES);
  assert.ok(entries.length > 0, "registry must not be empty");
  for (const [id, name] of entries) {
    assert.ok(
      id.startsWith("databricks-"),
      `ID ${id} must start with 'databricks-'`,
    );
    assert.ok(name.length > 0, `name for ${id} must be non-empty`);
    assert.notEqual(name, id, `curated name for ${id} must differ from raw ID`);
  }
});
