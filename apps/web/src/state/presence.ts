import { useAtomValue } from "@effect/atom-react";
import {
  createPresenceEnvironmentAtoms,
  type ThreadPresence,
} from "@t3tools/client-runtime/state/presence";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";

export const presenceEnvironment = createPresenceEnvironmentAtoms(connectionAtomRuntime);

/** Flips only on connect and disconnect, so presence can be re-sent to a fresh socket. */
export const environmentConnectedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentPresentations.presentationAtom(environmentId))?.connection.phase ===
      "connected",
  ).pipe(Atom.withLabel(`web-environment-connected:${environmentId}`)),
);

const NO_PRESENCE_ATOM = Atom.make<ThreadPresence>({ viewers: [], typers: [] }).pipe(
  Atom.withLabel("web-thread-presence:empty"),
);

export function useThreadPresence(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ThreadPresence {
  return useAtomValue(
    environmentId === null || threadId === null
      ? NO_PRESENCE_ATOM
      : presenceEnvironment.thread(environmentId, threadId),
  );
}
