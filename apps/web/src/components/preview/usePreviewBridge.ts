import type {
  DesktopPreviewTabState,
  PreviewReportStatusInput,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { recordFaviconForThread } from "~/browserFaviconStore";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { acquireBrowserSurfaceActivity } from "~/browser/browserSurfaceStore";
import { applyPreviewDesktopState, type DesktopPreviewOverlay } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Keeps a hidden guest painting behind the app while the desktop host captures it; Electron
 * composites no offscreen guest, so its screenshot or stream would otherwise never finish.
 */
export function createCaptureActivity(tabId: string) {
  let release: (() => void) | null = null;
  const update = (capturing: boolean) => {
    if (capturing && !release) release = acquireBrowserSurfaceActivity(tabId);
    else if (!capturing && release) {
      release();
      release = null;
    }
  };
  return { update, release: () => update(false) };
}

/** ElectronBrowserHost owns webview lifetime. */
export function usePreviewBridge(input: {
  threadRef: ScopedThreadRef;
  tabId: string;
  runtimeTabId: string;
  serverDriven?: boolean;
}): void {
  const { threadRef, tabId, runtimeTabId, serverDriven = false } = input;
  const clearBrowserPointer = useBrowserPointerStore((state) => state.clear);
  const reportStatus = useAtomCommand(previewEnvironment.reportStatus, "preview status report");
  const { environmentId, threadId } = threadRef;
  const stableThreadRef: ScopedThreadRef = { environmentId, threadId };

  const delivery = useRef({
    input: null as PreviewReportStatusInput | null,
    nextId: 0,
    deliveredId: 0,
  });
  const lastDesktopNavStatus = useRef<DesktopPreviewTabState["navStatus"] | null>(null);
  const captureActivity = useRef<ReturnType<typeof createCaptureActivity> | null>(null);
  const handleStateChange = useEffectEvent(
    (changedTabId: string, state: DesktopPreviewTabState): void => {
      if (changedTabId !== runtimeTabId) return;
      if (shouldClearBrowserPointer(lastDesktopNavStatus.current, state.navStatus)) {
        clearBrowserPointer(runtimeTabId);
      }
      lastDesktopNavStatus.current = state.navStatus;
      captureActivity.current?.update(state.capturing);
      applyPreviewDesktopState(stableThreadRef, tabId, projectDesktopState(state));
      if (state.favicon) {
        recordFaviconForThread(stableThreadRef, state.favicon);
      }
      const pendingDelivery = delivery.current;
      const reported = buildReportInput({
        threadId: stableThreadRef.threadId,
        tabId,
        state,
        lastReportedInput:
          pendingDelivery.deliveredId === pendingDelivery.nextId ? pendingDelivery.input : null,
      });
      if (!reported || serverDriven) return;
      const reportId = ++pendingDelivery.nextId;
      void reportStatus({
        environmentId: stableThreadRef.environmentId,
        input: reported,
      }).then((result) => {
        if (result._tag === "Success" && reportId > pendingDelivery.deliveredId) {
          pendingDelivery.input = reported;
          pendingDelivery.deliveredId = reportId;
        }
      });
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to preview bridge state changes and capture activity for the current tab
  useEffect(() => {
    if (!previewBridge || typeof window === "undefined") return;
    delivery.current = { input: null, nextId: 0, deliveredId: 0 };
    lastDesktopNavStatus.current = null;
    const activity = createCaptureActivity(runtimeTabId);
    captureActivity.current = activity;
    const unsubscribe = previewBridge.onStateChange(handleStateChange);
    return () => {
      unsubscribe();
      activity.release();
      if (captureActivity.current === activity) captureActivity.current = null;
    };
  }, [
    runtimeTabId,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A different tab or thread starts its status reports and pointer tracking from scratch.
    environmentId,
    threadId,
    tabId,
  ]);
}

function shouldClearBrowserPointer(
  previous: DesktopPreviewTabState["navStatus"] | null,
  current: DesktopPreviewTabState["navStatus"],
): boolean {
  if (!previous) return false;
  if (current.kind === "Loading" && previous.kind !== "Loading") return true;
  if (current.kind === "Idle" || previous.kind === "Idle") return false;
  return current.url !== previous.url;
}

export function projectDesktopState(state: DesktopPreviewTabState): DesktopPreviewOverlay {
  const navOrigin = state.navStatus.kind === "Idle" ? null : originOf(state.navStatus.url);
  return {
    hasWebContents: state.webContentsId !== null,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    loading: state.navStatus.kind === "Loading",
    zoomFactor: state.zoomFactor,
    pictureInPicture: state.pictureInPicture,
    colorScheme: state.colorScheme,
    audioMuted: state.audioMuted,
    audible: state.audible,
    controller: state.controller,
    favicon: state.favicon && originOf(state.favicon.pageUrl) === navOrigin ? state.favicon : null,
  };
}

function buildReportInput(args: {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly state: DesktopPreviewTabState;
  readonly lastReportedInput: PreviewReportStatusInput | null;
}): PreviewReportStatusInput | null {
  const { threadId, tabId, state, lastReportedInput } = args;
  const status = state.navStatus;
  if (status.kind === "Idle") return null;

  const sameAsLast =
    status.kind !== "LoadFailed" &&
    status.kind === lastReportedInput?.navStatus._tag &&
    status.url === lastReportedInput.navStatus.url &&
    status.title === lastReportedInput.navStatus.title &&
    state.canGoBack === lastReportedInput.canGoBack &&
    state.canGoForward === lastReportedInput.canGoForward;
  if (sameAsLast) return null;

  const base = {
    threadId,
    tabId,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
  };
  if (status.kind === "LoadFailed") {
    return {
      ...base,
      navStatus: {
        _tag: "LoadFailed",
        url: status.url,
        title: status.title,
        code: status.code,
        description: status.description,
      },
    };
  }
  return {
    ...base,
    navStatus: { _tag: status.kind, url: status.url, title: status.title },
  };
}
