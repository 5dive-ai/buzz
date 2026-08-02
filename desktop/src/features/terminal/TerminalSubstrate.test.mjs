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
let reducedMotion = false;

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
    get matches() {
      return reducedMotion;
    },
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
  reducedMotion = false;
  dom.window.localStorage.clear();
  dom.window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
    bottom: 782,
    height: 782,
    left: 0,
    right: 940.8,
    top: 0,
    width: 940.8,
    x: 0,
    y: 0,
    toJSON() {},
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({
    clearRect() {},
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
  const renderTree = (nextProps) =>
    createElement(
      ThemeProvider,
      null,
      createElement("div", {
        className: "buzz-huddle-app-surface",
        tabIndex: -1,
      }),
      createElement(TerminalSubstrate, nextProps),
    );
  const view = render(renderTree(props));
  return {
    calls,
    props,
    view,
    rerender(nextOverrides) {
      view.rerender(renderTree({ ...props, ...nextOverrides }));
    },
  };
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
  assert.deepEqual(calls.input, []);
  fireEvent.input(input, { target: { value: "か" } });
  assert.deepEqual(calls.input, ["か"]);
});

const EMPTY_FRAME = {
  cursor: { column: 0, line: 0, visible: false },
  full: false,
  rows: [],
  viewport: { columns: 112, generation: 1, screenLines: 46 },
};

const VISIBLE_FRAME = {
  ...EMPTY_FRAME,
  viewport: { ...EMPTY_FRAME.viewport, generation: 2 },
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
};

async function expectWelcome(view, present) {
  await waitFor(() =>
    present
      ? assert.ok(view.container.querySelector(".buzz-terminal-welcome"))
      : assert.equal(
          view.container.querySelector(".buzz-terminal-welcome"),
          null,
        ),
  );
}

test("non-empty output from the active PTY dismisses the welcome overlay", async () => {
  const subject = fixture({ frame: EMPTY_FRAME });
  await ready(subject.view);
  await expectWelcome(subject.view, true);

  subject.rerender({ frame: VISIBLE_FRAME });
  await expectWelcome(subject.view, false);
});

test("empty active output keeps the welcome overlay", async () => {
  const subject = fixture({ frame: EMPTY_FRAME });
  await ready(subject.view);
  await expectWelcome(subject.view, true);

  subject.rerender({
    frame: {
      ...EMPTY_FRAME,
      viewport: { ...EMPTY_FRAME.viewport, generation: 2 },
    },
  });
  await expectWelcome(subject.view, true);
});

test("non-empty output from an inactive PTY keeps the welcome overlay", async () => {
  const subject = fixture({
    sessionFrames: [{ frame: EMPTY_FRAME, sessionId: "one" }],
    sessions: [
      { active: true, closing: false, id: "one", title: "SHELL" },
      { active: false, closing: false, id: "two", title: "LOG" },
    ],
  });
  await ready(subject.view);
  await expectWelcome(subject.view, true);

  subject.rerender({
    sessionFrames: [
      { frame: EMPTY_FRAME, sessionId: "one" },
      { frame: VISIBLE_FRAME, sessionId: "two" },
    ],
  });
  await expectWelcome(subject.view, true);
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

test("cursor blink runs only while the terminal owns input and resets on input", async () => {
  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  const callbacks = new Map();
  let nextTimer = 1;
  window.setInterval = (callback) => {
    const timer = nextTimer++;
    callbacks.set(timer, callback);
    return timer;
  };
  window.clearInterval = (timer) => callbacks.delete(timer);
  try {
    const subject = fixture({ frame: VISIBLE_FRAME });
    await ready(subject.view);
    assert.equal(callbacks.size, 0, "Buzz ownership must pause blinking");

    toggleChord();
    await waitFor(() => assert.equal(callbacks.size, 1));
    const firstTimer = [...callbacks.keys()][0];
    act(() => callbacks.get(firstTimer)());

    fireEvent.input(subject.view.getByLabelText("Terminal input"), {
      target: { value: "a" },
    });
    await waitFor(() => {
      assert.deepEqual(subject.calls.input, ["a"]);
      assert.equal(callbacks.size, 1);
      assert.equal(callbacks.has(firstTimer), false);
    });

    toggleChord();
    await waitFor(() => assert.equal(callbacks.size, 0));
  } finally {
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
  }
});

test("reduced motion keeps the terminal cursor solid", async () => {
  reducedMotion = true;
  const originalSetInterval = window.setInterval;
  let intervals = 0;
  window.setInterval = () => {
    intervals += 1;
    return 1;
  };
  try {
    const subject = fixture({ frame: VISIBLE_FRAME });
    await ready(subject.view);
    toggleChord();
    await waitFor(() =>
      assert.equal(
        subject.view.container.querySelector(".buzz-terminal-substrate").dataset
          .terminalOwner,
        "terminal",
      ),
    );
    assert.equal(intervals, 0);
  } finally {
    window.setInterval = originalSetInterval;
  }
});
