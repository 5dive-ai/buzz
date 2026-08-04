import type * as React from "react";
import { ArrowUpRight } from "lucide-react";

import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import type { UserNote } from "@/shared/api/socialTypes";
import type { UserProfileSummary } from "@/shared/api/types";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { cn } from "@/shared/lib/cn";

/** Format a date the way a passport stamp would: `12 MAR 2026`. */
export function formatStampDate(date: Date): string {
  return date
    .toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    })
    .toUpperCase();
}

// ── Section frame ────────────────────────────────────────────────────────────

export function RecordSection({
  children,
  label,
  trailing,
}: {
  children: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 className="shrink-0 text-2xs font-semibold tracking-[0.3em] text-muted-foreground uppercase">
          {label}
        </h2>
        <div className="h-px flex-1 bg-border/60" />
        {trailing ? (
          <span className="shrink-0 text-2xs text-muted-foreground">
            {trailing}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

// ── Stamps ───────────────────────────────────────────────────────────────────

// Passport-stamp "inks": rotate through the chart tokens so a page of stamps
// reads as collected over time rather than as a uniform list.
const STAMP_TONES = [
  "border-chart-1 text-chart-1",
  "border-chart-2 text-chart-2",
  "border-chart-3 text-chart-3",
  "border-chart-4 text-chart-4",
  "border-chart-5 text-chart-5",
] as const;

const STAMP_ROTATIONS = [
  "-rotate-2",
  "rotate-1",
  "rotate-2",
  "-rotate-1",
  "rotate-0",
] as const;

export function PassportStamp({
  index,
  muted = false,
  onClick,
  subtitle,
  testId,
  title,
}: {
  /** Position in the stamp page — picks a stable ink color and tilt. */
  index: number;
  /** Faded, dashed rendering for expired visas (servers since departed). */
  muted?: boolean;
  onClick?: () => void;
  subtitle?: string | null;
  testId?: string;
  title: string;
}) {
  const tone = STAMP_TONES[index % STAMP_TONES.length];
  const rotation = STAMP_ROTATIONS[index % STAMP_ROTATIONS.length];
  const Element = onClick ? "button" : "div";

  return (
    <Element
      className={cn(
        "group inline-flex max-w-56 min-w-0 flex-col items-start rounded-xl border-2 px-3.5 py-2 text-left opacity-90 saturate-[0.85] transition-transform",
        tone,
        rotation,
        muted && "border-dashed opacity-45 saturate-50",
        onClick &&
          "cursor-pointer hover:rotate-0 hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
      )}
      data-testid={testId}
      onClick={onClick}
      type={onClick ? "button" : undefined}
    >
      <span className="flex w-full min-w-0 items-center gap-1 text-xs font-bold tracking-[0.15em] uppercase">
        <span className="min-w-0 truncate">{title}</span>
        {onClick ? (
          <ArrowUpRight
            aria-hidden="true"
            className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          />
        ) : null}
      </span>
      {subtitle ? (
        <span className="w-full min-w-0 truncate text-3xs font-medium tracking-[0.2em] uppercase opacity-80">
          {subtitle}
        </span>
      ) : null}
    </Element>
  );
}

export function StampPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-3.5 py-1">{children}</div>
  );
}

// ── Notes ledger ─────────────────────────────────────────────────────────────

export function NoteRecordList({ notes }: { notes: UserNote[] }) {
  return (
    <ul className="flex flex-col" data-testid="passport-notes">
      {notes.map((note) => (
        <li
          className="flex min-w-0 items-baseline gap-4 border-b border-dashed border-border/60 py-2.5 last:border-b-0"
          key={note.id}
        >
          <span className="shrink-0 font-mono text-2xs text-muted-foreground">
            {formatStampDate(new Date(note.createdAt * 1_000))}
          </span>
          <p className="min-w-0 flex-1 truncate text-sm text-foreground/90">
            {note.content}
          </p>
        </li>
      ))}
    </ul>
  );
}

// ── Following strip ──────────────────────────────────────────────────────────

export function FollowingStrip({
  contactPubkeys,
  profiles,
}: {
  contactPubkeys: string[];
  profiles: Record<string, UserProfileSummary>;
}) {
  const shown = contactPubkeys.slice(0, 12);

  return (
    <div className="flex items-center gap-3" data-testid="passport-following">
      <div className="flex -space-x-2">
        {shown.map((contactPubkey) => {
          const profile = profiles[contactPubkey.toLowerCase()];
          const label =
            profile?.displayName ??
            profile?.name ??
            truncatePubkey(contactPubkey);
          return (
            <ProfileAvatar
              avatarUrl={profile?.avatarUrl ?? null}
              className="h-8 w-8 border-2 border-background text-xs"
              iconClassName="h-3.5 w-3.5"
              key={contactPubkey}
              label={label}
            />
          );
        })}
      </div>
      {contactPubkeys.length > shown.length ? (
        <span className="text-xs text-muted-foreground">
          +{contactPubkeys.length - shown.length} more
        </span>
      ) : null}
    </div>
  );
}

// ── Empty record ─────────────────────────────────────────────────────────────

export function EmptyRecord({ displayName }: { displayName: string }) {
  return (
    <div
      className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 px-6 py-10 text-center"
      data-testid="passport-empty-record"
    >
      <p className="text-sm font-medium">No record on this community yet</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Stamps appear here as {displayName} joins channels, posts notes, and
        travels between communities.
      </p>
    </div>
  );
}
