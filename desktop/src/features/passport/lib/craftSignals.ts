/**
 * Craft signal counting — turns the community's NIP-34 work items into the
 * per-pubkey engineering counts that feed `computeAgentBadges`. Shared by the
 * passport screen and the agent catalog so both surfaces read the exact same
 * record.
 */

import type { ProjectIssue } from "@/features/projects/projectIssues.mjs";
import type { ProjectPullRequest } from "@/features/projects/projectPullRequests.mjs";

export type CraftSignalCounts = {
  closedPrCount: number;
  issuesOpenedCount: number;
  mergedPrCount: number;
  repoCount: number;
  reviewCount: number;
};

type CraftWorkItems = {
  issues: { items: Array<{ project: { id: string }; issue: ProjectIssue }> };
  pullRequests: {
    items: Array<{ project: { id: string }; pullRequest: ProjectPullRequest }>;
  };
};

/** Count the pubkey's authored PRs, filed issues, reviews, and repo spread. */
export function countCraftSignals(
  workItems: CraftWorkItems | undefined,
  pubkeyLower: string | null,
): CraftSignalCounts {
  const counts: CraftSignalCounts = {
    closedPrCount: 0,
    issuesOpenedCount: 0,
    mergedPrCount: 0,
    repoCount: 0,
    reviewCount: 0,
  };
  if (!pubkeyLower || !workItems) {
    return counts;
  }
  const repos = new Set<string>();
  for (const { project, pullRequest } of workItems.pullRequests.items) {
    if (pullRequest.author.toLowerCase() === pubkeyLower) {
      repos.add(project.id);
      if (pullRequest.status === "Merged") {
        counts.mergedPrCount += 1;
      } else if (pullRequest.status === "Closed") {
        counts.closedPrCount += 1;
      }
      continue;
    }
    // Reviews only count on other authors' PRs, and only comments that carry
    // review weight (decisions and inline code comments).
    for (const comment of pullRequest.comments) {
      if (
        comment.author.toLowerCase() === pubkeyLower &&
        (comment.isApproval ||
          comment.isChangeRequest ||
          comment.isInlineComment)
      ) {
        counts.reviewCount += 1;
        repos.add(project.id);
      }
    }
  }
  for (const { issue, project } of workItems.issues.items) {
    if (issue.author.toLowerCase() === pubkeyLower) {
      counts.issuesOpenedCount += 1;
      repos.add(project.id);
    }
  }
  counts.repoCount = repos.size;
  return counts;
}
