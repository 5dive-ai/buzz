/**
 * Pure state model for the encrypted-key-backup (NIP-49) creation flow,
 * shared by the onboarding BackupStep and the settings Password Backup row.
 *
 * All validation and phase logic lives here so it can be unit-tested without
 * React. Hosts wire the reducer to the Tauri commands
 * (`generate_backup_passphrase`, `create_ncryptsec_backup`) and dispatch
 * events; the model never touches the raw private key — by construction the
 * default backup path cannot invoke `get_nsec`.
 */

export type PassphraseMode = "generated" | "custom";

/** Mirrors `MIN_PASSPHRASE_LEN` in `src-tauri/src/key_backup.rs`. */
export const MIN_CUSTOM_PASSPHRASE_LEN = 12;

export type EncryptedBackupState = {
  /** Six-word passphrase generated in Rust; null until loaded. */
  generatedPassphrase: string | null;
  generateError: string | null;
  mode: PassphraseMode;
  customPassphrase: string;
  customConfirm: string;
  isCreating: boolean;
  createError: string | null;
  /** The persisted `ncryptsec1…` blob once the backup exists. */
  ncryptsec: string | null;
};

export const initialEncryptedBackupState: EncryptedBackupState = {
  generatedPassphrase: null,
  generateError: null,
  mode: "generated",
  customPassphrase: "",
  customConfirm: "",
  isCreating: false,
  createError: null,
  ncryptsec: null,
};

export type EncryptedBackupEvent =
  | { type: "passphrase-generated"; passphrase: string }
  | { type: "passphrase-generate-failed"; message: string }
  | { type: "set-mode"; mode: PassphraseMode }
  | { type: "set-custom-passphrase"; value: string }
  | { type: "set-custom-confirm"; value: string }
  | { type: "create-started" }
  | { type: "create-succeeded"; ncryptsec: string }
  | { type: "create-failed"; message: string };

export function encryptedBackupReducer(
  state: EncryptedBackupState,
  event: EncryptedBackupEvent,
): EncryptedBackupState {
  switch (event.type) {
    case "passphrase-generated":
      return {
        ...state,
        generatedPassphrase: event.passphrase,
        generateError: null,
      };
    case "passphrase-generate-failed":
      return { ...state, generateError: event.message };
    case "set-mode":
      // Editing state carries across toggles; validation re-derives.
      return { ...state, mode: event.mode, createError: null };
    case "set-custom-passphrase":
      return { ...state, customPassphrase: event.value, createError: null };
    case "set-custom-confirm":
      return { ...state, customConfirm: event.value, createError: null };
    case "create-started":
      return { ...state, isCreating: true, createError: null };
    case "create-succeeded":
      return { ...state, isCreating: false, ncryptsec: event.ncryptsec };
    case "create-failed":
      return { ...state, isCreating: false, createError: event.message };
  }
}

/**
 * Validation issue for a custom passphrase, or null when acceptable.
 * Confirm mismatch is only reported once the confirm field has content, so
 * the user isn't scolded mid-typing.
 */
export function customPassphraseIssue(
  passphrase: string,
  confirm: string,
): string | null {
  if (passphrase.length === 0) return null;
  if ([...passphrase].length < MIN_CUSTOM_PASSPHRASE_LEN) {
    return `Use at least ${MIN_CUSTOM_PASSPHRASE_LEN} characters.`;
  }
  if (confirm.length > 0 && passphrase !== confirm) {
    return "Passphrases don't match.";
  }
  return null;
}

/** The passphrase the Create action would submit, or null when not ready. */
export function effectivePassphrase(
  state: EncryptedBackupState,
): string | null {
  if (state.mode === "generated") return state.generatedPassphrase;
  const { customPassphrase, customConfirm } = state;
  if (
    [...customPassphrase].length < MIN_CUSTOM_PASSPHRASE_LEN ||
    customPassphrase !== customConfirm
  ) {
    return null;
  }
  return customPassphrase;
}

/** Whether the "Create backup" action is currently actionable. */
export function createDisabled(state: EncryptedBackupState): boolean {
  return state.isCreating || effectivePassphrase(state) === null;
}
