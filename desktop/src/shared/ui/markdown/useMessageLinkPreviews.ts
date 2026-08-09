import * as React from "react";

import { extractSupportedLinkPreviews } from "@/shared/lib/linkPreview";
import { parseLinkPreviewSnapshots } from "@/shared/lib/linkPreviewSnapshot";
import {
  type ResolvedLinkPreview,
  useResolvedLinkPreviews,
  withEntityFallbacks,
} from "@/shared/lib/useResolvedLinkPreviews";

/**
 * Resolve the link-preview cards for a rendered message.
 *
 * External URLs render exclusively from sender-authored
 * `["link-preview","snapshot",…]` tags (`parseLinkPreviewSnapshots`) — the
 * privacy model shipped in the rich-link-previews work: recipients never
 * contact external sites.
 *
 * `buzz://pr|issue|repo` entity links (and relay clone URLs, which normalize
 * onto `buzz://repo`) are the exception and are rendered recipient-side:
 * their titles come from the community relay itself via `entityTitleLoader`,
 * so the sender-snapshot privacy model does not apply — and senders (CLI,
 * agents, mobile) attach no snapshot tags for them. Snapshot cards win on
 * duplicate hrefs.
 */
export function useMessageLinkPreviews({
  content,
  interactive,
  linkPreviewTags,
  linkPreviewsSuppressed,
  relayOrigin,
}: {
  content: string;
  interactive: boolean;
  linkPreviewTags?: readonly (readonly string[])[];
  linkPreviewsSuppressed: boolean;
  relayOrigin: string | null;
}): ResolvedLinkPreview[] {
  const entityLinkPreviews = React.useMemo(
    () =>
      interactive && !linkPreviewsSuppressed
        ? extractSupportedLinkPreviews(content, relayOrigin).filter((preview) =>
            preview.href.startsWith("buzz://"),
          )
        : [],
    [content, interactive, linkPreviewsSuppressed, relayOrigin],
  );
  const relayResolvedEntityLinkPreviews =
    useResolvedLinkPreviews(entityLinkPreviews);
  const resolvedEntityLinkPreviews = React.useMemo(
    () =>
      withEntityFallbacks(entityLinkPreviews, relayResolvedEntityLinkPreviews),
    [entityLinkPreviews, relayResolvedEntityLinkPreviews],
  );
  return React.useMemo(() => {
    const snapshots =
      interactive && !linkPreviewsSuppressed
        ? parseLinkPreviewSnapshots(linkPreviewTags, content, relayOrigin)
        : [];
    if (resolvedEntityLinkPreviews.length === 0) return snapshots;
    const seen = new Set(snapshots.map((preview) => preview.href));
    return [
      ...snapshots,
      ...resolvedEntityLinkPreviews.filter(
        (preview) => !seen.has(preview.href),
      ),
    ];
  }, [
    content,
    interactive,
    linkPreviewTags,
    linkPreviewsSuppressed,
    relayOrigin,
    resolvedEntityLinkPreviews,
  ]);
}
