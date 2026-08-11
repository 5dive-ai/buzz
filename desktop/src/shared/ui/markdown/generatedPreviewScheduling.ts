import {
  MAX_VISIBLE_GENERATED_PREVIEWS,
  type GeneratedPreviewCandidate,
} from "@/shared/lib/linkPreview";
import type { ResolvedLinkPreview } from "@/shared/lib/useResolvedLinkPreviews";

export type MessageAvailability = "pending" | "available" | "unavailable";

/** Pending messages remain attempts, but do not reserve visible slots or controls. */
export function scheduleGeneratedPreviews(
  candidates: GeneratedPreviewCandidate[],
  previewsByHref: ReadonlyMap<string, ResolvedLinkPreview>,
  availability: ReadonlyMap<string, MessageAvailability>,
): {
  attemptedMessageHrefs: ReadonlySet<string>;
  visibleCandidates: GeneratedPreviewCandidate[];
} {
  const attemptedMessageHrefs = new Set<string>();
  const visibleCandidates: GeneratedPreviewCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.kind === "message") {
      attemptedMessageHrefs.add(candidate.href);
      if (availability.get(candidate.href) === "available") {
        visibleCandidates.push(candidate);
      }
    } else if (previewsByHref.has(candidate.preview.href)) {
      visibleCandidates.push(candidate);
    }

    if (visibleCandidates.length === MAX_VISIBLE_GENERATED_PREVIEWS) break;
  }

  return { attemptedMessageHrefs, visibleCandidates };
}
