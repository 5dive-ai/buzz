import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  focusManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";

import {
  FOCUS_RETURN_STALE_TIME_MS,
  refetchOnFocusWhenOld,
  shouldRefetchOnFocus,
} from "./useDocumentVisible.ts";

const NOW = 1_800_000_000_000;

afterEach(() => {
  focusManager.setFocused(undefined);
});

async function focusRefetchCount({
  ageMs,
  status = "success",
  dataUpdatedAt = Date.now() - ageMs,
}) {
  focusManager.setFocused(false);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.mount();

  const queryKey = ["focus-return-policy", ageMs, status, dataUpdatedAt];
  queryClient.setQueryData(queryKey, "cached", { updatedAt: dataUpdatedAt });
  if (status !== "success") {
    queryClient.getQueryCache().find({ queryKey }).setState({ status });
  }
  let fetchCount = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn: async () => {
      fetchCount += 1;
      return "refetched";
    },
    refetchOnMount: false,
    refetchOnWindowFocus: refetchOnFocusWhenOld,
    staleTime: 5_000,
  });
  const unsubscribe = observer.subscribe(() => {});

  focusManager.setFocused(true);
  await new Promise((resolve) => setImmediate(resolve));

  unsubscribe();
  queryClient.unmount();
  return fetchCount;
}

test("focus return keeps recently fetched stale queries cached", async () => {
  assert.equal(
    await focusRefetchCount({ ageMs: FOCUS_RETURN_STALE_TIME_MS - 1_000 }),
    0,
  );
});

test("focus return catches up genuinely old queries", async () => {
  assert.equal(
    await focusRefetchCount({ ageMs: FOCUS_RETURN_STALE_TIME_MS + 1 }),
    1,
  );
});

test("focus return fetches a missing result", () => {
  assert.equal(
    shouldRefetchOnFocus({ status: "pending", dataUpdatedAt: 0 }, NOW),
    "always",
  );
});

test("focus return retries an error with recent retained data", async () => {
  assert.equal(
    shouldRefetchOnFocus({ status: "error", dataUpdatedAt: NOW - 10_000 }, NOW),
    "always",
  );
  assert.equal(await focusRefetchCount({ ageMs: 10_000, status: "error" }), 1);
});

test("focus return fetches after the clock moves backward", async () => {
  assert.equal(
    shouldRefetchOnFocus(
      { status: "success", dataUpdatedAt: NOW + 1_000 },
      NOW,
    ),
    "always",
  );
  assert.equal(
    await focusRefetchCount({
      ageMs: -1_000,
      dataUpdatedAt: Date.now() + 1_000,
    }),
    1,
  );
});

test("focus return age-gates successful results at the exact boundary", () => {
  assert.equal(
    shouldRefetchOnFocus(
      {
        status: "success",
        dataUpdatedAt: NOW - FOCUS_RETURN_STALE_TIME_MS + 1,
      },
      NOW,
    ),
    false,
  );
  assert.equal(
    shouldRefetchOnFocus(
      {
        status: "success",
        dataUpdatedAt: NOW - FOCUS_RETURN_STALE_TIME_MS,
      },
      NOW,
    ),
    true,
  );
});
