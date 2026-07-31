import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";

import type { ResolvedLinkPreview } from "@/shared/lib/useResolvedLinkPreviews";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

function LinkPreviewIdentity({ preview }: { preview: ResolvedLinkPreview }) {
  if (preview.faviconDataUrl) {
    return (
      <img
        alt=""
        aria-hidden="true"
        className="size-4 rounded-sm object-contain"
        data-link-preview-favicon=""
        src={preview.faviconDataUrl}
      />
    );
  }
  return null;
}

function getHostname(preview: ResolvedLinkPreview): string {
  try {
    return new URL(preview.href).hostname.replace(/^www\./, "");
  } catch {
    return preview.provider;
  }
}

function isTweetPreview(preview: ResolvedLinkPreview): boolean {
  try {
    const url = new URL(preview.href);
    return (
      (url.hostname === "x.com" || url.hostname === "twitter.com") &&
      /^\/[^/]+\/status\/\d+/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function TweetPreview({
  className,
  onRemove,
  preview,
}: {
  className?: string;
  onRemove?: () => void;
  preview: ResolvedLinkPreview;
}) {
  const [contentExpanded, setContentExpanded] = useState(true);
  const reserveImage = preview.imageState !== "none";
  const showImage = preview.imageState === "image";
  const hasExpandableContent = Boolean(preview.description) || reserveImage;
  const hostname = getHostname(preview);

  return (
    <div
      className={cn(
        "relative w-lg max-w-full shrink-0 border-l-[3px] border-border py-1 pl-3",
        className,
      )}
      data-image-state={preview.imageState}
      data-link-preview={preview.kind}
      data-tweet-preview=""
    >
      <div
        className="text-xs leading-4 text-muted-foreground"
        data-link-preview-hostname=""
      >
        {hostname}
      </div>
      <a
        className="mt-0.5 line-clamp-2 whitespace-normal text-sm font-semibold leading-5 text-foreground hover:underline"
        href={preview.href}
        rel="noreferrer"
        target="_blank"
      >
        {preview.title}
      </a>
      {contentExpanded && preview.description ? (
        <div
          className="mt-1 whitespace-normal text-sm leading-5 text-foreground"
          data-slot="attachment-description"
        >
          {preview.description}
        </div>
      ) : null}
      {contentExpanded && reserveImage ? (
        <a
          aria-label={`Open tweet: ${preview.title}`}
          className="mt-2 block w-full max-w-75 overflow-hidden rounded-xl bg-muted"
          href={preview.href}
          rel="noreferrer"
          target="_blank"
        >
          <div className="aspect-video w-full" data-link-preview-thumbnail="">
            {showImage ? (
              <img
                alt={`Preview from ${preview.imageDomain}`}
                className="h-full w-full object-cover"
                src={preview.imageDataUrl ?? undefined}
              />
            ) : (
              <div
                className="h-full w-full animate-pulse bg-muted-foreground/10"
                data-link-preview-skeleton=""
              />
            )}
          </div>
        </a>
      ) : null}
      {hasExpandableContent ? (
        <button
          aria-expanded={contentExpanded}
          className="mt-1 flex items-center gap-1 text-xs leading-4 text-muted-foreground hover:text-foreground"
          onClick={() => setContentExpanded((expanded) => !expanded)}
          type="button"
        >
          {contentExpanded ? (
            <ChevronUp aria-hidden="true" className="size-3" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-3" />
          )}
          {contentExpanded ? "Show less" : "Show more"}
        </button>
      ) : null}
      {onRemove ? (
        <Button
          aria-label="Remove previews for everyone"
          className="absolute left-full top-0 z-20 ml-1 h-5 w-5 rounded-full text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/message:opacity-100"
          onClick={onRemove}
          size="icon-xs"
          title="Remove previews for everyone"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

export function RichLinkPreviewAttachment({
  className,
  onRemove,
  preview,
}: {
  className?: string;
  onRemove?: () => void;
  preview: ResolvedLinkPreview;
}) {
  const [contentExpanded, setContentExpanded] = useState(true);

  if (isTweetPreview(preview)) {
    return (
      <TweetPreview
        className={className}
        onRemove={onRemove}
        preview={preview}
      />
    );
  }

  const reserveImage = preview.imageState !== "none";
  const showImage = preview.imageState === "image";
  const hasExpandableContent = Boolean(preview.description) || reserveImage;
  const hostname = getHostname(preview);

  return (
    <div
      className={cn(
        "relative w-lg max-w-full shrink-0 border-l-[3px] border-border py-1 pl-3",
        className,
      )}
      data-image-state={preview.imageState}
      data-link-preview={preview.kind}
      data-link-preview-inline=""
    >
      <div
        className={cn(contentExpanded && reserveImage && "min-h-[3.875rem]")}
      >
        <div
          className="flex items-center gap-1.5 text-xs leading-4 text-muted-foreground"
          data-link-preview-identity=""
        >
          <LinkPreviewIdentity preview={preview} />
          <span data-link-preview-hostname="">{hostname}</span>
        </div>
        <a
          aria-label={`Open ${preview.provider} ${preview.typeLabel}: ${preview.title}`}
          className="mt-0.5 block text-sm font-semibold leading-5 text-foreground hover:underline"
          href={preview.href}
          rel="noreferrer"
          target="_blank"
        >
          <span className="line-clamp-2">{preview.title}</span>
        </a>
        {contentExpanded && preview.description ? (
          <div
            className="mt-1 whitespace-normal text-sm leading-5 text-muted-foreground"
            data-slot="attachment-description"
          >
            {preview.description}
          </div>
        ) : null}
      </div>
      {contentExpanded && reserveImage ? (
        <a
          aria-label={`Open preview image from ${hostname}`}
          className="mt-2 block w-full max-w-75 overflow-hidden rounded-xl bg-muted"
          href={preview.href}
          rel="noreferrer"
          target="_blank"
        >
          <div
            className="aspect-[1.91/1] w-full"
            data-link-preview-thumbnail=""
          >
            {showImage ? (
              <img
                alt={`Preview from ${preview.imageDomain}`}
                className="h-full w-full object-cover"
                src={preview.imageDataUrl ?? undefined}
              />
            ) : (
              <div
                className="h-full w-full animate-pulse bg-muted-foreground/10"
                data-link-preview-skeleton=""
              />
            )}
          </div>
        </a>
      ) : null}
      {hasExpandableContent ? (
        <button
          aria-expanded={contentExpanded}
          className="mt-1 flex items-center gap-1 text-xs leading-4 text-muted-foreground hover:text-foreground"
          onClick={() => setContentExpanded((expanded) => !expanded)}
          type="button"
        >
          {contentExpanded ? (
            <ChevronUp aria-hidden="true" className="size-3" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-3" />
          )}
          {contentExpanded ? "Show less" : "Show more"}
        </button>
      ) : null}
      {onRemove ? (
        <Button
          aria-label="Remove previews for everyone"
          className="absolute left-full top-0 z-20 ml-1 h-5 w-5 rounded-full text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/message:opacity-100"
          onClick={onRemove}
          size="icon-xs"
          title="Remove previews for everyone"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
