import * as React from "react";
import type { AgentPersona } from "@/shared/api/types";
import type { UpdatePersonaInput } from "@/shared/api/types";
import { useUpdatePersonaMutation } from "@/features/agents/hooks";
import {
  formatPersonaNamePoolText,
  parsePersonaNamePoolText,
} from "./personaDialogState";

/**
 * Manages name pool state for AgentInstanceEditDialog.
 *
 * When a linked persona exists the dialog exposes its name pool so users can
 * edit instance names without navigating to the definition dialog. This hook
 * owns the text state, seeds it once per open session from the persona, and
 * exposes a `saveIfChanged` function the dialog calls on submit.
 */
export function useNamePoolEdit({
  open,
  linkedPersona,
}: {
  open: boolean;
  linkedPersona: AgentPersona | null;
}) {
  const updatePersonaMutation = useUpdatePersonaMutation();
  const [namePoolText, setNamePoolText] = React.useState("");
  const seededRef = React.useRef(false);

  // Reset seed guard when the dialog closes.
  React.useEffect(() => {
    if (!open) {
      seededRef.current = false;
      setNamePoolText("");
    }
  }, [open]);

  // Seed once per open session when the linked persona resolves.
  React.useEffect(() => {
    if (!open || seededRef.current || linkedPersona === null) {
      return;
    }
    setNamePoolText(formatPersonaNamePoolText(linkedPersona.namePool));
    seededRef.current = true;
  }, [open, linkedPersona]);

  /**
   * Saves the name pool to the linked definition if it has changed.
   * No-op for built-in personas or when the text is unchanged.
   */
  async function saveIfChanged() {
    if (
      linkedPersona == null ||
      linkedPersona.isBuiltIn ||
      namePoolText === formatPersonaNamePoolText(linkedPersona.namePool)
    ) {
      return;
    }
    const input: UpdatePersonaInput = {
      id: linkedPersona.id,
      displayName: linkedPersona.displayName,
      avatarUrl: linkedPersona.avatarUrl ?? undefined,
      systemPrompt: linkedPersona.systemPrompt,
      runtime: linkedPersona.runtime ?? undefined,
      model: linkedPersona.model ?? undefined,
      provider: linkedPersona.provider ?? undefined,
      namePool: parsePersonaNamePoolText(namePoolText),
      envVars: linkedPersona.envVars,
    };
    await updatePersonaMutation.mutateAsync(input);
  }

  return {
    namePoolText,
    setNamePoolText,
    isPending: updatePersonaMutation.isPending,
    saveIfChanged,
  };
}
