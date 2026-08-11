import * as React from "react";

import type { Channel } from "@/shared/api/types";
import type { GeneratedPreviewCandidate } from "@/shared/lib/linkPreview";
import type { ResolvedLinkPreview } from "@/shared/lib/useResolvedLinkPreviews";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import { LinkPreviewList } from "@/shared/ui/link-preview-list";
import type { LinkPreviewImageLightboxComponent } from "@/shared/ui/rich-link-preview-attachment";
import type { ParsedMessageLink } from "@/features/messages/lib/messageLink";

import {
  scheduleGeneratedPreviews,
  type MessageAvailability,
} from "./generatedPreviewScheduling";
import { MessageEmbedList } from "./MessageEmbedList";

export function GeneratedPreviewCoordinator({
  candidates,
  channels,
  ImageLightbox,
  onOpenByHref,
  onOpenMessageLink,
  onRemoveForEveryone,
  previews,
}: {
  candidates: GeneratedPreviewCandidate[];
  channels: Channel[];
  ImageLightbox: LinkPreviewImageLightboxComponent;
  onOpenByHref?: ReadonlyMap<string, () => void>;
  onOpenMessageLink: (link: ParsedMessageLink) => void;
  onRemoveForEveryone?: () => Promise<void>;
  previews: ResolvedLinkPreview[];
}) {
  const [availability, setAvailability] = React.useState<
    ReadonlyMap<string, MessageAvailability>
  >(() => new Map());
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [removed, setRemoved] = React.useState(false);
  const previewsByHref = React.useMemo(
    () => new Map(previews.map((preview) => [preview.href, preview])),
    [previews],
  );
  const { attemptedMessageHrefs, visibleCandidates } = React.useMemo(
    () => scheduleGeneratedPreviews(candidates, previewsByHref, availability),
    [availability, candidates, previewsByHref],
  );
  const visibleMessageHrefs = React.useMemo(
    () =>
      new Set(
        visibleCandidates.flatMap((candidate) =>
          candidate.kind === "message" ? [candidate.href] : [],
        ),
      ),
    [visibleCandidates],
  );
  const visibleLinkPreviews = visibleCandidates.flatMap((candidate) =>
    candidate.kind === "link"
      ? [previewsByHref.get(candidate.preview.href)].filter(
          (preview): preview is ResolvedLinkPreview => preview !== undefined,
        )
      : [],
  );
  const messageCandidates = candidates.flatMap((candidate) =>
    candidate.kind === "message" && attemptedMessageHrefs.has(candidate.href)
      ? [candidate]
      : [],
  );
  const firstVisible = visibleCandidates[0];
  const previewCount = visibleCandidates.length;
  const previewNoun = previewCount === 1 ? "preview" : "previews";
  const requestRemove = onRemoveForEveryone
    ? () => setDialogOpen(true)
    : undefined;

  if (removed || candidates.length === 0) return null;

  return (
    <>
      <LinkPreviewList
        ImageLightbox={ImageLightbox}
        onOpenByHref={onOpenByHref}
        onRemove={requestRemove}
        previews={visibleLinkPreviews}
        showControls={firstVisible?.kind === "link"}
      />
      <MessageEmbedList
        channels={channels}
        controlsHref={
          firstVisible?.kind === "message" ? firstVisible.href : undefined
        }
        links={messageCandidates}
        onAvailabilityChange={(href, available) => {
          const nextAvailability: MessageAvailability =
            available === null
              ? "pending"
              : available
                ? "available"
                : "unavailable";
          setAvailability((current) => {
            if (current.get(href) === nextAvailability) return current;
            const next = new Map(current);
            next.set(href, nextAvailability);
            return next;
          });
        }}
        onOpenMessageLink={onOpenMessageLink}
        onRemove={requestRemove}
        showControls={firstVisible?.kind === "message"}
        visibleHrefs={visibleMessageHrefs}
      />
      {onRemoveForEveryone ? (
        <AlertDialog onOpenChange={setDialogOpen} open={dialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {previewNoun}?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes{" "}
                {previewCount === 1 ? "the preview" : "the previews"} for
                everyone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <Button
                  onClick={() => {
                    setRemoved(true);
                    void onRemoveForEveryone().catch(() => setRemoved(false));
                  }}
                  type="button"
                  variant="destructive"
                >
                  Remove {previewNoun}
                </Button>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
