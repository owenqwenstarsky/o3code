import { expect, it, vi } from "vite-plus/test";

import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "./useLiveRefresh";

const lifecycle = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | undefined>,
}));

vi.mock("react", () => ({
  useId: () => "unkeyed-view",
  useEffectEvent: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | undefined) => lifecycle.effects.push(effect),
}));

function setup() {
  lifecycle.effects = [];
  const browser = new EventTarget();
  vi.stubGlobal("document", Object.assign(browser, { visibilityState: "visible" }));
  vi.stubGlobal("window", browser);
  const mount = (refresh: () => void, key?: string) => {
    useLiveRefresh(refresh, { ...(key === undefined ? {} : { key }), intervalMs: null });
    const disposers = lifecycle.effects.splice(0).map((effect) => effect());
    return {
      [Symbol.dispose]: () => {
        for (const dispose of disposers) dispose?.();
      },
    };
  };
  return { mount, [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

it("drops unkeyed timestamps when their hook unmounts", () => {
  using harness = setup();
  using now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const refresh = vi.fn();
  {
    using _view = harness.mount(refresh);
  }
  now.mockReturnValue(1_000_000 + LIVE_REFRESH_MIN_INTERVAL_MS);
  using _view = harness.mount(refresh);
  expect(refresh).not.toHaveBeenCalled();
});

it("bounds retained keyed timestamps while preserving recent views across remounts", () => {
  using harness = setup();
  using now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
  const refresh = vi.fn();
  for (let index = 0; index <= 512; index++) {
    using _view = harness.mount(refresh, `bounded-${index}`);
  }
  now.mockReturnValue(2_000_000 + LIVE_REFRESH_MIN_INTERVAL_MS);
  using _oldest = harness.mount(refresh, "bounded-0");
  expect(refresh).not.toHaveBeenCalled();
  using _recent = harness.mount(refresh, "bounded-512");
  expect(refresh).toHaveBeenCalledOnce();
});
