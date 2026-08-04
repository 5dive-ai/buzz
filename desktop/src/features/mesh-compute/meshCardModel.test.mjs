/**
 * Contract tests for the sidebar shared-compute card model.
 *
 * The card's whole job is to make "am I giving compute / taking compute /
 * neither" unmistakable, so these tests pin the distinctions that are easy to
 * regress:
 *
 *   - consuming must never render as sharing (both report state:"running")
 *   - unknown capacity must never print "0 GB"
 *   - a serve node with no advertised model is warming up, not serving
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeMeshCapacity,
  describeParticipation,
  describeReadyModels,
  deriveMeshCardModel,
  formatCapacityGb,
  shortModelLabel,
} from "./meshCardModel.ts";

const OFF_TOGGLE = {
  isSharing: false,
  isConsuming: false,
  slotOccupied: false,
};
const SHARING_TOGGLE = {
  isSharing: true,
  isConsuming: false,
  slotOccupied: true,
};
const CONSUMING_TOGGLE = {
  isSharing: false,
  isConsuming: true,
  slotOccupied: true,
};

function device(overrides = {}) {
  return {
    deviceId: "endpoint-1",
    label: "Studio",
    capacityGb: 36,
    models: ["unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M"],
    state: "serving",
    isSelf: false,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    sharingDeviceCount: 1,
    sharedCapacityGb: 36,
    models: ["unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M"],
    devices: [device()],
    includesSelf: false,
    reason: null,
    ...overrides,
  };
}

function derive(overrides = {}) {
  return deriveMeshCardModel({
    snapshot: snapshot(),
    status: null,
    toggle: OFF_TOGGLE,
    pendingAction: null,
    canShare: true,
    busyNow: false,
    requestsRouted: 0,
    ...overrides,
  });
}

test("capacity headline counts devices and sums reported memory", () => {
  assert.equal(
    describeMeshCapacity(
      snapshot({ sharingDeviceCount: 3, sharedCapacityGb: 42.3 }),
    ),
    "42 GB · 3 devices",
  );
  assert.equal(
    describeMeshCapacity(
      snapshot({ sharingDeviceCount: 1, sharedCapacityGb: 18 }),
    ),
    "18 GB · 1 device",
  );
});

test("unknown capacity degrades to a device count, never 0 GB", () => {
  const text = describeMeshCapacity(
    snapshot({ sharingDeviceCount: 3, sharedCapacityGb: null }),
  );
  assert.equal(text, "Mesh capacity · 3 devices");
  assert.ok(!text.includes("0 GB"), "must not claim zero capacity");
});

test("an empty mesh reads as an honest empty state", () => {
  assert.equal(
    describeMeshCapacity(
      snapshot({ sharingDeviceCount: 0, sharedCapacityGb: null }),
    ),
    "No mesh capacity yet",
  );
  // `null` is "not fetched yet" and must not be reported as an empty mesh:
  // that would pass judgement on everyone else's machines during startup.
  assert.equal(describeMeshCapacity(null), "Checking mesh capacity…");
});

test("capacity formatting keeps small figures meaningful", () => {
  assert.equal(formatCapacityGb(42.3), "42 GB");
  assert.equal(formatCapacityGb(4.62), "4.6 GB");
});

test("model labels shorten to fit a narrow sidebar", () => {
  assert.equal(
    shortModelLabel("unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M"),
    "Gemma 4 26B A4B",
  );
  assert.equal(
    shortModelLabel("unsloth/gemma-4-E4B-it-GGUF:Q4_K_M"),
    "Gemma 4 E4B",
  );
});

test("ready models collapse to a count past one", () => {
  assert.equal(describeReadyModels(snapshot()), "Gemma 4 26B A4B ready");
  assert.equal(
    describeReadyModels(snapshot({ models: ["a", "b"] })),
    "2 models ready",
  );
  assert.equal(describeReadyModels(snapshot({ models: [] })), null);
});

test("consuming never renders as sharing", () => {
  const model = derive({
    toggle: CONSUMING_TOGGLE,
    snapshot: snapshot({ devices: [device({ label: "Mac Mini" })] }),
  });
  assert.equal(model.tone, "consuming");
  assert.equal(model.switchOn, false, "the Share switch must stay off");
  assert.match(model.headline, /Using shared compute/);
  assert.match(model.detail, /Mac Mini/);
  // A consuming client may be replaced by a serve runtime, so the switch stays
  // usable rather than locked.
  assert.equal(model.switchDisabled, false);
});

test("sharing leads with mesh capacity and omits the model name", () => {
  const model = derive({
    toggle: SHARING_TOGGLE,
    status: {
      state: "running",
      mode: "serve",
      health: { status: "ok", reason: null },
      modelId: "unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M",
      modelName: null,
      apiBaseUrl: null,
      consoleUrl: null,
    },
    snapshot: snapshot({
      sharingDeviceCount: 1,
      sharedCapacityGb: 115,
      devices: [device({ isSelf: true })],
      includesSelf: true,
    }),
  });
  assert.equal(model.tone, "sharing");
  assert.equal(model.switchOn, true);
  assert.equal(model.headline, "115 GB · 1 device");
  // The model belongs in the detail view, not on a 256px card.
  assert.ok(!/Gemma/i.test(model.detail ?? ""), "card must not name the model");
});

test("inflight work reads as working, never as 'someone is using you'", () => {
  const model = derive({
    toggle: SHARING_TOGGLE,
    status: {
      state: "running",
      mode: "serve",
      health: { status: "ok", reason: null },
      modelId: "m",
      modelName: null,
      apiBaseUrl: null,
      consoleUrl: null,
    },
    busyNow: true,
  });
  assert.match(model.detail, /working now/);
});

test("routed requests are a subtle used-ness signal, not a served claim", () => {
  const model = derive({
    toggle: SHARING_TOGGLE,
    status: {
      state: "running",
      mode: "serve",
      health: { status: "ok", reason: null },
      modelId: "m",
      modelName: null,
      apiBaseUrl: null,
      consoleUrl: null,
    },
    requestsRouted: 7,
  });
  assert.match(model.detail, /7 requests this session/);
});

test("participation copy never claims work was served for other members", () => {
  // mesh-llm exposes no inbound counter, so no wording here may imply that
  // another member consumed this machine's compute.
  const claims = [
    describeParticipation({ busyNow: false, requestsRouted: 0 }),
    describeParticipation({ busyNow: true, requestsRouted: 3 }),
    describeParticipation({ busyNow: false, requestsRouted: 3 }),
  ];
  assert.deepEqual(claims, [
    "Sharing · ready",
    "Sharing · working now",
    "Sharing · 3 requests this session",
  ]);
  for (const claim of claims) {
    assert.ok(
      !/served|for (others|members|someone)|consumed/i.test(claim),
      `must not claim served-for-others: ${claim}`,
    );
  }
});

test("one routed request is singular", () => {
  assert.equal(
    describeParticipation({ busyNow: false, requestsRouted: 1 }),
    "Sharing · 1 request this session",
  );
});

test("a serve node with no advertised model is warming up, not serving", () => {
  const model = derive({
    toggle: SHARING_TOGGLE,
    status: {
      state: "running",
      mode: "serve",
      health: { status: "ok", reason: null },
      modelId: "m",
      modelName: null,
      apiBaseUrl: null,
      consoleUrl: null,
    },
    snapshot: snapshot({
      sharingDeviceCount: 0,
      devices: [device({ isSelf: true, state: "loading", models: [] })],
    }),
  });
  assert.equal(model.tone, "pending");
  assert.match(model.headline, /Starting to share/);
});

test("a failed runtime surfaces its reason instead of claiming to share", () => {
  const model = derive({
    toggle: SHARING_TOGGLE,
    status: {
      state: "running",
      mode: "serve",
      health: { status: "degraded", reason: "llama runtime exited" },
      modelId: "m",
      modelName: null,
      apiBaseUrl: null,
      consoleUrl: null,
    },
  });
  assert.equal(model.tone, "failed");
  assert.match(model.detail, /llama runtime exited/);
});

test("the idle invitation leads with what the community already has", () => {
  const model = derive({
    snapshot: snapshot({ sharingDeviceCount: 2, sharedCapacityGb: 54 }),
  });
  assert.equal(model.tone, "idle");
  assert.equal(model.headline, "54 GB · 2 devices");
});

test("the switch is disabled until a model can be resolved", () => {
  assert.equal(derive({ canShare: false }).switchDisabled, true);
  assert.equal(derive({ canShare: true }).switchDisabled, false);
});

test("an unknown runtime occupant is not silently replaceable", () => {
  const model = derive({
    toggle: { isSharing: false, isConsuming: false, slotOccupied: true },
  });
  assert.equal(model.switchDisabled, true);
});

test("a solo sharer gets the waiting hint; a populated mesh does not", () => {
  const sharingStatus = {
    state: "running",
    mode: "serve",
    health: { status: "ok", reason: null },
    modelId: "m",
    modelName: null,
    apiBaseUrl: null,
    consoleUrl: null,
  };
  const solo = derive({
    toggle: SHARING_TOGGLE,
    status: sharingStatus,
    snapshot: snapshot({ devices: [device({ isSelf: true })] }),
  });
  assert.equal(solo.showSoloHint, true);

  const populated = derive({
    toggle: SHARING_TOGGLE,
    status: sharingStatus,
    snapshot: snapshot({
      sharingDeviceCount: 2,
      devices: [
        device({ isSelf: true }),
        device({ deviceId: "e2", label: "Studio 2" }),
      ],
    }),
  });
  assert.equal(populated.showSoloHint, false);
});
