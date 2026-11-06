import {
  type EnvironmentId,
  type PresenceSnapshot,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export interface PresentMember {
  readonly userId: string;
  readonly name: string;
}

export interface ThreadPresence {
  /** Other members with the thread open, typers included. */
  readonly viewers: ReadonlyArray<PresentMember>;
  readonly typers: ReadonlyArray<PresentMember>;
}

const NO_THREAD_PRESENCE: ThreadPresence = { viewers: [], typers: [] };

export function selectThreadPresence(
  snapshot: PresenceSnapshot | null,
  threadId: ThreadId,
): ThreadPresence {
  if (snapshot === null || snapshot.members.length === 0) return NO_THREAD_PRESENCE;
  const viewers: Array<PresentMember> = [];
  const typers: Array<PresentMember> = [];
  for (const member of snapshot.members) {
    const typing = member.typingThreadIds.includes(threadId);
    if (typing) typers.push({ userId: member.userId, name: member.name });
    if (typing || member.viewingThreadIds.includes(threadId)) {
      viewers.push({ userId: member.userId, name: member.name });
    }
  }
  return viewers.length === 0 ? NO_THREAD_PRESENCE : { viewers, typers };
}

/** "Alex is typing…", "Alex and Sam are typing…", "Alex, Sam and 2 others are typing…". */
export function formatTypingLabel(names: ReadonlyArray<string>): string | null {
  const [first, second, third] = names;
  if (first === undefined) return null;
  if (second === undefined) return `${first} is typing…`;
  if (third === undefined) return `${first} and ${second} are typing…`;
  if (names.length === 3) return `${first}, ${second} and ${third} are typing…`;
  const others = names.length - 2;
  return `${first}, ${second} and ${others} others are typing…`;
}

/**
 * The member whose message started the running turn, when that is someone other than the viewer.
 * Sending then queues behind their turn instead of steering it.
 */
export function otherMemberTurnOwner(input: {
  readonly runs: ReadonlyArray<{ readonly id: string; readonly userMessageId: string }>;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly author?: PresentMember | undefined;
  }>;
  readonly activeRunId: string | null;
  readonly viewerUserId: string | null;
}): PresentMember | null {
  if (input.activeRunId === null || input.viewerUserId === null) return null;
  const run = input.runs.find((candidate) => candidate.id === input.activeRunId);
  if (run === undefined) return null;
  const author = input.messages.find((message) => message.id === run.userMessageId)?.author;
  return author === undefined || author.userId === input.viewerUserId ? null : author;
}

export function createPresenceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const snapshot = createEnvironmentSubscriptionAtomFamily(runtime, {
    label: "environment-data:presence:snapshot",
    subscribe: (_input: null) => subscribe(WS_METHODS.subscribePresence, {}),
  });
  const snapshotData = (get: Atom.AtomContext, environmentId: EnvironmentId) =>
    AsyncResult.getOrElse(get(snapshot({ environmentId, input: null })), () => null);

  // Rows read these narrow atoms; structural equality keeps unrelated presence changes from re-rendering them.
  const threadFamily = Atom.family((key: string) => {
    const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
    return Atom.make((get) =>
      selectThreadPresence(snapshotData(get, environmentId), threadId),
    ).pipe(
      Atom.withEquality<ThreadPresence>(Equal.equals),
      Atom.withLabel(`environment-data:presence:thread:${key}`),
    );
  });
  const viewerFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => snapshotData(get, environmentId)?.viewerUserId ?? null).pipe(
      Atom.withLabel(`environment-data:presence:viewer:${environmentId}`),
    ),
  );

  return {
    snapshot,
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:presence:update",
      tag: WS_METHODS.presenceUpdate,
      concurrency: { mode: "latest", key: ({ environmentId }) => environmentId },
    }),
    thread: (environmentId: EnvironmentId, threadId: ThreadId) =>
      threadFamily(JSON.stringify([environmentId, threadId])),
    /** Which member this client is on the environment; null when it has no members. */
    viewerUserId: viewerFamily,
  };
}
