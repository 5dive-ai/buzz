import { TerminalSubstrate } from "./TerminalSubstrate";

/** Temporary frontend boundary until the Rust session commands land. */
export function TerminalBootstrap({
  channelName,
}: {
  channelName: string | null;
}) {
  return (
    <TerminalSubstrate
      bracketedPaste={false}
      focusReportingEnabled={false}
      channelName={channelName}
      onCloseSession={() => {}}
      onInput={() => {}}
      onNewSession={() => {}}
      onScroll={() => {}}
      onSelectSession={() => {}}
      onTerminalFocusChange={() => {}}
      sessions={[
        { active: true, closing: false, id: "bootstrap", title: "SHELL" },
      ]}
    />
  );
}
