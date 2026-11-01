import * as NetService from "@t3tools/shared/Net";
import { parseTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as DockerEngine from "./DockerEngine.ts";
import { InstanceConfig } from "./InstanceConfig.ts";

const WORKSPACE_T3_PORT = 3773;

export interface WorkspaceRuntimeSpec {
  readonly workspaceId: string;
  readonly slug: string;
  readonly label: string;
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
  /** The workspace's MagicDNS name once it has joined the tailnet, or its loopback `host:port`. */
  readonly tailnetHostname: string | null;
  readonly ready: boolean;
}

export type WorkspaceRuntimeError = DockerEngine.DockerEngineError | NetService.NetError;

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
    readonly removeData: (workspaceId: string) => Effect.Effect<void, WorkspaceRuntimeError>;
    readonly inspect: (
      containerIdOrSlug: string,
    ) => Effect.Effect<Option.Option<WorkspaceRuntimeState>, WorkspaceRuntimeError>;
    readonly probe: (containerId: string) => Effect.Effect<WorkspaceProbe, WorkspaceRuntimeError>;
    readonly logs: (containerId: string) => Effect.Effect<string, WorkspaceRuntimeError>;
    /** Home volume sizes by workspace id. */
    readonly diskUsage: Effect.Effect<ReadonlyMap<string, number>, WorkspaceRuntimeError>;
  }
>()("t3/instance/WorkspaceRuntime") {}

export const containerName = (slug: string) => `o3-ws-${slug}`;
const tailnetHostnameFor = (slug: string) => `o3-${slug}`;
const HOME_VOLUME_PREFIX = "o3-home-";
// Per workspace: two containers sharing the tailscale volume would share one tailnet identity.
const homeVolumeName = (workspaceId: string) => `${HOME_VOLUME_PREFIX}${workspaceId}`;
const tailscaleVolumeName = (workspaceId: string) => `o3-tailscale-${workspaceId}`;

const makeDockerRuntime = (
  engine: DockerEngine.DockerEngine["Service"],
  net: NetService.NetServiceShape,
  network: string,
  publish: "tailnet" | "loopback",
) =>
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
      const labels = {
        "dev.o3code.managed": "true",
        "dev.o3code.workspace": spec.workspaceId,
      };
      yield* engine.ensureVolume(homeVolumeName(spec.workspaceId), labels);
      yield* engine.ensureVolume(tailscaleVolumeName(spec.workspaceId), labels);
      // Dev instances in other worktrees share this Docker, and their slugs repeat.
      const name =
        publish === "loopback" ? `o3-dev-ws-${spec.workspaceId}` : containerName(spec.slug);
      // A container left behind by an interrupted create would block the name.
      yield* engine.removeContainer(name);
      if (publish === "loopback") {
        // A fixed host port, so restarts keep the address the instance recorded.
        const hostPort = yield* net.reserveLoopbackPort();
        return yield* engine.createContainer({
          name,
          image: spec.image,
          hostname: tailnetHostnameFor(spec.slug),
          network,
          labels,
          env: {
            O3_TOOLS: spec.tools.join(","),
            O3_WORKSPACE_LABEL: spec.label,
            O3_WORKSPACE_SLUG: spec.slug,
            O3_PUBLISH: "loopback",
            T3CODE_TAILSCALE_SERVE: "false",
            T3CODE_O3_INSTANCE_URL: spec.instanceUrl,
            T3CODE_O3_WORKSPACE_ID: spec.workspaceId,
            T3CODE_O3_WORKSPACE_SECRET: spec.workspaceSecret,
          },
          mounts: [{ volume: homeVolumeName(spec.workspaceId), target: "/home/o3" }],
          cpus: spec.limits.cpus,
          memoryBytes: spec.limits.memoryMb * 1024 * 1024,
          pids: spec.limits.pids,
          capAdd: [],
          devices: [],
          publish: [{ containerPort: WORKSPACE_T3_PORT, hostIp: "127.0.0.1", hostPort }],
        });
      }
      return yield* engine.createContainer({
        name,
        image: spec.image,
        hostname: tailnetHostnameFor(spec.slug),
        network,
        labels,
        env: {
          O3_TOOLS: spec.tools.join(","),
          O3_WORKSPACE_LABEL: spec.label,
          O3_WORKSPACE_SLUG: spec.slug,
          O3_TS_HOSTNAME: tailnetHostnameFor(spec.slug),
          O3_TS_TAGS: spec.tailscaleTag,
          ...(spec.tailscaleAuthKey
            ? { O3_TS_AUTHKEY: Redacted.value(spec.tailscaleAuthKey) }
            : {}),
          T3CODE_O3_INSTANCE_URL: spec.instanceUrl,
          T3CODE_O3_WORKSPACE_ID: spec.workspaceId,
          T3CODE_O3_WORKSPACE_SECRET: spec.workspaceSecret,
        },
        mounts: [
          { volume: homeVolumeName(spec.workspaceId), target: "/home/o3" },
          { volume: tailscaleVolumeName(spec.workspaceId), target: "/var/lib/tailscale" },
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
    removeData: Effect.fn("WorkspaceRuntime.removeData")((workspaceId) =>
      engine
        .removeVolume(homeVolumeName(workspaceId))
        .pipe(Effect.andThen(engine.removeVolume(tailscaleVolumeName(workspaceId)))),
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
      const healthy = engine
        .exec(containerId, [
          "curl",
          "-fsS",
          "-o",
          "/dev/null",
          `http://127.0.0.1:${WORKSPACE_T3_PORT}/.well-known/t3/environment`,
        ])
        .pipe(Effect.map((health) => health.exitCode === 0));
      if (publish === "loopback") {
        const state = yield* engine.inspectContainer(containerId);
        const hostPort = Option.flatMapNullishOr(
          state,
          (value) =>
            value.publishedPorts.find((port) => port.containerPort === WORKSPACE_T3_PORT)?.hostPort,
        );
        if (Option.isNone(hostPort)) return { tailnetHostname: null, ready: false };
        return { tailnetHostname: `127.0.0.1:${hostPort.value}`, ready: yield* healthy };
      }
      const status = yield* engine.exec(containerId, ["tailscale", "status", "--json"]);
      const tailnetHostname =
        status.exitCode === 0
          ? yield* parseTailscaleStatus(status.output).pipe(
              Effect.map((parsed) => parsed.magicDnsName),
              Effect.orElseSucceed(() => null),
            )
          : null;
      return { tailnetHostname, ready: tailnetHostname !== null && (yield* healthy) };
    }),
    logs: Effect.fn("WorkspaceRuntime.logs")((containerId) => engine.logs(containerId, 400)),
    diskUsage: engine.volumeSizes.pipe(
      Effect.map(
        (sizes) =>
          new Map(
            [...sizes].flatMap(([name, size]) =>
              name.startsWith(HOME_VOLUME_PREFIX)
                ? [[name.slice(HOME_VOLUME_PREFIX.length), size] as const]
                : [],
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
          Effect.all([DockerEngine.DockerEngine, NetService.NetService]).pipe(
            Effect.map(([engine, net]) =>
              makeDockerRuntime(engine, net, runtime.network, runtime.publish),
            ),
          ),
        ).pipe(
          Layer.provide(Layer.merge(DockerEngine.layer(runtime.socketPath), NetService.layer)),
        );
  }),
);
