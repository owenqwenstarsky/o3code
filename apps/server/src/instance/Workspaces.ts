import { buildTailscaleHttpsBaseUrl, readTailscaleStatus } from "@t3tools/tailscale";
import {
  InstanceBadRequestError,
  InstanceConflictError,
  InstanceNotFoundError,
  InstanceWorkspaceId,
  STATIC_WORKSPACE_ID,
  type InstanceWorkspace,
  type InstanceWorkspaceAction,
  type InstanceWorkspaceLimits,
} from "@t3tools/contracts/instance";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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
import { WorkspaceRuntime, containerName } from "./WorkspaceRuntime.ts";
import { normalizeToolIds, unknownToolIds } from "./WorkspaceTools.ts";

const RECONCILE_INTERVAL = "15 seconds";
const DISK_USAGE_INTERVAL = "5 minutes";
/** Keeps `o3-ws-<slug>` and `o3-<slug>` well inside a 63-character DNS label. */
const MAX_SLUG_LENGTH = 40;

export type WorkspaceError =
  | InstanceNotFoundError
  | InstanceBadRequestError
  | InstanceConflictError
  | InstanceStoreError;

export class Workspaces extends Context.Service<
  Workspaces,
  {
    readonly get: (
      workspaceId: string,
    ) => Effect.Effect<Option.Option<InstanceWorkspace>, InstanceStoreError>;
    /** Default first, then oldest first. */
    readonly listForUser: (
      userId: string,
    ) => Effect.Effect<ReadonlyArray<InstanceWorkspace>, InstanceStoreError>;
    /** Every workspace, by workspace id. */
    readonly list: Effect.Effect<ReadonlyMap<string, InstanceWorkspace>, InstanceStoreError>;
    /** Adds a workspace; it becomes the default when the user has none. */
    readonly create: (input: {
      readonly userId: string;
      readonly email: string;
      readonly label: string;
      readonly tools: ReadonlyArray<string>;
      readonly limits: InstanceWorkspaceLimits;
    }) => Effect.Effect<InstanceWorkspace, WorkspaceError>;
    readonly action: (
      workspaceId: string,
      action: InstanceWorkspaceAction,
    ) => Effect.Effect<InstanceWorkspace, WorkspaceError>;
    readonly update: (
      workspaceId: string,
      patch: {
        readonly label?: string;
        readonly tools?: ReadonlyArray<string>;
        readonly limits?: InstanceWorkspaceLimits;
      },
    ) => Effect.Effect<InstanceWorkspace, WorkspaceError>;
    readonly setDefault: (workspaceId: string) => Effect.Effect<InstanceWorkspace, WorkspaceError>;
    /** Removes one workspace; a user's last workspace goes only with the user. */
    readonly remove: (
      workspaceId: string,
      deleteData: boolean,
    ) => Effect.Effect<void, WorkspaceError>;
    readonly removeAllForUser: (
      userId: string,
      deleteData: boolean,
    ) => Effect.Effect<void, InstanceStoreError>;
    readonly stopAllForUser: (userId: string) => Effect.Effect<void, InstanceStoreError>;
    readonly startAllForUser: (userId: string) => Effect.Effect<void, InstanceStoreError>;
    readonly logs: (workspaceId: string) => Effect.Effect<string, WorkspaceError>;
    readonly upgradeAll: Effect.Effect<number, InstanceStoreError>;
    readonly verifySecret: (
      workspaceId: string,
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

const toSlugPart = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const slugCandidate = (email: string) => {
  const base = toSlugPart(email.split("@")[0]!).slice(0, 24).replace(/-+$/, "");
  return base.length > 0 ? base : "user";
};

const labelSlug = (label: string) => {
  const base = toSlugPart(label);
  return base.length > 0 ? base : "workspace";
};

const fitSlug = (value: string, maxLength: number) => value.slice(0, maxLength).replace(/-+$/, "");

/** The first workspace is named after the email; later ones add their label. */
export const workspaceSlug = (input: {
  readonly email: string;
  readonly label: string;
  readonly first: boolean;
  readonly taken: ReadonlySet<string>;
}) => {
  const base = input.first
    ? slugCandidate(input.email)
    : fitSlug(`${slugCandidate(input.email)}-${labelSlug(input.label)}`, MAX_SLUG_LENGTH);
  let slug = base;
  for (let suffix = 2; input.taken.has(slug); suffix += 1) {
    slug = `${fitSlug(base, MAX_SLUG_LENGTH - String(suffix).length - 1)}-${suffix}`;
  }
  return slug;
};

const sameLabel = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

const make = Effect.gen(function* () {
  const store = yield* InstanceStore;
  const settings = yield* InstanceSettings;
  const config = yield* InstanceConfig;
  const runtime = yield* WorkspaceRuntime;
  const tailscale = yield* TailscaleKeys;
  const crypto = yield* Crypto.Crypto;
  // Loops never finish; per-workspace actions do, so `drain` can wait on them alone.
  const loops = yield* FiberSet.make<unknown, never>();
  const actions = yield* FiberSet.make<unknown, never>();
  const locks = yield* Ref.make(new Map<string, Semaphore.Semaphore>());
  // Adding, removing, renaming and re-defaulting workspaces check rows across users (slugs are
  // global), so they share one lock; container work stays per workspace.
  const membership = Semaphore.makeUnsafe(1);
  const discoveredInstanceUrl = yield* Ref.make<string | null>(null);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const lockFor = (workspaceId: string) =>
    Ref.modify(locks, (current) => {
      const existing = current.get(workspaceId);
      if (existing) return [existing, current] as const;
      const created = Semaphore.makeUnsafe(1);
      return [created, new Map(current).set(workspaceId, created)] as const;
    });
  const serialized =
    (workspaceId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      lockFor(workspaceId).pipe(Effect.flatMap((lock) => lock.withPermit(effect)));

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const toView = (record: WorkspaceRecord): InstanceWorkspace => {
    const httpBaseUrl =
      config.runtime.kind === "static"
        ? config.runtime.url.replace(/\/+$/, "")
        : record.tailnetHostname
          ? buildTailscaleHttpsBaseUrl({ magicDnsName: record.tailnetHostname }).replace(/\/$/, "")
          : null;
    return {
      id: record.workspaceId,
      userId: record.userId,
      label: record.label,
      isDefault: record.isDefault,
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

  const patch = (workspaceId: string, values: WorkspacePatch) =>
    nowIso.pipe(Effect.flatMap((now) => store.updateWorkspace(workspaceId, values, now)));

  const requireRecord = (workspaceId: string) =>
    store.getWorkspace(workspaceId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new InstanceNotFoundError({ message: "Workspace not found." })),
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

  const markError = (workspaceId: string, message: string) =>
    patch(workspaceId, { status: "error", statusMessage: message }).pipe(
      Effect.andThen(Effect.logWarning("Workspace operation failed.", { workspaceId, message })),
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
    yield* patch(record.workspaceId, {
      status: "starting",
      statusMessage: "Creating the workspace container",
      image: instanceSettings.workspaceImage,
      secretHash: sha256(secret),
      containerId: null,
    });
    const containerId = yield* runtime.create({
      workspaceId: record.workspaceId,
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
    yield* patch(record.workspaceId, { containerId, statusMessage: "Starting" });
    yield* runtime.start(containerId);
  }, Effect.mapError(errorMessage));

  const inBackground = (
    workspaceId: string,
    effect: Effect.Effect<unknown, string | { readonly message: string }>,
  ) =>
    FiberSet.run(actions)(
      serialized(workspaceId)(
        effect.pipe(
          Effect.andThen(reconcileOne(workspaceId)),
          Effect.catch((error) => markError(workspaceId, errorMessage(error))),
        ),
      ),
    ).pipe(Effect.asVoid);

  const reconcileOne = Effect.fn("Workspaces.reconcileOne")(
    function* (workspaceId: string) {
      const found = yield* store.getWorkspace(workspaceId);
      if (Option.isNone(found)) return;
      const record = found.value;
      if (record.status === "provisioning" || record.status === "stopping") return;
      if (record.containerId === null) {
        if (record.status === "running") {
          yield* patch(workspaceId, {
            status: "error",
            statusMessage: "The container is missing.",
          });
        }
        return;
      }
      const state = yield* runtime.inspect(record.containerId);
      if (Option.isNone(state)) {
        yield* patch(workspaceId, {
          status: "error",
          statusMessage: "The container is missing. Recreate the workspace.",
          containerId: null,
        });
        return;
      }
      if (!state.value.running) {
        if (record.status !== "stopped") {
          yield* patch(workspaceId, { status: "error", statusMessage: state.value.detail });
        }
        return;
      }
      if (record.status === "running" && record.tailnetHostname !== null) return;
      const probe = yield* runtime.probe(record.containerId);
      yield* patch(workspaceId, {
        status: probe.ready ? "running" : "starting",
        statusMessage: probe.ready
          ? null
          : probe.tailnetHostname === null
            ? "Joining the tailnet"
            : "Starting O3 Code",
        tailnetHostname: probe.tailnetHostname ?? record.tailnetHostname,
      });
    },
    (effect, workspaceId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Workspace reconcile failed.", { workspaceId, cause }),
        ),
      ),
  );

  const reconcileAll = store.listWorkspaces().pipe(
    Effect.flatMap((records) =>
      Effect.forEach(
        records,
        (record) => serialized(record.workspaceId)(reconcileOne(record.workspaceId)),
        { concurrency: 4, discard: true },
      ),
    ),
    Effect.catch((cause) => Effect.logWarning("Workspace reconcile pass failed.", { cause })),
  );

  const refreshDiskUsage = runtime.diskUsage.pipe(
    Effect.flatMap((sizes) =>
      Effect.forEach(
        [...sizes],
        ([workspaceId, size]) => patch(workspaceId, { diskUsageBytes: size }),
        { discard: true },
      ),
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

  const assertLabelFree = Effect.fn("Workspaces.assertLabelFree")(function* (
    userId: string,
    label: string,
    exceptWorkspaceId: string | null,
  ) {
    const siblings = yield* store.listWorkspacesForUser(userId);
    const clash = siblings.some(
      (record) => record.workspaceId !== exceptWorkspaceId && sameLabel(record.label, label),
    );
    if (clash) {
      return yield* new InstanceConflictError({
        message: `This user already has a workspace named "${label.trim()}".`,
      });
    }
  });

  const view = (workspaceId: string) => requireRecord(workspaceId).pipe(Effect.map(toView));

  /** Removes the container, optionally the volumes, the tailnet device, then the row. */
  const teardown = (record: WorkspaceRecord, deleteData: boolean) =>
    serialized(record.workspaceId)(
      Effect.gen(function* () {
        yield* runtime
          .removeContainer(record.containerId ?? containerName(record.slug))
          .pipe(
            Effect.catch((cause) => Effect.logWarning("Failed to remove container.", { cause })),
          );
        if (deleteData) {
          yield* runtime
            .removeData(record.workspaceId)
            .pipe(
              Effect.catch((cause) => Effect.logWarning("Failed to remove volumes.", { cause })),
            );
        }
        if (runtime.kind === "docker" && record.tailnetHostname) {
          yield* tailscale
            .deleteDeviceByHostname(record.tailnetHostname.split(".")[0]!)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to remove the workspace's Tailscale device.", { cause }),
              ),
            );
        }
        yield* store.deleteWorkspace(record.workspaceId);
      }),
    );

  const action: Workspaces["Service"]["action"] = Effect.fn("Workspaces.action")(
    function* (workspaceId, kind) {
      const record = yield* requireRecord(workspaceId);
      switch (kind) {
        case "start":
          if (record.containerId === null) {
            yield* inBackground(workspaceId, createAndStart(record));
          } else {
            yield* patch(workspaceId, { status: "starting", statusMessage: "Starting" });
            yield* inBackground(workspaceId, runtime.start(record.containerId));
          }
          break;
        case "stop":
          yield* patch(workspaceId, { status: "stopping", statusMessage: null });
          yield* inBackground(
            workspaceId,
            Effect.gen(function* () {
              if (record.containerId) {
                yield* runtime.stop(record.containerId);
              }
              yield* patch(workspaceId, { status: "stopped", statusMessage: null });
            }),
          );
          break;
        case "restart":
          if (record.containerId === null) {
            yield* inBackground(workspaceId, createAndStart(record));
          } else {
            yield* patch(workspaceId, { status: "starting", statusMessage: "Restarting" });
            yield* inBackground(workspaceId, runtime.restart(record.containerId));
          }
          break;
        case "recreate":
          yield* patch(workspaceId, { status: "starting", statusMessage: "Recreating" });
          yield* inBackground(
            workspaceId,
            requireRecord(workspaceId).pipe(Effect.flatMap(createAndStart)),
          );
          break;
      }
      return yield* view(workspaceId);
    },
  );

  const listForUser = (userId: string) =>
    store.listWorkspacesForUser(userId).pipe(Effect.map((records) => records.map(toView)));

  return Workspaces.of({
    get: Effect.fn("Workspaces.get")((workspaceId) =>
      store.getWorkspace(workspaceId).pipe(Effect.map(Option.map(toView))),
    ),
    listForUser: Effect.fn("Workspaces.listForUser")(listForUser),
    list: store
      .listWorkspaces()
      .pipe(
        Effect.map(
          (records) => new Map(records.map((record) => [record.workspaceId, toView(record)])),
        ),
      ),
    create: Effect.fn("Workspaces.create")(function* (input) {
      const tools = yield* validateTools(input.tools);
      const record = yield* membership.withPermit(
        Effect.gen(function* () {
          const label = input.label.trim();
          yield* assertLabelFree(input.userId, label, null);
          const all = yield* store.listWorkspaces();
          const siblings = all.filter((record) => record.userId === input.userId);
          const instanceSettings = yield* settings.get;
          const now = yield* nowIso;
          const created: WorkspaceRecord = {
            workspaceId: InstanceWorkspaceId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
            userId: input.userId as WorkspaceRecord["userId"],
            label,
            isDefault: !siblings.some((record) => record.isDefault),
            slug: workspaceSlug({
              email: input.email,
              label,
              first: siblings.length === 0,
              taken: new Set(all.map((record) => record.slug)),
            }),
            status: "provisioning",
            statusMessage: "Preparing the workspace",
            containerId: null,
            tailnetHostname: null,
            image: instanceSettings.workspaceImage,
            tools,
            limits: input.limits,
            secretHash: sha256(generateSecret()),
            diskUsageBytes: null,
            createdAt: now,
            updatedAt: now,
          };
          yield* store.insertWorkspace(created);
          return created;
        }),
      );
      yield* inBackground(record.workspaceId, createAndStart(record));
      return toView(record);
    }),
    action,
    update: Effect.fn("Workspaces.update")(function* (workspaceId, input) {
      const record = yield* requireRecord(workspaceId);
      const label = input.label?.trim();
      if (label !== undefined && label !== record.label) {
        yield* membership.withPermit(
          assertLabelFree(record.userId, label, workspaceId).pipe(
            Effect.andThen(patch(workspaceId, { label })),
          ),
        );
      }
      const tools = input.tools === undefined ? record.tools : yield* validateTools(input.tools);
      const limits = input.limits ?? record.limits;
      const changed =
        tools.join(",") !== record.tools.join(",") ||
        limits.cpus !== record.limits.cpus ||
        limits.memoryMb !== record.limits.memoryMb ||
        limits.pids !== record.limits.pids;
      if (!changed) return yield* view(workspaceId);
      yield* patch(workspaceId, { tools, limits });
      // Tools install and limits apply when the container is created.
      return yield* action(workspaceId, "recreate");
    }),
    setDefault: Effect.fn("Workspaces.setDefault")(function* (workspaceId) {
      yield* membership.withPermit(
        Effect.gen(function* () {
          const record = yield* requireRecord(workspaceId);
          if (record.isDefault) return;
          yield* store.setDefaultWorkspace(record.userId, workspaceId, yield* nowIso);
        }),
      );
      return yield* view(workspaceId);
    }),
    remove: Effect.fn("Workspaces.remove")((workspaceId, deleteData) =>
      membership.withPermit(
        Effect.gen(function* () {
          const record = yield* requireRecord(workspaceId);
          const siblings = yield* store.listWorkspacesForUser(record.userId);
          const remaining = siblings
            .filter((sibling) => sibling.workspaceId !== workspaceId)
            .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
          const promoted = remaining[0];
          if (promoted === undefined) {
            return yield* new InstanceBadRequestError({
              message: "This is the user's only workspace. Delete the user instead.",
            });
          }
          yield* teardown(record, deleteData);
          if (record.isDefault) {
            yield* store.setDefaultWorkspace(record.userId, promoted.workspaceId, yield* nowIso);
          }
        }),
      ),
    ),
    removeAllForUser: Effect.fn("Workspaces.removeAllForUser")((userId, deleteData) =>
      membership.withPermit(
        store
          .listWorkspacesForUser(userId)
          .pipe(
            Effect.flatMap((records) =>
              Effect.forEach(records, (record) => teardown(record, deleteData), { discard: true }),
            ),
          ),
      ),
    ),
    stopAllForUser: Effect.fn("Workspaces.stopAllForUser")((userId) =>
      store.listWorkspacesForUser(userId).pipe(
        Effect.flatMap((records) =>
          Effect.forEach(
            records,
            (record) =>
              patch(record.workspaceId, {
                status: "stopped",
                statusMessage: "Account disabled",
              }).pipe(
                Effect.andThen(
                  record.containerId
                    ? serialized(record.workspaceId)(runtime.stop(record.containerId)).pipe(
                        Effect.catch((cause) =>
                          Effect.logWarning("Failed to stop workspace.", {
                            workspaceId: record.workspaceId,
                            cause,
                          }),
                        ),
                      )
                    : Effect.void,
                ),
              ),
            { discard: true },
          ),
        ),
      ),
    ),
    startAllForUser: Effect.fn("Workspaces.startAllForUser")((userId) =>
      store
        .listWorkspacesForUser(userId)
        .pipe(
          Effect.flatMap((records) =>
            Effect.forEach(
              records,
              (record) => action(record.workspaceId, "start").pipe(Effect.ignore),
              { discard: true },
            ),
          ),
        ),
    ),
    logs: Effect.fn("Workspaces.logs")((workspaceId) =>
      requireRecord(workspaceId).pipe(
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
        (record) => action(record.workspaceId, "recreate").pipe(Effect.ignore),
        { discard: true },
      );
      return outdated.length;
    }),
    verifySecret: Effect.fn("Workspaces.verifySecret")((workspaceId, secret) =>
      config.runtime.kind === "static"
        ? Effect.succeed(
            workspaceId === STATIC_WORKSPACE_ID &&
              timingSafeEqualStrings(secret, Redacted.value(config.runtime.secret)),
          )
        : store
            .getWorkspace(workspaceId)
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
