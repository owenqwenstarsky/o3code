import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConnectionCatalogStore from "../../app/DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { getConnectionCatalog, setConnectionCatalog } from "./connectionCatalog.ts";

vi.mock("electron", () => ({}));

it.effect.each([false, true])(
  "authorizes catalog reads and writes in development=%s",
  (isDevelopment) => {
    const calls: string[] = [];
    const frame = { url: `${isDevelopment ? "t3code-dev" : "t3code"}://app/settings` };
    const trusted = { sender: { id: 7 }, senderFrame: frame };
    return Effect.gen(function* () {
      for (const event of [
        undefined,
        { ...trusted, sender: { id: 8 } },
        { sender: { id: 7 } },
        { ...trusted, senderFrame: null },
        { ...trusted, senderFrame: { ...frame } },
      ]) {
        assert(Exit.isFailure(yield* Effect.exit(getConnectionCatalog.handler(undefined, event))));
        assert(Exit.isFailure(yield* Effect.exit(setConnectionCatalog.handler("catalog", event))));
      }
      for (const url of [
        "https://evil.example/",
        "t3code://other/",
        "t3code-dev://other/",
        `${isDevelopment ? "t3code" : "t3code-dev"}://app/`,
        "file:///tmp/guest.html",
        "not a URL",
      ]) {
        frame.url = url;
        assert(
          Exit.isFailure(yield* Effect.exit(getConnectionCatalog.handler(undefined, trusted))),
        );
        assert(
          Exit.isFailure(yield* Effect.exit(setConnectionCatalog.handler("catalog", trusted))),
        );
      }
      assert.deepEqual(calls, []);
      frame.url = `${isDevelopment ? "t3code-dev" : "t3code"}://app/settings`;
      assert.equal(yield* getConnectionCatalog.handler(undefined, trusted), "secret");
      assert.equal(yield* setConnectionCatalog.handler("catalog", trusted), true);
      assert.deepEqual(calls, ["get", "catalog"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ElectronWindow.ElectronWindow, {
            main: Effect.succeedSome({ webContents: { id: 7, mainFrame: frame } }),
          } as unknown as ElectronWindow.ElectronWindow["Service"]),
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            isDevelopment,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
          Layer.succeed(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, {
            get: Effect.sync(() => {
              calls.push("get");
              return Option.some("secret");
            }),
            set: (catalog: string) =>
              Effect.sync(() => {
                calls.push(catalog);
                return true;
              }),
          }),
        ),
      ),
    );
  },
);
