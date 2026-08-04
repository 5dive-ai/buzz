/**
 * Passport travel log — a persistent record of every community (server) this
 * identity has connected to, keyed by relay URL.
 *
 * Like the stamps in a physical passport, entries deliberately outlive the
 * visit: removing a community from the sidebar does not remove it from the
 * log. This is user-scoped cross-community history, so unlike the
 * community-scoped singletons in `resetCommunityState()`, it must NOT be
 * reset on community switches — recording the switch is its whole job.
 */

export type TravelLogEntry = {
  /** Community display name as of the most recent visit. */
  name: string;
  relayUrl: string;
  /** ISO timestamp of the first recorded connection. */
  firstVisitedAt: string;
  /** ISO timestamp of the most recent connection. */
  lastVisitedAt: string;
};

const STORAGE_KEY = "buzz-passport-travel-log";
/** Safety cap; evicts the least recently visited servers beyond it. */
const MAX_ENTRIES = 200;

/** Key relay URLs case-insensitively and ignore trailing slashes. */
export function normalizeRelayUrl(relayUrl: string): string {
  return relayUrl.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Pure upsert: revisits refresh `lastVisitedAt` and the display name but keep
 * `firstVisitedAt`. Returns entries sorted by most recent visit first.
 */
export function upsertTravelLogEntry(
  entries: TravelLogEntry[],
  visit: { name: string; relayUrl: string },
  visitedAt: string,
): TravelLogEntry[] {
  const key = normalizeRelayUrl(visit.relayUrl);
  const existing = entries.find(
    (entry) => normalizeRelayUrl(entry.relayUrl) === key,
  );
  const updated: TravelLogEntry = existing
    ? { ...existing, lastVisitedAt: visitedAt, name: visit.name }
    : {
        firstVisitedAt: visitedAt,
        lastVisitedAt: visitedAt,
        name: visit.name,
        relayUrl: visit.relayUrl,
      };

  return [
    updated,
    ...entries.filter((entry) => normalizeRelayUrl(entry.relayUrl) !== key),
  ]
    .sort((left, right) =>
      right.lastVisitedAt.localeCompare(left.lastVisitedAt),
    )
    .slice(0, MAX_ENTRIES);
}

function isTravelLogEntry(value: unknown): value is TravelLogEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    typeof entry.relayUrl === "string" &&
    typeof entry.firstVisitedAt === "string" &&
    typeof entry.lastVisitedAt === "string"
  );
}

/** Read the log from localStorage; malformed payloads yield an empty log. */
export function loadTravelLog(): TravelLogEntry[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isTravelLogEntry) : [];
  } catch {
    return [];
  }
}

/** Record a successful connection to a community's relay. */
export function recordCommunityVisit(visit: {
  name: string;
  relayUrl: string;
}): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const next = upsertTravelLogEntry(
      loadTravelLog(),
      visit,
      new Date().toISOString(),
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort history — never let bookkeeping break community init.
  }
}
