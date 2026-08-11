import type { MessageEmbedLink } from "@/features/messages/lib/messageEmbed";
import type { ParsedMessageLink } from "@/features/messages/lib/messageLink";
import type { Channel } from "@/shared/api/types";
import { AttachmentGroup } from "@/shared/ui/attachment";
import { LinkPreviewControls } from "@/shared/ui/link-preview-controls";

import { MessageEmbed } from "./MessageEmbed";

export function MessageEmbedList({
  channels,
  links,
  onAvailabilityChange,
  onOpenMessageLink,
  onRemove,
  controlsHref,
  showControls,
  visibleHrefs,
}: {
  channels: Channel[];
  links: MessageEmbedLink[];
  onAvailabilityChange: (href: string, available: boolean | null) => void;
  onOpenMessageLink: (link: ParsedMessageLink) => void;
  onRemove?: () => void;
  controlsHref?: string;
  showControls: boolean;
  visibleHrefs: ReadonlySet<string>;
}) {
  if (links.length === 0) return null;

  return (
    <AttachmentGroup
      className="w-full max-w-2xl flex-col items-stretch overflow-visible pb-0"
      data-message-embed-list=""
    >
      {links.map((link) => (
        <div className="relative" key={link.href}>
          {showControls && link.href === controlsHref ? (
            <LinkPreviewControls onRemove={onRemove} placement="left" />
          ) : null}
          <MessageEmbed
            channel={channels.find((channel) => channel.id === link.channelId)}
            link={link}
            onAvailabilityChange={(available) =>
              onAvailabilityChange(link.href, available)
            }
            onOpen={() => onOpenMessageLink(link)}
            visible={visibleHrefs.has(link.href)}
          />
        </div>
      ))}
    </AttachmentGroup>
  );
}
