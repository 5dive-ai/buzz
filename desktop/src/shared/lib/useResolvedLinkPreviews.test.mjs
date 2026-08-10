import assert from "node:assert/strict";
import test from "node:test";

import {
  __linkPreviewMetadataTest,
  resolveLinkPreview,
} from "./useResolvedLinkPreviews.ts";

const preview = {
  kind: "generic-link",
  href: "https://example.com/story",
  provider: "example.com",
  title: "example.com/story",
  typeLabel: "link",
};

function metadata(overrides = {}) {
  return {
    title: "A story",
    siteName: "Example",
    description: "Story description",
    imageDataUrl: null,
    imageDomain: null,
    imageFetchState: "none",
    imageRetryAfterMs: null,
    ...overrides,
  };
}

test("pending metadata reserves the image treatment", () => {
  assert.deepEqual(resolveLinkPreview(preview, undefined), {
    ...preview,
    imageState: "pending",
  });
});

test("resolved image metadata keeps the reserved image treatment", () => {
  const resolved = resolveLinkPreview(preview, {
    title: "A story",
    siteName: "Example",
    imageDataUrl: "data:image/jpeg;base64,abc",
    imageDomain: "cdn.example.com",
  });

  assert.equal(resolved.imageState, "image");
  assert.equal(resolved.provider, "Example");
  assert.equal(resolved.imageDomain, "cdn.example.com");
});

test("resolved metadata without a complete image collapses to the compact treatment", () => {
  const resolved = resolveLinkPreview(preview, {
    title: "A story",
    siteName: "Example",
    imageDataUrl: null,
    imageDomain: null,
  });

  assert.equal(resolved.imageState, "none");
  assert.equal(resolved.imageDataUrl, null);
  assert.equal(resolved.imageDomain, null);
});

test("transient and rejected image fetches use the stable fallback treatment", () => {
  const transient = resolveLinkPreview(
    preview,
    metadata({
      imageFetchState: "transient_failure",
      imageRetryAfterMs: 900_000,
    }),
  );
  const rejected = resolveLinkPreview(
    preview,
    metadata({ imageFetchState: "rejected" }),
  );

  assert.equal(transient.imageState, "fallback");
  assert.equal(rejected.imageState, "fallback");
});

test("metadata cache keys deduplicate URL fragments", () => {
  assert.equal(
    __linkPreviewMetadataTest.metadataCacheKey(
      "https://github.com/block/buzz/pull/3834#issuecomment-1",
    ),
    "https://github.com/block/buzz/pull/3834",
  );
});

test("transient metadata expires at the server retry boundary", () => {
  assert.equal(
    __linkPreviewMetadataTest.metadataExpiry(
      metadata({
        imageFetchState: "transient_failure",
        imageRetryAfterMs: 900_000,
      }),
      1_000,
    ),
    901_000,
  );
});

test("metadata loader retries transient images after the server cooldown", async () => {
  let now = 1_000;
  let calls = 0;
  const loader = __linkPreviewMetadataTest.createMetadataLoader({
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? metadata({
            imageFetchState: "transient_failure",
            imageRetryAfterMs: 10_000,
          })
        : metadata({
            imageDataUrl: "data:image/jpeg;base64,abc",
            imageDomain: "images.example.com",
            imageFetchState: "image",
          });
    },
    now: () => now,
  });

  assert.equal(
    (await loader.load(preview.href)).metadata?.imageFetchState,
    "transient_failure",
  );
  assert.equal(calls, 1);

  now += 10_000;
  assert.equal(
    (await loader.load(preview.href)).metadata?.imageFetchState,
    "image",
  );
  assert.equal(calls, 2);
});

test("a transient blip earns one immediate inline retry before caching", async () => {
  // A single unlucky fetch (timeout/5xx/network) should not blank the card: the
  // loader retries once inline after a short backoff. If that second attempt
  // succeeds, the card resolves right away with no wait at all.
  const now = 1_000;
  let calls = 0;
  const loader = __linkPreviewMetadataTest.createMetadataLoader({
    delay: () => Promise.resolve(),
    fetcher: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary failure");
      return metadata();
    },
    now: () => now,
  });

  assert.deepEqual((await loader.load(preview.href)).metadata, metadata());
  assert.equal(calls, 2);
});

