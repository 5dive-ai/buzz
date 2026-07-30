import type { ResolvedLinkPreview } from "@/shared/lib/useResolvedLinkPreviews";
import { useLinkPreviewStyle } from "@/shared/lib/linkPreviewStylePreference";
import { CompactLinkPreviewAttachment } from "@/shared/ui/compact-link-preview-attachment";
import { RichLinkPreviewAttachment } from "@/shared/ui/rich-link-preview-attachment";

export function LinkPreviewAttachment({
  className,
  onRemove,
  preview,
}: {
  className?: string;
  onRemove?: () => void;
  preview: ResolvedLinkPreview;
}) {
  const style = useLinkPreviewStyle();
  const Preview =
    style === "rich" ? RichLinkPreviewAttachment : CompactLinkPreviewAttachment;

  return (
    <Preview className={className} onRemove={onRemove} preview={preview} />
  );
}
