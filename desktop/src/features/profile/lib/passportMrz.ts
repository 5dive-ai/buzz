/**
 * Machine-readable zone (MRZ) lines for the Buzz Passport card.
 *
 * The MRZ is the passport's signature visual — but here it is also honest:
 * lines 2–3 carry the holder's full npub (bech32 is case-insensitive, so the
 * uppercase rendering remains decodable). This makes the passport a valid
 * "full key" trust surface per the pubkey-truncation rule: nothing on the
 * card abbreviates the identity.
 */

export const PASSPORT_MRZ_LINE_LENGTH = 44;

/** Document code by holder kind: P = person, A = agent. */
export function passportDocumentCode(isAgent: boolean): "P" | "A" {
  return isAgent ? "A" : "P";
}

/**
 * Reduce a display name to the MRZ character set (A–Z, 0–9). Words are
 * joined with `<<` after the first word (surname<<given convention) and `<`
 * between the remaining words. Diacritics are transliterated by stripping
 * combining marks.
 */
export function mrzName(displayName: string): string {
  const words = displayName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Z0-9]/g, ""))
    .filter((word) => word.length > 0);

  if (words.length === 0) {
    return "";
  }
  const [surname, ...given] = words;
  return given.length > 0 ? `${surname}<<${given.join("<")}` : surname;
}

function padMrzLine(line: string): string {
  return line
    .slice(0, PASSPORT_MRZ_LINE_LENGTH)
    .padEnd(PASSPORT_MRZ_LINE_LENGTH, "<");
}

/**
 * Build the three MRZ lines: a name/document line followed by the holder's
 * full npub split across two lines.
 */
export function buildPassportMrz({
  displayName,
  isAgent,
  npub,
}: {
  displayName: string;
  isAgent: boolean;
  npub: string;
}): [string, string, string] {
  const nameLine = `${passportDocumentCode(isAgent)}<BUZ${mrzName(displayName)}`;
  const key = npub.toUpperCase();
  return [
    padMrzLine(nameLine),
    padMrzLine(key.slice(0, PASSPORT_MRZ_LINE_LENGTH)),
    padMrzLine(key.slice(PASSPORT_MRZ_LINE_LENGTH)),
  ];
}
