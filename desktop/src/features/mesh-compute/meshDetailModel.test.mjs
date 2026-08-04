import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract tests for the mesh detail popover projection.
 *
 * The load-bearing rule: mesh-llm exposes **no inbound counter**. Every figure
 * available describes work this machine dispatched, so nothing here may claim
 * another member consumed our compute. Several tests exist purely to pin that.
 */

import {
  describeActivity,
  describeRequestOrigin,
  deriveMeshDetailModel,
} from "./meshDetailModel.ts";

function usage(overrides = {}) {
  return {
    inflight: 0,
    peakInflight: 0,
    requestsServed: 0,
    tokensServed: 0,
    tokensPerSecond: 0,
    localAttempts: 0,
    remoteAttempts: 0,
    endpointAttempts: 0,
    peers: 0,
    locallyServed: 0,
    remotelyServed: 0,
    endpointServed: 0,
    ...overrides,
  };
}

function device(overrides = {}) {
  return {
    deviceId: "d1",
    label: "Device",
    capacityGb: 16,
    models: ["m"],
    state: "serving",
    isSelf: false,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    sharingDeviceCount: 1,
    sharedCapacityGb: 16,
    models: ["m"],
    devices: [device({ isSelf: true })],
    includesSelf: true,
    memberCount: 1,
    reason: null,
    ...overrides,
  };
}

test("request origin distinguishes borrowed compute from local work", () => {
  assert.equal(
    describeRequestOrigin(usage({ locallyServed: 5 })),
    "5 requests · all on this computer",
  );
  assert.equal(
    describeRequestOrigin(usage({ remotelyServed: 4 })),
    "4 requests · all on shared compute",
  );
  assert.equal(
    describeRequestOrigin(usage({ locallyServed: 9, remotelyServed: 3 })),
    "3 of 12 requests on shared compute",
  );
});

test("endpoint-served requests count as shared, not local", () => {
  // An endpoint is not this machine's GPU, so it must not read as local work.
  assert.equal(
    describeRequestOrigin(usage({ locallyServed: 1, endpointServed: 1 })),
    "1 of 2 requests on shared compute",
  );
});

test("no completed requests yields no origin claim, never '0 remote'", () => {
  assert.equal(describeRequestOrigin(usage()), null);
  assert.equal(describeRequestOrigin(null), null);
});

test("singular grammar for a single request", () => {
  assert.equal(
    describeRequestOrigin(usage({ locallyServed: 1 })),
    "1 request · all on this computer",
  );
});

test("activity reports inflight work without attributing it to anyone", () => {
  const live = describeActivity(usage({ inflight: 2 }), true);
  assert.equal(live, "2 requests in flight");
  // The counter cannot distinguish a local agent from a remote member, so the
  // phrasing must never imply someone else is using this machine.
  assert.ok(
    !/(served|for (others|members|someone)|using your|consumed)/i.test(live),
    `must not attribute inbound work: ${live}`,
  );
});

test("a warm sharing runtime with no traffic is its own state", () => {
  assert.equal(describeActivity(usage(), true), "Ready · no requests yet");
  // Not sharing and idle is not noteworthy — stay silent.
  assert.equal(describeActivity(usage(), false), null);
  assert.equal(describeActivity(null, true), null);
});

test("participation names the roster denominator", () => {
  const model = deriveMeshDetailModel({
    snapshot: snapshot({
      sharingDeviceCount: 2,
      memberCount: 12,
      sharedCapacityGb: 115,
      devices: [device({ isSelf: true }), device({ deviceId: "d2" })],
    }),
    usage: usage(),
    isSharing: true,
  });
  assert.equal(model.participationLabel, "2 of 12 members sharing");
  assert.equal(model.capacityLabel, "115 GB");
  // 12 members, 2 with published status notes -> 10 ghosts.
  assert.equal(model.ghostCount, 10);
});

test("ghost count never goes negative when the roster lags devices", () => {
  // A device can report while a stale roster page omits it. A negative ghost
  // count is nonsense, so it clamps at zero.
  const model = deriveMeshDetailModel({
    snapshot: snapshot({
      memberCount: 1,
      devices: [device({ isSelf: true }), device({ deviceId: "d2" })],
    }),
    usage: usage(),
    isSharing: true,
  });
  assert.equal(model.ghostCount, 0);
});

test("an empty roster falls back to a device count", () => {
  const model = deriveMeshDetailModel({
    snapshot: snapshot({ sharingDeviceCount: 1, memberCount: 0 }),
    usage: usage(),
    isSharing: true,
  });
  assert.equal(model.participationLabel, "1 device sharing");
});

test("unknown capacity drops the figure rather than printing 0 GB", () => {
  const model = deriveMeshDetailModel({
    snapshot: snapshot({ sharedCapacityGb: null }),
    usage: usage(),
    isSharing: true,
  });
  assert.equal(model.capacityLabel, null);
});

test("a null snapshot is renderable and claims nothing", () => {
  const model = deriveMeshDetailModel({
    snapshot: null,
    usage: null,
    isSharing: false,
  });
  assert.equal(model.capacityLabel, null);
  assert.equal(model.ghostCount, 0);
  assert.equal(model.busyNow, false);
  assert.equal(model.activityLabel, null);
  assert.equal(model.originLabel, null);
});

test("capacity formatting keeps small figures meaningful", () => {
  assert.equal(
    deriveMeshDetailModel({
      snapshot: snapshot({ sharedCapacityGb: 4.62 }),
      usage: usage(),
      isSharing: true,
    }).capacityLabel,
    "4.6 GB",
  );
});
