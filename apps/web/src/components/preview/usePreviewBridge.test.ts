import { EnvironmentId, ThreadId, type DesktopPreviewTabState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";

const bridge = vi.hoisted(() => ({
  listener: undefined as ((tabId: string, state: DesktopPreviewTabState) => void) | undefined,
  report: vi.fn(),
  cleanup: undefined as (() => void) | undefined,
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) => ({ current }),
  useEffectEvent: (callback: unknown) => callback,
  useEffect: (effect: () => () => void) => {
    bridge.cleanup = effect();
  },
}));
vi.mock("./previewBridge", () => ({
  previewBridge: {
    onStateChange: (listener: typeof bridge.listener) => {
      bridge.listener = listener;
      return () => {
        bridge.listener = undefined;
      };
    },
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => bridge.report }));
vi.mock("~/state/preview", () => ({ previewEnvironment: {} }));
vi.mock("~/browser/browserPointerStore", () => ({ useBrowserPointerStore: () => vi.fn() }));
vi.mock("~/browserFaviconStore", () => ({ recordFaviconForThread: vi.fn() }));
vi.mock("~/previewStateStore", () => ({ applyPreviewDesktopState: vi.fn() }));

import { createCaptureActivity, projectDesktopState, usePreviewBridge } from "./usePreviewBridge";

function setupBridge() {
  bridge.report.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  vi.stubGlobal("window", {});
  usePreviewBridge({
    threadRef: { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") },
    tabId: "tab-1",
    runtimeTabId: "runtime-1",
  });
  return {
    send: (next: DesktopPreviewTabState) => bridge.listener!("runtime-1", next),
    [Symbol.dispose]: () => {
      bridge.cleanup?.();
      vi.unstubAllGlobals();
    },
  };
}

const favicon = {
  dataUrl: "data:image/png;base64,AAAA",
  pageUrl: "http://localhost:3000/app",
  capturedAt: 1,
};

function state(navStatus: DesktopPreviewTabState["navStatus"]): DesktopPreviewTabState {
  return {
    tabId: "tab-1",
    webContentsId: 1,
    navStatus,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    audioMuted: false,
    audible: false,
    controller: "none",
    capturing: false,
    favicon,
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

describe("projectDesktopState", () => {
  it("shows a retained icon only while the current document has the captured origin", () => {
    expect(
      projectDesktopState(
        state({ kind: "Loading", url: "http://localhost:3000/reload", title: "" }),
      ).favicon,
    ).toEqual(favicon);
    expect(
      projectDesktopState(
        state({
          kind: "LoadFailed",
          url: "https://example.com/",
          title: "",
          code: -105,
          description: "failed",
        }),
      ).favicon,
    ).toBeNull();
    expect(projectDesktopState(state({ kind: "Idle" })).favicon).toBeNull();
  });
});

describe("createCaptureActivity", () => {
  it("keeps the guest painting while the host captures it, alongside other activity", () => {
    const activity = () => useBrowserSurfaceStore.getState().activityByTabId["tab-1"];
    const recording = useBrowserSurfaceStore.getState().acquireActivity("tab-1");
    const capture = createCaptureActivity("tab-1");

    capture.update(true);
    capture.update(true);
    expect(activity()).toBe(2);
    capture.update(false);
    expect(activity()).toBe(1);
    capture.update(true);
    capture.release();
    capture.release();
    expect(activity()).toBe(1);
    recording();
    expect(activity()).toBeUndefined();
  });
});

describe("preview status delivery", () => {
  it("reports title and history changes without repeating unchanged state", async () => {
    using host = setupBridge();
    const next = state({ kind: "Success", url: "https://example.com", title: "First" });
    host.send(next);
    await bridge.report.mock.results.at(-1)!.value;
    host.send(next);
    expect(bridge.report).toHaveBeenCalledTimes(1);
    const titleChanged = state({ kind: "Success", url: "https://example.com", title: "Second" });
    for (const changed of [
      titleChanged,
      { ...titleChanged, canGoBack: true },
      { ...titleChanged, canGoBack: true, canGoForward: true },
    ]) {
      const count = bridge.report.mock.calls.length;
      host.send(changed);
      expect(bridge.report).toHaveBeenCalledTimes(count + 1);
      expect(bridge.report.mock.calls.at(-1)![0].input).toMatchObject({
        canGoBack: changed.canGoBack,
        canGoForward: changed.canGoForward,
        navStatus: { title: changed.navStatus.kind === "Idle" ? "" : changed.navStatus.title },
      });
      await bridge.report.mock.results.at(-1)!.value;
    }
  });

  it("retries a failed report when the same desktop state arrives again", async () => {
    using host = setupBridge();
    bridge.report.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
    const next = state({ kind: "Success", url: "https://example.com", title: "Page" });
    host.send(next);
    await bridge.report.mock.results.at(-1)!.value;
    host.send(next);
    expect(bridge.report).toHaveBeenCalledTimes(2);
    await bridge.report.mock.results.at(-1)!.value;
    host.send(next);
    expect(bridge.report).toHaveBeenCalledTimes(2);
  });

  it("reports a return to the delivered state while a different status is pending", async () => {
    using host = setupBridge();
    const next = state({ kind: "Success", url: "https://example.com", title: "Page" });
    host.send(next);
    await bridge.report.mock.results.at(-1)!.value;
    let finish!: (result: ReturnType<typeof AsyncResult.success<void>>) => void;
    const pending = new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
      finish = resolve;
    });
    bridge.report.mockReturnValueOnce(pending);
    host.send(state({ kind: "Loading", url: "https://example.com/other", title: "Other" }));
    host.send(next);
    try {
      expect(bridge.report).toHaveBeenCalledTimes(3);
      await bridge.report.mock.results.at(-1)!.value;
    } finally {
      finish(AsyncResult.success(undefined));
      await pending;
    }
    host.send(next);
    expect(bridge.report).toHaveBeenCalledTimes(3);
  });
});
