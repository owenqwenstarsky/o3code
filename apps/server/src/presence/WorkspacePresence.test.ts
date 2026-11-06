import { assert, it } from "@effect/vitest";
import { type PresenceSnapshot, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as WorkspacePresence from "./WorkspacePresence.ts";

const alex = { userId: "alex", name: "Alex" };
const sam = { userId: "sam", name: "Sam" };
const threadA = ThreadId.make("thread:a");
const threadB = ThreadId.make("thread:b");

const watch = (selfUserId: string | undefined) =>
  Effect.gen(function* () {
    const presence = yield* WorkspacePresence.WorkspacePresence;
    const snapshots = yield* Queue.unbounded<PresenceSnapshot>();
    yield* presence.stream(selfUserId).pipe(
      Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
      Effect.forkScoped,
    );
    const next = Queue.take(snapshots);
    // The current state arrives first.
    assert.deepEqual(yield* next, { viewerUserId: selfUserId ?? null, members: [] });
    return Effect.map(next, (snapshot) => snapshot.members);
  });

it.effect("folds a member's tabs, hides yourself, and expires typing and closed connections", () =>
  Effect.gen(function* () {
    const presence = yield* WorkspacePresence.WorkspacePresence;
    const next = yield* watch(alex.userId);

    // Your own presence never reaches you.
    yield* presence.update("alex-tab", Option.some(alex), {
      viewingThreadId: threadA,
      typingThreadId: threadA,
    });
    yield* presence.update("sam-tab-1", Option.some(sam), {
      viewingThreadId: threadA,
      typingThreadId: threadA,
    });
    assert.deepEqual(yield* next, [
      { userId: "sam", name: "Sam", viewingThreadIds: [threadA], typingThreadIds: [threadA] },
    ]);

    // A second tab adds a thread to the same member instead of a second member.
    yield* presence.update("sam-tab-2", Option.some(sam), {
      viewingThreadId: threadB,
      typingThreadId: null,
    });
    assert.deepEqual(yield* next, [
      {
        userId: "sam",
        name: "Sam",
        viewingThreadIds: [threadA, threadB],
        typingThreadIds: [threadA],
      },
    ]);

    // Repeating the same state emits nothing, so the next snapshot is the typing expiry.
    yield* presence.update("sam-tab-2", Option.some(sam), {
      viewingThreadId: threadB,
      typingThreadId: null,
    });
    // Typing the client stops refreshing clears itself.
    yield* TestClock.adjust(WorkspacePresence.TYPING_EXPIRES_AFTER);
    assert.deepEqual((yield* next)[0]?.typingThreadIds, []);

    yield* presence.remove("sam-tab-1");
    assert.deepEqual((yield* next)[0]?.viewingThreadIds, [threadB]);
    yield* presence.remove("sam-tab-2");
    assert.deepEqual(yield* next, []);
  }).pipe(Effect.scoped, Effect.provide(WorkspacePresence.layer)),
);

it.effect("ignores connections without a member and typing outside the viewed thread", () =>
  Effect.gen(function* () {
    const presence = yield* WorkspacePresence.WorkspacePresence;
    const next = yield* watch(undefined);

    yield* presence.update("local", Option.none(), {
      viewingThreadId: threadA,
      typingThreadId: threadA,
    });

    yield* presence.update("sam-tab", Option.some(sam), {
      viewingThreadId: threadA,
      typingThreadId: threadB,
    });
    assert.deepEqual(yield* next, [
      { userId: "sam", name: "Sam", viewingThreadIds: [threadA], typingThreadIds: [] },
    ]);

    // A hidden tab views nothing, so the member drops out.
    yield* presence.update("sam-tab", Option.some(sam), {
      viewingThreadId: null,
      typingThreadId: null,
    });
    assert.deepEqual(yield* next, []);
  }).pipe(Effect.scoped, Effect.provide(WorkspacePresence.layer)),
);
