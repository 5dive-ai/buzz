import { buildPassportMrz } from "@/features/profile/lib/passportMrz";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { safeNpub } from "@/shared/lib/nostrUtils";
import { cn } from "@/shared/lib/cn";
import { StyledQrCode } from "@/shared/ui/styled-qr-code";

export type PassportCardProps = {
  avatarUrl: string | null;
  className?: string;
  /** Issuing community name — the server this identity is currently visiting. */
  communityName: string | null;
  displayName: string;
  /** NIP-05 handle, when the profile has one. */
  handle: string | null;
  isAgent: boolean;
  /** Owner handle for agent passports (the human the agent acts for). */
  operatorName: string | null;
  pubkey: string;
};

/**
 * The Buzz Passport — a portable identity card for a person or agent.
 *
 * One mental model: your keypair IS your passport. It travels with you to
 * other communities, and your agents carry passports of their own that name
 * you as operator. The card renders that idea literally: photo, holder
 * fields, an issuing community, a scannable key, and a machine-readable zone
 * carrying the full npub (never truncated — this is a trust surface).
 *
 * Visual language stays on Buzz basics: Catppuccin semantic tokens, stock
 * rem type ramp, rounded-2xl card geometry shared with the identity cards.
 */
export function PassportCard({
  avatarUrl,
  className,
  communityName,
  displayName,
  handle,
  isAgent,
  operatorName,
  pubkey,
}: PassportCardProps) {
  const npub = safeNpub(pubkey) ?? pubkey;
  const mrzLines = buildPassportMrz({ displayName, isAgent, npub });

  return (
    <div
      className={cn(
        "group relative w-[22rem] max-w-full overflow-hidden rounded-3xl border border-border/70 bg-card text-card-foreground shadow-2xl",
        className,
      )}
      data-testid="passport-card"
    >
      {/* Tinted wash + top highlight, both from semantic tokens so the card
          adapts to Latte/Macchiato without theme-specific branches. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/15 via-transparent to-primary/10" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-background/50 to-transparent" />
      <GuillochePattern />
      {/* Holographic glint that sweeps across on hover. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 -left-full w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-primary/20 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-[300%] motion-reduce:hidden"
      />

      <div className="relative flex flex-col gap-5 p-6">
        <header className="flex items-baseline justify-between gap-3">
          <span className="text-2xs font-semibold tracking-[0.35em] text-muted-foreground">
            BUZZ&thinsp;·&thinsp;PASSPORT
          </span>
          <span
            className="rounded-full border border-primary/40 px-2 py-0.5 text-3xs font-semibold tracking-[0.2em] text-primary"
            data-testid="passport-holder-kind"
          >
            {isAgent ? "AGENT" : "HUMAN"}
          </span>
        </header>

        <div className="flex gap-5">
          <ProfileAvatar
            avatarUrl={avatarUrl}
            className="h-28 w-28 rounded-2xl border border-border/60 text-2xl shadow-none"
            iconClassName="h-10 w-10"
            imageClassName="rounded-2xl"
            label={displayName}
            testId="passport-photo"
          />

          <dl className="flex min-w-0 flex-1 flex-col justify-between gap-2 py-0.5">
            <PassportField label="Name" testId="passport-name">
              <span className="text-base font-semibold tracking-tight text-foreground">
                {displayName}
              </span>
            </PassportField>
            {handle ? (
              <PassportField label="Handle" testId="passport-handle">
                {handle}
              </PassportField>
            ) : null}
            {isAgent && operatorName ? (
              <PassportField label="Operator" testId="passport-operator">
                {operatorName}
              </PassportField>
            ) : null}
            <PassportField label="Community" testId="passport-community">
              {communityName ?? "—"}
            </PassportField>
          </dl>
        </div>

        <div className="flex items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-3xs font-medium tracking-[0.25em] text-muted-foreground uppercase">
              Identity key
            </span>
            <p className="text-xs leading-relaxed text-muted-foreground">
              This key is {isAgent ? "this agent's" : "your"} passport — it
              travels to every community and conversation.
            </p>
          </div>
          <div className="shrink-0 rounded-xl border border-border/60 bg-background/60 p-1.5">
            <StyledQrCode
              backgroundColor="transparent"
              foregroundColor="hsl(var(--foreground))"
              size={84}
              title={`${displayName} identity key QR code`}
              value={npub}
            />
          </div>
        </div>
      </div>

      {/* Machine-readable zone — carries the FULL npub (uppercased bech32
          stays decodable), so the passport never truncates the identity. */}
      <div
        className="relative border-t border-border/60 bg-background/70 px-6 py-4 font-mono text-2xs leading-relaxed tracking-normal text-foreground/80"
        data-testid="passport-mrz"
      >
        {mrzLines.map((line) => (
          <div className="truncate whitespace-pre" key={line}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function PassportField({
  children,
  label,
  testId,
}: {
  children: React.ReactNode;
  label: string;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-3xs font-medium tracking-[0.25em] text-muted-foreground uppercase">
        {label}
      </dt>
      <dd
        className="truncate text-sm font-medium text-foreground/90"
        data-testid={testId}
      >
        {children}
      </dd>
    </div>
  );
}

type GuillocheEllipse = {
  cx: number;
  cy: number;
  rotate: number;
  rx: number;
  ry: number;
};

function guillocheBand({
  count,
  start,
  step,
}: {
  count: number;
  start: GuillocheEllipse;
  step: GuillocheEllipse;
}): GuillocheEllipse[] {
  return Array.from({ length: count }, (_, index) => ({
    cx: start.cx + step.cx * index,
    cy: start.cy + step.cy * index,
    rotate: start.rotate + step.rotate * index,
    rx: start.rx + step.rx * index,
    ry: start.ry + step.ry * index,
  }));
}

const GUILLOCHE_BANDS: GuillocheEllipse[][] = [
  guillocheBand({
    count: 9,
    start: { cx: 300, cy: 60, rotate: -18, rx: 190, ry: 70 },
    step: { cx: -6, cy: 10, rotate: 4, rx: 18, ry: 9 },
  }),
  guillocheBand({
    count: 9,
    start: { cx: 40, cy: 400, rotate: 16, rx: 170, ry: 60 },
    step: { cx: 5, cy: -8, rotate: -3, rx: 16, ry: 8 },
  }),
];

/**
 * Faint guilloché-style security lines, like the engraved curves on a real
 * passport data page. Pure decoration (`aria-hidden`), drawn in the primary
 * token at very low opacity.
 */
function GuillochePattern() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full text-primary opacity-[0.07]"
      fill="none"
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 352 440"
    >
      {GUILLOCHE_BANDS.flat().map((ellipse) => (
        <ellipse
          cx={ellipse.cx}
          cy={ellipse.cy}
          key={`${ellipse.cx}-${ellipse.cy}-${ellipse.rx}`}
          rx={ellipse.rx}
          ry={ellipse.ry}
          stroke="currentColor"
          strokeWidth="0.75"
          transform={`rotate(${ellipse.rotate} ${ellipse.cx} ${ellipse.cy})`}
        />
      ))}
    </svg>
  );
}
