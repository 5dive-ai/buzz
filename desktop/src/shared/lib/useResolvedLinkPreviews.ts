import * as React from "react";

import { invokeTauri } from "@/shared/api/tauri";

import type { SupportedLinkPreview } from "./linkPreview";

type LinkPreviewImageFetchState =
  | "none"
  | "image"
  | "transient_failure"
  | "rejected";

type LinkPreviewMetadata = {
  title: string;
  siteName: string | null;
  description: string | null;
  imageDataUrl: string | null;
  imageDomain: string | null;
  imageFetchState?: LinkPreviewImageFetchState;
  imageRetryAfterMs?: number | null;
  faviconDataUrl?: string | null;
};

type MetadataCacheEntry = {
  expiresAt: number | null;
  metadata: LinkPreviewMetadata | null;
};

type MetadataLoadResult = MetadataCacheEntry & {
  key: string;
};

const DEFAULT_TRANSIENT_RETRY_MS = 30_000;
const NULL_METADATA_RETRY_MS = 5 * 60_000;
const MAX_CONCURRENT_METADATA_FETCHES = 2;

function metadataCacheKey(href: string): string {
  try {
    const url = new URL(href);
    url.hash = "";
    return url.href;
  } catch {
    return href.split("#", 1)[0] ?? href;
  }
}

function metadataExpiry(
  metadata: LinkPreviewMetadata | null,
  now: number,
): number | null {
  if (metadata === null) return now + NULL_METADATA_RETRY_MS;
  if (metadata.imageFetchState !== "transient_failure") return null;
  const retryAfterMs =
    typeof metadata.imageRetryAfterMs === "number" &&
    Number.isFinite(metadata.imageRetryAfterMs)
      ? Math.max(1_000, metadata.imageRetryAfterMs)
      : DEFAULT_TRANSIENT_RETRY_MS;
  return now + retryAfterMs;
}

function createTaskScheduler(concurrency: number) {
  const pending: Array<() => void> = [];
  let active = 0;

  const drain = () => {
    while (active < concurrency) {
      const run = pending.shift();
      if (!run) return;
      active += 1;
      run();
    }
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.push(() => {
        void task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            drain();
          });
      });
      drain();
    });
}

function createMetadataLoader({
  concurrency = MAX_CONCURRENT_METADATA_FETCHES,
  fetcher,
  now = Date.now,
}: {
  concurrency?: number;
  fetcher: (href: string) => Promise<LinkPreviewMetadata | null>;
  now?: () => number;
}) {
  const cache = new Map<
    string,
    MetadataCacheEntry | Promise<MetadataLoadResult>
  >();
  const schedule = createTaskScheduler(Math.max(1, concurrency));
  let generation = 0;

  const peek = (href: string): MetadataLoadResult | undefined => {
    const key = metadataCacheKey(href);
    const cached = cache.get(key);
    if (!cached || cached instanceof Promise) return undefined;
    if (cached.expiresAt !== null && cached.expiresAt <= now()) {
      cache.delete(key);
      return undefined;
    }
    return { key, ...cached };
  };

  const load = (href: string): Promise<MetadataLoadResult> => {
    const key = metadataCacheKey(href);
    const cached = cache.get(key);
    if (cached instanceof Promise) return cached;
    if (cached) {
      if (cached.expiresAt === null || cached.expiresAt > now()) {
        return Promise.resolve({ key, ...cached });
      }
      cache.delete(key);
    }

    const requestGeneration = generation;
    const promise = schedule(() => fetcher(href))
      .catch(() => null)
      .then((metadata) => {
        const entry = {
          expiresAt: metadataExpiry(metadata, now()),
          metadata,
        };
        if (requestGeneration === generation) {
          cache.set(key, entry);
        }
        return { key, ...entry };
      });
    cache.set(key, promise);
    return promise;
  };

  return {
    deleteKey(key: string) {
      cache.delete(key);
    },
    load,
    peek,
    reset() {
      generation += 1;
      cache.clear();
    },
  };
}