test("a blip that also fails the inline retry caches transient, recovering after the short TTL", async () => {
  // When both the initial fetch and its inline retry fail, the loader gives up
  // and caches a transient entry (short 30s TTL), not a full 5-min hard miss.
  let now = 1_000;
  let calls = 0;
  const loader = __linkPreviewMetadataTest.createMetadataLoader({
    delay: () => Promise.resolve(),
    fetcher: async () => {
      calls += 1;
      // Both the initial attempt and its inline retry fail; success afterward.
      if (calls <= 2) throw new Error("temporary failure");
      return metadata();
    },
    now: () => now,
  });

  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 2);

  now += 30_000;
  assert.deepEqual((await loader.load(preview.href)).metadata, metadata());
  assert.equal(calls, 3);
});

test("a rejected fetch does not poison the cache for the full miss TTL", async () => {
  // Regression: a single transient failure (timeout/429/5xx/network) used to be
  // cached like a genuine "no metadata" miss, blanking a perfectly valid link
  // for 5 minutes. Even when the inline retry also fails, the transient entry
  // must clear well before the miss TTL so the card recovers.
  let now = 1_000;
  let calls = 0;
  const loader = __linkPreviewMetadataTest.createMetadataLoader({
    delay: () => Promise.resolve(),
    fetcher: async () => {
      calls += 1;
      if (calls <= 2) throw new Error("temporary failure");
      return metadata();
    },
    now: () => now,
  });

  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 2);

  // Well before NULL_METADATA_RETRY_MS (5 min) the transient entry has expired
  // and the retry succeeds — a hard miss would still be cached here.
  now += 60_000;
  assert.deepEqual((await loader.load(preview.href)).metadata, metadata());
  assert.equal(calls, 3);
});

test("a rate limit skips the inline retry and waits out its Retry-After", async () => {
  // A 429 must NOT get the fast inline retry (an immediate retry would just be
  // throttled again). It caches transient and honors the server's Retry-After
  // as the wait, then refetches once that window elapses.
  let now = 1_000;
  let calls = 0;
  const loader = __linkPreviewMetadataTest.createMetadataLoader({
    delay: () => Promise.resolve(),
    fetcher: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("link preview rate limited: retry-after 45");
      }
      return metadata();
    },
    now: () => now,
  });

  assert.equal((await loader.load(preview.href)).metadata, null);
  // No inline retry on a rate limit: exactly one fetch so far.
  assert.equal(calls, 1);

  // The default transient window has passed, but the server asked for 45s — the
  // entry is still cached, no refetch yet.
  now += 30_000;
  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 1);

  // Past the honored Retry-After the entry expires and the refetch succeeds.
  now += 15_000;
  assert.deepEqual((await loader.load(preview.href)).metadata, metadata());
  assert.equal(calls, 2);
});

test("a rate limit without Retry-After falls back to the default transient window", async () => {
  let now = 1_000;
  let calls = 0;
  const loader = __linkPreviewMetadataTest.createMetadataLoader({
    delay: () => Promise.resolve(),
    fetcher: async () => {
      calls += 1;
      if (calls === 1) throw new Error("link preview rate limited");
      return metadata();
    },
    now: () => now,
  });

  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 1);

  now += 30_000;
  assert.deepEqual((await loader.load(preview.href)).metadata, metadata());
  assert.equal(calls, 2);
});

test("a genuine no-metadata miss stays cached for the full miss TTL", async () => {
  let now = 1_000;
  let calls = 0;
  const loader = __linkPreviewMetadataTest.createMetadataLoader({
    fetcher: async () => {
      calls += 1;
      return null;
    },
    now: () => now,
  });

  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 1);

  // A resolved null (200 + HTML + no metadata) is a hard miss: it must not be
  // refetched inside the transient window.
  now += 60_000;
  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 1);

  now += 5 * 60_000;
  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 2);
});

