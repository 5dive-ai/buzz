import { motion, useReducedMotion } from "motion/react";
import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import {
  ONBOARDING_SECURITY_PRIMARY_CTA_CLASS,
  ONBOARDING_SECONDARY_CTA_CLASS,
} from "./OnboardingChrome";
import { OnboardingFooter } from "./OnboardingFooter";
import {
  type OnboardingTransitionDirection,
  OnboardingSlideTransition,
} from "./OnboardingSlideTransition";
import {
  type EncryptedBackupSession,
  EncryptedBackupCreator,
} from "./EncryptedBackupCreator";

type DownloadKeyStepProps = {
  direction: OnboardingTransitionDirection;
  /**
   * Backup state owned by the parent flow so Back navigation (which unmounts
   * this step) doesn't discard the created backup, the entered password, or
   * the backup-test progress.
   */
  session: EncryptedBackupSession;
  onBack: () => void;
};

/**
 * Password-backup security subview within the identity-key onboarding step.
 * The raw key never enters this component: Rust builds the NIP-49 payload
 * locally and the native save dialog produces the user-owned file.
 */
export function DownloadKeyStep({
  direction,
  session,
  onBack,
}: DownloadKeyStepProps) {
  const reduceMotion = useReducedMotion() ?? false;
  // Once the encrypted payload is saved, the creator advances to its guided
  // backup test while this surface keeps its own navigation.
  const hasCreated = session.created;
  const hasSelectedBackup = session.test.stage === "password";
  const hasUnsavedProgress =
    !hasCreated &&
    (session.state.passphrase.length > 0 ||
      session.state.requestId !== null ||
      session.state.encrypted !== null ||
      session.state.ncryptsec !== null ||
      session.state.downloadPending);
  const [confirmBack, setConfirmBack] = React.useState(false);
  const [primaryActionSlot, setPrimaryActionSlot] =
    React.useState<HTMLElement | null>(null);

  return (
    <OnboardingSlideTransition
      className="flex min-h-0 w-full flex-col items-center"
      data-testid="onboarding-page-download"
      direction={direction}
      transitionKey={`download-${direction}`}
    >
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="flex w-full max-w-[500px] shrink-0 flex-col text-center"
        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
        key={hasCreated ? "test-heading" : "password-heading"}
        transition={{ duration: reduceMotion ? 0 : 0.3, ease: "easeOut" }}
      >
        {/* Plain string concat: cn()'s tailwind-merge misreads the custom
            text-title size token as conflicting with text-foreground. */}
        <h1 className="text-title font-normal text-foreground">
          {hasSelectedBackup
            ? "That’s your backup file"
            : hasCreated
              ? "Optionally, test your backup"
              : "Backup your key with a password"}
        </h1>
        <p className="mt-5 text-sm leading-6 text-foreground/80">
          {hasSelectedBackup
            ? "Now enter your password to prove you can unlock it."
            : hasCreated
              ? "Learn how your backup works. Drop the file you just saved and unlock it with your password."
              : "Keep the downloaded file private — you need both it and your password to restore your identity. Save the backup password somewhere safe; Buzz cannot reset it if lost."}
        </p>
      </motion.div>

      <div className="flex w-full max-w-[1040px] flex-1 flex-col justify-center py-10">
        <div className="w-full">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            key={hasCreated ? "test-panel" : "password-panel"}
            transition={{
              delay: reduceMotion ? 0 : 0.12,
              duration: reduceMotion ? 0 : 0.4,
              ease: "easeOut",
            }}
          >
            <div
              className="mx-auto w-full max-w-140 px-6 py-5"
              data-testid="backup-password-panel"
            >
              <EncryptedBackupCreator
                createButtonClassName={ONBOARDING_SECURITY_PRIMARY_CTA_CLASS}
                createButtonPortal={primaryActionSlot}
                session={session}
                variant="spotlight"
                verifyButtonPortal={primaryActionSlot}
              />
            </div>
          </motion.div>
        </div>
      </div>

      <OnboardingFooter>
        <div
          className="flex justify-center"
          data-testid={
            hasCreated ? "onboarding-verify-slot" : "onboarding-create-slot"
          }
          ref={setPrimaryActionSlot}
        />
        <Button
          className={ONBOARDING_SECONDARY_CTA_CLASS}
          data-testid="onboarding-back"
          onClick={() => {
            if (hasUnsavedProgress) {
              setConfirmBack(true);
              return;
            }
            onBack();
          }}
          type="button"
          variant="ghost"
        >
          {hasCreated ? "Skip for now" : "Back"}
        </Button>
      </OnboardingFooter>
      <AlertDialog open={confirmBack} onOpenChange={setConfirmBack}>
        <AlertDialogContent
          className="buzz-onboarding-security-theme"
          data-testid="backup-discard-dialog"
          surface="textured"
          textureSize="compact"
          textureTone="dark"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Start over?</AlertDialogTitle>
            <AlertDialogDescription>
              Going back now clears any password you’ve entered and unfinished
              backup progress. If you haven’t downloaded the file, you’ll need
              to create it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={ONBOARDING_SECONDARY_CTA_CLASS}>
              Keep working
            </AlertDialogCancel>
            <AlertDialogAction
              className={ONBOARDING_SECURITY_PRIMARY_CTA_CLASS}
              data-testid="backup-discard-confirm"
              onClick={onBack}
            >
              Discard and go back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </OnboardingSlideTransition>
  );
}
