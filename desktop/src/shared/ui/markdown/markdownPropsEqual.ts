import { shallowArrayEqual, shallowRecordEqual } from "../markdownUtils";
import type { MarkdownProps } from "./types";

function shallowTagsEqual(
  a?: readonly (readonly string[])[],
  b?: readonly (readonly string[])[],
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every(
    (tag, index) =>
      tag.length === b[index]?.length &&
      tag.every((value, valueIndex) => value === b[index]?.[valueIndex]),
  );
}

export function markdownPropsEqual(prev: MarkdownProps, next: MarkdownProps) {
  return (
    prev.content === next.content &&
    prev.className === next.className &&
    prev.customEmoji === next.customEmoji &&
    prev.interactive === next.interactive &&
    prev.mediaInset === next.mediaInset &&
    shallowRecordEqual(
      prev.agentMentionPubkeysByName,
      next.agentMentionPubkeysByName,
    ) &&
    shallowRecordEqual(prev.mentionPubkeysByName, next.mentionPubkeysByName) &&
    shallowArrayEqual(prev.mentionNames, next.mentionNames) &&
    shallowArrayEqual(prev.channelNames, next.channelNames) &&
    prev.imetaByUrl === next.imetaByUrl &&
    prev.configNudgeAuthorPubkey === next.configNudgeAuthorPubkey &&
    prev.searchQuery === next.searchQuery &&
    prev.snapshotSharedBy === next.snapshotSharedBy &&
    prev.videoReviewContext === next.videoReviewContext &&
    prev.linkPreviewsSuppressed === next.linkPreviewsSuppressed &&
    shallowTagsEqual(prev.linkPreviewTags, next.linkPreviewTags) &&
    prev.onRemoveLinkPreviewsForEveryone ===
      next.onRemoveLinkPreviewsForEveryone &&
    prev.messageId === next.messageId
  );
}
