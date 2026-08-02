import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { JSDOM } from "jsdom";

let act;
let cleanup;
let createElement;
let fireEvent;
let render;
let waitFor;
let ThemeProvider;
let TerminalSubstrate;

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLCanvasElement: dom.window.HTMLCanvasElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.HTMLElement.prototype.animate = () => ({
    cancel() {},
    currentTime: 0,
    finished: new Promise(() => {}),
    play() {},
    playbackRate: 1,
    reverse() {},
  });
  ({ act, cleanup, fireEvent, render, waitFor } = await import(
    "@testing-library/react"
  ));
  ({ createElement } = await import("react"));
  ({ ThemeProvider } = await import("@/shared/theme/ThemeProvider"));
  ({ TerminalSubstrate } = await import("./TerminalSubstrate.tsx"));
});

after(() => dom.window.close());
beforeEach(() => {
  cleanup?.();
  dom.window.localStorage.clear();
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({
    fillRect() {},
    fillStyle: "",
    fillText() {},
    font: "",
    restore() {},
    save() {},
    setTransform() {},
    textBaseline: "",
  });
});

function fixture(overrides = {}) {
  const calls = { input: [], scroll: [] };
  const props = {
    bracketedPaste: false,
    channelName: "terminal-test",
    focusReportingEnabled: false,
    onCloseSession() {},
    onInput(value) {
      calls.input.push(value);
    },
    onNewSession() {},
    onScroll(lines) {
      calls.scroll.push(lines);
    },
    onSelectSession() {},
    onTerminalFocusChange() {},
    sessions: [{ active: true, closing: false, id: "one", title: "SHELL" }],
    ...overrides,
  };
  const view = render(
    createElement(
      ThemeProvider,
      null,
      createElement("div", {
        className: "buzz-huddle-app-surface",
        tabIndex: -1,
      }),
      createElement(TerminalSubstrate, props),
    ),
  );
  return { calls, props, view };
}

async function ready(view) {
  await waitFor(() =>
    assert.ok(view.container.querySelector(".buzz-terminal-substrate")),
  );
}

function toggleChord(composing = false) {
  const init = {
    bubbles: true,
    code: "KeyJ",
    isComposing: composing,
    metaKey: true,
  };
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", init));
    window.dispatchEvent(new KeyboardEvent("keyup", init));
  });
}

test("mounted IME paths neither toggle nor emit preedit text", async () => {
  const { calls, view } = fixture();
  await ready(view);
  const substrate = view.container.querySelector(".buzz-terminal-substrate");
  toggleChord(true);
  assert.equal(substrate.dataset.terminalOwner, "buzz");

  toggleChord();
  await waitFor(() =>
    assert.equal(substrate.dataset.terminalOwner, "terminal"),
  );
  const input = view.getByLabelText("Terminal input");
  fireEvent.compositionStart(input);
  fireEvent.input(input, { target: { value: "k" } });
  fireEvent.input(input, { target: { value: "か" } });
  assert.deepEqual(calls.input, []);
  fireEvent.compositionEnd(input, { data: "か" });
  assert.deepEqual(calls.input, ["か"]);
});

test("welcome survives non-intersecting frame and dismisses on input or intersecting damage", async () => {
  const baseFrame = {
    cursor: { column: 0, line: 0, visible: false },
    full: false,
    rows: [
      {
        line: 0,
        spans: [
          {
            style: { fg: 0, bg: 0, flags: 0 },
            clusters: [{ column: 0, text: "$", width: 1 }],
          },
        ],
      },
    ],
    viewport: { columns: 80, generation: 1, screenLines: 24 },
  };
  const { view } = fixture({ frame: baseFrame });
  await ready(view);
  assert.ok(view.container.querySelector(".buzz-terminal-welcome"));
  toggleChord();
  const input = view.getByLabelText("Terminal input");
  fireEvent.input(input, { target: { value: "x" } });
  await waitFor(() =>
    assert.equal(view.container.querySelector(".buzz-terminal-welcome"), null),
  );

  cleanup();
  const intersecting = fixture({
    frame: {
      ...baseFrame,
      rows: [
        {
          line: 8,
          spans: [
            {
              style: { fg: 0, bg: 0, flags: 0 },
              clusters: [{ column: 0, text: "x", width: 1 }],
            },
          ],
        },
      ],
    },
  });
  await ready(intersecting.view);
  await waitFor(() =>
    assert.equal(
      intersecting.view.container.querySelector(".buzz-terminal-welcome"),
      null,
    ),
  );
});

test("mounted wheel path accumulates fractional lines per active session", async () => {
  const { calls, view } = fixture();
  await ready(view);
  const substrate = view.container.querySelector(".buzz-terminal-substrate");
  fireEvent.wheel(substrate, { deltaMode: 0, deltaY: 8 });
  assert.deepEqual(calls.scroll, []);
  fireEvent.wheel(substrate, { deltaMode: 0, deltaY: 10 });
  assert.deepEqual(calls.scroll, [1]);
});

test("canvas failure atomically restores Buzz ownership", async () => {
  const { props, view } = fixture();
  await ready(view);
  const substrate = view.container.querySelector(".buzz-terminal-substrate");
  toggleChord();
  await waitFor(() =>
    assert.equal(substrate.dataset.terminalOwner, "terminal"),
  );
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  view.rerender(
    createElement(
      ThemeProvider,
      null,
      createElement("div", {
        className: "buzz-huddle-app-surface",
        tabIndex: -1,
      }),
      createElement(TerminalSubstrate, {
        ...props,
        frame: {
          cursor: { column: 0, line: 0, visible: false },
          full: false,
          rows: [],
          viewport: { columns: 80, generation: 1, screenLines: 24 },
        },
      }),
    ),
  );
  await waitFor(() => assert.equal(substrate.dataset.terminalOwner, "buzz"));
  toggleChord();
  await waitFor(() =>
    assert.equal(substrate.dataset.terminalOwner, "terminal"),
  );
});
