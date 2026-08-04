import { Copy } from "lucide-react";
import { toast } from "sonner";

import { useCommunities } from "@/features/communities/useCommunities";
import { useUserProfileQuery } from "@/features/profile/hooks";
import {
  PassportCard,
  type PassportCardProps,
} from "@/features/profile/ui/PassportCard";
import { writeTextToClipboard } from "@/shared/lib/clipboard";
import { safeNpub } from "@/shared/lib/nostrUtils";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";

type PassportDialogProps = Omit<
  PassportCardProps,
  "communityName" | "operatorName"
> & {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** Declared owner pubkey (NIP-OA) for agent passports. */
  ownerPubkey: string | null;
};

/**
 * Passport viewer — the card floats alone over the backdrop (no dialog
 * chrome), the same "the card is the hero" treatment as the agent trading
 * card viewer. The issuing community and operator identity are resolved
 * here so the card itself stays purely presentational.
 */
export function PassportDialog({
  onOpenChange,
  open,
  ownerPubkey,
  ...cardProps
}: PassportDialogProps) {
  const { activeCommunity } = useCommunities();
  const ownerProfileQuery = useUserProfileQuery(ownerPubkey ?? undefined);
  const operatorName = ownerPubkey
    ? ownerProfileQuery.data?.nip05Handle?.trim() ||
      ownerProfileQuery.data?.displayName?.trim() ||
      truncatePubkey(ownerPubkey)
    : null;
  const npub = safeNpub(cardProps.pubkey) ?? cardProps.pubkey;

  const copyKey = async () => {
    await writeTextToClipboard(npub);
    toast.success("Identity key copied.");
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-w-fit justify-items-center"
        data-testid="passport-dialog"
        showCloseButton={false}
        surface="none"
      >
        <DialogTitle className="sr-only">
          {`${cardProps.displayName}'s passport`}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Portable identity card carrying the full public key, handle, and
          issuing community.
        </DialogDescription>
        <PassportCard
          {...cardProps}
          communityName={activeCommunity?.name ?? null}
          operatorName={operatorName}
        />
        <Button
          className="text-muted-foreground hover:text-foreground"
          data-testid="passport-copy-key"
          onClick={() => void copyKey()}
          size="sm"
          variant="ghost"
        >
          <Copy className="mr-2 h-3.5 w-3.5" />
          Copy identity key
        </Button>
      </DialogContent>
    </Dialog>
  );
}
