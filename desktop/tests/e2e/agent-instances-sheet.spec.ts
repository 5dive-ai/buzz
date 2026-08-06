import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

// ── Incident-shaped supplementary UI coverage for the Instances Sheet ──────
//
// These tests are supplementary UI coverage only (row state, Sheet flow,
// cache invalidation). They are NOT proof for the Rust/relay path — the relay
// acceptance tests in identity_archive/relay_acceptance are the authoritative
// gate for correctness.
//
// Incident shape: sietch-tabr:duncan had 2 active relay instances, the CLI's
// apply_cardinality_rule refused to guess which was canonical and failed
// closed. These specs verify that:
// (1) the start-control safeguard opens the Sheet instead of minting a new
//     instance when the relay inventory has active instances
// (2) the Sheet shows the expected instances for the persona
// (3) rows expose Archive/Unarchive actions for Verified instances
// (4) unknown archive trust suppresses mutation affordances
// (5) local+relay merge: correct local-device marker per row
// (6) exact-target Archive → refetch → Unarchive flow
// (7) unknown-persona instances render in a separate section

const PERSONA_ID = "custom:sietch-tabr-duncan";
const PERSONA_DISPLAY_NAME = "Duncan";
// Instance A: locally managed on this device (has `local` summary).
const INSTANCE_PUBKEY_A =
  "1c206895aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// Instance B: relay-only, no local record — the stale duplicate.
const INSTANCE_PUBKEY_B =
  "9a232143bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
// Second persona pubkey — negative control (must never appear under PERSONA_ID).
const PERSONA_ID_2 = "custom:sietch-tabr-paul";
const INSTANCE_PUBKEY_C =
  "cc000000cccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
// Unknown-persona instance.
const UNKNOWN_PUBKEY =
  "dd000000dddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const RELAY_URL = "http://localhost:3000";

async function gotoAgentsView(page: import("@playwright/test").Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const w = window as Window & {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: unknown;
        __TAURI_INTERNALS__?: { invoke?: unknown };
      };
      return (
        typeof w.__BUZZ_E2E_INVOKE_MOCK_COMMAND__ === "function" ||
        typeof w.__TAURI_INTERNALS__?.invoke === "function"
      );
    },
    null,
    { timeout: 5_000 },
  );
  await page.getByTestId("open-agents-view").click();
  await expect(page.getByTestId("agents-library-personas")).toBeVisible();
}

/** Read all recorded archive_identity / unarchive_identity payloads. */
async function getMutationPayloads(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const w = window as Window & {
      __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{
        command: string;
        payload: unknown;
      }>;
    };
    return (w.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []).filter(
      (e) =>
        e.command === "archive_identity" || e.command === "unarchive_identity",
    );
  });
}

// ── Test 1: start-control safeguard opens Sheet on active relay instances ──

test("start-control safeguard opens Instances Sheet instead of minting when inventory has active instances", async ({
  page,
}) => {
  await installMockBridge(page, {
    personas: [
      {
        id: PERSONA_ID,
        displayName: PERSONA_DISPLAY_NAME,
        systemPrompt: "The incident-shape agent.",
      },
    ],
    // Seed 2 active (non-archived) relay instances — mirrors the incident.
    ownedAgentInventory: {
      archiveStateTrusted: true,
      byPersonaId: {
        [PERSONA_ID]: [
          {
            pubkey: INSTANCE_PUBKEY_A,
            displayName: "Duncan (instance A)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            local: {
              pubkey: INSTANCE_PUBKEY_A,
              name: "Duncan A",
              personaId: PERSONA_ID,
            },
          },
          {
            pubkey: INSTANCE_PUBKEY_B,
            displayName: "Duncan (instance B)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            local: null, // relay-only
          },
        ],
      },
      unknown: [],
    },
  });
  await gotoAgentsView(page);

  // The persona has no local managed agent — the start button renders with
  // testid `persona-runtime-start-${PERSONA_ID}`.
  const startButton = page.getByTestId(`persona-runtime-start-${PERSONA_ID}`);
  await expect(startButton).toBeVisible();

  // Click start: safeguard detects 2 active relay instances and should open
  // the Sheet instead of calling onStartPersona.
  await startButton.click();

  // The Sheet must open — not the persona profile panel.
  await expect(page.getByTestId("instances-sheet")).toBeVisible();
  // The persona profile panel must NOT open (no navigation away from agents).
  await expect(page.getByTestId("agents-library-personas")).toBeVisible();
});

// ── Test 2: Sheet shows 2 instances for the persona ───────────────────────

