import type { DesktopUpdateState } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createDesktopUpdateStateAtom } from "./desktopUpdate";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("desktopUpdateStateAtom", () => {
  it("does not let a slower initial read overwrite a newer update event", async () => {
    const initial = deferred<DesktopUpdateState>();
    const subscribed = deferred<(state: DesktopUpdateState) => void>();
    const atom = createDesktopUpdateStateAtom(() => ({
      getUpdateState: () => initial.promise,
      onUpdateState: (listener) => {
        subscribed.resolve(listener);
        return () => undefined;
      },
    }));
    const registry = AtomRegistry.make();
    registry.mount(atom);
    const seen: Array<DesktopUpdateState | null> = [];
    registry.subscribe(atom, (result) => {
      seen.push(AsyncResult.getOrElse(result, () => null));
    });

    const listener = await subscribed.promise;
    const newerState: DesktopUpdateState = { ...baseState, status: "checking" };
    listener(newerState);
    initial.resolve(baseState);
    // The initial read settles before this later event; a stale write would show up between them.
    const settled = deferred<void>();
    const laterState: DesktopUpdateState = { ...baseState, status: "downloading" };
    const unsubscribe = registry.subscribe(atom, (result) => {
      if (AsyncResult.getOrElse(result, () => null) === laterState) settled.resolve();
    });
    await initial.promise;
    listener(laterState);
    await settled.promise;
    unsubscribe();

    expect(seen).toEqual([newerState, laterState]);
    registry.dispose();
  });
});
