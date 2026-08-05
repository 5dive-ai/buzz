import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract tests for the sidebar Compute row.
 *
 * The row is one line with one signal, so the tone carries almost all of the
 * meaning. These tests pin the distinctions that are easy to collapse by
 * accident — especially "nothing here" vs "something here you have not joined",
 * which is the whole reason the row shows capacity while switched off.
 */

import { deriveMeshRowModel } from "./meshRowModel.ts";

const OFF = { isSharing: false, isConsuming: false, slotOccupied: false };
const SHARING = { isSharing: true, isConsuming: false, slotOccupied: true };
const CONSUMING = { isSharing: false, isConsuming: true, slotOccupied: true };

function snapshot(overrides = {}) {
  return {
    sharingDeviceCount: 0,
    sharedCapacityGb: null,
    models: [],
    devices: [],
    includesSelf: false,
    memberCount: 0,
    reason: null,
    ...overrides,
  };
}

function view(overrides = {}) {
  return { connected: true, selfCapacityGb: 115, peers: [], ...overrides };
}

function peer(overrides = {}) {
  return {
    id: "p1",
    label: "studio54",
    state: "serving",
    capacityGb: 36,
    models: [],
    rttMs: 30,
    ...overrides,
  };
}

function derive(overrides = {}) {
  return deriveMeshRowModel({
    snapshot: null,
    status: null,
    toggle: OFF,
    view: null,
    pendingAction: null,
    busyNow: false,
    ...overrides,
  });
}

test("an unfetched snapshot is unknown, not empty", () => {
  // `null` is "not asked yet". Claiming the community has nothing before the
  // first query lands is a verdict on other people's machines from no data.
  const model = derive({ snapshot: null });
  assert.equal(model.tone, "unknown");
  assert.match(model.tooltip, /Checking/);
});

test("a fetched empty snapshot says so plainly", () => {
  const model = derive({ snapshot: snapshot() });
  assert.equal(model.tone, "unknown");
  assert.match(model.tooltip, /No shared compute/);
});

test("capacity you have not joined is its own tone", () => {
  // The point of the row: someone else is sharing 92 GB and you are outside it.
  const model = derive({
    snapshot: snapshot({ sharingDeviceCount: 3, sharedCapacityGb: 92 }),
  });
  assert.equal(model.tone, "available");
  assert.match(model.tooltip, /92 GB/);
  assert.equal(model.showSwitch, true);
});

test("unknown capacity degrades to a device count, never 0 GB", () => {
  const model = derive({
    snapshot: snapshot({ sharingDeviceCount: 2, sharedCapacityGb: null }),
  });
  assert.equal(model.tone, "available");
  assert.match(model.tooltip, /2 devices/);
  assert.doesNotMatch(model.tooltip, /0 GB/);
});

test("sharing hides the switch and shows live capacity instead", () => {
  const model = derive({
    toggle: SHARING,
    view: view({ peers: [peer()] }),
  });
  assert.equal(model.tone, "sharing");
  // Stop lives in the popover, so the row reclaims the space for the payoff.
  assert.equal(model.showSwitch, false);
  assert.equal(model.badge, "151 GB");
  assert.match(model.tooltip, /1 peer\b/);
});

test("a solo sharer is named as waiting, not as a peer count of zero", () => {
  const model = derive({ toggle: SHARING, view: view() });
  assert.match(model.tooltip, /waiting for another device/);
});

test("consuming keeps the switch: sharing is always available", () => {
  const model = derive({ toggle: CONSUMING });
  assert.equal(model.tone, "consuming");
  // A client runtime can be replaced by a serve runtime. Consuming is not a
  // lock, so the row must never present it as one.
  assert.equal(model.showSwitch, true);
});

test("an activity pulse means real work, nothing else", () => {
  // A still dot has to be a real statement, so motion is never decorative.
  assert.equal(derive({ toggle: SHARING, view: view() }).pulse, "none");
  assert.equal(
    derive({ toggle: SHARING, view: view(), busyNow: true }).pulse,
    "activity",
  );
  assert.equal(derive({ toggle: CONSUMING, busyNow: true }).pulse, "activity");
});

test("capacity you have not joined throbs as an invitation", () => {
  // The one state worth drawing the eye to unprompted: there is compute to tap
  // into, and this machine is neither using nor adding to it.
  const model = derive({
    snapshot: snapshot({ sharingDeviceCount: 3, sharedCapacityGb: 92 }),
  });
  assert.equal(model.pulse, "invite");
});

test("an invite is distinct from activity, so one animation never means two things", () => {
  const invite = derive({
    snapshot: snapshot({ sharingDeviceCount: 1, sharedCapacityGb: 36 }),
  });
  const activity = derive({
    toggle: SHARING,
    view: view(),
    busyNow: true,
  });
  assert.notEqual(invite.pulse, activity.pulse);
});

test("an empty or unfetched community never throbs", () => {
  // Nothing to act on: an invitation to join a mesh that does not exist would
  // be a lie told with animation.
  assert.equal(derive({ snapshot: null }).pulse, "none");
  assert.equal(derive({ snapshot: snapshot() }).pulse, "none");
});

test("a transition outranks any steady tone", () => {
  assert.equal(derive({ pendingAction: "start" }).tone, "starting");
  assert.equal(
    derive({ toggle: SHARING, pendingAction: "stop" }).tone,
    "starting",
  );
  assert.equal(
    derive({ toggle: SHARING, status: { state: "starting" } }).tone,
    "starting",
  );
});

test("an unhealthy serve runtime reads failed, and can still be stopped", () => {
  const model = derive({
    toggle: SHARING,
    status: { state: "running", health: { status: "unreachable" } },
  });
  assert.equal(model.tone, "failed");
  assert.equal(model.switchLabel, "Stop sharing");
});
