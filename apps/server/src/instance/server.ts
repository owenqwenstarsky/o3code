// @effect-diagnostics nodeBuiltinImport:off -- NodeHttpServer takes a node:http server factory.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ensureTailscaleServe } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { loopbackUrlHostForAddress } from "../startupAccess.ts";
import * as AuthSync from "./AuthSync.ts";
import * as InstanceAuth from "./InstanceAuth.ts";
import * as InstanceConfig from "./InstanceConfig.ts";
import * as InstanceHttp from "./http.ts";
import * as InstanceSettings from "./InstanceSettings.ts";
import * as InstanceStore from "./InstanceStore.ts";
import * as InstanceUsers from "./InstanceUsers.ts";
import * as TailscaleKeys from "./TailscaleKeys.ts";
import * as WorkspaceRuntime from "./WorkspaceRuntime.ts";
import * as Workspaces from "./Workspaces.ts";

/** Instance services over an already-provided database and `ServerConfig`. */
export const layerServices = InstanceUsers.layer.pipe(
  Layer.provideMerge(AuthSync.layer),
  Layer.provideMerge(Workspaces.layer),
  Layer.provideMerge(InstanceAuth.layer),
  Layer.provideMerge(TailscaleKeys.layer),
  Layer.provideMerge(WorkspaceRuntime.layer),
  Layer.provideMerge(InstanceSettings.layer),
  Layer.provideMerge(InstanceStore.layer),
  Layer.provideMerge(
    SessionStore.layer.pipe(
      Layer.provideMerge(ServerEnvironment.layer),
      Layer.provideMerge(ServerSecretStore.layer),
    ),
  ),
);

const layerRoutes = Layer.mergeAll(InstanceHttp.layer, ServerHttp.layerStaticAndDevRoute).pipe(
  Layer.provide(ServerHttp.layerBrowserApiCors),
  Layer.provide(ServerHttp.layerHttpCompression),
);

const layerHttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return NodeHttpServer.layer(() => NodeHttp.createServer(), {
      host: config.host ?? "127.0.0.1",
      port: config.port,
      gracefulShutdownTimeout: 0,
    });
  }),
);

const layerTailscaleServe = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (!config.tailscaleServeEnabled) return Layer.empty;
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) return;
        yield* ensureTailscaleServe({
          localPort: address.port,
          servePort: config.tailscaleServePort,
          localHost: loopbackUrlHostForAddress(address),
        }).pipe(
          Effect.tap(() => Effect.logInfo("Tailscale Serve configured for the instance.")),
          Effect.catch((cause) =>
            Effect.logWarning("Failed to configure Tailscale Serve for the instance.", { cause }),
          ),
        );
      }),
    );
  }),
);

const layerStartupLog = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const config = yield* InstanceConfig.InstanceConfig;
    const address = server.address;
    yield* Effect.logInfo("O3 instance listening", {
      port: "port" in address ? address.port : null,
      runtime: config.runtime.kind,
      tailscale: config.tailscale.mode,
    });
    if (config.tailscale.mode === "none" && config.runtime.kind === "docker") {
      yield* Effect.logWarning(
        "No Tailscale credentials: workspaces cannot join the tailnet. Set O3_TS_OAUTH_CLIENT_ID and O3_TS_OAUTH_CLIENT_SECRET.",
      );
    }
  }),
);

const layerInstanceServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const layerApp = Layer.mergeAll(
      HttpRouter.serve(layerRoutes, { disableLogger: true }),
      Layer.effectDiscard(
        InstanceUsers.InstanceUsers.pipe(Effect.flatMap((users) => users.bootstrap)),
      ),
      layerTailscaleServe,
      layerStartupLog,
    );
    return layerApp.pipe(
      Layer.provideMerge(layerServices),
      Layer.provideMerge(InstanceConfig.layerFromEnv),
      Layer.provideMerge(SqlitePersistence.layerFromPath(config.dbPath)),
      Layer.provideMerge(layerHttpServer),
      Layer.provideMerge(FetchHttpClient.layer),
    );
  }),
);

export const runInstanceServer = Layer.launch(layerInstanceServer);
