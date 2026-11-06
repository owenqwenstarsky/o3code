import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useContext, useEffect } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { environmentConnectedAtom, presenceEnvironment } from "../../state/presence";

/** How often a typing member re-announces; the server clears an unrefreshed flag after 6s. */
const TYPING_REFRESH_MS = 3_000;
/** A draft left untouched this long no longer counts as typing. */
const TYPING_IDLE_MS = 4_000;

/**
 * Tells the other members of a shared workspace that this thread is open here and whether its
 * composer is being typed in. Sends nothing on a server with no members.
 */
export function usePresencePublisher(environmentId: EnvironmentId, threadId: ThreadId | null) {
  const registry = useContext(RegistryContext);
  const isMember = useAtomValue(presenceEnvironment.viewerUserId(environmentId)) !== null;
  // Presence lives with the socket, so a reconnect starts from nothing and is sent again.
  const connected = useAtomValue(environmentConnectedAtom(environmentId));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes this tab's presence to the server and follows the composer store and page visibility.
  useEffect(() => {
    if (threadId === null || !isMember || !connected) return;
    const threadRef = scopeThreadRef(environmentId, threadId);
    let typing = false;
    let lastTypingSentAt = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== "hidden";
    const send = (viewing: boolean) => {
      void runAtomCommand(
        registry,
        presenceEnvironment.update,
        {
          environmentId,
          input: {
            viewingThreadId: viewing ? threadId : null,
            typingThreadId: viewing && typing ? threadId : null,
          },
        },
        { reportFailure: false, reportDefect: false },
      );
    };
    const stopTyping = () => {
      clearTimeout(idleTimer);
      if (!typing) return;
      typing = false;
      send(visible());
    };
    const readPrompt = () =>
      useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt ?? "";
    let prompt = readPrompt();
    const unsubscribe = useComposerDraftStore.subscribe(() => {
      const next = readPrompt();
      if (next === prompt) return;
      prompt = next;
      // Sending clears the draft, which ends typing.
      if (next.trim() === "") return stopTyping();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
      const now = Date.now();
      if (typing && now - lastTypingSentAt < TYPING_REFRESH_MS) return;
      typing = true;
      lastTypingSentAt = now;
      send(visible());
    });
    const onVisibilityChange = () => {
      if (!visible()) typing = false;
      send(visible());
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    send(visible());
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimeout(idleTimer);
      typing = false;
      send(false);
    };
  }, [registry, environmentId, threadId, isMember, connected]);
}