test("Instances Sheet shows both relay instances when seeded", async ({
  page,
}) => {
  await installMockBridge(page, {
    personas: [
      {
        id: PERSONA_ID,
        displayName: PERSONA_DISPLAY_NAME,
        systemPrompt: "The incident-shape agent.",
      },
    ],
    ownedAgentInventory: {
      archiveStateTrusted: true,
      byPersonaId: {
        [PERSONA_ID]: [
          {
            pubkey: INSTANCE_PUBKEY_A,
            displayName: "Duncan (instance A)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            local: {
              pubkey: INSTANCE_PUBKEY_A,
              name: "Duncan A",
              personaId: PERSONA_ID,
            },
          },
          {
            pubkey: INSTANCE_PUBKEY_B,
            displayName: "Duncan (instance B)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            local: null,
          },
        ],
      },
      unknown: [],
    },
  });
  await gotoAgentsView(page);

  // Click the instances count button (rendered when instances > 1).
  const instancesButton = page.getByLabel(`Instances (2)`);
  await expect(instancesButton).toBeVisible();
  await instancesButton.click();

  const sheet = page.getByTestId("instances-sheet");
  await expect(sheet).toBeVisible();

  // Both instance rows should be present.
  await expect(
    page.getByTestId(`instance-row-${INSTANCE_PUBKEY_A}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`instance-row-${INSTANCE_PUBKEY_B}`),
  ).toBeVisible();
});

// ── Test 3: Archive button visible for Verified instances ─────────────────

test("Archive button is present for Verified instances with trusted archive state", async ({
  page,
}) => {
  await installMockBridge(page, {
    personas: [
      {
        id: PERSONA_ID,
        displayName: PERSONA_DISPLAY_NAME,
        systemPrompt: "The incident-shape agent.",
      },
    ],
    ownedAgentInventory: {
      archiveStateTrusted: true,
      byPersonaId: {
        [PERSONA_ID]: [
          {
            pubkey: INSTANCE_PUBKEY_A,
            displayName: "Duncan (instance A)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            local: {
              pubkey: INSTANCE_PUBKEY_A,
              name: "Duncan A",
              personaId: PERSONA_ID,
            },
          },
        ],
      },
      unknown: [],
    },
  });
  await gotoAgentsView(page);

  // Open the Sheet via the start-button safeguard path (1 active instance).
  const startButton = page.getByTestId(`persona-runtime-start-${PERSONA_ID}`);
  await expect(startButton).toBeVisible();
  await startButton.click();

  const sheet = page.getByTestId("instances-sheet");
  await expect(sheet).toBeVisible();

  // The Archive button must be visible for the active verified instance.
  const archiveButton = page.getByTestId(
    `archive-instance-${INSTANCE_PUBKEY_A}`,
  );
  await expect(archiveButton).toBeVisible();
});

// ── Test 4: Unknown archive trust suppresses mutation affordances ─────────

test("Archive/Unarchive actions suppressed when archive state is not trusted", async ({
  page,
}) => {
  await installMockBridge(page, {
    personas: [
      {
        id: PERSONA_ID,
        displayName: PERSONA_DISPLAY_NAME,
        systemPrompt: "The incident-shape agent.",
      },
    ],
    ownedAgentInventory: {
      archiveStateTrusted: false, // untrusted snapshot
      byPersonaId: {
        [PERSONA_ID]: [
          {
            pubkey: INSTANCE_PUBKEY_A,
            displayName: "Duncan (instance A)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: null }, // unknown
            personaId: PERSONA_ID,
            local: {
              pubkey: INSTANCE_PUBKEY_A,
              name: "Duncan A",
              personaId: PERSONA_ID,
            },
          },
        ],
      },
      unknown: [],
    },
  });
  await gotoAgentsView(page);

  // Safeguard: untrusted inventory → Sheet.
  const startButton = page.getByTestId(`persona-runtime-start-${PERSONA_ID}`);
  await expect(startButton).toBeVisible();
  await startButton.click();

  const sheet = page.getByTestId("instances-sheet");
  await expect(sheet).toBeVisible();

  // Archive button must NOT be visible — trust is unknown.
  await expect(
    page.getByTestId(`archive-instance-${INSTANCE_PUBKEY_A}`),
  ).toHaveCount(0);
  // Unarchive button must NOT be visible either.
  await expect(
    page.getByTestId(`unarchive-instance-${INSTANCE_PUBKEY_A}`),
  ).toHaveCount(0);
});

// ── Test 5: No-third-mint regression ──────────────────────────────────────
//
// When the relay inventory is loading (undefined), the safeguard must open
// the Sheet rather than calling onStartPersona — preventing an implicit mint.

test("no-third-mint: start is intercepted when inventory is untrusted", async ({
  page,
}) => {
  await installMockBridge(page, {
    personas: [
      {
        id: PERSONA_ID,
        displayName: PERSONA_DISPLAY_NAME,
        systemPrompt: "The incident-shape agent.",
      },
    ],
    // archiveStateTrusted: false forces the safeguard to open the Sheet
    // rather than proceeding with start.
    ownedAgentInventory: {
      archiveStateTrusted: false,
      byPersonaId: {},
      unknown: [],
    },
  });
  await gotoAgentsView(page);

  const startButton = page.getByTestId(`persona-runtime-start-${PERSONA_ID}`);
  await expect(startButton).toBeVisible();

  // Click: untrusted inventory → Sheet must open (not a direct persona start).
  await startButton.click();

  // Sheet opens — no mint was attempted.
  await expect(page.getByTestId("instances-sheet")).toBeVisible();
});

// ── Test 6: Local+relay merge — correct device marker per row ─────────────
//
// One local+relay instance and one relay-only instance for the same persona.
// Second persona is a negative control (its instance must not appear).
// Asserts: local instance has NO relay-only badge; relay-only instance HAS badge.

test("local and relay-only instances show correct device markers", async ({
  page,
}) => {
  await installMockBridge(page, {
    personas: [
      {
        id: PERSONA_ID,
        displayName: PERSONA_DISPLAY_NAME,
        systemPrompt: "The incident-shape agent.",
      },
      {
        id: PERSONA_ID_2,
        displayName: "Paul",
        systemPrompt: "Second persona — negative control.",
      },
    ],
    ownedAgentInventory: {
      archiveStateTrusted: true,
      byPersonaId: {
        [PERSONA_ID]: [
          {
            pubkey: INSTANCE_PUBKEY_A,
            displayName: "Duncan (local)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            // Has a local record — this is the device's managed instance.
            local: {
              pubkey: INSTANCE_PUBKEY_A,
              name: "Duncan A",
              personaId: PERSONA_ID,
            },
          },
          {
            pubkey: INSTANCE_PUBKEY_B,
            displayName: "Duncan (stale relay)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            // No local record — relay-only (the stale duplicate).
            local: null,
          },
        ],
        [PERSONA_ID_2]: [
          {
            pubkey: INSTANCE_PUBKEY_C,
            displayName: "Paul",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID_2,
            local: {
              pubkey: INSTANCE_PUBKEY_C,
              name: "Paul",
              personaId: PERSONA_ID_2,
            },
          },
        ],
      },
      unknown: [],
    },
  });
  await gotoAgentsView(page);

  // Open the Sheet for PERSONA_ID (2 instances → instances count button).
  const instancesButton = page.getByLabel(`Instances (2)`);
  await expect(instancesButton).toBeVisible();
  await instancesButton.click();
  await expect(page.getByTestId("instances-sheet")).toBeVisible();

  // Instance A (local): NO relay-only badge.
  await expect(
    page.getByTestId(`instance-relay-only-${INSTANCE_PUBKEY_A}`),
  ).toHaveCount(0);

  // Instance B (relay-only): HAS relay-only badge.
  await expect(
    page.getByTestId(`instance-relay-only-${INSTANCE_PUBKEY_B}`),
  ).toBeVisible();

  // Negative control: Paul's instance must NOT appear in this persona's sheet.
  await expect(
    page.getByTestId(`instance-row-${INSTANCE_PUBKEY_C}`),
  ).toHaveCount(0);
});

// ── Test 7: Exact-target Archive → refetch → Unarchive flow ───────────────
//
// Proves the full mutation path:
// - Archive records the exact targetPubkey (relay-only instance B)
// - Post-mutation refetch shows instance B as archived + Unarchive button
// - Unarchive records the exact targetPubkey again

test("Archive sends exact targetPubkey, refetch shows Archived, Unarchive sends exact targetPubkey", async ({
  page,
}) => {
  await installMockBridge(page, {
    personas: [
      {
        id: PERSONA_ID,
        displayName: PERSONA_DISPLAY_NAME,
        systemPrompt: "The incident-shape agent.",
      },
    ],
    ownedAgentInventory: {
      archiveStateTrusted: true,
      byPersonaId: {
        [PERSONA_ID]: [
          {
            pubkey: INSTANCE_PUBKEY_A,
            displayName: "Duncan (local)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            local: {
              pubkey: INSTANCE_PUBKEY_A,
              name: "Duncan A",
              personaId: PERSONA_ID,
            },
          },
          {
            pubkey: INSTANCE_PUBKEY_B,
            displayName: "Duncan (stale relay)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            local: null,
          },
        ],
      },
      unknown: [],
    },
  });
  await gotoAgentsView(page);

  // Open the Sheet for PERSONA_ID.
  const instancesButton = page.getByLabel(`Instances (2)`);
  await expect(instancesButton).toBeVisible();
  await instancesButton.click();
  const sheet = page.getByTestId("instances-sheet");
  await expect(sheet).toBeVisible();

  // Both rows visible before mutation.
  await expect(
    page.getByTestId(`instance-row-${INSTANCE_PUBKEY_B}`),
  ).toBeVisible();

  // Click Archive on instance B (the relay-only stale duplicate).
  const archiveBtn = page.getByTestId(`archive-instance-${INSTANCE_PUBKEY_B}`);
  await expect(archiveBtn).toBeVisible();
  await archiveBtn.click();

  // Confirm the archive dialog.
  const confirmBtn = page.getByTestId("archive-confirm-action");
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();

  // Assert the exact targetPubkey was sent.
  const afterArchive = await getMutationPayloads(page);
  const archiveEntry = afterArchive.find(
    (e) => e.command === "archive_identity",
  );
  expect(archiveEntry).toBeTruthy();
  const archivePayload = archiveEntry?.payload as {
    req?: { targetPubkey?: string };
  };
  expect(archivePayload?.req?.targetPubkey).toBe(INSTANCE_PUBKEY_B);

  // After refetch: instance B should show the Unarchive button (archived state).
  const unarchiveBtn = page.getByTestId(
    `unarchive-instance-${INSTANCE_PUBKEY_B}`,
  );
  await expect(unarchiveBtn).toBeVisible();

  // Click Unarchive.
  await unarchiveBtn.click();

  // Assert the exact targetPubkey was sent for unarchive.
  const afterUnarchive = await getMutationPayloads(page);
  const unarchiveEntry = afterUnarchive.find(
    (e) => e.command === "unarchive_identity",
  );
  expect(unarchiveEntry).toBeTruthy();
  const unarchivePayload = unarchiveEntry?.payload as {
    req?: { targetPubkey?: string };
  };
  expect(unarchivePayload?.req?.targetPubkey).toBe(INSTANCE_PUBKEY_B);
});

// ── Test 8: Exact-profile opening ────────────────────────────────────────
//
// Clicking the profile button on an instance row opens the profile for that
// exact pubkey (not another row's pubkey). Asserts:
// - `user-profile-panel` becomes visible (navigation occurred)
// - The e2eBridge recorded a `get_user_profile` command for INSTANCE_PUBKEY_B

test("clicking instance row opens the exact pubkey profile", async ({
  page,
}) => {
  await installMockBridge(page, {
    personas: [
      {
        id: PERSONA_ID,
        displayName: PERSONA_DISPLAY_NAME,
        systemPrompt: "The incident-shape agent.",
      },
    ],
    searchProfiles: [
      {
        pubkey: INSTANCE_PUBKEY_A,
        displayName: "Duncan (local)",
        avatarUrl: null,
      },
      {
        pubkey: INSTANCE_PUBKEY_B,
        displayName: "Duncan (stale relay)",
        avatarUrl: null,
      },
    ],
    ownedAgentInventory: {
      archiveStateTrusted: true,
      byPersonaId: {
        [PERSONA_ID]: [
          {
            pubkey: INSTANCE_PUBKEY_A,
            displayName: "Duncan (local)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            local: {
              pubkey: INSTANCE_PUBKEY_A,
              name: "Duncan A",
              personaId: PERSONA_ID,
            },
          },
          {
            pubkey: INSTANCE_PUBKEY_B,
            displayName: "Duncan (stale relay)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            local: null,
          },
        ],
      },
      unknown: [],
    },
  });
  await gotoAgentsView(page);

  // Open sheet.
  await page.getByLabel("Instances (2)").click();
  await expect(page.getByTestId("instances-sheet")).toBeVisible();

  // Click the profile button for instance B specifically.
  await page
    .getByTestId(`instance-row-${INSTANCE_PUBKEY_B}`)
    .getByRole("button", { name: /open profile/i })
    .first()
    .click();

  // The profile panel for instance B's pubkey should open.
  await expect(page.getByTestId("user-profile-panel")).toBeVisible();

  // The e2eBridge must have recorded a profile fetch for instance B.
  const profileCmds = await page.evaluate(() => {
    const w = window as Window & {
      __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{
        command: string;
        payload: unknown;
      }>;
    };
    return (w.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []).filter(
      (e) => e.command === "get_user_profile",
    );
  });
  const fetchedB = profileCmds.some((e) => {
    const p = e.payload as { pubkey?: string };
    return p?.pubkey?.toLowerCase() === INSTANCE_PUBKEY_B.toLowerCase();
  });
  expect(fetchedB).toBe(true);
});

// ── Test 9: Unknown-persona instances reachable from top-level library ───
//
// When the relay inventory has unknown-persona instances, the "Unknown relay
// agents" group appears in the Agents library at the top level. Clicking it
// opens the global unknown Sheet without going through any persona's Sheet.
// This proves the instance is discoverable without opening an unrelated
// persona's Sheet.

test("unknown-persona instances render in the Unknown agents section", async ({
  page,
}) => {
  await installMockBridge(page, {
    personas: [
      {
        id: PERSONA_ID,
        displayName: PERSONA_DISPLAY_NAME,
        systemPrompt: "The incident-shape agent.",
      },
    ],
    ownedAgentInventory: {
      archiveStateTrusted: true,
      byPersonaId: {
        // No instances for the persona — the user must not need to open
        // Duncan's Sheet to find the unknown instance.
        [PERSONA_ID]: [],
      },
      // Unknown instance has no persona_id.
      unknown: [
        {
          pubkey: UNKNOWN_PUBKEY,
          displayName: "Mystery agent",
          picture: null,
          relayUrl: RELAY_URL,
          nipIaOwnerProof: { result: "verified" },
          archiveState: { isArchived: false },
          personaId: null,
          local: null,
        },
      ],
    },
  });
  await gotoAgentsView(page);

  // The top-level "Unknown relay agents" group must appear in the library
  // WITHOUT opening any persona's Sheet.
  const relayUnknownGroup = page.getByTestId("relay-unknown-agents-group");
  await expect(relayUnknownGroup).toBeVisible();

  // Click the group button to open the global unknown sheet.
  await relayUnknownGroup.getByRole("button").click();

  // The global unknown Sheet must open.
  await expect(page.getByTestId("instances-sheet")).toBeVisible();

  // Unknown section must be visible inside the sheet.
  await expect(page.getByTestId("unknown-instances-section")).toBeVisible();

  // Unknown instance row must be present.
  await expect(
    page.getByTestId(`instance-row-${UNKNOWN_PUBKEY}`),
  ).toBeVisible();

  // Unknown instance must have the relay-only badge (local === null).
  await expect(
    page.getByTestId(`instance-relay-only-${UNKNOWN_PUBKEY}`),
  ).toBeVisible();
});

// ── Test 10: Presence indicators show distinct Online/Offline per row ─────
//
// Seeds presence overrides so instance A is "online" and instance B is
// "offline". Asserts the per-row Online/Offline badges differ.

test("presence indicators show Online for active instance and Offline for relay-only instance", async ({
  page,
}) => {
  await installMockBridge(page, {
    personas: [
      {
        id: PERSONA_ID,
        displayName: PERSONA_DISPLAY_NAME,
        systemPrompt: "The incident-shape agent.",
      },
    ],
    // Seed presence: A is online (the device's managed instance), B is offline
    // (the stale relay-only duplicate we want to archive).
    presenceOverrides: {
      [INSTANCE_PUBKEY_A]: "online",
      [INSTANCE_PUBKEY_B]: "offline",
    },
    ownedAgentInventory: {
      archiveStateTrusted: true,
      byPersonaId: {
        [PERSONA_ID]: [
          {
            pubkey: INSTANCE_PUBKEY_A,
            displayName: "Duncan (local)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            local: {
              pubkey: INSTANCE_PUBKEY_A,
              name: "Duncan A",
              personaId: PERSONA_ID,
            },
          },
          {
            pubkey: INSTANCE_PUBKEY_B,
            displayName: "Duncan (stale relay)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
            local: null,
          },
        ],
      },
      unknown: [],
    },
  });
  await gotoAgentsView(page);

  // Open the Sheet for PERSONA_ID.
  const instancesButton = page.getByLabel(`Instances (2)`);
  await expect(instancesButton).toBeVisible();
  await instancesButton.click();
  await expect(page.getByTestId("instances-sheet")).toBeVisible();

  // Instance A (online): presence badge should say "Online".
  const presenceA = page.getByTestId(`instance-presence-${INSTANCE_PUBKEY_A}`);
  await expect(presenceA).toBeVisible();
  await expect(presenceA).toContainText("Online");

  // Instance B (offline): presence badge should say "Offline".
  const presenceB = page.getByTestId(`instance-presence-${INSTANCE_PUBKEY_B}`);
  await expect(presenceB).toBeVisible();
  await expect(presenceB).toContainText("Offline");
});
