import { expect, test } from "@playwright/test";

import type { RelayEvent } from "@/shared/api/types";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const DEFAULT_MOCK_PUBKEY = "deadbeef".repeat(8);
// The owned relay agent fixture ("nadia") — profile declares the mock viewer
// as operator and carries the seeded NIP-34 engineering record.
const OWNED_RELAY_AGENT_PUBKEY =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";
const OUTDIR = "test-results/persona-catalog-passport";

function createCatalogEvent(input: {
  id: string;
  ownerPubkey: string;
  sourcePersonaId: string;
  displayName: string;
  systemPrompt: string;
}): RelayEvent {
  return {
    id: input.id,
    pubkey: input.ownerPubkey,
    created_at: 1_721_750_400,
    kind: 30175,
    tags: [
      ["d", input.sourcePersonaId],
      ["shared", "true"],
    ],
    content: JSON.stringify({
      display_name: input.displayName,
      system_prompt: input.systemPrompt,
      avatar_url: null,
      runtime: null,
      model: null,
      provider: null,
      name_pool: [],
    }),
    sig: "2".repeat(128),
  };
}

async function openCatalog(page: import("@playwright/test").Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-agents-view").click();
  await page.getByTestId("new-agent-card").click();
  await page
    .getByRole("menuitem", { exact: true, name: "Discover agents" })
    .click();
}

test("catalog entry shows the deployed agent's passport record", async ({
  page,
}) => {
  // "nadia" is the mock relay agent owned by the viewer, with a seeded NIP-34
  // engineering record — publishing a same-named persona under the viewer's
  // key makes the catalog resolve that agent as its deployment.
  await installMockBridge(page, {
    personaCatalogEvents: [
      createCatalogEvent({
        displayName: "nadia",
        id: "3".repeat(64),
        ownerPubkey: DEFAULT_MOCK_PUBKEY,
        sourcePersonaId: "nadia-persona",
        systemPrompt: "Ship relay fixes and review incoming pull requests.",
      }),
      // Alice re-shared her copy of the persona (same operating prompt) —
      // that is the observable trace of a duplication.
      createCatalogEvent({
        displayName: "nadia (fork)",
        id: "6".repeat(64),
        ownerPubkey: TEST_IDENTITIES.alice.pubkey,
        sourcePersonaId: "nadia-persona-fork",
        systemPrompt: "Ship relay fixes and review incoming pull requests.",
      }),
    ],
    relayAgents: [
      {
        channelNames: ["agents"],
        name: "nadia",
        pubkey: OWNED_RELAY_AGENT_PUBKEY,
      },
    ],
  });
  await openCatalog(page);
  // Both entries share the prompt; "nadia" sorts before "nadia (fork)" and is
  // auto-selected, so the detail pane shows the original.

  const passportSection = page.getByTestId("persona-catalog-passport");
  await expect(passportSection).toBeVisible();
  await expect(
    passportSection.getByTestId("passport-agent-chip"),
  ).toBeVisible();
  // Craft badges come from the seeded git record (merged PRs, issues,
  // reviews) — their presence proves the record is wired through.
  await expect(
    passportSection.getByTestId("passport-badge-shipped"),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    passportSection.getByTestId("passport-badge-high-signal"),
  ).toBeVisible();

  // Own entry: the publisher link points at the viewer's own passport.
  await expect(
    passportSection.getByTestId("persona-catalog-publisher-passport"),
  ).toHaveText(/View your passport/);

  // Alice's re-shared copy of the same prompt counts as a duplication.
  await expect(
    passportSection.getByTestId("persona-catalog-adoption"),
  ).toHaveText(/Duplicated by 1 other member/);

  await waitForAnimations(page);
  await page
    .getByTestId("persona-catalog-detail-pane")
    .screenshot({ path: `${OUTDIR}/01-catalog-passport.png` });

  // Sample-data network record (dev/e2e builds only, labelled as such).
  const preview = passportSection.getByTestId(
    "persona-catalog-passport-preview",
  );
  await preview.scrollIntoViewIfNeeded();
  await expect(preview).toBeVisible();
  await preview.screenshot({ path: `${OUTDIR}/03-network-preview.png` });

  // The chip closes the dialog and lands on the agent's full passport.
  await passportSection.getByTestId("passport-agent-chip").click();
  await expect(page.getByTestId("persona-catalog-dialog")).toHaveCount(0);
  await expect(page.getByTestId("passport-screen")).toBeVisible();
});

test("another member's deployment matches by persona name", async ({
  page,
}) => {
  // Alice publishes the persona, but the running instance ("nadia") is
  // operated by the viewer — adoption still shows on the entry.
  await installMockBridge(page, {
    personaCatalogEvents: [
      createCatalogEvent({
        displayName: "nadia",
        id: "5".repeat(64),
        ownerPubkey: TEST_IDENTITIES.alice.pubkey,
        sourcePersonaId: "nadia-from-alice",
        systemPrompt: "Shared by alice, run by anyone.",
      }),
    ],
    relayAgents: [
      {
        channelNames: ["agents"],
        name: "nadia",
        pubkey: OWNED_RELAY_AGENT_PUBKEY,
      },
    ],
  });
  await openCatalog(page);

  const passportSection = page.getByTestId("persona-catalog-passport");
  await expect(
    passportSection.getByTestId("passport-agent-chip"),
  ).toBeVisible();
  await expect(
    passportSection.getByTestId("persona-catalog-publisher-passport"),
  ).toHaveText(/View alice’s passport/);
});

test("entry without a deployed agent shows the empty passport state", async ({
  page,
}) => {
  await installMockBridge(page, {
    personaCatalogEvents: [
      createCatalogEvent({
        displayName: "Aloe",
        id: "4".repeat(64),
        ownerPubkey: TEST_IDENTITIES.alice.pubkey,
        sourcePersonaId: "aloe-persona",
        systemPrompt: "A persona nobody is running yet.",
      }),
    ],
  });
  await openCatalog(page);

  const emptyState = page.getByTestId("persona-catalog-passport-empty");
  await expect(emptyState).toBeVisible();
  // Even with no deployment, the publisher's passport stays one click away.
  await expect(
    page.getByTestId("persona-catalog-publisher-passport"),
  ).toBeVisible();

  await waitForAnimations(page);
  await page
    .getByTestId("persona-catalog-detail-pane")
    .screenshot({ path: `${OUTDIR}/02-catalog-passport-empty.png` });
});
