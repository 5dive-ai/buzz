import type { Channel, RelayEvent } from "@/shared/api/types";
import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_V2,
} from "@/shared/constants/kinds";
import type { MessagePreviewCandidate } from "@/shared/lib/linkPreview";

import type { ParsedMessageLink } from "./messageLink";

export type MessageEmbedLink = MessagePreviewCandidate;

export function canReadMessageEmbedSource(
  channel: Pick<Channel, "isMember" | "visibility"> | undefined,
): boolean {
  return (
    channel !== undefined && (channel.isMember || channel.visibility === "open")
  );
}

/** Only user-authored timeline prose is eligible for a quoted-message card. */
export function isEmbeddableMessageEvent(event: RelayEvent): boolean {
  return (
    event.kind === KIND_STREAM_MESSAGE ||
    event.kind === KIND_STREAM_MESSAGE_V2 ||
    event.kind === KIND_STREAM_MESSAGE_DIFF
  );
}

export function isMatchingMessageEmbedEvent(
  event: RelayEvent,
  link: ParsedMessageLink,
): boolean {
  const eventChannelId = event.tags.find((tag) => tag[0] === "h")?.[1];
  return (
    event.id === link.messageId &&
    eventChannelId === link.channelId &&
    isEmbeddableMessageEvent(event)
  );
}

export function messageEmbedExcerpt(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}
