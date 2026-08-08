/**
 * Utilities for extracting and parsing the `buzz:permission-request` sentinel
 * that `buzz-acp` publishes as a kind:9 reply into the triggering thread when
 * an `ask`-policy permission request is admitted.
 *
 * Wire format (versioned discriminated union, schema v1 — frozen at event
 * b31c716e):
 *
 * ```buzz:permission-request
 * {"v":1,"state":"pending", … }
 * ```
 *
 * The prose above the fence is the plaintext fallback for non-card clients.
 * Desktop strips the sentinel and renders a `PermissionRequestCard` instead.
 *
 * Security invariants:
 * - `agentPubkey` and `channelId` are derived from the SIGNED EVENT ENVELOPE,
 *   never from sentinel JSON.
 * - `optionId` values are opaque — treated as arbitrary strings; never
 *   interpreted as ACP kinds by the renderer.
 * - Labels come from `labels[optionId]` — harness-provided display strings,
 *   not raw ACP kind names.
 * - All untrusted display strings are size-bounded (≤ 200 chars) and
 *   HTML-escaped by React at render time.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Pending sentinel — the card is actionable.
 *
 * `requestNonce` and `expiresAt` are trusted as unsigned ints from the harness.
 * `labels` values are untrusted display strings (capped at 200 chars).
 */
export type PermissionRequestPending = {
  v: 1;
  state: "pending";
  requestNonce: string;
  sessionId: string | null;
  turnId: string | null;
  expiresAt: number;
  /** Opaque option IDs. Size-bounded: ≤ 10. */
  optionIds: string[];
  /** Harness-provided display labels keyed by optionId. Each ≤ 200 chars. */
  labels: Record<string, string>;
  /** True when an `allow_always` option is present (D5 durable-rule disclosure). */
  hasDurableRule: boolean;
  /**
   * Human-readable durable-rule disclosure note. Non-null only when
   * `hasDurableRule === true`. E.g. "Includes an 'Always allow' option —
   * creates a machine-wide durable rule in Codex."
   */
  durableRuleNote: string | null;
};

/**
 * Resolved sentinel — the card is non-actionable (archived state).
 *
 * Published by the harness as a kind-40003 edit signed by the original agent.
 * `originalEventId` is the kind-9 event ID — correlates the edit to the card.
 */
export type PermissionRequestResolved = {
  v: 1;
  state: "resolved";
  requestNonce: string;
  originalEventId: string;
  sessionId: string | null;
  turnId: string | null;
  expiresAt: number;
  optionIds: string[];
  labels: Record<string, string>;
  hasDurableRule: boolean;
  durableRuleNote: string | null;
  /** One of "applied" | "timed_out" | "cancelled" | "rejected". */
  outcome: string;
  /** Non-null only when outcome === "applied". */
  chosenOptionId: string | null;
};

export type PermissionRequestPayload =
  | PermissionRequestPending
  | PermissionRequestResolved;

// ── Constants ─────────────────────────────────────────────────────────────────

const FENCE_OPEN = "```buzz:permission-request";
const FENCE_CLOSE = "```";

/** Maximum character length for any untrusted display string in the sentinel. */
const MAX_LABEL_CHARS = 200;

/** Maximum number of option IDs in a sentinel (PERMISSION_OPTIONS_MAX). */
const MAX_OPTION_IDS = 10;

// ── Extractor ─────────────────────────────────────────────────────────────────

/**
 * Extract the `PermissionRequestPayload` from a message body, if present.
 *
 * Returns `null` when:
 * - the sentinel fence is absent
 * - the JSON inside is malformed
 * - the parsed value does not match the expected shape
 *
 * Never throws — all errors are swallowed so this is safe in the render path.
 */
export function extractPermissionRequest(
  content: string,
): PermissionRequestPayload | null {
  const openIdx = content.indexOf(FENCE_OPEN);
  if (openIdx === -1) return null;

  const jsonStart = content.indexOf("\n", openIdx);
  if (jsonStart === -1) return null;

  const closeIdx = content.indexOf(`\n${FENCE_CLOSE}`, jsonStart);
  if (closeIdx === -1) return null;

  const json = content.slice(jsonStart + 1, closeIdx).trim();
  if (!json) return null;

  try {
    const parsed: unknown = JSON.parse(json);
    return isPermissionRequestPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Strip the `buzz:permission-request` sentinel block (and any preceding blank
 * line) from a message body. Returns the original string unchanged when no
 * sentinel is present.
 *
 * Used so the prose fallback renders without the raw code block.
 */
export function stripPermissionRequestSentinel(content: string): string {
  const openIdx = content.indexOf(FENCE_OPEN);
  if (openIdx === -1) return content;

  const closeIdx = content.indexOf(`\n${FENCE_CLOSE}`, openIdx);
  if (closeIdx === -1) return content;

  const afterFence = closeIdx + `\n${FENCE_CLOSE}`.length;
  const prose = content.slice(0, openIdx).replace(/\n{2,}$/, "\n");
  return prose + content.slice(afterFence);
}

// ── Type guards ────────────────────────────────────────────────────────────────

function isSafeString(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_LABEL_CHARS;
}

function isNullableString(v: unknown): v is string | null {
  return v === null || isSafeString(v);
}

function isLabelsRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(isSafeString);
}

function isPermissionRequestPayload(v: unknown): v is PermissionRequestPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (p.v !== 1) return false;

  // Shared fields present in both states
  if (typeof p.requestNonce !== "string" || p.requestNonce.length === 0) {
    return false;
  }
  if (!isNullableString(p.sessionId)) return false;
  if (!isNullableString(p.turnId)) return false;
  if (typeof p.expiresAt !== "number" || !Number.isFinite(p.expiresAt)) {
    return false;
  }
  if (
    !Array.isArray(p.optionIds) ||
    p.optionIds.length === 0 ||
    p.optionIds.length > MAX_OPTION_IDS ||
    !p.optionIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    return false;
  }
  if (!isLabelsRecord(p.labels)) return false;
  if (typeof p.hasDurableRule !== "boolean") return false;
  if (!isNullableString(p.durableRuleNote)) return false;

  if (p.state === "pending") {
    return true;
  }

  if (p.state === "resolved") {
    // originalEventId: 64-char hex string
    if (
      typeof p.originalEventId !== "string" ||
      p.originalEventId.length !== 64
    ) {
      return false;
    }
    if (typeof p.outcome !== "string" || p.outcome.length === 0) return false;
    // chosenOptionId: string or null (non-null only on "applied")
    if (p.chosenOptionId !== null && typeof p.chosenOptionId !== "string") {
      return false;
    }
    return true;
  }

  return false;
}
