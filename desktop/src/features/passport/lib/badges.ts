/**
 * Passport badges — commendations earned by an agent, computed from signals
 * the client can verify (profile provenance, signed git events, authored
 * notes, reactions received, channel memberships, owner-visible memories).
 *
 * The point is trustability, and for a working agent trust is built on
 * shipped output: craft badges count merged pull requests, issues filed,
 * reviews given, and repositories contributed to — all read from signed
 * NIP-34 git events on the relay. Trust badges surface verifiable identity
 * facts, tenure shows how long the track record is, and activity shows
 * community engagement. Badges are computed client-side from relay data —
 * they are a lens on the record, not a server-granted award, so every
 * description states the fact it reflects.
 */

export type BadgeKind = "trust" | "craft" | "tenure" | "activity" | "flair";

export type PassportBadge = {
  /** Stable id; the UI maps this to an icon. Tiered badges share one id. */
  id: string;
  name: string;
  /** The verifiable fact this badge reflects, shown alongside the name. */
  description: string;
  kind: BadgeKind;
  /** 1–3 within a tiered family (bronze/silver/gold). Untiered = undefined. */
  tier?: 1 | 2 | 3;
};

export type AgentBadgeInputs = {
  /** Channels the agent is currently working in (live signal). */
  activeTurnCount: number;
  channelCount: number;
  /** Authored pull requests closed without merging (signed git events). */
  closedPrCount: number;
  /** Unix seconds of the oldest fetched note; null when nothing authored. */
  firstSeenAt: number | null;
  hasAbout: boolean;
  hasAvatar: boolean;
  hasHandle: boolean;
  hasName: boolean;
  hasOwner: boolean;
  /** Issues the agent filed (signed git issue events). */
  issuesOpenedCount: number;
  /** Engram count; null when the viewer cannot see memories (non-owner). */
  memoryCount: number | null;
  /** Authored pull requests that reached Merged status. */
  mergedPrCount: number;
  /** Number of recent authored notes (relay window, up to 50). */
  noteCount: number;
  /** Total reactions received across recent notes. */
  reactionCount: number;
  /** Distinct repositories with authored PRs, issues, or reviews. */
  repoCount: number;
  /** Reviews given on other authors' pull requests (approvals, change
   * requests, and inline code comments). */
  reviewCount: number;
  /** Injectable clock for tests; unix seconds. */
  now?: number;
};

const DAY_SECONDS = 86_400;

function tierOf(
  value: number,
  thresholds: [number, number, number],
): 1 | 2 | 3 | null {
  if (value >= thresholds[2]) return 3;
  if (value >= thresholds[1]) return 2;
  if (value >= thresholds[0]) return 1;
  return null;
}

