import { AlertTriangle, RefreshCw } from "lucide-react";
import * as React from "react";

import {
  createNcryptsecBackup,
  generateBackupPassphrase,
  saveNcryptsecCopy,
} from "@/shared/api/tauriIdentity";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";
import {
  createDisabled,
  customPassphraseIssue,
  encryptedBackupReducer,
  initialEncryptedBackupState,
  MIN_CUSTOM_PASSPHRASE_LEN,
  effectivePassphrase,
} from "../lib/encryptedBackup";
import { NsecMaskedDisplay } from "./NsecMaskedDisplay";

type EncryptedBackupCreatorProps = {
  /** "spotlight" is the onboarding treatment; "boxed" fits settings cards. */
  variant?: "spotlight" | "boxed";
  /** Fired once the backup blob exists (hosts gate Next / show toasts). */
  onCreated?: (ncryptsec: string) => void;
};

/**
 * Passphrase-first NIP-49 backup creation flow, shared by the onboarding
 * BackupStep and the settings Password Backup row.
 *
 * The raw private key never enters this component: it collects a passphrase,
 * asks Rust to create + persist the encrypted backup, and displays the
 * returned `ncryptsec1…` blob. A generated 6-word passphrase is the default;
 * "choose my own" requires ≥12 characters plus confirmation.
 */
