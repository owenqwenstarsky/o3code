import { parseTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as DockerEngine from "./DockerEngine.ts";
import { InstanceConfig } from "./InstanceConfig.ts";

const WORKSPACE_T3_PORT = 3773;

/** The static dev runtime serves every user, so its workspace credential names no user. */
export const STATIC_WORKSPACE_USER = "static";

export interface WorkspaceRuntimeSpec {
  readonly userId: string;
  readonly slug: string;
  readonly image: string;
  readonly tools: ReadonlyArray<string>;
  readonly limits: { readonly cpus: number; readonly memoryMb: number; readonly pids: number };
  readonly instanceUrl: string;
  readonly workspaceSecret: string;
  readonly tailscaleAuthKey: Redacted.Redacted<string> | null;
  readonly tailscaleTag: string;
}

export interface WorkspaceRuntimeState {
  readonly containerId: string;
  readonly running: boolean;
  readonly image: string;
  readonly detail: string;
}

export interface WorkspaceProbe {
  /** The workspace's MagicDNS name once it has joined the tailnet. */
  readonly tailnetHostname: string | null;
  readonly ready: boolean;
}

export type WorkspaceRuntimeError = DockerEngine.DockerEngineError;

/** Where workspaces run. Docker in production; `static` points every user at one dev server. */
export class WorkspaceRuntime extends Context.Service<
  WorkspaceRuntime,
  {
    readonly kind: "docker" | "static";
    readonly info: Effect.Effect<
      {
        readonly version: string | null;
        readonly cpus: number | null;
        readonly memoryBytes: number | null;
      },
      WorkspaceRuntimeError
    >;
    readonly create: (spec: WorkspaceRuntimeSpec) => Effect.Effect<string, WorkspaceRuntimeError>;
    readonly start: (containerId: string) => Effect.Effect<void, WorkspaceRuntimeError>;
    readonly stop: (containerId: string) => Effect.Effect<void, WorkspaceRuntimeError>;
    readonly restart: (containerId: string) => Effect.Effect<void, WorkspaceRuntimeError>;
    readonly removeContainer: (containerId: string) => Effect.Effect<void, WorkspaceRuntimeError>;
    readonly removeData: (userId: string) => Effect.Effect<void, WorkspaceRuntimeError>;
    readonly inspect: (
      containerIdOrSlug: string,
    ) => Effect.Effect<Option.Option<WorkspaceRuntimeState>, WorkspaceRuntimeError>;
    readonly probe: (containerId: string) => Effect.Effect<WorkspaceProbe, WorkspaceRuntimeError>;
    readonly logs: (containerId: string) => Effect.Effect<string, WorkspaceRuntimeError>;
    readonly diskUsage: Effect.Effect<ReadonlyMap<string, number>, WorkspaceRuntimeError>;
  }
>()("t3/instance/WorkspaceRuntime") {}

export const containerName = (slug: string) => `o3-ws-${slug}`;
const tailnetHostnameFor = (slug: string) => `o3-${slug}`;
const homeVolumeName = (userId: string) => `o3-home-${userId}`;
const tailscaleVolumeName = (userId: string) => `o3-tailscale-${userId}`;

const makeDockerRuntime = (engine: DockerEngine.DockerEngine["Service"], network: string) =>
  WorkspaceRuntime.of({
    kind: "docker",
    info: engine.info.pipe(
      Effect.map((info) => ({
        version: info.serverVersion,
        cpus: info.cpus,
        memoryBytes: info.memoryBytes,
      })),
    ),
    create: Effect.fn("WorkspaceRuntime.create")(function* (spec) {
      yield* engine.ensureImage(spec.image);
      yield* engine.ensureNetwork(network);
      const labels = { "dev.o3code.managed": "true", "dev.o3code.user": spec.userId };
      yield* engine.ensureVolume(homeVolumeName(spec.userId), labels);
      yield* engine.ensureVolume(tailscaleVolumeName(spec.userId), labels);
      const name = containerName(spec.slug);
      // A container left behind by an interrupted create would block the name.
      yield* engine.removeContainer(name);
      return yield* engine.createContainer({
        name,
        image: spec.image,
        hostname: tailnetHostnameFor(spec.slug),
        network,
        labels,
        env: {
          O3_TOOLS: spec.tools.join(","),
          O3_TS_HOSTNAME: tailnetHostnameFor(spec.slug),
          O3_TS_TAGS: spec.tailscaleTag,
          ...(spec.tailscaleAuthKey
            ? { O3_TS_AUTHKEY: Redacted.value(spec.tailscaleAuthKey) }
            : {}),
          T3CODE_O3_INSTANCE_URL: spec.instanceUrl,
          T3CODE_O3_USER_ID: spec.userId,
          T3CODE_O3_WORKSPACE_SECRET: spec.workspaceSecret,
        },
        mounts: [
          { volume: homeVolumeName(spec.userId), target: "/home/o3" },
          { volume: tailscaleVolumeName(spec.userId), target: "/var/lib/tailscale" },
        ],
        cpus: spec.limits.cpus,
        memoryBytes: spec.limits.memoryMb * 1024 * 1024,
        pids: spec.limits.pids,
        // Kernel-mode tailscaled, so tools in the workspace reach the tailnet like any device.
        capAdd: ["NET_ADMIN"],
        devices: ["/dev/net/tun"],
      });
    }),
    start: engine.startContainer,
    stop: engine.stopContainer,
    restart: engine.restartContainer,
    removeContainer: engine.removeContainer,
    removeData: Effect.fn("WorkspaceRuntime.removeData")((userId) =>
      engine
        .removeVolume(homeVolumeName(userId))
        .pipe(Effect.andThen(engine.removeVolume(tailscaleVolumeName(userId)))),
    ),
    inspect: Effect.fn("WorkspaceRuntime.inspect")((containerIdOrSlug) =>
      engine.inspectContainer(containerIdOrSlug).pipe(
        Effect.map(
          Option.map((state) => ({
            containerId: state.id,
            running: state.running,
            image: state.image,
            detail:
              state.error.length > 0
                ? state.error
                : state.running
                  ? "running"
                  : `${state.status} (exit ${state.exitCode})`,
          })),
        ),
      ),
    ),
    probe: Effect.fn("WorkspaceRuntime.probe")(function* (containerId) {
      const status = yield* engine.exec(containerId, ["tailscale", "status", "--json"]);
      const tailnetHostname =
        status.exitCode === 0
          ? yield* parseTailscaleStatus(status.output).pipe(
              Effect.map((parsed) => parsed.magicDnsName),
              Effect.orElseSucceed(() => null),
            )
          : null;
      const health = yield* engine.exec(containerId, [
        "curl",
        "-fsS",
        "-o",
        "/dev/null",
        `http://127.0.0.1:${WORKSPACE_T3_PORT}/.well-known/t3/environment`,
      ]);
      return { tailnetHostname, ready: health.exitCode === 0 && tailnetHostname !== null };
    }),
    logs: Effect.fn("WorkspaceRuntime.logs")((containerId) => engine.logs(containerId, 400)),
    diskUsage: engine.volumeSizes.pipe(
      Effect.map(
        (sizes) =>
          new Map(
            [...sizes].flatMap(([name, size]) =>
              name.startsWith("o3-home-") ? [[name.slice("o3-home-".length), size] as const] : [],
            ),
          ),
      ),
    ),
  });

const makeStaticRuntime = (url: string) => {
  const host = new URL(url).host;
  return WorkspaceRuntime.of({
    kind: "static",
    info: Effect.succeed({ version: null, cpus: null, memoryBytes: null }),
    create: Effect.fn("WorkspaceRuntime.create")(() => Effect.succeed("static")),
    start: Effect.fn("WorkspaceRuntime.start")(() => Effect.void),
    stop: Effect.fn("WorkspaceRuntime.stop")(() => Effect.void),
    restart: Effect.fn("WorkspaceRuntime.restart")(() => Effect.void),
    removeContainer: Effect.fn("WorkspaceRuntime.removeContainer")(() => Effect.void),
    removeData: Effect.fn("WorkspaceRuntime.removeData")(() => Effect.void),
    inspect: Effect.fn("WorkspaceRuntime.inspect")(() =>
      Effect.succeedSome({ containerId: "static", running: true, image: "static", detail: url }),
    ),
    probe: Effect.fn("WorkspaceRuntime.probe")(() =>
      Effect.succeed({ tailnetHostname: host, ready: true }),
    ),
    logs: Effect.fn("WorkspaceRuntime.logs")(() =>
      Effect.succeed(`Static workspace runtime: every user connects to ${url}.\n`),
    ),
    diskUsage: Effect.succeed(new Map()),
  });
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* InstanceConfig;
    const runtime = config.runtime;
    return runtime.kind === "static"
      ? Layer.succeed(WorkspaceRuntime, makeStaticRuntime(runtime.url))
      : Layer.effect(
          WorkspaceRuntime,
          DockerEngine.DockerEngine.pipe(
            Effect.map((engine) => makeDockerRuntime(engine, runtime.network)),
          ),
        ).pipe(Layer.provide(DockerEngine.layer(runtime.socketPath)));
  }),
);
