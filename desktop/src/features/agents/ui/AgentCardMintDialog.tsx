import * as React from "react";
import {
  Download,
  ExternalLink,
  KeyRound,
  Lock,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import {
  useOpenDmMutation,
  useUpsertCachedChannel,
} from "@/features/channels/hooks";
import { globalAgentConfigQueryKey } from "@/features/agents/useGlobalAgentConfig";
import {
  cardMintKeyStatus,
  cardMintSaveOpenaiKey,
  mintAgentCard,
  NO_OPENAI_KEY_PREFIX,
  saveAgentCard,
  type MintedAgentCard,
} from "@/shared/api/tauriPersonas";
import type { UserSearchResult } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";

import { PersonaShareRecipients } from "./PersonaShareRecipients";
import { useSnapshotSendController } from "./useSnapshotSendController";

/** Decode base64 card bytes into the number[] shape the upload path expects. */
function cardBytesFromBase64(b64: string): number[] {
  return Array.from(atob(b64), (char) => char.charCodeAt(0));
}

const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

/**
 * The free alternative, as an action: ordinary snapshot export shares the
 * same importable agent without card art or API spend. Rendered in both the
 * key-setup panel and the normal pre-mint form (the cost disclosure and its
 * escape hatch must be visible BEFORE any spend, not only during onboarding).
 */
function FreeSharePathRow({
  disabled,
  onExportInstead,
}: {
  disabled: boolean;
  onExportInstead?: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3"
      data-testid="agent-card-free-path"
    >
      <p className="text-xs text-muted-foreground">
        Don’t want to spend money? Ordinary export shares the same importable
        agent — free, just without the card art.
      </p>
      {onExportInstead ? (
        <Button
          className="shrink-0"
          data-testid="agent-card-export-instead"
          disabled={disabled}
          onClick={onExportInstead}
          size="sm"
          variant="outline"
        >
          Share without card art
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Mint-a-trading-card dialog: optional style notes → one long Rust-side
 * Responses API call → preview with reroll → save as `.agent.png`.
 *
 * The saved PNG carries the agent's `buzz_agent_snapshot` chunk, so sharing
 * the card shares an importable agent (config only — never memory, never
 * identity). All snapshot construction and verification happens in Rust.
 */
export function AgentCardMintDialog({
  agentId,
  agentName,
  canLock,
  onExportInstead,
  onOpenChange,
}: {
  /** Instance pubkey or definition slug — same resolution as snapshot export. */
  agentId: string;
  agentName: string;
  /**
   * True when the agent has a linked instance (a keypair to lock to).
   * Locking is disabled — with an explanation — for bare definitions.
   */
  canLock: boolean;
  /**
   * Free alternative: close this dialog and open the ordinary snapshot
   * export flow (no API spend). Omitted = the action is not rendered.
   */
  onExportInstead?: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [styleNotes, setStyleNotes] = React.useState("");
  const [lockCard, setLockCard] = React.useState(false);
  const [card, setCard] = React.useState<MintedAgentCard | null>(null);
  const [recipients, setRecipients] = React.useState<UserSearchResult[]>([]);
  const [keyDraft, setKeyDraft] = React.useState("");

  const queryClient = useQueryClient();
  const sendController = useSnapshotSendController(card !== null);
  const openDmMutation = useOpenDmMutation();
  const upsertCachedChannel = useUpsertCachedChannel();

  // Whether a key already resolves through the agent's env layering. While
  // unknown (loading/error) we show the normal mint form — the mint itself
  // still fails cleanly if no key exists.
  const keyStatusQuery = useQuery({
    queryKey: ["cardMintKeyStatus", agentId],
    queryFn: () => cardMintKeyStatus(agentId),
  });
  const needsKey = keyStatusQuery.data === false;

  // Save the pasted key into the global Agent Defaults env — the same single
  // source of truth every agent inherits. Narrow Rust seam: validated
  // single-key merge, never restarts running agents (the mint re-reads
  // config per call, so no restart is needed for minting).
  const saveKeyMutation = useMutation({
    mutationFn: (key: string) => cardMintSaveOpenaiKey(key),
    onSuccess: () => {
      queryClient.setQueryData(["cardMintKeyStatus", agentId], true);
      // The Agent Defaults editor caches the whole config — refetch it so a
      // later-opened settings view shows the key we just wrote.
      void queryClient.invalidateQueries({
        queryKey: globalAgentConfigQueryKey,
      });
      setKeyDraft("");
      toast.success(
        "API key saved to your agent defaults. Running agents pick it up on their next restart.",
      );
    },
    onError: (error) =>
      toast.error(typeof error === "string" ? error : "Couldn't save the key."),
  });

  const mintMutation = useMutation({
    mutationFn: () =>
      mintAgentCard(
        agentId,
        styleNotes.trim() || undefined,
        canLock && lockCard,
      ),
    onSuccess: (minted) => setCard(minted),
    onError: (error: Error) => {
      if (error.message.startsWith(NO_OPENAI_KEY_PREFIX)) {
        // The pre-check missed (e.g. key removed since open) — flip the
        // dialog into key-setup mode instead of leaving a dead-end toast.
        queryClient.setQueryData(["cardMintKeyStatus", agentId], false);
      } else {
        toast.error(error.message);
      }
    },
  });

  const saveMutation = useMutation({
    mutationFn: (minted: MintedAgentCard) =>
      saveAgentCard(minted.cardPngBase64, minted.fileName),
    onSuccess: (saved) => {
      if (saved) {
        toast.success(
          `Saved ${agentName}'s card. Share it — the card IS the agent.`,
        );
        onOpenChange(false);
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const isMinting = mintMutation.isPending;
  const isSending =
    sendController.state.phase !== "idle" &&
    sendController.state.phase !== "done" &&
    sendController.state.phase !== "error";
  const isBusy = isMinting || saveMutation.isPending || isSending;

  async function sendToRecipients(minted: MintedAgentCard) {
    if (recipients.length === 0) return;
    const sent = await sendController.beginSend(
      async () => ({
        fileBytes: cardBytesFromBase64(minted.cardPngBase64),
        fileName: minted.fileName,
      }),
      async () => {
        const directMessage = await openDmMutation.mutateAsync({
          pubkeys: recipients.map((recipient) => recipient.pubkey),
        });
        await upsertCachedChannel(directMessage);
        return directMessage.id;
      },
      agentName,
    );
    if (sent) {
      toast.success(`Sent ${agentName}'s card.`);
      onOpenChange(false);
    } else if (sent === false) {
      toast.error("Couldn’t send the card. Try again.");
    }
  }

  return (
    <Dialog onOpenChange={(open) => !isBusy && onOpenChange(open)} open>
      <DialogContent className="max-w-md" data-testid="agent-card-mint-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            {card ? `${agentName}'s card` : `Create ${agentName}'s card`}
          </DialogTitle>
          <DialogDescription>
            {card
              ? card.locked
                ? "This card is locked: only you and the agent can import it. Anyone else sees just the image."
                : "The card carries the agent — anyone who imports this PNG gets a working copy (config only, fresh identity, no memories)."
              : "Mint a collectible trading card that doubles as a shareable, importable copy of this agent."}
          </DialogDescription>
        </DialogHeader>

        {card ? (
          <div className="flex flex-col gap-4">
            <img
              alt={`${agentName} trading card`}
              className="mx-auto max-h-[28rem] rounded-lg border shadow-lg"
              data-testid="agent-card-preview"
              src={`data:image/png;base64,${card.cardPngBase64}`}
            />
            <PersonaShareRecipients
              disabled={isBusy || !sendController.isDmSafetyReady}
              excludedPubkeys={
                sendController.relaySelfPubkey
                  ? [sendController.relaySelfPubkey]
                  : []
              }
              onSelectionChange={setRecipients}
              open
              selectedUsers={recipients}
              testIdPrefix="agent-card-share"
            />
            <div className="flex justify-end gap-2">
              <Button
                disabled={isBusy}
                onClick={() => mintMutation.mutate()}
                variant="outline"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {isMinting ? "Rerolling…" : "Reroll"}
              </Button>
              <Button
                disabled={isBusy}
                onClick={() => saveMutation.mutate(card)}
                data-testid="agent-card-save"
                variant={recipients.length > 0 ? "outline" : "default"}
              >
                <Download className="mr-2 h-4 w-4" />
                Save card
              </Button>
              {recipients.length > 0 ? (
                <Button
                  disabled={isBusy}
                  onClick={() => void sendToRecipients(card)}
                  data-testid="agent-card-send"
                >
                  <Send className="mr-2 h-4 w-4" />
                  {isSending ? "Sending…" : "Send"}
                </Button>
              ) : null}
            </div>
          </div>
        ) : needsKey ? (
          <div
            className="flex flex-col gap-4"
            data-testid="agent-card-key-setup"
          >
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <KeyRound className="h-3.5 w-3.5" />
                One-time setup: OpenAI API key
              </span>
              <p className="text-xs text-muted-foreground">
                Minting a card costs money — it generates the art and card text
                through the OpenAI API with your key (typically well under a
                dollar per mint, billed by OpenAI). The key is saved to your
                agent defaults, so you only do this once.
              </p>
              <Button
                className="w-fit px-0 text-xs"
                data-testid="agent-card-key-link"
                onClick={() =>
                  void openUrl(OPENAI_KEYS_URL).catch(() => {
                    toast.error("Failed to open link");
                  })
                }
                size="sm"
                variant="link"
              >
                <ExternalLink className="mr-1 h-3 w-3" />
                Get a key at platform.openai.com
              </Button>
              <Input
                autoFocus
                data-testid="agent-card-key-input"
                disabled={saveKeyMutation.isPending}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="sk-…"
                type="password"
                value={keyDraft}
              />
            </div>
            <FreeSharePathRow
              disabled={saveKeyMutation.isPending}
              onExportInstead={onExportInstead}
            />
            <div className="flex justify-end">
              <Button
                data-testid="agent-card-key-save"
                disabled={
                  saveKeyMutation.isPending || keyDraft.trim().length === 0
                }
                onClick={() => saveKeyMutation.mutate(keyDraft.trim())}
              >
                <KeyRound className="mr-2 h-4 w-4" />
                {saveKeyMutation.isPending ? "Saving…" : "Save key & continue"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Textarea
              disabled={isMinting}
              onChange={(e) => setStyleNotes(e.target.value)}
              placeholder="Optional directions — art (“stormy night, lightning motif”) and/or card text (“ability: Verify — scry 2”). Your directions take priority; anything you leave open is designed for you."
              rows={3}
              value={styleNotes}
            />
            <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
              <div className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Lock className="h-3.5 w-3.5" />
                  Lock card
                </span>
                <span className="text-xs text-muted-foreground">
                  {canLock
                    ? "Encrypt the embedded agent so only you and this agent can import it. Anyone else sees just the image."
                    : "Locking needs a linked agent instance — start this agent once to enable it."}
                </span>
              </div>
              <Switch
                checked={canLock && lockCard}
                data-testid="agent-card-lock-toggle"
                disabled={isMinting || !canLock}
                onCheckedChange={setLockCard}
              />
            </div>
            <p
              className="text-xs text-muted-foreground"
              data-testid="agent-card-cost-note"
            >
              Minting calls the OpenAI API with your key and costs money —
              typically well under a dollar per mint, billed by OpenAI.
            </p>
            <FreeSharePathRow
              disabled={isMinting}
              onExportInstead={onExportInstead}
            />
            <div className="flex justify-end">
              <Button
                disabled={isMinting}
                onClick={() => mintMutation.mutate()}
                data-testid="agent-card-mint"
              >
                <Sparkles className="mr-2 h-4 w-4" />
                {isMinting ? "Minting… (takes a few minutes)" : "Mint card"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
