import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

async function enterMachineBackup(page: import("@playwright/test").Page) {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Create a new identity key" }).click();
}

const SHOTS = "test-results/screenshots-onboarding";

test("backup step appears on fresh-key path after profile submit", async ({
  page,
}) => {
  await enterMachineBackup(page);

  await expect(page.getByTestId("onboarding-page-backup")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Your unique identity key has been created",
    }),
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// Encrypted-by-default path (plan D3): passphrase → create → ncryptsec shown.
// The raw key must never be fetched on this path.
// ---------------------------------------------------------------------------

test("encrypted backup happy path: generated passphrase, create, save copy, Next", async ({
  page,
}) => {
  await enterMachineBackup(page);

  // Default mode: generated passphrase shown, Next locked until backup exists.
  await expect(page.getByTestId("backup-passphrase-generated")).toBeVisible();
  await expect(page.getByTestId("onboarding-next")).toBeDisabled();

  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/02-backup-step-passphrase.png` });

  await page.getByTestId("encrypted-backup-create").click();

  // The persisted blob is displayed masked; copy + save-a-copy available.
  const blob = page.getByTestId("ncryptsec-value");
  await expect(blob).toBeVisible();
  await expect(blob).toHaveCSS("filter", /blur/);
  await page.getByTestId("ncryptsec-reveal-toggle").click();
  await expect(blob).toContainText("ncryptsec1");

  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/03-backup-step-encrypted.png` });

  await page.getByTestId("encrypted-backup-save-copy").click();
  await expect(page.getByTestId("encrypted-backup-saved-path")).toContainText(
    "identity.ncryptsec",
  );

  // The default path must never have fetched the raw key.
  const commands = await page.evaluate(
    () =>
      (window as Window & { __BUZZ_E2E_COMMANDS__?: string[] })
        .__BUZZ_E2E_COMMANDS__ ?? [],
  );
  expect(commands).not.toContain("get_nsec");
  expect(commands).toContain("create_ncryptsec_backup");

  await expect(page.getByTestId("onboarding-next")).toBeEnabled();
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-page-2")).toBeVisible();
});

test("custom passphrase requires 12 characters and confirmation", async ({
  page,
}) => {
  await enterMachineBackup(page);

  await page.getByTestId("backup-passphrase-choose-own").click();
  const create = page.getByTestId("encrypted-backup-create");

  await page.getByTestId("backup-passphrase-custom").fill("short");
  await expect(page.getByTestId("backup-passphrase-issue")).toBeVisible();
  await expect(create).toBeDisabled();

  await page
    .getByTestId("backup-passphrase-custom")
    .fill("a much longer passphrase");
  await expect(create).toBeDisabled(); // confirm still empty

  await page
    .getByTestId("backup-passphrase-confirm")
    .fill("a much longer passphrase");
  await expect(create).toBeEnabled();
});

// ---------------------------------------------------------------------------
// Raw-key path: preserved behind an explicit "Show raw key instead" click.
// ---------------------------------------------------------------------------

test("raw key path is one explicit click away and shows the masked nsec", async ({
  page,
}) => {
  await enterMachineBackup(page);

  await page.getByTestId("backup-show-raw-key").click();

  const nsecDisplay = page.getByTestId("nsec-value");
  await expect(nsecDisplay).toBeVisible();

  // Should start masked (blurred) — reveal button exists and eye icon visible.
  const revealBtn = page.getByTestId("nsec-reveal-toggle");
  await expect(revealBtn).toBeVisible();
  await expect(nsecDisplay).toHaveCSS("filter", /blur/);

  // Reveal and verify the mock nsec appears.
  await revealBtn.click();
  await expect(nsecDisplay).not.toHaveCSS("filter", /blur/);
  await expect(nsecDisplay).toContainText("nsec1mock");

  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/04-backup-step-raw-revealed.png` });

  // Raw mode keeps the previous gating: key shown → Next enabled.
  await expect(page.getByTestId("onboarding-next")).toBeEnabled();
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-page-2")).toBeVisible();
});

test("backup step back button returns to machine identity choice", async ({
  page,
}) => {
  await enterMachineBackup(page);

  await expect(page.getByTestId("onboarding-page-backup")).toBeVisible();
  await page.getByTestId("onboarding-back").click();

  // Backing out preserves the loaded key — primary CTA continues setup rather
  // than minting another identity (#2318).
  await expect(
    page.getByRole("button", { name: "Continue setup" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use a different key instead" }),
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// B4: Error path coverage (raw path)
// ---------------------------------------------------------------------------

test("raw path shows error banner and retry button when get_nsec fails", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { nsecError: "Keychain locked" },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Create a new identity key" }).click();

  await expect(page.getByTestId("onboarding-page-backup")).toBeVisible();
  await page.getByTestId("backup-show-raw-key").click();

  await expect(page.getByTestId("backup-load-error")).toBeVisible();
  await expect(page.getByTestId("backup-retry")).toBeVisible();
  // Next is blocked on error; Skip for now ghost is shown instead.
  await expect(page.getByTestId("onboarding-next")).toBeDisabled();
  await expect(page.getByTestId("backup-skip")).toBeVisible();

  // Skip for now still advances to machine setup.
  await page.getByTestId("backup-skip").click();
  await expect(page.getByTestId("onboarding-page-2")).toBeVisible();
});

test("raw path retry succeeds and shows key after initial failure", async ({
  page,
}) => {
  // First call fails, second succeeds (sequenced via nsecErrors).
  await installMockBridge(
    page,
    { nsecErrors: ["Keychain locked", null] },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Create a new identity key" }).click();
  await page.getByTestId("backup-show-raw-key").click();

  await expect(page.getByTestId("backup-load-error")).toBeVisible();

  // Retry — second call succeeds.
  await page.getByTestId("backup-retry").click();
  await expect(page.getByTestId("nsec-value")).toBeVisible();
  await expect(page.getByTestId("backup-load-error")).not.toBeVisible();
});