function fetchLinkPreviewMetadata(
  href: string,
): Promise<LinkPreviewMetadata | null> {
  return invokeTauri<LinkPreviewMetadata | null>(
    "fetch_link_preview_metadata",
    {
      href,
    },
  );
}

const metadataLoader = createMetadataLoader({
  fetcher: fetchLinkPreviewMetadata,
});

/** Clear ephemeral metadata when the active relay/community changes. */
export function resetLinkPreviewMetadataCache(): void {
  metadataLoader.reset();
}

export type LinkPreviewImageState = "pending" | "image" | "fallback" | "none";

export type ResolvedLinkPreview = SupportedLinkPreview & {
  description?: string | null;
  faviconDataUrl?: string | null;
  imageState: LinkPreviewImageState;
};

type ResolvedMetadataByHref = Record<
  string,
  LinkPreviewMetadata | null | undefined
>;

export function resolveLinkPreview(
  preview: SupportedLinkPreview,
  metadata: LinkPreviewMetadata | null | undefined,
): ResolvedLinkPreview {
  if (metadata === undefined) {
    return { ...preview, imageState: "pending" };
  }
  if (metadata === null) {
    return { ...preview, imageState: "none" };
  }

  const hasImage = Boolean(metadata.imageDataUrl && metadata.imageDomain);
  const imageState: LinkPreviewImageState = hasImage
    ? "image"
    : metadata.imageFetchState === "image" ||
        metadata.imageFetchState === "transient_failure" ||
        metadata.imageFetchState === "rejected"
      ? "fallback"
      : "none";
  return {
    ...preview,
    title: metadata.title,
    description: metadata.description,
    faviconDataUrl: metadata.faviconDataUrl,
    provider:
      preview.kind === "generic-link" && metadata.siteName
        ? metadata.siteName
        : preview.provider,
    imageDataUrl: hasImage ? metadata.imageDataUrl : null,
    imageDomain: hasImage ? metadata.imageDomain : null,
    imageState,
  };
}

export function useResolvedLinkPreviews(
  previews: SupportedLinkPreview[],
): ResolvedLinkPreview[] {
  const [resolvedMetadata, setResolvedMetadata] =
    React.useState<ResolvedMetadataByHref>({});
  const [retryGeneration, setRetryGeneration] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    let retryAt = Number.POSITIVE_INFINITY;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRetry = ({
      expiresAt,
      key,
    }: Pick<MetadataLoadResult, "expiresAt" | "key">) => {
      if (expiresAt === null || expiresAt >= retryAt) return;
      retryAt = expiresAt;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = setTimeout(
        () => {
          metadataLoader.deleteKey(key);
          setResolvedMetadata((current) => {
            if (!(key in current)) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
          setRetryGeneration(retryGeneration + 1);
        },
        Math.max(0, expiresAt - Date.now()),
      );
    };

    for (const preview of previews) {
      const cached = metadataLoader.peek(preview.href);
      if (cached !== undefined) {
        setResolvedMetadata((current) =>
          current[cached.key] === cached.metadata
            ? current
            : { ...current, [cached.key]: cached.metadata },
        );
        scheduleRetry(cached);
        continue;
      }

      void metadataLoader.load(preview.href).then((result) => {
        if (cancelled) return;
        setResolvedMetadata((current) =>
          current[result.key] === result.metadata
            ? current
            : { ...current, [result.key]: result.metadata },
        );
        scheduleRetry(result);
      });
    }

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [previews, retryGeneration]);

  return React.useMemo(
    () =>
      previews.map((preview) =>
        resolveLinkPreview(
          preview,
          resolvedMetadata[metadataCacheKey(preview.href)],
        ),
      ),
    [previews, resolvedMetadata],
  );
}

export const __linkPreviewMetadataTest = {
  createMetadataLoader,
  createTaskScheduler,
  metadataCacheKey,
  metadataExpiry,
};
