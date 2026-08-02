import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const callbacks = new Map();
const calls = [];
let nextCallback = 1;
let channel;

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
    right: 840,
    top: 0,
    width: 840,
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
        return Promise.resolve({
          sessionId: "session-1",
          subscriptionId: "subscription-1",
          viewport: { columns: 100, generation: 0, screenLines: 24 },
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

function emit(message, index = 0) {
  const id = Number(channel.toJSON().slice("__CHANNEL__:".length));
  callbacks.get(id)({ index, message });
}

test("mounted bootstrap passes GUI context and ACKs only after consuming a frame", async () => {
  const { createElement } = await import("react");
  const { act, render, waitFor } = await import("@testing-library/react");
  const { ThemeProvider } = await import("@/shared/theme/ThemeProvider");
  const { TerminalBootstrap } = await import("./TerminalBootstrap.tsx");

  render(
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

  await act(async () => {
    emit({
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
    });
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
});
