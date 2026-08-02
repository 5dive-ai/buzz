import * as React from "react";

import { useTheme } from "@/shared/theme/ThemeProvider";
import { cn } from "@/shared/lib/cn";
import { FadeController } from "./fadeController";
import {
  INITIAL_HANDOFF_STATE,
  accumulateScrollLines,
  encodePaste,
  encodeTerminalKey,
  reduceHandoff,
  updateWelcomeForOutput,
  type WelcomeState,
} from "./terminalState";
import { type TerminalFrame, TerminalGrid } from "./terminalRenderer";

export type TerminalSessionTab = {
  id: string;
  title: string;
  closing: boolean;
  active: boolean;
};

type TerminalSubstrateProps = {
  appSurfaceRef?: React.RefObject<HTMLDivElement | null>;
  channelName: string | null;
  frame?: TerminalFrame;
  sessions: readonly TerminalSessionTab[];
  bracketedPaste: boolean;
  focusReportingEnabled: boolean;
  onInput: (text: string) => void;
  onScroll: (deltaPx: number) => void;
  onTerminalFocusChange: (focused: boolean) => void;
  onSelectSession: (id: string) => void;
  onCloseSession: (id: string) => void;
  onNewSession: () => void;
};

function isToggleChord(event: KeyboardEvent): boolean {
  return (
    event.code === "KeyJ" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

const CELL_HEIGHT = 17;
const WELCOME_COLUMNS = 25;
const WELCOME_LINES = 4;

function welcomeRect(frame: TerminalFrame) {
  const top = Math.max(
    0,
    Math.floor(frame.viewport.screenLines * 0.42 - WELCOME_LINES / 2),
  );
  const left = Math.max(
    0,
    Math.floor((frame.viewport.columns - WELCOME_COLUMNS) / 2),
  );
  return {
    top,
    left,
    bottom: top + WELCOME_LINES,
    right: left + WELCOME_COLUMNS,
  };
}

function frameDamageRects(frame: TerminalFrame) {
  return frame.rows.flatMap((row) =>
    row.spans.flatMap((span) =>
      span.clusters
        .filter((cluster) => cluster.text.trim().length > 0)
        .map((cluster) => ({
          top: row.line,
          left: cluster.column,
          bottom: row.line + 1,
          right: cluster.column + cluster.width,
        })),
    ),
  );
}

export function TerminalSubstrate({
  appSurfaceRef,
  channelName,
  frame,
  sessions,
  bracketedPaste,
  focusReportingEnabled,
  onInput,
  onScroll,
  onTerminalFocusChange,
  onSelectSession,
  onCloseSession,
  onNewSession,
}: TerminalSubstrateProps) {
  const { terminalPalette } = useTheme();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fadeRef = React.useRef<FadeController | null>(null);
  const handoffRef = React.useRef(INITIAL_HANDOFF_STATE);
  const gridRef = React.useRef<TerminalGrid | null>(null);
  const paintedPaletteRef = React.useRef(terminalPalette);
  const previousFocusRef = React.useRef<HTMLElement | null>(null);
  const reportedFocusRef = React.useRef<boolean | null>(null);
  const scrollBySessionRef = React.useRef(new Map<string, number>());
  const activeSession = sessions.find((session) => session.active);
  const [owner, setOwner] = React.useState<"buzz" | "terminal">("buzz");
  const [welcome, setWelcome] = React.useState<WelcomeState>({
    visible: true,
    reserved: null,
  });
  const shortcutLabel = /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘J"
    : "CTRL+J";
  const getAppSurface = React.useCallback(
    () =>
      appSurfaceRef?.current ??
      document.querySelector<HTMLDivElement>(".buzz-huddle-app-surface"),
    [appSurfaceRef],
  );
  const terminalStyle = terminalPalette
    ? ({
        "--buzz-terminal-background": terminalPalette.background,
        "--buzz-terminal-foreground": terminalPalette.foreground,
      } as React.CSSProperties)
    : undefined;

  const commitOwner = React.useEffectEvent((next: "buzz" | "terminal") => {
    const appSurface = getAppSurface();
    if (!appSurface) return;
    if (next === "terminal") {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      appSurface.inert = true;
      appSurface.setAttribute("aria-hidden", "true");
      textareaRef.current?.focus({ preventScroll: true });
    } else {
      appSurface.inert = false;
      appSurface.removeAttribute("aria-hidden");
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      else appSurface.focus({ preventScroll: true });
    }
    setOwner(next);
  });

  const forceBuzzFallback = React.useEffectEvent(() => {
    handoffRef.current = { ...INITIAL_HANDOFF_STATE };
    commitOwner("buzz");
    fadeRef.current?.settle("conceal");
  });

  const sendInput = React.useEffectEvent((text: string) => {
    if (!text) return;
    setWelcome((current) => ({ ...current, visible: false }));
    onInput(text);
  });

  React.useEffect(() => {
    if (!focusReportingEnabled) {
      reportedFocusRef.current = null;
      return;
    }
    const reportCompositeFocus = () => {
      const focused = owner === "terminal" && document.hasFocus();
      if (reportedFocusRef.current === focused) return;
      reportedFocusRef.current = focused;
      onTerminalFocusChange(focused);
    };
    reportCompositeFocus();
    window.addEventListener("focus", reportCompositeFocus);
    window.addEventListener("blur", reportCompositeFocus);
    return () => {
      window.removeEventListener("focus", reportCompositeFocus);
      window.removeEventListener("blur", reportCompositeFocus);
    };
  }, [focusReportingEnabled, onTerminalFocusChange, owner]);

  React.useLayoutEffect(() => {
    const appSurface = getAppSurface();
    if (!appSurface) return;
    fadeRef.current = new FadeController(appSurface);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isToggleChord(event)) return;
      if (event.isComposing) {
        handoffRef.current = reduceHandoff(handoffRef.current, {
          type: "focus-lost",
        }).state;
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const result = reduceHandoff(handoffRef.current, {
        type: "chord-down",
        repeat: event.repeat,
      });
      handoffRef.current = result.state;
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!isToggleChord(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.isComposing) return;
      const result = reduceHandoff(handoffRef.current, { type: "chord-up" });
      handoffRef.current = result.state;
      if (!result.toggled) return;
      commitOwner(result.state.owner);
      fadeRef.current?.toggle(
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
    };
    const cancelChord = () => {
      handoffRef.current = reduceHandoff(handoffRef.current, {
        type: "focus-lost",
      }).state;
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", cancelChord);
    document.addEventListener("visibilitychange", cancelChord);
    return () => {
      fadeRef.current?.settle("conceal");
      fadeRef.current = null;
      appSurface.inert = false;
      appSurface.removeAttribute("aria-hidden");
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", cancelChord);
      document.removeEventListener("visibilitychange", cancelChord);
    };
  }, [getAppSurface]);

  React.useEffect(() => {
    if (frame) {
      setWelcome((current) =>
        updateWelcomeForOutput(
          { ...current, reserved: welcomeRect(frame) },
          frameDamageRects(frame),
        ),
      );
      const current = gridRef.current;
      if (!current) gridRef.current = new TerminalGrid(frame.viewport);
      else if (
        current.viewport.generation !== frame.viewport.generation ||
        current.viewport.columns !== frame.viewport.columns ||
        current.viewport.screenLines !== frame.viewport.screenLines
      ) {
        current.resize(frame.viewport);
      }
      gridRef.current?.apply(frame);
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!terminalPalette) {
      forceBuzzFallback();
      return;
    }
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      forceBuzzFallback();
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const bounds = canvas.getBoundingClientRect();
    const pixelWidth = Math.round(bounds.width * dpr);
    const pixelHeight = Math.round(bounds.height * dpr);
    const resized =
      canvas.width !== pixelWidth || canvas.height !== pixelHeight;
    const paletteChanged = paintedPaletteRef.current !== terminalPalette;
    paintedPaletteRef.current = terminalPalette;
    if (resized) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    if (resized || paletteChanged) {
      gridRef.current?.markAllDirty();
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (resized || paletteChanged) {
      context.fillStyle = terminalPalette.background;
      context.fillRect(0, 0, bounds.width, bounds.height);
    }
    gridRef.current?.paint(
      context,
      {
        width: 8.4,
        height: 17,
        baseline: 13,
        font: '14px "JetBrains Mono", monospace',
        boldFont: '700 14px "JetBrains Mono", monospace',
      },
      terminalPalette,
    );
  }, [frame, terminalPalette]);

  return (
    <section
      aria-label="Local terminal"
      className="buzz-terminal-substrate"
      data-terminal-owner={owner}
      style={terminalStyle}
      onWheel={(event) => {
        event.preventDefault();
        const sessionId = activeSession?.id;
        if (!sessionId) return;
        const deltaPx =
          event.deltaMode === 1
            ? event.deltaY * CELL_HEIGHT
            : event.deltaMode === 2
              ? event.deltaY * event.currentTarget.clientHeight
              : event.deltaY;
        const result = accumulateScrollLines(
          { remainderPx: scrollBySessionRef.current.get(sessionId) ?? 0 },
          deltaPx,
          CELL_HEIGHT,
        );
        scrollBySessionRef.current.set(sessionId, result.state.remainderPx);
        if (result.lines !== 0) onScroll(result.lines);
      }}
    >
      <div className="buzz-terminal-contract-bar">
        <div className="buzz-terminal-tabs" role="tablist">
          {sessions.map((session, index) => (
            <div
              className={cn(
                "buzz-terminal-tab",
                session.active && "buzz-terminal-tab-active",
              )}
              key={session.id}
              role="presentation"
            >
              <button
                aria-selected={session.active}
                className="buzz-terminal-tab-select"
                disabled={session.closing}
                onClick={() => onSelectSession(session.id)}
                role="tab"
                type="button"
              >
                <span className="buzz-terminal-designator">
                  SYS.{String(index + 1).padStart(2, "0")}
                </span>
                <span>{session.closing ? "CLOSING" : session.title}</span>
              </button>
              <button
                aria-label={`Close ${session.title}`}
                className="buzz-terminal-close"
                disabled={session.closing}
                onClick={() => onCloseSession(session.id)}
                type="button"
              >
                ×
              </button>
            </div>
          ))}
          <button
            aria-label="New terminal tab"
            className="buzz-terminal-new-tab"
            onClick={onNewSession}
            type="button"
          >
            +
          </button>
        </div>
        <div className="buzz-terminal-readout">
          <span>{channelName ? `#${channelName}` : "BUZZ"}</span>
          <span>LOCAL PTY · PRIVATE</span>
          <span>{shortcutLabel} BUZZ</span>
        </div>
      </div>
      <div className="buzz-terminal-viewport">
        <canvas ref={canvasRef} />
        {welcome.visible ? (
          <div className="buzz-terminal-welcome" aria-hidden="true">
            <pre>{`┌─╲  BUZZ SUBSTRATE  ╱─┐
│   B U Z Z    /\\_/\\  │
│   LOCAL PTY ( o.o )  │
└────────────── > ^ < ─┘`}</pre>
          </div>
        ) : null}
        <textarea
          aria-label="Terminal input"
          autoCapitalize="off"
          autoComplete="off"
          className="buzz-terminal-input"
          onCompositionEnd={() => {
            handoffRef.current = reduceHandoff(handoffRef.current, {
              type: "composition-end",
            }).state;
          }}
          onCompositionStart={() => {
            handoffRef.current = reduceHandoff(handoffRef.current, {
              type: "composition-start",
            }).state;
          }}
          onInput={(event) => {
            if (handoffRef.current.composing) return;
            const committed = event.currentTarget.value;
            event.currentTarget.value = "";
            sendInput(committed);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              event.stopPropagation();
              return;
            }
            if (isToggleChord(event.nativeEvent)) return;
            const encoded = encodeTerminalKey(event);
            if (encoded) {
              event.preventDefault();
              sendInput(encoded);
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            sendInput(
              encodePaste(
                event.clipboardData.getData("text/plain"),
                bracketedPaste,
              ),
            );
          }}
          ref={textareaRef}
          spellCheck={false}
          tabIndex={owner === "terminal" ? 0 : -1}
        />
      </div>
      <div aria-live="polite" className="sr-only">
        {owner === "terminal" ? "Terminal mode" : "Buzz mode"}
      </div>
    </section>
  );
}
