import { buildTailscaleHttpsBaseUrl, readTailscaleStatus } from "@t3tools/tailscale";
import {
  InstanceBadRequestError,
  InstanceConflictError,
  InstanceNotFoundError,
  type InstanceWorkspace,
  type InstanceWorkspaceAction,
  type InstanceWorkspaceLimits,
} from "@t3tools/contracts/instance";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/process";

import { InstanceConfig } from "./InstanceConfig.ts";
import { InstanceSettings } from "./InstanceSettings.ts";
import {
  InstanceStore,
  type InstanceStoreError,
  type WorkspacePatch,
  type WorkspaceRecord,
} from "./InstanceStore.ts";
import { generateSecret, sha256, timingSafeEqualStrings } from "./Passwords.ts";
import { TailscaleKeys } from "./TailscaleKeys.ts";
import { STATIC_WORKSPACE_USER, WorkspaceRuntime, containerName } from "./WorkspaceRuntime.ts";
import { normalizeToolIds, unknownToolIds } from "./WorkspaceTools.ts";

const RECONCILE_INTERVAL = "15 seconds";
const DISK_USAGE_INTERVAL = "5 minutes";

export type WorkspaceError =
  | InstanceNotFoundError
  | InstanceBadRequestError
  | InstanceConflictError
  | InstanceStoreError;

