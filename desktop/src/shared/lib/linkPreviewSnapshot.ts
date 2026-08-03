import {
  extractSupportedLinkPreviews,
  parseSupportedLinkPreview,
} from "./linkPreview";
import type { ResolvedLinkPreview } from "./useResolvedLinkPreviews";

export const LINK_PREVIEW_SNAPSHOT_VERSION = "1";
const MAX_SNAPSHOTS = 8;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IMAGE_EXT_RE = /^(?:jpg|png|gif|webp)$/;

export type LinkPreviewSnapshot = {
  canonicalUrl: string;
  title: string;
  siteName: string;
  description: string;
  imageUrl: string;
  imageSha256: string;
  faviconUrl: string;
  faviconSha256: string;
};

function validText(value: string, max: number): boolean {
  return (
    value.length <= max &&
    !Array.from(value).some((char) => {
      const code = char.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function isRelayMediaPair(
  url: string,
  sha256: string,
  relayOrigin: string,
): boolean {
  if (!url && !sha256) return true;
  if (!url || !SHA256_RE.test(sha256)) return false;
  try {
    const parsed = new URL(url);
    if (
      parsed.origin !== relayOrigin ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      return false;
    const match = /^\/media\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/.exec(
      parsed.pathname,
    );
    return Boolean(
      match && match[1] === sha256 && IMAGE_EXT_RE.test(match[2] ?? ""),
    );
  } catch {
    return false;
  }
}

export function parseLinkPreviewSnapshots(
  tags: readonly (readonly string[])[] | undefined,
  content: string,
  relayOrigin: string | null,
): ResolvedLinkPreview[] {
  if (!relayOrigin || !tags) return [];
  const contentUrls = new Set(
    extractSupportedLinkPreviews(content).map((preview) => preview.href),
  );
  const seen = new Set<string>();
  const snapshots: ResolvedLinkPreview[] = [];
  for (const tag of tags) {
    if (tag[0] !== "link-preview" || tag[1] !== "snapshot") continue;
    if (
      snapshots.length >= MAX_SNAPSHOTS ||
      tag.length !== 11 ||
      tag[2] !== LINK_PREVIEW_SNAPSHOT_VERSION
    )
      continue;
    const [
      ,
      ,
      ,
      canonicalUrl,
      title,
      siteName,
      description,
      imageUrl,
      imageSha256,
      faviconUrl,
      faviconSha256,
    ] = tag;
    const parsed = parseSupportedLinkPreview(canonicalUrl);
    if (
      !parsed ||
      parsed.href !== canonicalUrl ||
      !contentUrls.has(canonicalUrl) ||
      seen.has(canonicalUrl)
    )
      continue;
    if (
      !validText(title, 300) ||
      !validText(siteName, 100) ||
      !validText(description, 1000)
    )
      continue;
    if (
      !isRelayMediaPair(imageUrl, imageSha256, relayOrigin) ||
      !isRelayMediaPair(faviconUrl, faviconSha256, relayOrigin)
    )
      continue;
    seen.add(canonicalUrl);
    snapshots.push({
      ...parsed,
      title: title || parsed.title,
      provider: siteName || parsed.provider,
      description: description || null,
      faviconDataUrl: faviconUrl || null,
      imageDataUrl: imageUrl || null,
      imageDomain: imageUrl ? new URL(imageUrl).hostname : null,
      imageState: imageUrl ? "image" : "none",
    });
  }
  return snapshots;
}

export function buildLinkPreviewSnapshotTag(
  snapshot: LinkPreviewSnapshot,
): string[] {
  return [
    "link-preview",
    "snapshot",
    LINK_PREVIEW_SNAPSHOT_VERSION,
    snapshot.canonicalUrl,
    snapshot.title,
    snapshot.siteName,
    snapshot.description,
    snapshot.imageUrl,
    snapshot.imageSha256,
    snapshot.faviconUrl,
    snapshot.faviconSha256,
  ];
}
