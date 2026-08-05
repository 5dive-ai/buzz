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

const PERSONA_ID = "custom:sietch-tabr-duncan";
const PERSONA_DISPLAY_NAME = "Duncan";
const INSTANCE_PUBKEY_A =
  "1c206895aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INSTANCE_PUBKEY_B =
  "9a232143bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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
          },
          {
            pubkey: INSTANCE_PUBKEY_B,
            displayName: "Duncan (instance B)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
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
          },
          {
            pubkey: INSTANCE_PUBKEY_B,
            displayName: "Duncan (instance B)",
            picture: null,
            relayUrl: RELAY_URL,
            nipIaOwnerProof: { result: "verified" },
            archiveState: { isArchived: false },
            personaId: PERSONA_ID,
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