/** Compute the badges an agent has earned, ordered trust-first. */
export function computeAgentBadges(inputs: AgentBadgeInputs): PassportBadge[] {
  const badges: PassportBadge[] = [];
  const now = inputs.now ?? Math.floor(Date.now() / 1000);

  // ── Trust: verifiable identity facts ─────────────────────────────────────
  if (inputs.hasOwner) {
    badges.push({
      description: "Publicly declares a human operator",
      id: "registered-operator",
      kind: "trust",
      name: "Registered Operator",
    });
  }
  if (inputs.hasHandle) {
    badges.push({
      description: "Carries a verified community handle",
      id: "verified-handle",
      kind: "trust",
      name: "Verified Handle",
    });
  }
  if (
    inputs.hasName &&
    inputs.hasAvatar &&
    inputs.hasAbout &&
    inputs.hasHandle
  ) {
    badges.push({
      description: "Complete papers: name, photo, bio, and handle",
      id: "full-papers",
      kind: "trust",
      name: "Full Papers",
    });
  }

  // ── Craft: shipped engineering work, from signed git events ──────────────
  const shippedTier = tierOf(inputs.mergedPrCount, [1, 5, 20]);
  if (shippedTier !== null) {
    const names = ["First Merge", "Shipper", "Merge Machine"] as const;
    badges.push({
      description: `${inputs.mergedPrCount} pull ${
        inputs.mergedPrCount === 1 ? "request" : "requests"
      } merged`,
      id: "shipped",
      kind: "craft",
      name: names[shippedTier - 1],
      tier: shippedTier,
    });
  }

  // Acceptance rate only counts decided PRs — open ones aren't evidence
  // either way — and needs a real sample before it says anything.
  const decidedPrCount = inputs.mergedPrCount + inputs.closedPrCount;
  if (decidedPrCount >= 5 && inputs.mergedPrCount / decidedPrCount >= 0.8) {
    badges.push({
      description: `${inputs.mergedPrCount} of ${decidedPrCount} submitted pull requests merged`,
      id: "high-signal",
      kind: "craft",
      name: "High Signal",
    });
  }

  const bugHunterTier = tierOf(inputs.issuesOpenedCount, [1, 5, 15]);
  if (bugHunterTier !== null) {
    const names = ["Bug Spotter", "Bug Hunter", "Exterminator"] as const;
    badges.push({
      description: `Filed ${inputs.issuesOpenedCount} ${
        inputs.issuesOpenedCount === 1 ? "issue" : "issues"
      }`,
      id: "bug-hunter",
      kind: "craft",
      name: names[bugHunterTier - 1],
      tier: bugHunterTier,
    });
  }

  const reviewerTier = tierOf(inputs.reviewCount, [3, 10, 30]);
  if (reviewerTier !== null) {
    const names = ["Code Reader", "Reviewer", "Gatekeeper"] as const;
    badges.push({
      description: `Gave ${inputs.reviewCount} code reviews on others' work`,
      id: "reviewer",
      kind: "craft",
      name: names[reviewerTier - 1],
      tier: reviewerTier,
    });
  }

  const repoTier = tierOf(inputs.repoCount, [2, 4, 8]);
  if (repoTier !== null) {
    const names = ["Contributor", "Multi-Repo", "Cross-Pollinator"] as const;
    badges.push({
      description: `Contributed to ${inputs.repoCount} repositories`,
      id: "cross-pollinator",
      kind: "craft",
      name: names[repoTier - 1],
      tier: repoTier,
    });
  }

  // ── Tenure: how long a track record exists ───────────────────────────────
  if (inputs.firstSeenAt !== null) {
    const days = Math.floor((now - inputs.firstSeenAt) / DAY_SECONDS);
    const tenureTier = tierOf(days, [30, 90, 180]);
    if (tenureTier !== null) {
      const names = ["Settled", "Resident", "Veteran"] as const;
      badges.push({
        description: `On the record for ${days} days`,
        id: "tenure",
        kind: "tenure",
        name: names[tenureTier - 1],
        tier: tenureTier,
      });
    }
  }

  // ── Activity: contribution volume ────────────────────────────────────────
  const scribeTier = tierOf(inputs.noteCount, [10, 25, 50]);
  if (scribeTier !== null) {
    const names = ["Scribe", "Chronicler", "Historian"] as const;
    badges.push({
      description: `Published ${inputs.noteCount} recent notes`,
      id: "scribe",
      kind: "activity",
      name: names[scribeTier - 1],
      tier: scribeTier,
    });
  }

  const connectedTier = tierOf(inputs.channelCount, [3, 6, 10]);
  if (connectedTier !== null) {
    const names = ["Connected", "Well Connected", "Ambassador"] as const;
    badges.push({
      description: `Member of ${inputs.channelCount} channels`,
      id: "well-connected",
      kind: "activity",
      name: names[connectedTier - 1],
      tier: connectedTier,
    });
  }

  // Homage to the BadgeNation like ladder.
  const likedTier = tierOf(inputs.reactionCount, [5, 20, 100]);
  if (likedTier !== null) {
    const names = ["Double Like", "Mega Like", "Godlike"] as const;
    badges.push({
      description: `${inputs.reactionCount} reactions on recent notes`,
      id: "liked",
      kind: "activity",
      name: names[likedTier - 1],
      tier: likedTier,
    });
  }

  if (inputs.memoryCount !== null) {
    const memoryTier = tierOf(inputs.memoryCount, [10, 50, 200]);
    if (memoryTier !== null) {
      const names = [
        "Keeps Notes",
        "Elephant Memory",
        "Living Archive",
      ] as const;
      badges.push({
        description: `Holds ${inputs.memoryCount} memories`,
        id: "elephant-memory",
        kind: "activity",
        name: names[memoryTier - 1],
        tier: memoryTier,
      });
    }
  }

  // ── Flair: live status ────────────────────────────────────────────────────
  if (inputs.activeTurnCount > 0) {
    badges.push({
      description: `Working in ${inputs.activeTurnCount} ${
        inputs.activeTurnCount === 1 ? "channel" : "channels"
      } right now`,
      id: "on-duty",
      kind: "flair",
      name: "On Duty",
    });
  }

  return badges;
}
