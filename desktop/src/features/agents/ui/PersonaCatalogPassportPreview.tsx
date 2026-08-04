import { CopyPlus, Globe, Users } from "lucide-react";

/**
 * SAMPLE-DATA preview of the cross-network passport signals we cannot read
 * from a single relay yet: which other servers run this persona, how many
 * times it has been duplicated network-wide, and how many operators use it.
 * See BADGES.md § "Wants relay support first" for what the real signals need
 * (adoption event kind, portable attestations or a relay directory).
 *
 * Rendered only in dev and e2e builds, and visually labelled as sample data,
 * so the mock numbers can never be mistaken for a real record. The values are
 * derived deterministically from the persona id, so each entry keeps a stable,
 * distinct-looking record across renders and app restarts.
 */

const SAMPLE_SERVERS = [
  { host: "atlas.buzzmesh.dev", since: "Nov 2025" },
  { host: "foundry-collective.net", since: "Jan 2026" },
  { host: "relay.oss-hive.org", since: "Feb 2026" },
  { host: "buzz.nightshift.team", since: "Mar 2026" },
  { host: "commons.protolab.io", since: "Apr 2026" },
  { host: "hivemind.builders", since: "Jun 2026" },
] as const;

/** FNV-1a, so the sample record is a stable function of the persona id. */
function hashPersonaId(personaId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < personaId.length; index += 1) {
    hash ^= personaId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function isPassportNetworkPreviewEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.MODE === "e2e";
}

export function PersonaCatalogPassportPreview({
  personaId,
}: {
  personaId: string;
}) {
  const seed = hashPersonaId(personaId);
  const serverCount = 2 + (seed % 3);
  const firstServer = seed % SAMPLE_SERVERS.length;
  const servers = Array.from(
    { length: serverCount },
    (_, index) => SAMPLE_SERVERS[(firstServer + index) % SAMPLE_SERVERS.length],
  );
  const duplicateCount = 5 + ((seed >>> 8) % 24);
  const operatorCount = serverCount + 1 + ((seed >>> 16) % 9);

  return (
    <div
      className="space-y-2 rounded-xl border border-dashed border-border/70 p-3"
      data-testid="persona-catalog-passport-preview"
    >
      <p className="flex items-center gap-2 text-3xs font-medium tracking-[0.25em] text-muted-foreground uppercase">
        Network record
        <span className="rounded-full border border-chart-4/60 px-1.5 py-px tracking-normal text-chart-4">
          Sample data
        </span>
      </p>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Globe className="h-3.5 w-3.5 shrink-0" />
        <span>
          Also running on {servers.length} other{" "}
          {servers.length === 1 ? "server" : "servers"}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {servers.map((server) => (
          <span
            className="inline-flex items-baseline gap-1.5 rounded-lg border border-border bg-muted/40 px-2 py-1"
            key={server.host}
          >
            <span className="font-mono text-2xs text-foreground">
              {server.host}
            </span>
            <span className="text-3xs text-muted-foreground">
              since {server.since}
            </span>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CopyPlus className="h-3.5 w-3.5 shrink-0" />
        <span>Duplicated {duplicateCount} times across the network</span>
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Users className="h-3.5 w-3.5 shrink-0" />
        <span>Run by {operatorCount} operators outside this community</span>
      </div>
    </div>
  );
}