export class Workspaces extends Context.Service<
  Workspaces,
  {
    readonly get: (
      userId: string,
    ) => Effect.Effect<Option.Option<InstanceWorkspace>, InstanceStoreError>;
    readonly list: Effect.Effect<ReadonlyMap<string, InstanceWorkspace>, InstanceStoreError>;
    readonly provision: (input: {
      readonly userId: string;
      readonly email: string;
      readonly tools: ReadonlyArray<string>;
      readonly limits: InstanceWorkspaceLimits;
    }) => Effect.Effect<InstanceWorkspace, WorkspaceError>;
    readonly action: (
      userId: string,
      action: InstanceWorkspaceAction,
    ) => Effect.Effect<InstanceWorkspace, WorkspaceError>;
    readonly update: (
      userId: string,
      patch: { readonly tools?: ReadonlyArray<string>; readonly limits?: InstanceWorkspaceLimits },
    ) => Effect.Effect<InstanceWorkspace, WorkspaceError>;
    readonly stopAndKeep: (userId: string) => Effect.Effect<void, InstanceStoreError>;
    readonly remove: (
      userId: string,
      deleteData: boolean,
    ) => Effect.Effect<void, InstanceStoreError>;
    readonly logs: (userId: string) => Effect.Effect<string, WorkspaceError>;
    readonly upgradeAll: Effect.Effect<number, InstanceStoreError>;
    readonly verifySecret: (
      userId: string,
      secret: string,
    ) => Effect.Effect<boolean, InstanceStoreError>;
    readonly runtimeInfo: Effect.Effect<{
      readonly kind: "docker" | "static";
      readonly reachable: boolean;
      readonly version: string | null;
      readonly cpus: number | null;
      readonly memoryBytes: number | null;
      readonly message: string | null;
    }>;
    readonly instanceUrl: Effect.Effect<string | null>;
    /** Waits for in-flight workspace actions, such as a container being created. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/instance/Workspaces") {}

const errorMessage = (error: string | { readonly message: string }) =>
  typeof error === "string" ? error : error.message;

export const slugCandidate = (email: string) => {
  const base = email
    .split("@")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return base.length > 0 ? base : "user";
};

const make = Effect.gen(function* () {
  const store = yield* InstanceStore;
  const settings = yield* InstanceSettings;
  const config = yield* InstanceConfig;
  const runtime = yield* WorkspaceRuntime;
  const tailscale = yield* TailscaleKeys;
  // Loops never finish; per-user actions do, so `drain` can wait on them alone.
  const loops = yield* FiberSet.make<unknown, never>();
  const actions = yield* FiberSet.make<unknown, never>();
  const locks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
  const discoveredInstanceUrl = yield* Ref.make<string | null>(null);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const lockFor = (userId: string) =>
    Ref.modify(locks, (current) => {
      const existing = current.get(userId);
      if (existing) return [existing, current] as const;
      const created = Semaphore.makeUnsafe(1);
      return [created, new Map(current).set(userId, created)] as const;
    });
  const serialized =
    (userId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      lockFor(userId).pipe(Effect.flatMap((lock) => lock.withPermit(effect)));

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const toView = (record: WorkspaceRecord): InstanceWorkspace => {
    const httpBaseUrl =
      config.runtime.kind === "static"
        ? config.runtime.url.replace(/\/+$/, "")
        : record.tailnetHostname
          ? buildTailscaleHttpsBaseUrl({ magicDnsName: record.tailnetHostname }).replace(/\/$/, "")
          : null;
    return {
      userId: record.userId,
      slug: record.slug,
      status: record.status,
      statusMessage: record.statusMessage,
      tailnetHostname: record.tailnetHostname,
      httpBaseUrl,
      wsBaseUrl: httpBaseUrl?.replace(/^http/, "ws") ?? null,
      image: record.image,
      tools: record.tools,
      limits: record.limits,
      diskUsageBytes: record.diskUsageBytes,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  };

  const patch = (userId: string, values: WorkspacePatch) =>
    nowIso.pipe(Effect.flatMap((now) => store.updateWorkspace(userId, values, now)));

  const requireRecord = (userId: string) =>
    store.getWorkspace(userId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new InstanceNotFoundError({ message: "This user has no workspace." })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const resolveInstanceUrl = Effect.gen(function* () {
    if (Option.isSome(config.instanceUrl)) return config.instanceUrl.value.replace(/\/+$/, "");
    const cached = yield* Ref.get(discoveredInstanceUrl);
    if (cached) return cached;
    const status = yield* readTailscaleStatus.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.option,
    );
    const name = Option.flatMap(status, (value) => Option.fromNullishOr(value.magicDnsName));
    if (Option.isNone(name)) return null;
    const url = buildTailscaleHttpsBaseUrl({ magicDnsName: name.value }).replace(/\/$/, "");
    yield* Ref.set(discoveredInstanceUrl, url);
    return url;
  });

  const markError = (userId: string, message: string) =>
    patch(userId, { status: "error", statusMessage: message }).pipe(
      Effect.andThen(Effect.logWarning("Workspace operation failed.", { userId, message })),
      Effect.ignore,
    );

  /** Creates a fresh container on the existing volumes, rotating the workspace secret. */
  const createAndStart = Effect.fn("Workspaces.createAndStart")(function* (
    record: WorkspaceRecord,
  ) {
    const instanceSettings = yield* settings.get;
    const instanceUrl = yield* resolveInstanceUrl;
    if (instanceUrl === null && runtime.kind === "docker") {
      return yield* Effect.fail(
        "The instance URL is unknown. Join the instance to Tailscale or set O3_INSTANCE_URL.",
      );
    }
    const authKey =
      runtime.kind === "docker"
        ? yield* tailscale.mintAuthKey(`o3 workspace ${record.slug}`)
        : null;
    if (record.containerId) {
      yield* runtime.removeContainer(record.containerId);
    }
    const secret = generateSecret();
    yield* patch(record.userId, {
      status: "starting",
      statusMessage: "Creating the workspace container",
      image: instanceSettings.workspaceImage,
      secretHash: sha256(secret),
      containerId: null,
    });
    const containerId = yield* runtime.create({
      userId: record.userId,
      slug: record.slug,
      image: instanceSettings.workspaceImage,
      tools: record.tools,
      limits: record.limits,
      instanceUrl: instanceUrl ?? "",
      workspaceSecret: secret,
      tailscaleAuthKey: authKey,
      tailscaleTag: config.tailscaleTag,
    });
    yield* patch(record.userId, { containerId, statusMessage: "Starting" });
    yield* runtime.start(containerId);
  }, Effect.mapError(errorMessage));

  const inBackground = (
    userId: string,
    effect: Effect.Effect<unknown, string | { readonly message: string }>,
  ) =>
    FiberSet.run(actions)(
      serialized(userId)(
        effect.pipe(
          Effect.andThen(reconcileOne(userId)),
          Effect.catch((error) => markError(userId, errorMessage(error))),
        ),
      ),
    ).pipe(Effect.asVoid);

  const reconcileOne = Effect.fn("Workspaces.reconcileOne")(
    function* (userId: string) {
      const found = yield* store.getWorkspace(userId);
      if (Option.isNone(found)) return;
      const record = found.value;
      if (record.status === "provisioning" || record.status === "stopping") return;
      if (record.containerId === null) {
        if (record.status === "running") {
          yield* patch(userId, { status: "error", statusMessage: "The container is missing." });
        }
        return;
      }
      const state = yield* runtime.inspect(record.containerId);
      if (Option.isNone(state)) {
        yield* patch(userId, {
          status: "error",
          statusMessage: "The container is missing. Recreate the workspace.",
          containerId: null,
        });
        return;
      }
      if (!state.value.running) {
        if (record.status !== "stopped") {
          yield* patch(userId, { status: "error", statusMessage: state.value.detail });
        }
        return;
      }
      if (record.status === "running" && record.tailnetHostname !== null) return;
      const probe = yield* runtime.probe(record.containerId);
      yield* patch(userId, {
        status: probe.ready ? "running" : "starting",
        statusMessage: probe.ready
          ? null
          : probe.tailnetHostname === null
            ? "Joining the tailnet"
            : "Starting O3 Code",
        tailnetHostname: probe.tailnetHostname ?? record.tailnetHostname,
      });
    },
    (effect, userId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Workspace reconcile failed.", { userId, cause }),
        ),
      ),
  );

  const reconcileAll = store.listWorkspaces().pipe(
    Effect.flatMap((records) =>
      Effect.forEach(records, (record) => serialized(record.userId)(reconcileOne(record.userId)), {
        concurrency: 4,
        discard: true,
      }),
    ),
    Effect.catch((cause) => Effect.logWarning("Workspace reconcile pass failed.", { cause })),
  );

  const refreshDiskUsage = runtime.diskUsage.pipe(
    Effect.flatMap((sizes) =>
      Effect.forEach([...sizes], ([userId, size]) => patch(userId, { diskUsageBytes: size }), {
        discard: true,
      }),
    ),
    Effect.catch((cause) => Effect.logDebug("Workspace disk usage refresh failed.", { cause })),
  );

  yield* FiberSet.run(loops)(
    reconcileAll.pipe(Effect.repeat(Schedule.spaced(RECONCILE_INTERVAL)), Effect.asVoid),
  );
  yield* FiberSet.run(loops)(
    refreshDiskUsage.pipe(Effect.repeat(Schedule.spaced(DISK_USAGE_INTERVAL)), Effect.asVoid),
  );

  const validateTools = (tools: ReadonlyArray<string>) => {
    const unknown = unknownToolIds(tools);
    return unknown.length > 0
      ? Effect.fail(
          new InstanceBadRequestError({ message: `Unknown tools: ${unknown.join(", ")}` }),
        )
      : Effect.succeed(normalizeToolIds(tools));
  };

  const view = (userId: string) => requireRecord(userId).pipe(Effect.map(toView));

  const action: Workspaces["Service"]["action"] = Effect.fn("Workspaces.action")(
    function* (userId, kind) {
      const record = yield* requireRecord(userId);
      switch (kind) {
        case "start":
          if (record.containerId === null) {
            yield* inBackground(userId, createAndStart(record));
          } else {
            yield* patch(userId, { status: "starting", statusMessage: "Starting" });
            yield* inBackground(userId, runtime.start(record.containerId));
          }
          break;
        case "stop":
          yield* patch(userId, { status: "stopping", statusMessage: null });
          yield* inBackground(
            userId,
            Effect.gen(function* () {
              if (record.containerId) {
                yield* runtime.stop(record.containerId);
              }
              yield* patch(userId, { status: "stopped", statusMessage: null });
            }),
          );
          break;
        case "restart":
          if (record.containerId === null) {
            yield* inBackground(userId, createAndStart(record));
          } else {
            yield* patch(userId, { status: "starting", statusMessage: "Restarting" });
            yield* inBackground(userId, runtime.restart(record.containerId));
          }
          break;
        case "recreate":
          yield* patch(userId, { status: "starting", statusMessage: "Recreating" });
          yield* inBackground(userId, requireRecord(userId).pipe(Effect.flatMap(createAndStart)));
          break;
      }
      return yield* view(userId);
    },
  );

  return Workspaces.of({
    get: Effect.fn("Workspaces.get")((userId) =>
      store.getWorkspace(userId).pipe(Effect.map(Option.map(toView))),
    ),
    list: store
      .listWorkspaces()
      .pipe(
        Effect.map((records) => new Map(records.map((record) => [record.userId, toView(record)]))),
      ),
    provision: Effect.fn("Workspaces.provision")(function* (input) {
      const tools = yield* validateTools(input.tools);
      const existing = yield* store.listWorkspaces();
      const taken = new Set(existing.map((record) => record.slug));
      const base = slugCandidate(input.email);
      let slug = base;
      for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${base}-${suffix}`;
      const instanceSettings = yield* settings.get;
      const now = yield* nowIso;
      const record: WorkspaceRecord = {
        userId: input.userId as WorkspaceRecord["userId"],
        slug,
        status: "provisioning",
        statusMessage: "Preparing the workspace",
        containerId: null,
        tailnetHostname: null,
        image: instanceSettings.workspaceImage,
        tools,
        limits: input.limits,
        secretHash: sha256(generateSecret()),
        tailscaleDeviceId: null,
        diskUsageBytes: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* store.insertWorkspace(record);
      yield* inBackground(input.userId, createAndStart(record));
      return toView(record);
    }),
    action,
    update: Effect.fn("Workspaces.update")(function* (userId, input) {
      const record = yield* requireRecord(userId);
      const tools = input.tools === undefined ? record.tools : yield* validateTools(input.tools);
      const limits = input.limits ?? record.limits;
      const changed =
        tools.join(",") !== record.tools.join(",") ||
        limits.cpus !== record.limits.cpus ||
        limits.memoryMb !== record.limits.memoryMb ||
        limits.pids !== record.limits.pids;
      if (!changed) return toView(record);
      yield* patch(userId, { tools, limits });
      // Tools install and limits apply when the container is created.
      return yield* action(userId, "recreate");
    }),
    stopAndKeep: Effect.fn("Workspaces.stopAndKeep")((userId) =>
      store.getWorkspace(userId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (record) =>
              patch(userId, { status: "stopped", statusMessage: "Account disabled" }).pipe(
                Effect.andThen(
                  record.containerId
                    ? serialized(userId)(runtime.stop(record.containerId)).pipe(
                        Effect.catch((cause) =>
                          Effect.logWarning("Failed to stop workspace.", { userId, cause }),
                        ),
                      )
                    : Effect.void,
                ),
              ),
          }),
        ),
      ),
    ),
    remove: Effect.fn("Workspaces.remove")((userId, deleteData) =>
      Effect.gen(function* () {
        const found = yield* store.getWorkspace(userId);
        if (Option.isNone(found)) return;
        const record = found.value;
        yield* serialized(userId)(
          Effect.gen(function* () {
            yield* runtime
              .removeContainer(record.containerId ?? containerName(record.slug))
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to remove container.", { cause }),
                ),
              );
            if (deleteData) {
              yield* runtime
                .removeData(userId)
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Failed to remove volumes.", { cause }),
                  ),
                );
            }
            if (runtime.kind === "docker" && record.tailnetHostname) {
              yield* tailscale.deleteDeviceByHostname(record.tailnetHostname.split(".")[0]!).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to remove the workspace's Tailscale device.", {
                    cause,
                  }),
                ),
              );
            }
          }),
        );
      }),
    ),
    logs: Effect.fn("Workspaces.logs")((userId) =>
      requireRecord(userId).pipe(
        Effect.flatMap((record) =>
          record.containerId === null
            ? Effect.succeed(record.statusMessage ?? "No container yet.\n")
            : runtime
                .logs(record.containerId)
                .pipe(
                  Effect.catch((error) =>
                    Effect.succeed(`Could not read logs: ${error.message}\n`),
                  ),
                ),
        ),
      ),
    ),
    upgradeAll: Effect.gen(function* () {
      const instanceSettings = yield* settings.get;
      const records = yield* store.listWorkspaces();
      const outdated = records.filter(
        (record) => record.image !== instanceSettings.workspaceImage && record.status !== "stopped",
      );
      yield* Effect.forEach(
        outdated,
        (record) => action(record.userId, "recreate").pipe(Effect.ignore),
        {
          discard: true,
        },
      );
      return outdated.length;
    }),
    verifySecret: Effect.fn("Workspaces.verifySecret")((userId, secret) =>
      config.runtime.kind === "static"
        ? Effect.succeed(
            userId === STATIC_WORKSPACE_USER &&
              timingSafeEqualStrings(secret, Redacted.value(config.runtime.secret)),
          )
        : store
            .getWorkspace(userId)
            .pipe(
              Effect.map((found) =>
                Option.isSome(found)
                  ? timingSafeEqualStrings(sha256(secret), found.value.secretHash)
                  : false,
              ),
            ),
    ),
    runtimeInfo: runtime.info.pipe(
      Effect.map((info) => ({ kind: runtime.kind, reachable: true, ...info, message: null })),
      Effect.catch((error) =>
        Effect.succeed({
          kind: runtime.kind,
          reachable: false,
          version: null,
          cpus: null,
          memoryBytes: null,
          message: error.message,
        }),
      ),
    ),
    instanceUrl: resolveInstanceUrl,
    drain: FiberSet.awaitEmpty(actions),
  });
});

export const layer = Layer.effect(Workspaces, make);
