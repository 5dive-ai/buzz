/**
 * Screenshots for the "DM from x" inbox label vertical-spacing fix.
 *
 * Channel rows render a #channel chip in the context line; DM rows render
 * plain text. Without a shared min-height the DM line is shorter, so the
 * rows visibly misalign. These shots document the row stack with all three
 * label variants adjacent.
 *
 * Run: pnpm build:e2e && pnpm exec playwright test --project=smoke \
 *        tests/e2e/dm-label-spacing-screenshots.spec.ts
 * Output: test-results/dm-label-spacing/
 */
import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const SHOTS = "test-results/dm-label-spacing";

const GENERAL_CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const DM_CHANNEL_ID = "f48efb06-0c93-5025-aac9-2e646bb6bfa8";

type MockFeedWindow = Window & {
  __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
    channelName: string;
    content: string;
    createdAt?: number;
    id?: string;
    pubkey?: string;
  }) => {
    content: string;
    created_at: number;
    id: string;
    kind: number;
    pubkey: string;
    tags: string[][];
  };
  __BUZZ_E2E_PUSH_MOCK_FEED_ITEM__?: (item: {
    category: "mention" | "needs_action" | "activity" | "agent_activity";
    channel_id: string | null;
    channel_name: string;
    channel_type?: string | null;
    content: string;
    created_at: number;
    id: string;
    kind: number;
    pubkey: string;
    tags: string[][];
  }) => void;
};

test.describe("dm label spacing screenshots", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("inbox rows with channel chips and DM labels align", async ({
    page,
  }) => {
    await installMockBridge(page, { mode: "mock" });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("home-inbox-list")).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForFunction(() => {
      const win = window as MockFeedWindow;
      return (
        typeof win.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function" &&
        typeof win.__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__ === "function"
      );
    });

    await page.evaluate(
      ({ alice, charlie, dmChannelId, generalChannelId }) => {
        const win = window as MockFeedWindow;
        const emitMessage = win.__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
        const pushFeedItem = win.__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__;
        if (!emitMessage || !pushFeedItem) {
          throw new Error("Mock bridge helpers are not installed.");
        }

        const base = Math.floor(Date.now() / 1000);
        const seed = (input: {
          category: "mention" | "activity";
          channelId: string;
          channelName: string;
          channelType: string | null;
          content: string;
          id: string;
          offset: number;
          pubkey: string;
        }) => {
          const event = emitMessage({
            channelName: input.channelName,
            content: input.content,
            createdAt: base + input.offset,
            id: input.id,
            pubkey: input.pubkey,
          });
          pushFeedItem({
            category: input.category,
            channel_id: input.channelId,
            channel_name: input.channelName,
            channel_type: input.channelType,
            content: event.content,
            created_at: event.created_at,
            id: event.id,
            kind: event.kind,
            pubkey: event.pubkey,
            tags: event.tags,
          });
        };

        seed({
          category: "mention",
          channelId: generalChannelId,
          channelName: "general",
          channelType: "stream",
          content: "Can you take a look at the release checklist?",
          id: "shot-spacing-mention",
          offset: 3,
          pubkey: charlie,
        });
        seed({
          category: "activity",
          channelId: dmChannelId,
          channelName: "alice-tyler",
          channelType: "dm",
          content: "also should I be doing tests on these before approving?",
          id: "shot-spacing-dm",
          offset: 2,
          pubkey: alice,
        });
        seed({
          category: "activity",
          channelId: generalChannelId,
          channelName: "general",
          channelType: "stream",
          content: "ah speaking of I have a fix for this page.",
          id: "shot-spacing-thread",
          offset: 1,
          pubkey: charlie,
        });
      },
      {
        alice: TEST_IDENTITIES.alice.pubkey,
        charlie: TEST_IDENTITIES.charlie.pubkey,
        dmChannelId: DM_CHANNEL_ID,
        generalChannelId: GENERAL_CHANNEL_ID,
      },
    );

    const mentionRow = page.getByTestId("home-inbox-item-shot-spacing-mention");
    const dmRow = page.getByTestId("home-inbox-item-shot-spacing-dm");
    await expect(mentionRow).toBeVisible();
    await expect(dmRow).toBeVisible();
    await expect(dmRow).toContainText("DM from alice");
    await expect(mentionRow).toContainText("Mentioned in");
    await waitForAnimations(page);

    // The claim under test: the context line under the sender name has the
    // same height whether it holds a #channel chip or plain "DM from x" text.
    const labelHeights = await page.evaluate(() => {
      const measure = (id: string) => {
        const row = document.querySelector(`[data-testid="${id}"]`);
        const label = row?.querySelector(".message-markdown");
        return label ? label.getBoundingClientRect().height : null;
      };
      return {
        dm: measure("home-inbox-item-shot-spacing-dm"),
        mention: measure("home-inbox-item-shot-spacing-mention"),
      };
    });
    console.log("label heights:", JSON.stringify(labelHeights));

    await page.screenshot({ path: `${SHOTS}/inbox-row-stack.png` });
    await page
      .getByTestId("home-inbox-list")
      .screenshot({ path: `${SHOTS}/inbox-list-only.png` });

    expect(labelHeights.dm).not.toBeNull();
    expect(labelHeights.mention).not.toBeNull();
    // Regression guard: chip rows and plain-text DM rows share a height.
    expect(labelHeights.dm).toBe(labelHeights.mention);
  });
});
