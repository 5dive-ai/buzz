import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const callbacks = new Map();
const calls = [];
let nextCallback = 1;
let channel;
let resizeCallback;
let canvasWidth = 840;
let attachResolver = null;

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLCanvasElement: dom.window.HTMLCanvasElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    isTauri: true,
    window: dom.window,
  });
  dom.window.localStorage.setItem("buzz-follow-system", "false");
  dom.window.isTauri = true;
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.ResizeObserver = class {
    constructor(callback) {
      resizeCallback = callback;
    }
    observe() {}
    disconnect() {}
  };
  dom.window.HTMLElement.prototype.animate = () => ({
    cancel() {},
    currentTime: 0,
    finished: new Promise(() => {}),
    play() {},
    playbackRate: 1,
    reverse() {},
  });
  dom.window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
    bottom: 408,
    height: 408,
    left: 0,
    right: canvasWidth,
    top: 0,
    width: canvasWidth,
    x: 0,
    y: 0,
    toJSON() {},
  });
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
  dom.window.__TAURI_INTERNALS__ = {
    invoke(command, args) {
      calls.push({ command, args });
      if (command === "terminal_attach") {
        channel = args.onFrame;
        const response = {
          sessionId: "session-1",
          subscriptionId: "subscription-1",
          viewport: { columns: 100, generation: 0, screenLines: 24 },
        };
        return attachResolver
          ? new Promise((resolve) => {
              attachResolver = () => resolve(response);
            })
          : Promise.resolve(response);
      }
      if (command === "terminal_resize") {
        return Promise.resolve({
          columns: args.columns,
          generation: args.columns,
          screenLines: args.rows,
        });
      }
      return Promise.resolve();
    },
    transformCallback(callback) {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
  };
});

after(() => dom.window.close());
afterEach(() => {
  calls.length = 0;
  canvasWidth = 840;
  attachResolver = null;
});

function emit(message, index = 0) {
  const id = Number(channel.toJSON().slice("__CHANNEL__:".length));
  callbacks.get(id)({ index, message });
}

test("mounted bootstrap passes GUI context and ACKs only after consuming a frame", async () => {
  const { StrictMode, createElement } = await import("react");
  const { act, render, waitFor } = await import("@testing-library/react");
  const { ThemeProvider } = await import("@/shared/theme/ThemeProvider");
  const { TerminalBootstrap } = await import("./TerminalBootstrap.tsx");

  render(
    createElement(
      StrictMode,
      null,
      createElement(
        ThemeProvider,
        null,
        createElement("div", {
          className: "buzz-huddle-app-surface",
          tabIndex: -1,
        }),
        createElement(TerminalBootstrap, {
          channelId: "channel-1",
          channelName: "general",
          npub: "npub1owner",
          relayUrl: "wss://relay.example",
          threadId: "thread-1",
        }),
      ),
    ),
  );

  await waitFor(() =>
    assert.ok(calls.some(({ command }) => command === "terminal_attach")),
  );
  const attach = calls.find(({ command }) => command === "terminal_attach");
  assert.deepEqual(attach.args.request, {
    channelId: "channel-1",
    channelName: "general",
    columns: 100,
    npub: "npub1owner",
    pixelHeight: 408,
    pixelWidth: 840,
    relayUrl: "wss://relay.example",
    rows: 24,
    threadId: "thread-1",
  });

  const frameMessage = {
    type: "frame",
    payload: {
      bracketedPaste: true,
      cursor: { column: 0, line: 0, visible: true },
      focusReporting: true,
      full: true,
      rows: [],
      sequence: 7,
      subscriptionId: "subscription-1",
      viewport: { columns: 100, generation: 0, screenLines: 24 },
    },
  };
  await act(async () => {
    emit(frameMessage);
  });
  await waitFor(() =>
    assert.ok(calls.some(({ command }) => command === "terminal_ack")),
  );
  assert.deepEqual(
    calls.find(({ command }) => command === "terminal_ack").args,
    {
      sequence: 7,
      sessionId: "session-1",
      subscriptionId: "subscription-1",
    },
  );

  await act(async () => {
    emit(frameMessage, 1);
  });
  assert.equal(
    calls.filter(({ command }) => command === "terminal_ack").length,
    1,
  );
});

test("resize during attach declares only the newest viewport ready", async () => {
  const { createElement } = await import("react");
  const { act, render, waitFor } = await import("@testing-library/react");
  const { ThemeProvider } = await import("@/shared/theme/ThemeProvider");
  const { TerminalBootstrap } = await import("./TerminalBootstrap.tsx");

  attachResolver = () => {};
  const view = render(
    createElement(
      ThemeProvider,
      null,
      createElement("div", {
        className: "buzz-huddle-app-surface",
        tabIndex: -1,
      }),
      createElement(TerminalBootstrap, {
        channelId: "channel-1",
        channelName: "general",
        npub: "npub1owner",
        relayUrl: "wss://relay.example",
        threadId: null,
      }),
    ),
  );
  await waitFor(() => assert.equal(typeof attachResolver, "function"));

  canvasWidth = 1_008;
  act(() => resizeCallback());
  await act(async () => attachResolver());
  await waitFor(() =>
    assert.ok(
      calls.some(({ command }) => command === "terminal_viewport_ready"),
    ),
  );

  const readyCalls = calls.filter(
    ({ command }) => command === "terminal_viewport_ready",
  );
  assert.equal(readyCalls.at(-1).args.viewport.columns, 120);
  assert.equal(
    readyCalls.every(({ args }) => args.viewport.columns === 120),
    true,
  );
  view.unmount();
});