export function EncryptedBackupCreator({
  variant = "spotlight",
  onCreated,
}: EncryptedBackupCreatorProps) {
  const [state, dispatch] = React.useReducer(
    encryptedBackupReducer,
    initialEncryptedBackupState,
  );
  const [savedPath, setSavedPath] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);
  const mountedRef = React.useRef(true);

  const generate = React.useCallback(async () => {
    try {
      const passphrase = await generateBackupPassphrase();
      if (mountedRef.current)
        dispatch({ type: "passphrase-generated", passphrase });
    } catch (err) {
      if (mountedRef.current)
        dispatch({
          type: "passphrase-generate-failed",
          message:
            err instanceof Error
              ? err.message
              : "Failed to generate a passphrase.",
        });
    }
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    void generate();
    return () => {
      mountedRef.current = false;
    };
  }, [generate]);

  const handleCreate = React.useCallback(async () => {
    const passphrase = effectivePassphrase(state);
    if (!passphrase || state.isCreating) return;
    dispatch({ type: "create-started" });
    try {
      const ncryptsec = await createNcryptsecBackup(passphrase);
      if (!mountedRef.current) return;
      dispatch({ type: "create-succeeded", ncryptsec });
      onCreated?.(ncryptsec);
    } catch (err) {
      if (mountedRef.current)
        dispatch({
          type: "create-failed",
          message:
            err instanceof Error ? err.message : "Failed to create backup.",
        });
    }
  }, [onCreated, state]);

  const handleSaveCopy = React.useCallback(async () => {
    if (!state.ncryptsec || isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const path = await saveNcryptsecCopy(state.ncryptsec);
      if (mountedRef.current && path) setSavedPath(path);
    } catch (err) {
      if (mountedRef.current)
        setSaveError(
          err instanceof Error ? err.message : "Failed to save a copy.",
        );
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  }, [isSaving, state.ncryptsec]);

  const isSpotlight = variant === "spotlight";
  const customIssue = customPassphraseIssue(
    state.customPassphrase,
    state.customConfirm,
  );

  if (state.ncryptsec) {
    return (
      <div className="space-y-4" data-testid="encrypted-backup-result">
        <NsecMaskedDisplay
          kind="ncryptsec"
          nsec={state.ncryptsec}
          variant={isSpotlight ? "bare" : "boxed"}
        />
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button
            className="h-8 gap-1.5 text-sm"
            data-testid="encrypted-backup-save-copy"
            disabled={isSaving}
            onClick={() => void handleSaveCopy()}
            size="sm"
            type="button"
            variant="outline"
          >
            {isSaving ? <Spinner className="h-3.5 w-3.5 border-2" /> : null}
            Save a copy…
          </Button>
          {savedPath ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="encrypted-backup-saved-path"
            >
              Saved to {savedPath}
            </p>
          ) : null}
        </div>
        {saveError ? (
          <p className="text-center text-sm text-destructive">{saveError}</p>
        ) : null}
        <p className="text-center text-xs leading-5 text-muted-foreground">
          This backup can only be unlocked with your passphrase. Without the
          passphrase it cannot be recovered — not even by Buzz.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn("mx-auto w-full max-w-[500px] space-y-4 text-left")}
      data-testid="encrypted-backup-creator"
    >
      {state.mode === "generated" ? (
        <div className="space-y-3">
          {state.generatedPassphrase ? (
            <div className="rounded-xl bg-white/50 px-6 py-5 text-center">
              <p
                className="font-mono text-lg leading-8 text-foreground"
                data-testid="backup-passphrase-generated"
              >
                {state.generatedPassphrase}
              </p>
            </div>
          ) : state.generateError ? (
            <div
              className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              data-testid="backup-passphrase-generate-error"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Could not generate a passphrase: {state.generateError}
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-foreground/70">
              <Spinner className="h-4 w-4 border-2" />
              Generating a passphrase…
            </div>
          )}
          <div className="flex items-center justify-center gap-3">
            <Button
              className="h-8 gap-1.5 text-sm"
              data-testid="backup-passphrase-regenerate"
              onClick={() => void generate()}
              size="sm"
              type="button"
              variant="outline"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              New passphrase
            </Button>
            <Button
              className="h-8 text-sm text-muted-foreground hover:text-accent-foreground"
              data-testid="backup-passphrase-choose-own"
              onClick={() => dispatch({ type: "set-mode", mode: "custom" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              Choose my own
            </Button>
          </div>
          <p className="text-center text-xs leading-5 text-muted-foreground">
            Write this passphrase down. It protects your backup and cannot be
            recovered if lost.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2">
            <Input
              aria-label="Backup passphrase"
              autoComplete="new-password"
              className="h-10 bg-background"
              data-testid="backup-passphrase-custom"
              onChange={(event) =>
                dispatch({
                  type: "set-custom-passphrase",
                  value: event.target.value,
                })
              }
              placeholder={`Passphrase (min ${MIN_CUSTOM_PASSPHRASE_LEN} characters)`}
              type="password"
              value={state.customPassphrase}
            />
            <Input
              aria-label="Confirm backup passphrase"
              autoComplete="new-password"
              className="h-10 bg-background"
              data-testid="backup-passphrase-confirm"
              onChange={(event) =>
                dispatch({
                  type: "set-custom-confirm",
                  value: event.target.value,
                })
              }
              placeholder="Confirm passphrase"
              type="password"
              value={state.customConfirm}
            />
          </div>
          {customIssue ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="backup-passphrase-issue"
            >
              {customIssue}
            </p>
          ) : null}
          <div className="flex items-center justify-center">
            <Button
              className="h-8 text-sm text-muted-foreground hover:text-accent-foreground"
              data-testid="backup-passphrase-use-generated"
              onClick={() => dispatch({ type: "set-mode", mode: "generated" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              Use a generated passphrase
            </Button>
          </div>
          <p className="text-center text-xs leading-5 text-muted-foreground">
            Your passphrase protects the backup and cannot be recovered if lost.
          </p>
        </div>
      )}

      {state.createError ? (
        <p
          className="text-center text-sm text-destructive"
          data-testid="encrypted-backup-create-error"
        >
          {state.createError}
        </p>
      ) : null}

      <div className="flex justify-center">
        <Button
          className="h-9 rounded-full px-6"
          data-testid="encrypted-backup-create"
          disabled={createDisabled(state)}
          onClick={() => void handleCreate()}
          type="button"
        >
          {state.isCreating ? (
            <>
              <Spinner className="h-4 w-4 border-2" />
              Encrypting… this takes a couple of seconds
            </>
          ) : (
            "Create encrypted backup"
          )}
        </Button>
      </div>
    </div>
  );
}
