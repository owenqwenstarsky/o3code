import {
  type OrchestrationV2Member,
  PresenceSnapshot,
  type PresenceUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/** A typing flag the client stops refreshing (closed laptop, lost socket) clears itself. */
export const TYPING_EXPIRES_AFTER = Duration.seconds(6);

interface ConnectionPresence {
  readonly member: OrchestrationV2Member;
  readonly viewingThreadId: ThreadId | null;
  readonly typingThreadId: ThreadId | null;
}

type Connections = ReadonlyMap<string, ConnectionPresence>;

const snapshotEquivalence = Schema.toEquivalence(PresenceSnapshot);

function snapshotFor(connections: Connections, selfUserId: string | undefined): PresenceSnapshot {
  const byUser = new Map<string, { name: string; viewing: Set<ThreadId>; typing: Set<ThreadId> }>();
  for (const connection of connections.values()) {
    if (connection.member.userId === selfUserId) continue;
    if (connection.viewingThreadId === null && connection.typingThreadId === null) continue;
    const entry = byUser.get(connection.member.userId) ?? {
      name: connection.member.name,
      viewing: new Set<ThreadId>(),
      typing: new Set<ThreadId>(),
    };
    if (connection.viewingThreadId !== null) entry.viewing.add(connection.viewingThreadId);
    if (connection.typingThreadId !== null) entry.typing.add(connection.typingThreadId);
    byUser.set(connection.member.userId, entry);
  }
  return {
    viewerUserId: selfUserId ?? null,
    members: [...byUser.entries()]
      .map(([userId, entry]) => ({
        userId,
        name: entry.name,
        viewingThreadIds: [...entry.viewing].toSorted(),
        typingThreadIds: [...entry.typing].toSorted(),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)),
  };
}

/**
 * Who on a shared workspace is looking at or typing in which thread. Held in memory per
 * connection and never persisted; a connection's presence ends with its socket.
 */
export class WorkspacePresence extends Context.Service<
  WorkspacePresence,
  {
    readonly update: (
      connectionKey: string,
      member: Option.Option<OrchestrationV2Member>,
      input: PresenceUpdateInput,
    ) => Effect.Effect<void>;
    readonly remove: (connectionKey: string) => Effect.Effect<void>;
    /** The other members present, emitted whenever that changes. */
    readonly stream: (selfUserId: string | undefined) => Stream.Stream<PresenceSnapshot>;
  }
>()("t3/presence/WorkspacePresence") {}

const make = Effect.gen(function* () {
  const connections = yield* SubscriptionRef.make<Connections>(new Map());
  const typingExpiry = yield* FiberMap.make<string>();

  const clearTyping = (connectionKey: string) =>
    SubscriptionRef.update(connections, (current) => {
      const connection = current.get(connectionKey);
      if (connection === undefined || connection.typingThreadId === null) return current;
      return new Map(current).set(connectionKey, { ...connection, typingThreadId: null });
    });

  const update = Effect.fn("WorkspacePresence.update")(function* (
    connectionKey: string,
    member: Option.Option<OrchestrationV2Member>,
    input: PresenceUpdateInput,
  ) {
    // A plain local server has no members, so there is no one to show.
    if (member._tag === "None") return;
    // Typing only counts in the thread the member is looking at.
    const typingThreadId =
      input.typingThreadId !== null && input.typingThreadId === input.viewingThreadId
        ? input.typingThreadId
        : null;
    yield* SubscriptionRef.update(connections, (current) =>
      new Map(current).set(connectionKey, {
        member: member.value,
        viewingThreadId: input.viewingThreadId,
        typingThreadId,
      }),
    );
    if (typingThreadId === null) {
      yield* FiberMap.remove(typingExpiry, connectionKey);
    } else {
      yield* FiberMap.run(
        typingExpiry,
        connectionKey,
        Effect.sleep(TYPING_EXPIRES_AFTER).pipe(Effect.andThen(clearTyping(connectionKey))),
      );
    }
  });

  const remove = Effect.fn("WorkspacePresence.remove")(function* (connectionKey: string) {
    yield* FiberMap.remove(typingExpiry, connectionKey);
    yield* SubscriptionRef.update(connections, (current) => {
      if (!current.has(connectionKey)) return current;
      const next = new Map(current);
      next.delete(connectionKey);
      return next;
    });
  });

  return WorkspacePresence.of({
    update,
    remove,
    stream: (selfUserId) =>
      SubscriptionRef.changes(connections).pipe(
        Stream.map((current) => snapshotFor(current, selfUserId)),
        Stream.changesWith(snapshotEquivalence),
      ),
  });
});

export const layer = Layer.effect(WorkspacePresence, make);
