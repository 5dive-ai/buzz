/**
 * Inline card rendered when the desktop detects a `buzz:permission-request`
 * sentinel in a kind:9 message body. Mirrors the `ConfigNudgeCard` pattern.
 *
 * Security invariants enforced by the caller (`MessageRow`):
 * - `request` is only non-null when the kind-9 signer equals the known agent
 *   pubkey for this channel (D1 signer gate in `computePermissionRequest`).
 * - Resolved state (`state === "resolved"`) requires the edit to have been
 *   signed by the original agent (edit authenticity gate).
 *
 * Actionable buttons render ONLY when:
 *   (a) `request.state === "pending"` AND
 *   (b) `isOwner` is true (the current viewer is the verified agent owner).
 * All other viewers see a read-only card.
 */
import * as React from "react";
import { ShieldCheck } from "lucide-react";

import { sendPermissionDecision } from "@/shared/api/agentControl";
import { cn } from "@/shared/lib/cn";
import {
  Attachment,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from "@/shared/ui/attachment";
import type {
  PermissionRequestPayload,
  PermissionRequestPending,
} from "@/shared/lib/permissionRequest";

export type PermissionRequestCardProps = {
  className?: string;
  request: PermissionRequestPayload;
  /** Hex pubkey of the agent that published the sentinel. */
  agentPubkey: string;
  /** Channel ID for routing the permission decision. */
  channelId: string;
  /**
   * True when the current viewer is the verified agent owner.
   * Absent or false → read-only card (buttons suppressed).
   */
  isOwner?: boolean;
};

/**
 * Heuristic: treat an option as "deny" when its harness label contains deny,
 * reject, or block (case-insensitive). Opaque optionIds carry no inherent
 * semantics — the label is the only display hint available.
 */
function isDenyLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return (
    lower.includes("deny") ||
    lower.includes("reject") ||
    lower.includes("block")
  );
}

function buttonClass(deny: boolean): string {
  return deny
    ? "rounded px-2 py-0.5 text-xs font-medium border border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-50"
    : "rounded px-2 py-0.5 text-xs font-medium border border-green-600/40 text-green-700 dark:text-green-400 hover:bg-green-600/10 disabled:opacity-50";
}

/**
 * Outcome display label — maps the harness outcome string to human copy.
 */
function outcomeLabel(
  outcome: string,
  chosenOptionId: string | null,
  labels: Record<string, string>,
): string {
  if (outcome === "applied" && chosenOptionId !== null) {
    const chosen = labels[chosenOptionId];
    return chosen ? `Approved: ${chosen}` : "Approved";
  }
  if (outcome === "timed_out") return "Timed out";
  if (outcome === "cancelled") return "Cancelled";
  if (outcome === "rejected") return "Denied";
  return outcome;
}

/**
 * Allow/Deny buttons for a pending, owner-visible permission card.
 * On click: disables locally and shows "Decision sent". Convergence to final
 * state comes from the agent's kind-40003 edit or expiry — no promise of
 * immediate resolution from the harness response.
 */
function PermissionButtons({
  agentPubkey,
  channelId,
  request,
}: {
  agentPubkey: string;
  channelId: string;
  request: PermissionRequestPending;
}) {
  const [submitted, setSubmitted] = React.useState<string | null>(null);

  const now = Date.now() / 1000;
  const expired = request.expiresAt <= now;

  if (expired) {
    return (
      <div className="mt-1.5 text-xs text-muted-foreground">Timed out</div>
    );
  }

  if (submitted !== null) {
    return (
      <div className="mt-1.5 text-xs text-muted-foreground">Decision sent</div>
    );
  }

  return (
    <div className="mt-1.5 flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {request.optionIds.map((optionId) => {
          const label = request.labels[optionId] ?? optionId;
          return (
            <button
              key={optionId}
              type="button"
              className={buttonClass(isDenyLabel(label))}
              data-testid={`permission-decision-${optionId}`}
              onClick={() => {
                setSubmitted(optionId);
                void sendPermissionDecision(
                  agentPubkey,
                  channelId,
                  request.requestNonce,
                  optionId,
                ).catch(() => {
                  // Relay rejected the send. Re-enable so the user can retry.
                  setSubmitted(null);
                });
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      {request.hasDurableRule && request.durableRuleNote !== null ? (
        <p className="max-w-[28rem] text-[11px] leading-4 text-amber-700 dark:text-amber-400 opacity-80">
          ⚠ {request.durableRuleNote}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Countdown display for a pending card. Updates every second until expiry.
 * Returns null when already expired (buttons handle that state).
 */
function ExpiryCountdown({ expiresAt }: { expiresAt: number }) {
  const [secsLeft, setSecsLeft] = React.useState(() =>
    Math.max(0, Math.round(expiresAt - Date.now() / 1000)),
  );

  React.useEffect(() => {
    if (secsLeft <= 0) return;
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.round(expiresAt - Date.now() / 1000));
      setSecsLeft(remaining);
      if (remaining <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [expiresAt, secsLeft]);

  if (secsLeft <= 0) return null;
  const mins = Math.floor(secsLeft / 60);
  const secs = secsLeft % 60;
  const label = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  return (
    <span className="text-[11px] text-muted-foreground opacity-70">
      {" "}
      · expires in {label}
    </span>
  );
}

export function PermissionRequestCard({
  className,
  request,
  agentPubkey,
  channelId,
  isOwner,
}: PermissionRequestCardProps) {
  if (request.state === "resolved") {
    const resolvedLabel = outcomeLabel(
      request.outcome,
      request.chosenOptionId,
      request.labels,
    );
    return (
      <Attachment
        className={cn(
          "max-w-[min(100%,32rem)] shrink-0 shadow-none",
          className,
        )}
        orientation="horizontal"
        state="done"
      >
        <AttachmentMedia className="text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="h-4 w-4" />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle className="whitespace-normal text-muted-foreground line-clamp-2">
            Permission request resolved
          </AttachmentTitle>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {resolvedLabel}
          </div>
        </AttachmentContent>
      </Attachment>
    );
  }

  // Pending state
  const pending = request as PermissionRequestPending;
  const expired = pending.expiresAt <= Date.now() / 1000;

  return (
    <Attachment
      className={cn("max-w-[min(100%,32rem)] shrink-0 shadow-none", className)}
      orientation="horizontal"
      state={expired ? "done" : "idle"}
    >
      <AttachmentMedia className="text-amber-600 dark:text-amber-400">
        <ShieldCheck aria-hidden="true" className="h-4 w-4" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle className="whitespace-normal text-amber-700 dark:text-amber-400 line-clamp-2">
          Permission request
          {!expired ? <ExpiryCountdown expiresAt={pending.expiresAt} /> : null}
        </AttachmentTitle>
        {isOwner ? (
          <PermissionButtons
            agentPubkey={agentPubkey}
            channelId={channelId}
            request={pending}
          />
        ) : (
          <div className="mt-1 text-xs text-muted-foreground">
            Waiting for owner approval
          </div>
        )}
      </AttachmentContent>
    </Attachment>
  );
}
