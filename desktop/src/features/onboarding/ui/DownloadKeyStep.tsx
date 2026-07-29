import { motion, useReducedMotion } from "motion/react";
import * as React from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { ONBOARDING_PRIMARY_CTA_CLASS } from "./OnboardingChrome";
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
  const [createButtonSlot, setCreateButtonSlot] =
    React.useState<HTMLElement | null>(null);

  return (
    <OnboardingSlideTransition
      className="flex min-h-0 w-full flex-col items-center"
      data-testid="onboarding-page-download"
      direction={direction}
      transitionKey={`download-${direction}`}
    >
      <div className="flex w-full max-w-[500px] shrink-0 flex-col text-center">
        {/* Plain string concat: cn()'s tailwind-merge misreads the custom
            text-title size token as conflicting with text-foreground. */}
        <h1 className="text-title font-normal text-foreground">
          {hasCreated
            ? "Now, test your backup"
            : "Backup your key with a password"}
        </h1>
        <p className="mt-5 text-sm leading-6 text-foreground/80">
          {hasCreated
            ? "Make sure your backup works: drop the file you just saved and unlock it with your password."
            : "Keep the downloaded file private — you need both it and your password to restore your identity. Save the backup password somewhere safe; Buzz cannot reset it if lost."}
        </p>
      </div>

      <div className="flex w-full max-w-[1040px] flex-1 flex-col justify-center py-10">
        <div className="w-full">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            transition={{ delay: 0.12, duration: 0.4, ease: "easeOut" }}
          >
            <Card className="w-full border-foreground/15 bg-card px-8 py-6 shadow-none">
              <div className="mx-auto w-full max-w-[832px]">
                <EncryptedBackupCreator
                  createButtonClassName={ONBOARDING_PRIMARY_CTA_CLASS}
                  createButtonPortal={createButtonSlot}
                  session={session}
                  variant="spotlight"
                />
              </div>
            </Card>
          </motion.div>
        </div>
      </div>

      <OnboardingFooter>
        {hasCreated ? null : (
          <div
            className="flex justify-center"
            data-testid="onboarding-create-slot"
            ref={setCreateButtonSlot}
          />
        )}
        <Button
          className="h-9 rounded-full bg-foreground/10 px-6 hover:bg-foreground/15"
          data-testid="onboarding-back"
          onClick={onBack}
          type="button"
          variant="ghost"
        >
          Back
        </Button>
      </OnboardingFooter>
    </OnboardingSlideTransition>
  );
}
