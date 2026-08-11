import { useLinkPreviewStyle } from "@/shared/lib/linkPreviewStylePreference";
import type { ResolvedLinkPreview } from "@/shared/lib/useResolvedLinkPreviews";
import { AttachmentGroup } from "@/shared/ui/attachment";
import { LinkPreviewAttachment } from "@/shared/ui/link-preview-attachment";
import type { LinkPreviewImageLightboxComponent } from "@/shared/ui/rich-link-preview-attachment";

export function LinkPreviewList({
  ImageLightbox,
  onOpenByHref,
  onRemove,
  previews,
  showControls = false,
}: {
  ImageLightbox: LinkPreviewImageLightboxComponent;
  onOpenByHref?: ReadonlyMap<string, () => void>;
  onRemove?: () => void;
  previews: ResolvedLinkPreview[];
  showControls?: boolean;
}) {
  const style = useLinkPreviewStyle();
  if (previews.length === 0) return null;

  return (
    <AttachmentGroup
      className={
        style === "compact"
          ? "max-w-full flex-row flex-wrap items-start overflow-visible pb-0"
          : "max-w-full flex-col items-start overflow-visible pb-0"
      }
      data-link-preview-list=""
    >
      {previews.map((preview, index) => (
        <LinkPreviewAttachment
          key={preview.href}
          ImageLightbox={ImageLightbox}
          onOpen={onOpenByHref?.get(preview.href)}
          onRemove={showControls && index === 0 ? onRemove : undefined}
          preview={preview}
          showControls={showControls && index === 0}
        />
      ))}
    </AttachmentGroup>
  );
}
