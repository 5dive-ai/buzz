import * as React from "react";
import { Download, RefreshCw, Send, Sparkles } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  useOpenDmMutation,
  useUpsertCachedChannel,
} from "@/features/channels/hooks";
import {
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
import { Textarea } from "@/shared/ui/textarea";

import { PersonaShareRecipients } from "./PersonaShareRecipients";
import { useSnapshotSendController } from "./useSnapshotSendController";

/** Decode base64 card bytes into the number[] shape the upload path expects. */
function cardBytesFromBase64(b64: string): number[] {
  return Array.from(atob(b64), (char) => char.charCodeAt(0));
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
  onOpenChange,
}: {
  /** Instance pubkey or definition slug — same resolution as snapshot export. */
  agentId: string;
  agentName: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [styleNotes, setStyleNotes] = React.useState("");
  const [card, setCard] = React.useState<MintedAgentCard | null>(null);
  const [recipients, setRecipients] = React.useState<UserSearchResult[]>([]);

  const sendController = useSnapshotSendController(card !== null);
  const openDmMutation = useOpenDmMutation();
  const upsertCachedChannel = useUpsertCachedChannel();

  const mintMutation = useMutation({
    mutationFn: () => mintAgentCard(agentId, styleNotes.trim() || undefined),
    onSuccess: (minted) => setCard(minted),
    onError: (error: Error) => {
      if (error.message.startsWith(NO_OPENAI_KEY_PREFIX)) {
        toast.error(
          "No OpenAI API key found. Add OPENAI_API_KEY in the agent's environment variables or global agent settings.",
        );
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
              ? "The card carries the agent — anyone who imports this PNG gets a working copy (config only, fresh identity, no memories)."
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
        ) : (
          <div className="flex flex-col gap-4">
            <Textarea
              disabled={isMinting}
              onChange={(e) => setStyleNotes(e.target.value)}
              placeholder="Optional art direction — e.g. “stormy night, lightning motif”. The card always matches the agent's avatar style."
              rows={3}
              value={styleNotes}
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
