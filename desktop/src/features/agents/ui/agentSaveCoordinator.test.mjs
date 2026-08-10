import assert from "node:assert/strict";
import test from "node:test";

import { runAgentSaveCoordinator } from "./agentSaveCoordinator.ts";
import { seedAgentFormModel, emitAgentFormDiff } from "./agentFormModel.ts";

// ── Shared fixtures ────────────────────────────────────────────────────────────

function makeDefinition(overrides = {}) {
  return {
    id: "def-1",
    displayName: "Alice",
    avatarUrl: "",
    systemPrompt: "Be helpful.",
    runtime: "goose",
    model: "gpt-4o",
    provider: null,
    isBuiltIn: false,
    isActive: true,
    namePool: [],
    envVars: {},
    respondTo: null,
    respondToAllowlist: [],
    parallelism: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeInstance(overrides = {}) {
  return {
    pubkey: "pk-abc",
    name: "Alice",
    avatarUrl: "",
    systemPrompt: null,
    model: null,
    provider: null,
    envVars: {},
    respondTo: null,
    respondToAllowlist: [],
    parallelism: null,
    autoRestartOnConfigChange: false,
    startOnAppLaunch: false,
    ...overrides,
  };
}

function makePersonaInput(overrides = {}) {
  return {
    id: "def-1",
    displayName: "Alice",
    systemPrompt: "Be helpful.",
    avatarUrl: "",
    runtime: "goose",
    model: "gpt-4o",
    provider: undefined,
    namePool: [],
    envVars: {},
    ...overrides,
  };
}

function makeAgentInput(overrides = {}) {
  return {
    pubkey: "pk-abc",
    ...overrides,
  };
}

/** Build minimal coordinator options. All mutations succeed by default. */
function makeOpts(overrides = {}) {
  const def = makeDefinition();
  const inst = makeInstance();

  const calls = {
    updatePersona: 0,
    updatePersonaAndPublish: 0,
    updateManagedAgent: 0,
    setAutoRestart: 0,
    setStartOnAppLaunch: 0,
    onDone: 0,
    onSavedWhileStopped: 0,
  };

  const opts = {
    ctx: { kind: "instance-with-definition", definition: def, instance: inst },
    personaInput: null,
    agentInput: null,
    policySets: [],
    publishCatalogUpdates: false,
    runtimes: undefined,
    updatePersona: async () => {
      calls.updatePersona++;
    },
    updatePersonaAndPublish: async () => {
      calls.updatePersonaAndPublish++;
      return { publicationStatus: "published" };
    },
    updateManagedAgent: async () => {
      calls.updateManagedAgent++;
      return { agent: inst, profileSyncError: null };
    },
    setAutoRestart: async () => {
      calls.setAutoRestart++;
    },
    setStartOnAppLaunch: async () => {
      calls.setStartOnAppLaunch++;
    },
    refetchStores: async () => ({ persona: def, agent: inst }),
    onDone: () => {
      calls.onDone++;
    },
    onSavedWhileStopped: () => {
      calls.onSavedWhileStopped++;
    },
    _calls: calls,
    ...overrides,
  };

  return opts;
}

// ── Test family 1: write ordering ─────────────────────────────────────────────
//
// Step 1 (definition write) must run before step 2 (instance write), and a
// step-1 error must prevent step 2 from being attempted.

test("test_write_ordering_definition_write_failure_skips_instance_write", async () => {
  const calls = { updatePersona: 0, updateManagedAgent: 0 };

  const opts = makeOpts({
    personaInput: makePersonaInput(),
    agentInput: makeAgentInput({ name: "Alice-renamed" }),
    updatePersona: async () => {
      calls.updatePersona++;
      throw new Error("Relay offline");
    },
    updateManagedAgent: async () => {
      calls.updateManagedAgent++;
      return { agent: makeInstance(), profileSyncError: null };
    },
    refetchStores: async () => ({ persona: null, agent: null }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    false,
    "should return false on definition write failure",
  );
  assert.equal(calls.updatePersona, 1, "definition write should be attempted");
  assert.equal(
    calls.updateManagedAgent,
    0,
    "instance write must NOT be attempted when definition write fails",
  );
});

test("test_write_ordering_instance_write_runs_after_definition_write_succeeds", async () => {
  const calls = { updatePersona: 0, updateManagedAgent: 0 };

  const opts = makeOpts({
    personaInput: makePersonaInput(),
    agentInput: makeAgentInput({ name: "Alice-renamed" }),
    updatePersona: async () => {
      calls.updatePersona++;
    },
    updateManagedAgent: async () => {
      // Must only be called after updatePersona
      assert.equal(
        calls.updatePersona,
        1,
        "definition write must precede instance write",
      );
      calls.updateManagedAgent++;
      return {
        agent: makeInstance({ name: "Alice-renamed" }),
        profileSyncError: null,
      };
    },
    refetchStores: async () => ({
      persona: makeDefinition(),
      agent: makeInstance({ name: "Alice-renamed" }),
    }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, true, "should return true on full success");
  assert.equal(calls.updatePersona, 1, "definition write should be called");
  assert.equal(calls.updateManagedAgent, 1, "instance write should be called");
});

test("test_write_ordering_policy_setters_run_only_after_both_data_writes_succeed", async () => {
  const calls = { updatePersona: 0, updateManagedAgent: 0, setAutoRestart: 0 };
  // The refetchStores must reflect each write as it happens so per-boundary
  // settlement passes and the coordinator can advance through all steps.
  // After I-write the agent has name "Alice-renamed"; after autoRestart the
  // agent also has autoRestartOnConfigChange: true.
  let refetchCount = 0;

  const opts = makeOpts({
    personaInput: makePersonaInput(),
    agentInput: makeAgentInput({ name: "Alice-renamed" }),
    policySets: [{ type: "autoRestart", pubkey: "pk-abc", value: true }],
    updatePersona: async () => {
      calls.updatePersona++;
    },
    updateManagedAgent: async () => {
      calls.updateManagedAgent++;
      return {
        agent: makeInstance({ name: "Alice-renamed" }),
        profileSyncError: null,
      };
    },
    setAutoRestart: async () => {
      // Must only be called after both data writes
      assert.equal(
        calls.updatePersona,
        1,
        "definition write must precede policy setter",
      );
      assert.equal(
        calls.updateManagedAgent,
        1,
        "instance write must precede policy setter",
      );
      calls.setAutoRestart++;
    },
    refetchStores: async () => {
      refetchCount++;
      // After D-write (refetch 1): persona matches, agent has original name.
      // After I-write (refetch 2): agent now has renamed name.
      // After autoRestart setter (refetch 3 + final): agent also has autoRestart=true.
      const agentName = refetchCount >= 2 ? "Alice-renamed" : "Alice";
      const autoRestart = refetchCount >= 3;
      return {
        persona: makeDefinition(),
        agent: makeInstance({
          name: agentName,
          autoRestartOnConfigChange: autoRestart,
        }),
      };
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, true);
  assert.equal(calls.setAutoRestart, 1, "policy setter should be called");
});

// ── Test family 2: local-save / publish failure ───────────────────────────────
//
// A definition write failure should surface as partial failure, reporting what
// did NOT persist. A publish failure (updatePersonaAndPublish throws) should
// also stop the sequence.

test("test_local_save_failure_returns_false_and_calls_settlement", async () => {
  let settlementCalled = false;

  const opts = makeOpts({
    personaInput: makePersonaInput(),
    updatePersona: async () => {
      throw new Error("Disk full");
    },
    refetchStores: async () => {
      settlementCalled = true;
      return { persona: null, agent: null };
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, false, "should return false on local save failure");
  assert.equal(
    settlementCalled,
    true,
    "settlement (refetchStores) must be called even on failure",
  );
});

test("test_publish_failure_returns_false_stops_sequence", async () => {
  const calls = { updateManagedAgent: 0 };

  const opts = makeOpts({
    personaInput: makePersonaInput(),
    agentInput: makeAgentInput({ name: "Alice-renamed" }),
    publishCatalogUpdates: true,
    updatePersonaAndPublish: async () => {
      throw new Error("Relay rejected");
    },
    updateManagedAgent: async () => {
      calls.updateManagedAgent++;
      return { agent: makeInstance(), profileSyncError: null };
    },
    refetchStores: async () => ({ persona: null, agent: null }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, false, "should return false on publish failure");
  assert.equal(
    calls.updateManagedAgent,
    0,
    "instance write must not run if publish step failed",
  );
});

// ── Test family 3: observed mismatch ─────────────────────────────────────────
//
// Command success alone does not mean persistence. If the re-fetched observed
// state does not match what was submitted, the coordinator must return false
// and report the mismatch.

test("test_observed_mismatch_returns_false_when_persona_not_in_store_after_write", async () => {
  // updatePersona succeeds but refetchStores returns persona: null
  // (the write never actually persisted — e.g. a race with another write).
  const opts = makeOpts({
    personaInput: makePersonaInput({ displayName: "Alice-renamed" }),
    updatePersona: async () => {},
    // Observed store shows the original name (write lost)
    refetchStores: async () => ({
      persona: makeDefinition({ displayName: "Alice" }),
      agent: null,
    }),
  });

  const result = await runAgentSaveCoordinator(opts);

  // The submitted displayName "Alice-renamed" doesn't match observed "Alice"
  assert.equal(
    result,
    false,
    "should return false when observed state doesn't match submission",
  );
  assert.equal(
    opts._calls.onDone,
    0,
    "onDone must NOT be called when observed state doesn't match",
  );
});

test("test_observed_match_calls_onDone_and_returns_true", async () => {
  // Both the write succeeds and the observed state matches.
  const updatedPersona = makeDefinition({ displayName: "Alice-renamed" });

  const opts = makeOpts({
    personaInput: makePersonaInput({ displayName: "Alice-renamed" }),
    updatePersona: async () => {},
    refetchStores: async () => ({ persona: updatedPersona, agent: null }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    true,
    "should return true when observed state matches submission",
  );
  assert.equal(opts._calls.onDone, 1, "onDone must be called on full success");
});

test("test_absent_entity_after_refetch_is_not_persisted", async () => {
  // persona: null after refetch means the entity was not found → not persisted.
  const opts = makeOpts({
    personaInput: makePersonaInput(),
    updatePersona: async () => {},
    // Simulate write succeeding at command level but entity not appearing in store
    refetchStores: async () => ({ persona: null, agent: null }),
  });

  const result = await runAgentSaveCoordinator(opts);

  // Even though updatePersona didn't throw, the absent observed state means failure.
  assert.equal(
    result,
    false,
    "absent entity after refetch must be treated as not persisted",
  );
});

// ── Test family 4: partial policy failure ─────────────────────────────────────
//
// Multiple policy setters: if the first succeeds and the second fails, the
// coordinator must report the second as failed and return false. Unattempted
// policies (beyond the failing one) must also be reported as failed.

test("test_partial_policy_failure_first_succeeds_second_fails_returns_false", async () => {
  const calls = { setAutoRestart: 0, setStartOnAppLaunch: 0 };

  const inst = makeInstance({
    autoRestartOnConfigChange: false,
    startOnAppLaunch: false,
  });

  // Per-boundary settlement: after the first policy setter (autoRestart) succeeds,
  // refetchStores must return autoRestartOnConfigChange: true for the check to
  // pass and the coordinator to advance to the second setter. The second setter
  // throws, so the second policy is attempted but fails.
  let refetchCount = 0;

  const opts = makeOpts({
    ctx: {
      kind: "instance-with-definition",
      definition: makeDefinition(),
      instance: inst,
    },
    policySets: [
      { type: "autoRestart", pubkey: "pk-abc", value: true },
      { type: "startOnAppLaunch", pubkey: "pk-abc", value: true },
    ],
    setAutoRestart: async () => {
      calls.setAutoRestart++;
    },
    setStartOnAppLaunch: async () => {
      calls.setStartOnAppLaunch++;
      throw new Error("Permission denied");
    },
    refetchStores: async () => {
      refetchCount++;
      // After first policy setter (autoRestart=true) succeeds, reflect it.
      // startOnAppLaunch stays false throughout (second setter throws).
      const autoRestart = refetchCount >= 1 && calls.setAutoRestart > 0;
      return {
        persona: makeDefinition(),
        agent: makeInstance({
          autoRestartOnConfigChange: autoRestart,
          startOnAppLaunch: false,
        }),
      };
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    false,
    "should return false when any policy setter fails",
  );
  assert.equal(calls.setAutoRestart, 1, "first policy should be attempted");
  assert.equal(
    calls.setStartOnAppLaunch,
    1,
    "second policy should be attempted",
  );
  assert.equal(
    opts._calls.onDone,
    0,
    "onDone must not be called on partial policy failure",
  );
});

test("test_early_policy_failure_skips_subsequent_policies", async () => {
  const calls = { setAutoRestart: 0, setStartOnAppLaunch: 0 };

  const inst = makeInstance();

  const opts = makeOpts({
    ctx: {
      kind: "instance-with-definition",
      definition: makeDefinition(),
      instance: inst,
    },
    policySets: [
      { type: "autoRestart", pubkey: "pk-abc", value: true },
      { type: "startOnAppLaunch", pubkey: "pk-abc", value: true },
    ],
    setAutoRestart: async () => {
      calls.setAutoRestart++;
      throw new Error("Store locked");
    },
    setStartOnAppLaunch: async () => {
      calls.setStartOnAppLaunch++;
    },
    refetchStores: async () => ({ persona: makeDefinition(), agent: inst }),
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(
    result,
    false,
    "should return false when first policy setter fails",
  );
  assert.equal(calls.setAutoRestart, 1, "first policy should be attempted");
  assert.equal(
    calls.setStartOnAppLaunch,
    0,
    "second policy must NOT be attempted after first failure (stop-at-first-failure per spec)",
  );
});

test("test_settlement_always_runs_even_when_no_writes_attempted", async () => {
  // No personaInput, no agentInput, no policySets: nothing to write.
  // Settlement (refetchStores) should still be called for the success path.
  let settlementCalled = false;

  const opts = makeOpts({
    refetchStores: async () => {
      settlementCalled = true;
      return { persona: null, agent: null };
    },
    onDone: () => {},
  });

  await runAgentSaveCoordinator(opts);

  assert.equal(
    settlementCalled,
    true,
    "settlement must always run regardless of writes",
  );
});

// -- CRITICAL-3: per-boundary mismatch tests --
//
// These verify Thufir's two probes: successful harness command whose refetched
// agent retains old harness fields must NOT call onDone; successful auto-restart
// setter whose refetched agent remains false must NOT call onDone.

test("test_harness_command_success_but_observed_mismatch_returns_false", async () => {
  // Thufir probe 1: agentCommand submitted, command returns success, but the
  // refetched agent still has the old command. Must NOT call onDone.
  let doneCalled = false;

  const staleAgent = makeInstance({
    agentCommand: "/old/harness",
    agentCommandOverride: null,
    agentArgs: [],
    acpCommand: "",
  });
  const opts = makeOpts({
    agentInput: { pubkey: "pk-abc", agentCommand: "/new/harness" },
    updateManagedAgent: async () => ({
      agent: staleAgent,
      profileSyncError: null,
    }),
    refetchStores: async () => ({
      persona: null,
      agent: staleAgent, // old command -- mismatch with submitted
    }),
    onDone: () => {
      doneCalled = true;
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, false, "mismatch must return false");
  assert.equal(
    doneCalled,
    false,
    "onDone must NOT be called on harness mismatch",
  );
});

test("test_auto_restart_success_but_observed_unchanged_returns_false", async () => {
  // Thufir probe 2: autoRestart setter returns success (no throw), but the
  // refetched agent still has the old value (false). Must NOT call onDone.
  let doneCalled = false;

  const unchangedAgent = makeInstance({ autoRestartOnConfigChange: false });
  const opts = makeOpts({
    policySets: [{ type: "autoRestart", pubkey: "pk-abc", value: true }],
    setAutoRestart: async () => {},
    refetchStores: async () => ({
      persona: null,
      agent: unchangedAgent, // still false -- mismatch with submitted true
    }),
    onDone: () => {
      doneCalled = true;
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, false, "auto-restart mismatch must return false");
  assert.equal(
    doneCalled,
    false,
    "onDone must NOT be called when policy did not persist",
  );
});

test("test_start_on_app_launch_success_and_observed_match_calls_onDone", async () => {
  // Positive case: startOnAppLaunch setter succeeds AND observed state matches.
  let doneCalled = false;

  const updatedAgent = makeInstance({ startOnAppLaunch: true });
  const opts = makeOpts({
    policySets: [{ type: "startOnAppLaunch", pubkey: "pk-abc", value: true }],
    setStartOnAppLaunch: async () => {},
    refetchStores: async () => ({
      persona: null,
      agent: updatedAgent, // matches submitted value
    }),
    onDone: () => {
      doneCalled = true;
    },
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, true, "matching policy must return true");
  assert.equal(doneCalled, true, "onDone must be called on policy success");
});

test("test_definition_write_not_persisted_stops_instance_write", async () => {
  // Per-boundary: if D-write succeeds but observed persona does not match,
  // the coordinator must not advance to the I-write.
  let instanceWriteCalled = false;

  const stalePersona = makeDefinition({
    displayName: "Old Name",
    systemPrompt: "Be helpful.",
  });
  const opts = makeOpts({
    personaInput: {
      id: "def-1",
      displayName: "Updated Name",
      systemPrompt: "Updated prompt.",
      namePool: [],
      envVars: {},
    },
    agentInput: { pubkey: "pk-abc", name: "updated-name" },
    updatePersona: async () => {},
    updateManagedAgent: async () => {
      instanceWriteCalled = true;
      return { agent: makeInstance(), profileSyncError: null };
    },
    refetchStores: async () => ({
      // Persona with OLD displayName = mismatch after D-write.
      persona: stalePersona,
      agent: makeInstance(),
    }),
    onDone: () => {},
  });

  const result = await runAgentSaveCoordinator(opts);

  assert.equal(result, false, "D-write mismatch must return false");
  assert.equal(
    instanceWriteCalled,
    false,
    "instance write must NOT be attempted when D-write did not persist",
  );
});

// ── R6 route-level behavioral tests ──────────────────────────────────────────
//
// These tests exercise the full chain that R6 (owner-review dialog) exercises
// in production:
//   1. reviewOverrides.respondTo arrives from useAgentManagement
//   2. Dialog seed effect applies it as initialValueOverrides.respondTo
//   3. emitAgentFormDiff routes the change to personaInput.behavior.respondTo
//   4. runAgentSaveCoordinator calls updatePersona with the correct behavior
//   5. onValidate is checked (permission gate)
//   6. Settlement confirms persistence
//
// This is a coordinator-level behavioral test: it calls emitAgentFormDiff to
// produce inputs and then passes them through runAgentSaveCoordinator, proving
// the full pipeline from override → emission → coordinator → save.

test("test_r6_respondTo_override_visible_and_delivered_through_coordinator", async () => {
  // Scenario: owner-review dialog for a definition that currently has no
  // respondTo (null = owner-only by backend default). Agent requested
  // respondTo: "owner-only" explicitly. The dialog pre-fills it via
  // initialValueOverrides.respondTo = "owner-only".

  const definition = makeDefinition({ respondTo: null });
  const ctx = { kind: "definition-only", definition };

  // Step 1: seed form model (mirrors AgentEditMergedDialog's seed effect).
  const seed = seedAgentFormModel(ctx);
  assert.equal(
    seed.respondTo,
    null,
    "definition-only seed preserves null respondTo",
  );

  // Step 2: apply initialValueOverrides.respondTo (mirrors the dialog's
  // useEffect block that sets respondTo from initialValueOverrides).
  const formState = { ...seed, respondTo: "owner-only" };

  // Step 3: emit the diff — proves the override is visible in the form state
  // and routes to personaInput (D-owned in definition-only context).
  const { personaInput, agentInput } = emitAgentFormDiff(seed, formState, ctx);

  assert.ok(
    personaInput,
    "R6 respondTo override must produce a personaInput diff",
  );
  assert.equal(
    personaInput.behavior?.respondTo,
    "owner-only",
    "personaInput.behavior.respondTo must carry the agent-requested value",
  );
  assert.equal(agentInput, null, "definition-only: no agentInput");

  // Step 4+5: run coordinator to verify coordinator receives and
  // persists a well-formed personaInput from the emission pipeline.
  // (onValidate is called by useAgentEditMergedSubmit before the coordinator;
  // we verify here that the coordinator delivers the respondTo to updatePersona.)
  let capturedPersonaInput = null;
  let doneCalled = false;

  const updatedDefinition = makeDefinition({
    respondTo: "owner-only",
    respondToAllowlist: [],
    parallelism: null,
  });

  const result = await runAgentSaveCoordinator({
    ctx,
    personaInput,
    agentInput: null,
    policySets: [],
    updatePersona: async (input) => {
      capturedPersonaInput = input;
    },
    updatePersonaAndPublish: async () => ({ publicationStatus: "published" }),
    updateManagedAgent: async () => {
      throw new Error("no instance in definition-only context");
    },
    setAutoRestart: async () => {},
    setStartOnAppLaunch: async () => {},
    refetchStores: async () => ({
      persona: updatedDefinition,
      agent: null,
    }),
    onDone: () => {
      doneCalled = true;
    },
  });

  assert.equal(result, true, "coordinator must succeed with approved save");
  assert.ok(capturedPersonaInput, "updatePersona must be called");
  assert.equal(
    capturedPersonaInput.behavior?.respondTo,
    "owner-only",
    "updatePersona must receive the agent-requested respondTo",
  );
  assert.equal(doneCalled, true, "onDone must be called on success");
});

test("test_r6_respondTo_override_settlement_fails_if_persona_not_updated", async () => {
  // Negative case: coordinator emits the correct personaInput but the
  // re-fetched persona still has the old value → settlement failure → onDone NOT called.
  const definition = makeDefinition({ respondTo: null });
  const ctx = { kind: "definition-only", definition };
  const seed = seedAgentFormModel(ctx);
  const formState = { ...seed, respondTo: "owner-only" };
  const { personaInput } = emitAgentFormDiff(seed, formState, ctx);

  let doneCalled = false;

  // Settlement returns STALE persona (respondTo still null).
  const stalePersona = makeDefinition({ respondTo: null });

  const result = await runAgentSaveCoordinator({
    ctx,
    personaInput,
    agentInput: null,
    policySets: [],
    updatePersona: async () => {},
    updatePersonaAndPublish: async () => ({ publicationStatus: "published" }),
    updateManagedAgent: async () => {
      throw new Error("no instance in definition-only context");
    },
    setAutoRestart: async () => {},
    setStartOnAppLaunch: async () => {},
    refetchStores: async () => ({
      persona: stalePersona,
      agent: null,
    }),
    onDone: () => {
      doneCalled = true;
    },
  });

  assert.equal(result, false, "stale observed state must return false");
  assert.equal(
    doneCalled,
    false,
    "onDone must NOT be called when respondTo did not persist",
  );
});
