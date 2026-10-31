import { buildTailscaleHttpsBaseUrl, readTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";

/**
 * The origin (`scheme://host[:port]`) at which people other than the owner reach this
 * environment, such as a guest opening a link or a webhook sender. None means the environment
 * has no such address, so guest links are unavailable and webhook URLs stay relative.
 */
export class EnvironmentPublicOrigin extends Context.Reference<{
  readonly current: Effect.Effect<Option.Option<string>>;
}>("t3/environment/EnvironmentPublicOrigin", {
  defaultValue: () => ({ current: Effect.succeedNone }),
}) {}

/**
 * Behind Tailscale Serve (every O3 workspace), the environment's tailnet HTTPS name is where
 * others on the tailnet reach it. The name is read lazily and cached; it rarely changes.
 */
export const layerFromConfig = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (!config.tailscaleServeEnabled) return Layer.empty;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const current = yield* Effect.cachedWithTTL(
      readTailscaleStatus.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.map((status) =>
          Option.map(Option.fromNullishOr(status.magicDnsName), (magicDnsName) =>
            buildTailscaleHttpsBaseUrl({
              magicDnsName,
              servePort: config.tailscaleServePort,
            }).replace(/\/$/, ""),
          ),
        ),
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
      "5 minutes",
    );
    return Layer.succeed(EnvironmentPublicOrigin, { current });
  }),
);
