import * as React from "react";
import { Download, RefreshCw, Sparkles } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  mintAgentCard,
  NO_OPENAI_KEY_PREFIX,
  saveAgentCard,
  type MintedAgentCard,
} from "@/shared/api/tauriPersonas";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Textarea } from "@/shared/ui/textarea";

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

  return (
    <Dialog onOpenChange={(open) => !isMinting && onOpenChange(open)} open>
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
            <div className="flex justify-end gap-2">
              <Button
                disabled={isMinting || saveMutation.isPending}
                onClick={() => mintMutation.mutate()}
                variant="outline"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {isMinting ? "Rerolling…" : "Reroll"}
              </Button>
              <Button
                disabled={isMinting || saveMutation.isPending}
                onClick={() => saveMutation.mutate(card)}
                data-testid="agent-card-save"
              >
                <Download className="mr-2 h-4 w-4" />
                Save card
              </Button>
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