test("a Retry-After: 0 floors the transient window instead of looping", async () => {
  // Regression: a 429 with `Retry-After: 0` used to yield expiresAt === now, so
  // the expiry timer would delete and refetch immediately, spinning a tight
  // loop while the 429 persisted. The transient window must be floored at a
  // positive minimum so the refetch is deferred, not fired on the same tick.
  let now = 1_000;
  let calls = 0;
  const loader = __linkPreviewMetadataTest.createMetadataLoader({
    delay: () => Promise.resolve(),
    fetcher: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("link preview rate limited: retry-after 0");
      }
      return metadata();
    },
    now: () => now,
  });

  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 1);

  // On the same tick the entry is still cached — no immediate refetch loop.
  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 1);

  // Past the positive floor the entry expires and the refetch succeeds.
  now += 1_000;
  assert.deepEqual((await loader.load(preview.href)).metadata, metadata());
  assert.equal(calls, 2);
});

test("a 429 on the inline retry keeps its own Retry-After", async () => {
  // Regression: a transient blip earns one inline retry; if that retry itself
  // comes back 429 with a Retry-After, the loader must re-classify it and honor
  // that cooldown — not collapse the second rejection to the default 30s window.
  let now = 1_000;
  let calls = 0;
  const loader = __linkPreviewMetadataTest.createMetadataLoader({
    delay: () => Promise.resolve(),
    fetcher: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary failure");
      if (calls === 2) {
        throw new Error("link preview rate limited: retry-after 600");
      }
      return metadata();
    },
    now: () => now,
  });

  // Initial blip + one inline retry that comes back 429: two fetches, cached.
  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 2);

  // The default transient window has elapsed, but the retry's Retry-After was
  // 600s — the entry is still cached, no refetch yet.
  now += 30_000;
  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 2);

  // Past the honored 600s cooldown the entry expires and the refetch succeeds.
  now += 570_000;
  assert.deepEqual((await loader.load(preview.href)).metadata, metadata());
  assert.equal(calls, 3);
});

test("a permanent rejection skips the inline retry and holds the full miss TTL", async () => {
  // Regression: a permanent validation/policy rejection (SSRF private-host,
  // non-HTTPS/credentialed URL, bad port, unparseable URL/redirect) used to be
  // treated as transient — inline-retried and then self-heal polled every 30s,
  // turning an attacker-controlled URL into recurring DNS/IPC work. It must get
  // NO inline retry and cache as a hard miss for the full miss TTL.
  let now = 1_000;
  let calls = 0;
  const loader = __linkPreviewMetadataTest.createMetadataLoader({
    delay: () => Promise.resolve(),
    fetcher: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error(
          "link preview rejected: link preview host resolved to a private or reserved address",
        );
      }
      return metadata();
    },
    now: () => now,
  });

  assert.equal((await loader.load(preview.href)).metadata, null);
  // No inline retry on a permanent rejection: exactly one fetch.
  assert.equal(calls, 1);

  // Well past the transient window it is still cached — no 30s self-heal poll.
  now += 60_000;
  assert.equal((await loader.load(preview.href)).metadata, null);
  assert.equal(calls, 1);

  // Only after the full miss TTL does it expire and refetch.
  now += 5 * 60_000;
  assert.deepEqual((await loader.load(preview.href)).metadata, metadata());
  assert.equal(calls, 2);
});

test("metadata loader coalesces fragment variants and bounds concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const loader = __linkPreviewMetadataTest.createMetadataLoader({
    concurrency: 2,
    fetcher: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return metadata();
    },
  });

  await Promise.all([
    loader.load("https://example.com/one#first"),
    loader.load("https://example.com/one#second"),
    loader.load("https://example.com/two"),
    loader.load("https://example.com/three"),
  ]);

  assert.equal(calls, 3);
  assert.equal(maxActive, 2);
});
