import * as React from "react";

import { getRelayHttpUrl, uploadMediaBytes } from "@/shared/api/tauri";
import { extractSupportedLinkPreviews } from "@/shared/lib/linkPreview";
import { buildLinkPreviewSnapshotTag } from "@/shared/lib/linkPreviewSnapshot";
import {
  beginRelayOriginFetch,
  getCachedRelayOrigin,
} from "@/shared/lib/mediaUrl";
import { useResolvedLinkPreviews } from "@/shared/lib/useResolvedLinkPreviews";
import { LinkPreviewList } from "@/shared/ui/link-preview-list";
import { LinkPreviewImageLightbox } from "@/shared/ui/markdown";

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  try {
    return Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function uploadDataUrl(
  dataUrl: string | null | undefined,
  filename: string,
) {
  if (!dataUrl) return { url: "", sha256: "" };
  const bytes = dataUrlBytes(dataUrl);
  if (!bytes) throw new Error("invalid preview media data");
  const uploaded = await uploadMediaBytes([...bytes], filename);
  return { url: uploaded.url, sha256: uploaded.sha256 };
}

export function useComposerLinkPreviews(content: string) {
  const candidates = React.useMemo(
    () => extractSupportedLinkPreviews(content),
    [content],
  );
  const previews = useResolvedLinkPreviews(candidates);
  const [readyTags, setReadyTags] = React.useState<Record<string, string[]>>(
    {},
  );
  const readyTagsRef = React.useRef<string[][]>([]);
  const uploadsRef = React.useRef(new Set<string>());
  const activeHrefsRef = React.useRef(new Set<string>());
  activeHrefsRef.current = new Set(candidates.map((preview) => preview.href));

  React.useEffect(() => {
    if (getCachedRelayOrigin()) return;
    const publishRelayOrigin = beginRelayOriginFetch();
    void getRelayHttpUrl()
      .then((url) => publishRelayOrigin(url))
      .catch(() => publishRelayOrigin(null));
  }, []);

  React.useEffect(() => {
    const active = new Set(candidates.map((preview) => preview.href));
    setReadyTags((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([href]) => active.has(href)),
      ),
    );
  }, [candidates]);

  React.useEffect(() => {
    for (const preview of previews) {
      if (
        !preview.snapshotReady ||
        readyTags[preview.href] ||
        uploadsRef.current.has(preview.href)
      )
        continue;
      uploadsRef.current.add(preview.href);
      void Promise.all([
        uploadDataUrl(preview.imageDataUrl, "link-preview-image.png"),
        uploadDataUrl(preview.faviconDataUrl, "link-preview-favicon.png"),
      ])
        .then(([image, favicon]) => {
          if (!activeHrefsRef.current.has(preview.href)) return;
          const tag = buildLinkPreviewSnapshotTag({
            canonicalUrl: preview.href,
            title: preview.title,
            siteName: preview.provider,
            description: preview.description ?? "",
            imageUrl: image.url,
            imageSha256: image.sha256,
            faviconUrl: favicon.url,
            faviconSha256: favicon.sha256,
          });
          setReadyTags((current) => ({ ...current, [preview.href]: tag }));
        })
        .catch(() => {})
        .finally(() => uploadsRef.current.delete(preview.href));
    }
  }, [previews, readyTags]);

  readyTagsRef.current = candidates.flatMap((candidate) =>
    readyTags[candidate.href] ? [readyTags[candidate.href]] : [],
  );
  const previewList = previews.length ? (
    <div
      className="message-markdown mb-2"
      data-composer-link-previews=""
      data-ready-snapshot-count={readyTagsRef.current.length}
    >
      <LinkPreviewList
        ImageLightbox={LinkPreviewImageLightbox}
        previews={previews}
      />
    </div>
  ) : null;
  const getReadyTags = React.useCallback(() => readyTagsRef.current, []);
  return { previewList, getReadyTags };
}
