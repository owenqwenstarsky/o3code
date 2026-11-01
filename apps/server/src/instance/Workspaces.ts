import { buildTailscaleHttpsBaseUrl, readTailscaleStatus } from "@t3tools/tailscale";
import {
  InstanceBadRequestError,
  InstanceConflictError,
  InstanceNotFoundError,
  InstanceWorkspaceId,
  STATIC_WORKSPACE_ID,
  type InstanceAdminWorkspace,
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
  type MemberRecord,
  type UserRecord,
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
    /** The user's workspaces, default first, then oldest first. */
    readonly listForUser: (
      userId: string,
    ) => Effect.Effect<ReadonlyArray<InstanceWorkspace>, InstanceStoreError>;
    /** Every workspace, by workspace id. */
    readonly list: Effect.Effect<ReadonlyMap<string, InstanceWorkspace>, InstanceStoreError>;
    /** Every workspace with its members, oldest first. */
    readonly listWithMembers: Effect.Effect<
      ReadonlyArray<InstanceAdminWorkspace>,
      InstanceStoreError
    >;
    readonly getWithMembers: (
      workspaceId: string,
    ) => Effect.Effect<InstanceAdminWorkspace, WorkspaceError>;
    readonly isMember: (
      workspaceId: string,
      userId: string,
    ) => Effect.Effect<boolean, InstanceStoreError>;
    /** Adds a workspace; it becomes the default of each member who has none. */
    readonly create: (input: {
      readonly label: string;
      readonly tools: ReadonlyArray<string>;
      readonly limits: InstanceWorkspaceLimits;
      readonly memberUserIds: ReadonlyArray<string>;
    }) => Effect.Effect<InstanceAdminWorkspace, WorkspaceError>;
    /** Starts the workspace if it was stopped with nobody active on it. */
    readonly addMember: (
      workspaceId: string,
      userId: string,
    ) => Effect.Effect<InstanceAdminWorkspace, WorkspaceError>;
    /** Stops the workspace when nobody active is left on it; the workspace itself stays. */
    readonly removeMember: (
      workspaceId: string,
      userId: string,
    ) => Effect.Effect<InstanceAdminWorkspace, WorkspaceError>;
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
    readonly setDefault: (
      userId: string,
      workspaceId: string,
    ) => Effect.Effect<void, WorkspaceError>;
    readonly remove: (
      workspaceId: string,
      deleteData: boolean,
    ) => Effect.Effect<void, WorkspaceError>;
    /** Removes the user from every workspace, stopping those left with nobody active. */
    readonly detachUser: (userId: string) => Effect.Effect<void, InstanceStoreError>;
    /** For a disabled user: stops their workspaces that nobody active is left on. */
    readonly stopAllForUser: (userId: string) => Effect.Effect<void, InstanceStoreError>;
    /** For a re-enabled user: starts their stopped workspaces. */
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

const fitSlug = (value: string, maxLength: number) => value.slice(0, maxLength).replace(/-+$/, "");

/** Named after the label; slugs never change, so renaming a workspace keeps its container. */
export const workspaceSlug = (input: {
  readonly label: string;
  readonly taken: ReadonlySet<string>;
}) => {
  const fitted = fitSlug(toSlugPart(input.label), MAX_SLUG_LENGTH);
  const base = fitted.length > 0 ? fitted : "workspace";
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
  // Adding, removing, renaming workspaces and changing members check rows across the instance
  // (labels and slugs are global), so they share one lock; container work stays per workspace.
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

  const toView = (record: WorkspaceRecord, isDefault = false): InstanceWorkspace => {
    const httpBaseUrl =
      config.runtime.kind === "static"
        ? config.runtime.url.replace(/\/+$/, "")
        : record.tailnetHostname
          ? buildTailscaleHttpsBaseUrl({ magicDnsName: record.tailnetHostname }).replace(/\/$/, "")
          : null;
    return {
      id: record.workspaceId,
      label: record.label,
      isDefault,
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
    label: string,
    exceptWorkspaceId: string | null,
  ) {
    const all = yield* store.listWorkspaces();
    const clash = all.some(
      (record) => record.workspaceId !== exceptWorkspaceId && sameLabel(record.label, label),
    );
    if (clash) {
      return yield* new InstanceConflictError({
        message: `A workspace named "${label.trim()}" already exists.`,
      });
    }
  });

  const view = (workspaceId: string) =>
    requireRecord(workspaceId).pipe(Effect.map((record) => toView(record)));

  const withMembers = (
    record: WorkspaceRecord,
    members: ReadonlyArray<MemberRecord>,
    users: ReadonlyMap<string, UserRecord>,
  ): InstanceAdminWorkspace => ({
    ...toView(record),
    members: members.flatMap((member) => {
      const user = users.get(member.userId);
      return user === undefined
        ? []
        : [
            {
              userId: user.userId,
              email: user.email,
              name: user.name,
              disabled: user.disabledAt !== null,
              isDefault: member.isDefault,
            },
          ];
    }),
  });

  const usersById = store
    .listUsers()
    .pipe(Effect.map((users) => new Map(users.map((user) => [user.userId, user]))));

  const getWithMembers = Effect.fn("Workspaces.getWithMembers")(function* (workspaceId: string) {
    const record = yield* requireRecord(workspaceId);
    return withMembers(record, yield* store.listMembers(workspaceId), yield* usersById);
  });

  /** True while at least one enabled user is a member. */
  const hasActiveMember = Effect.fn("Workspaces.hasActiveMember")(function* (workspaceId: string) {
    const members = yield* store.listMembers(workspaceId);
    const users = yield* usersById;
    return members.some((member) => users.get(member.userId)?.disabledAt === null);
  });

  /** Stops the container under the workspace's lock, so one still being created stops too. */
  const stopNow = (workspaceId: string, statusMessage: string) =>
    serialized(workspaceId)(
      Effect.gen(function* () {
        const current = yield* store.getWorkspace(workspaceId);
        if (Option.isNone(current)) return;
        if (current.value.containerId) {
          yield* runtime
            .stop(current.value.containerId)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Failed to stop workspace.", { workspaceId, cause }),
              ),
            );
        }
        yield* patch(workspaceId, { status: "stopped", statusMessage });
      }),
    );

  const stopIfUnattended = (workspaceIds: ReadonlyArray<string>, statusMessage: string) =>
    Effect.forEach(
      workspaceIds,
      (workspaceId) =>
        hasActiveMember(workspaceId).pipe(
          Effect.flatMap((active) => (active ? Effect.void : stopNow(workspaceId, statusMessage))),
        ),
      { discard: true },
    );

  const requireEnabledUser = Effect.fn("Workspaces.requireEnabledUser")(function* (userId: string) {
    const user = yield* store.getUser(userId);
    if (Option.isNone(user)) {
      return yield* new InstanceNotFoundError({ message: "User not found." });
    }
    if (user.value.disabledAt !== null) {
      return yield* new InstanceBadRequestError({
        message: "Enable this user before adding them to a workspace.",
      });
    }
  });

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
    store
      .listWorkspacesForUser(userId)
      .pipe(Effect.map((records) => records.map((record) => toView(record, record.isDefault))));

  return Workspaces.of({
    get: Effect.fn("Workspaces.get")((workspaceId) =>
      store.getWorkspace(workspaceId).pipe(Effect.map(Option.map((record) => toView(record)))),
    ),
    listForUser: Effect.fn("Workspaces.listForUser")(listForUser),
    list: store
      .listWorkspaces()
      .pipe(
        Effect.map(
          (records) => new Map(records.map((record) => [record.workspaceId, toView(record)])),
        ),
      ),
    listWithMembers: Effect.gen(function* () {
      const records = yield* store.listWorkspaces();
      const members = yield* store.listMembers(null);
      const users = yield* usersById;
      return records.map((record) =>
        withMembers(
          record,
          members.filter((member) => member.workspaceId === record.workspaceId),
          users,
        ),
      );
    }),
    getWithMembers,
    isMember: Effect.fn("Workspaces.isMember")((workspaceId, userId) =>
      store
        .listMembers(workspaceId)
        .pipe(Effect.map((members) => members.some((member) => member.userId === userId))),
    ),
    create: Effect.fn("Workspaces.create")(function* (input) {
      const tools = yield* validateTools(input.tools);
      const memberUserIds = [...new Set(input.memberUserIds)];
      const record = yield* membership.withPermit(
        Effect.gen(function* () {
          const label = input.label.trim();
          yield* assertLabelFree(label, null);
          yield* Effect.forEach(memberUserIds, requireEnabledUser, { discard: true });
          const all = yield* store.listWorkspaces();
          const instanceSettings = yield* settings.get;
          const now = yield* nowIso;
          const created: WorkspaceRecord = {
            workspaceId: InstanceWorkspaceId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
            label,
            slug: workspaceSlug({ label, taken: new Set(all.map((record) => record.slug)) }),
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
          yield* Effect.forEach(
            memberUserIds,
            (userId) => store.addMember(created.workspaceId, userId, now),
            { discard: true },
          );
          return created;
        }),
      );
      const members = yield* store.listMembers(record.workspaceId);
      yield* inBackground(record.workspaceId, createAndStart(record));
      return withMembers(record, members, yield* usersById);
    }),
    addMember: Effect.fn("Workspaces.addMember")(function* (workspaceId, userId) {
      const wake = yield* membership.withPermit(
        Effect.gen(function* () {
          const record = yield* requireRecord(workspaceId);
          yield* requireEnabledUser(userId);
          const wasAttended = yield* hasActiveMember(workspaceId);
          yield* store.addMember(workspaceId, userId, yield* nowIso);
          return record.status === "stopped" && !wasAttended;
        }),
      );
      if (wake) yield* action(workspaceId, "start");
      return yield* getWithMembers(workspaceId);
    }),
    removeMember: Effect.fn("Workspaces.removeMember")(function* (workspaceId, userId) {
      yield* membership.withPermit(
        requireRecord(workspaceId).pipe(Effect.andThen(store.removeMember(workspaceId, userId))),
      );
      yield* stopIfUnattended([workspaceId], "Nobody active is on this workspace");
      return yield* getWithMembers(workspaceId);
    }),
    action,
    update: Effect.fn("Workspaces.update")(function* (workspaceId, input) {
      const record = yield* requireRecord(workspaceId);
      const label = input.label?.trim();
      if (label !== undefined && label !== record.label) {
        yield* membership.withPermit(
          assertLabelFree(label, workspaceId).pipe(Effect.andThen(patch(workspaceId, { label }))),
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
    setDefault: Effect.fn("Workspaces.setDefault")(function* (userId, workspaceId) {
      yield* membership.withPermit(
        Effect.gen(function* () {
          const workspaces = yield* store.listWorkspacesForUser(userId);
          if (!workspaces.some((record) => record.workspaceId === workspaceId)) {
            return yield* new InstanceNotFoundError({
              message: "This user is not on that workspace.",
            });
          }
          yield* store.setDefaultWorkspace(userId, workspaceId);
        }),
      );
    }),
    remove: Effect.fn("Workspaces.remove")((workspaceId, deleteData) =>
      membership.withPermit(
        requireRecord(workspaceId).pipe(Effect.flatMap((record) => teardown(record, deleteData))),
      ),
    ),
    detachUser: Effect.fn("Workspaces.detachUser")(function* (userId) {
      const workspaceIds = yield* membership.withPermit(
        Effect.gen(function* () {
          const records = yield* store.listWorkspacesForUser(userId);
          yield* Effect.forEach(
            records,
            (record) => store.removeMember(record.workspaceId, userId),
            { discard: true },
          );
          return records.map((record) => record.workspaceId);
        }),
      );
      yield* stopIfUnattended(workspaceIds, "Nobody active is on this workspace");
    }),
    stopAllForUser: Effect.fn("Workspaces.stopAllForUser")(function* (userId) {
      const records = yield* store.listWorkspacesForUser(userId);
      yield* stopIfUnattended(
        records.map((record) => record.workspaceId),
        "Account disabled",
      );
    }),
    startAllForUser: Effect.fn("Workspaces.startAllForUser")(function* (userId) {
      const records = yield* store.listWorkspacesForUser(userId);
      yield* Effect.forEach(
        records.filter((record) => record.status === "stopped"),
        (record) => action(record.workspaceId, "start").pipe(Effect.ignore),
        { discard: true },
      );
    }),
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
