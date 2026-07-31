import type { ResolvedLinkPreview } from "@/shared/lib/useResolvedLinkPreviews";
import { useLinkPreviewStyle } from "@/shared/lib/linkPreviewStylePreference";
import { CompactLinkPreviewAttachment } from "@/shared/ui/compact-link-preview-attachment";
import {
  type LinkPreviewImageLightboxComponent,
  RichLinkPreviewAttachment,
} from "@/shared/ui/rich-link-preview-attachment";

export function LinkPreviewAttachment({
  className,
  ImageLightbox,
  onRemove,
  preview,
  showControls,
}: {
  className?: string;
  ImageLightbox: LinkPreviewImageLightboxComponent;
  onRemove?: () => void;
  preview: ResolvedLinkPreview;
  showControls?: boolean;
}) {
  const style = useLinkPreviewStyle();
  if (style === "rich") {
    return (
      <RichLinkPreviewAttachment
        className={className}
        ImageLightbox={ImageLightbox}
        onRemove={onRemove}
        preview={preview}
        showControls={showControls}
      />
    );
  }

  return (
    <CompactLinkPreviewAttachment
      className={className}
      onRemove={onRemove}
      preview={preview}
      showControls={showControls}
    />
  );
}
