import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { promptLinkAppPath } from "@t3tools/shared/promptLinks";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { openFileInPreview, openUrlInPreview } from "../../browser/openFileInPreview";
import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useOpenChangeRequestLink } from "../../lib/openPullRequestLink";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { assetEnvironment } from "../../state/assets";
import { readProject, readThreadShell } from "../../state/entities";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironment } from "../../state/environments";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** A link handed over by the OS is a plain click: nothing about it asks for the browser. */
const externalClick = {
  preventDefault() {},
  stopPropagation() {},
  metaKey: false,
  ctrlKey: false,
};

/**
 * HTML files are served by this machine's environment, so only its threads can
 * take them.
 */
function threadShowingBrowser(
  routeParams: Record<string, string | undefined>,
  fileEnvironmentId: EnvironmentId | null,
): ScopedThreadRef | null {
  const target = resolveThreadRouteTarget(routeParams);
  if (target === null) return null;
  let threadRef = target.kind === "server" ? target.threadRef : null;
  if (target.kind === "draft") {
    const session = useComposerDraftStore.getState().getDraftSession(target.draftId);
    if (!session || session.promotedTo) return null;
    threadRef = scopeThreadRef(session.environmentId, session.threadId);
  }
  if (threadRef === null || !isPreviewAvailableFor(threadRef.environmentId)) return null;
  if (fileEnvironmentId !== null && threadRef.environmentId !== fileEnvironmentId) return null;
  const surface = selectActiveRightPanelSurface(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  );
  return surface?.kind === "preview" ? threadRef : null;
}

export function DesktopWebLinkCoordinator() {
  const router = useRouter();
  const primaryEnvironment = usePrimaryEnvironment();
  const openChangeRequest = useOpenChangeRequestLink();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const openThread = useNewThreadHandler();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const httpBaseUrl = useEnvironmentHttpBaseUrl(primaryEnvironment?.environmentId ?? null);
  const queueRef = useRef(Promise.resolve());
  const webLinks = window.desktopBridge?.webLinks;

  const reportFailure = (url: string, description = url) =>
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Could not open the link", description }),
    );

  const startThread = async (url: string): Promise<ScopedThreadRef | null> => {
    const environmentId = scratchEnvironmentId(primaryEnvironment?.environmentId ?? null);
    if (environmentId === null) {
      reportFailure(url);
      return null;
    }
    const project = await openScratchProject(environmentId, "Could not open the link");
    if (!project) return null;
    const opened = await openThread(scopeProjectRef(project.environmentId, project.id));
    if (!opened) {
      reportFailure(url);
      return null;
    }
    const threadRef = scopeThreadRef(project.environmentId, opened.threadId);
    useRightPanelStore.getState().requestMaximize(threadRef);
    return threadRef;
  };

  const openInBrowser = useEffectEvent(async (url: string) => {
    const routeParams = router.state.matches.at(-1)?.params ?? {};
    const isFile = url.startsWith("file:");
    // Only this machine's environment serves files, so fail before starting a thread.
    if (isFile && httpBaseUrl === null) {
      reportFailure(url);
      return;
    }
    const threadRef =
      threadShowingBrowser(
        routeParams,
        isFile ? (primaryEnvironment?.environmentId ?? null) : null,
      ) ?? (await startThread(url));
    if (threadRef === null) return;
    const result = isFile
      ? httpBaseUrl === null
        ? null
        : await openFileInPreview({
            threadRef,
            filePath: decodeURIComponent(new URL(url).pathname),
            workspaceRoot: undefined,
            httpBaseUrl,
            createAssetUrl,
            openPreview,
          })
      : await openUrlInPreview({ threadRef, url, openPreview });
    if (result === null) {
      reportFailure(url);
      return;
    }
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      reportFailure(url, error instanceof Error ? error.message : url);
    }
  });

  const openLink = useEffectEvent(async (url: string) => {
    const appPath = promptLinkAppPath(url);
    if (appPath !== null) {
      await router.navigate({ href: appPath });
      return;
    }
    const routeParams = router.state.matches.at(-1)?.params ?? {};
    const routeTarget = resolveThreadRouteTarget(routeParams);
    const activeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : undefined;
    const activeThread = activeThreadRef ? readThreadShell(activeThreadRef) : null;
    const activeProject =
      activeThread && activeThreadRef
        ? readProject(scopeProjectRef(activeThreadRef.environmentId, activeThread.projectId))
        : null;
    const commitThreadRef =
      activeThread &&
      sourceControlClients.parseCommitUrl(url, activeProject?.repositoryIdentity?.provider) !== null
        ? activeThreadRef
        : undefined;
    // A commit the thread's workspace lacks continues here, after its lookup.
    const openUnavailableCommit = () => {
      queueRef.current = queueRef.current.then(() => openInBrowser(url)).catch(() => undefined);
    };
    if (openChangeRequest(externalClick, url, commitThreadRef, undefined, openUnavailableCommit))
      return;
    await openInBrowser(url);
  });

  const receiveLink = useEffectEvent((url: string) => {
    queueRef.current = queueRef.current.then(() => openLink(url)).catch(() => undefined);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop web link opens over the bridge and marks the renderer ready
  useEffect(() => {
    if (webLinks === undefined) return;
    let subscribed = true;
    const unsubscribe = webLinks.onOpen(receiveLink);
    queueMicrotask(() => {
      if (subscribed) void webLinks.setReady(true).catch(() => undefined);
    });
    return () => {
      subscribed = false;
      void webLinks.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, [webLinks]);

  return null;
}
