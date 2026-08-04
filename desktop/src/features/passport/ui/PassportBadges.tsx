import {
  Activity,
  BadgeCheck,
  Brain,
  Feather,
  Heart,
  type LucideIcon,
  Medal,
  Moon,
  Network,
  ScrollText,
  ShieldCheck,
  Sunrise,
} from "lucide-react";

import type { BadgeKind, PassportBadge } from "@/features/passport/lib/badges";
import { cn } from "@/shared/lib/cn";

const BADGE_ICONS: Record<string, LucideIcon> = {
  "early-bird": Sunrise,
  "elephant-memory": Brain,
  "full-papers": ScrollText,
  liked: Heart,
  "night-hawk": Moon,
  "on-duty": Activity,
  "registered-operator": ShieldCheck,
  scribe: Feather,
  tenure: Medal,
  "verified-handle": BadgeCheck,
  "well-connected": Network,
};

const KIND_TONES: Record<BadgeKind, string> = {
  activity: "border-chart-3/60 text-chart-3",
  flair: "border-chart-4/60 text-chart-4",
  tenure: "border-chart-5/60 text-chart-5",
  trust: "border-primary/60 text-primary",
};

/**
 * Commendations pinned under the passport: each medallion is an icon in a
 * double ring, with the badge name and the verifiable fact it reflects. Tier
 * pips show progression within a badge family.
 */
export function PassportBadgeList({ badges }: { badges: PassportBadge[] }) {
  return (
    <ul
      className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2"
      data-testid="passport-badges"
    >
      {badges.map((badge) => {
        const Icon = BADGE_ICONS[badge.id] ?? Medal;
        return (
          <li
            className="flex min-w-0 items-center gap-3"
            data-testid={`passport-badge-${badge.id}`}
            key={badge.id}
          >
            <span
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 bg-muted/40 shadow-xs ring-2 ring-border/40 ring-offset-2 ring-offset-background",
                KIND_TONES[badge.kind],
              )}
            >
              <Icon aria-hidden="true" className="h-5 w-5" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <span className="truncate">{badge.name}</span>
                {badge.tier ? <TierPips tier={badge.tier} /> : null}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {badge.description}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function TierPips({ tier }: { tier: 1 | 2 | 3 }) {
  return (
    <span
      aria-label={`Tier ${tier} of 3`}
      className="flex shrink-0 items-center gap-0.5"
      role="img"
    >
      {[1, 2, 3].map((pip) => (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            pip <= tier ? "bg-current opacity-80" : "bg-border",
          )}
          key={pip}
        />
      ))}
    </span>
  );
}
