import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { awaitLauncherLoss } from "./launcherWatch.ts";

const launcherPid = 4100;
// Orphans are adopted by init or a subreaper, so the new parent is not always 1.
const subreaperPid = 1800;

const watch = (getParentPid: () => number, platform: NodeJS.Platform, startPid = launcherPid) =>
  awaitLauncherLoss({ launcherPid: startPid, getParentPid }).pipe(
    Effect.provideService(HostProcess.Platform, platform),
  );

it.effect("notices a launcher that was already gone when the watch began", () =>
  watch(() => subreaperPid, "linux"),
);

it.effect("keeps polling until the parent changes, then stops", () =>
  Effect.gen(function* () {
    const parents = [launcherPid, launcherPid, subreaperPid];
    let polls = 0;
    const fiber = yield* Effect.forkChild(watch(() => parents[polls++] ?? subreaperPid, "linux"));
    yield* TestClock.adjust("2 seconds");
    assert.isUndefined(fiber.pollUnsafe());
    yield* TestClock.adjust("2 seconds");
    yield* Fiber.join(fiber);
    assert.equal(polls, 3);
  }),
);

it.effect.each([
  { platform: "win32" as const, startPid: launcherPid, reason: "Windows keeps the exited parent" },
  { platform: "linux" as const, startPid: 1, reason: "init launched the backend" },
])("never fires when $reason", ({ platform, startPid }) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(watch(() => subreaperPid, platform, startPid));
    yield* TestClock.adjust("1 hour");
    assert.isUndefined(fiber.pollUnsafe());
    yield* Fiber.interrupt(fiber);
  }),
);
