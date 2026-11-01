import {
  InstanceBadRequestError,
  InstanceConflictError,
  InstanceNotFoundError,
  type InstanceCreateUserRequest,
  type InstanceUpdateUserRequest,
  InstanceUserId,
  type InstanceUserWithWorkspaces,
  type InstancePrincipalShape,
  type InstanceUser,
  type InstanceWorkspace,
} from "@t3tools/contracts/instance";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { InstanceAuth, toInstanceUser } from "./InstanceAuth.ts";
import { InstanceConfig } from "./InstanceConfig.ts";
import { InstanceSettings } from "./InstanceSettings.ts";
import { InstanceStore, type InstanceStoreError, type UserRecord } from "./InstanceStore.ts";
import { generateTemporaryPassword, hashPassword } from "./Passwords.ts";
import { Workspaces, type WorkspaceError } from "./Workspaces.ts";

type UsersError = WorkspaceError | InstanceStoreError;

const encodeDetail = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class InstanceUsers extends Context.Service<
  InstanceUsers,
  {
    readonly list: Effect.Effect<ReadonlyArray<InstanceUserWithWorkspaces>, InstanceStoreError>;
    readonly get: (userId: string) => Effect.Effect<InstanceUserWithWorkspaces, UsersError>;
    readonly create: (
      actor: InstancePrincipalShape | null,
      input: InstanceCreateUserRequest,
      options?: { readonly password?: string; readonly mustChangePassword?: boolean },
    ) => Effect.Effect<
      {
        readonly user: InstanceUser;
        readonly workspace: InstanceWorkspace | null;
        readonly temporaryPassword: string;
      },
      UsersError
    >;
    readonly update: (
      actor: InstancePrincipalShape,
      userId: string,
      input: InstanceUpdateUserRequest,
    ) => Effect.Effect<InstanceUserWithWorkspaces, UsersError>;
    readonly resetPassword: (
      actor: InstancePrincipalShape | null,
      userId: string,
      password?: string,
    ) => Effect.Effect<string, UsersError>;
    /** Deletes the account; its workspaces stay for their other members and admins. */
    readonly remove: (
      actor: InstancePrincipalShape,
      userId: string,
    ) => Effect.Effect<void, UsersError>;
    /** Seeds the first admin from the environment when the instance has no users. */
    readonly bootstrap: Effect.Effect<void, UsersError>;
  }
>()("t3/instance/InstanceUsers") {}

const make = Effect.gen(function* () {
  const store = yield* InstanceStore;
  const auth = yield* InstanceAuth;
  const settings = yield* InstanceSettings;
  const workspaces = yield* Workspaces;
  const config = yield* InstanceConfig;
  const crypto = yield* Crypto.Crypto;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const requireUser = (userId: string) =>
    store.getUser(userId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new InstanceNotFoundError({ message: "User not found." })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const withWorkspaces = (record: UserRecord) =>
    workspaces.listForUser(record.userId).pipe(
      Effect.map((list): InstanceUserWithWorkspaces => ({
        user: toInstanceUser(record),
        workspaces: list,
      })),
    );

  const activeAdmins = store
    .listUsers()
    .pipe(
      Effect.map((users) =>
        users.filter((user) => user.role === "admin" && user.disabledAt === null),
      ),
    );

  const actorFields = (actor: InstancePrincipalShape | null) => ({
    actorUserId: actor?.user.id ?? null,
    actorEmail: actor?.user.email ?? null,
  });

  const auditMember = (
    actor: InstancePrincipalShape | null,
    action: string,
    workspace: InstanceWorkspace,
    user: UserRecord,
  ) =>
    settings.audit({
      ...actorFields(actor),
      action,
      targetUserId: user.userId,
      targetEmail: user.email,
      detail: encodeDetail({ workspace: workspace.slug, label: workspace.label }),
    });

  /** The first of `base`, `base 2`, `base 3`… no workspace uses yet. */
  const freeLabel = Effect.fn("InstanceUsers.freeLabel")(function* (base: string) {
    const taken = new Set(
      [...(yield* workspaces.list).values()].map((workspace) => workspace.label.toLowerCase()),
    );
    const trimmed = base.trim().slice(0, 40).trim();
    let label = trimmed;
    for (let suffix = 2; taken.has(label.toLowerCase()); suffix += 1) {
      label = `${trimmed.slice(0, 40 - String(suffix).length - 1).trim()} ${suffix}`;
    }
    return label;
  });

  const create: InstanceUsers["Service"]["create"] = Effect.fn("InstanceUsers.create")(
    function* (actor, input, options) {
      if (Option.isSome(yield* store.findUserByEmail(input.email))) {
        return yield* new InstanceConflictError({
          message: "A user with this email already exists.",
        });
      }
      const target = input.workspace ?? { kind: "new" as const };
      if (target.kind === "existing") {
        const all = yield* workspaces.list;
        const missing = target.workspaceIds.find((workspaceId) => !all.has(workspaceId));
        if (missing !== undefined) {
          return yield* new InstanceNotFoundError({ message: "Workspace not found." });
        }
      }
      const instanceSettings = yield* settings.get;
      const temporaryPassword = options?.password ?? generateTemporaryPassword();
      const userId = InstanceUserId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const now = yield* nowIso;
      const record: UserRecord = {
        userId,
        email: input.email.trim(),
        name: input.name,
        role: input.role,
        passwordHash: yield* hashPassword(temporaryPassword).pipe(Effect.orDie),
        mustChangePassword: options?.mustChangePassword ?? true,
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      };
      yield* store.insertUser(record);
      if (target.kind === "new") {
        const created = yield* workspaces.create({
          label: target.label ?? (yield* freeLabel(record.name)),
          tools: target.tools ?? instanceSettings.defaultTools,
          limits: target.limits ?? instanceSettings.defaultLimits,
          memberUserIds: [userId],
        });
        yield* auditMember(actor, "workspace.created", created, record);
      } else {
        yield* Effect.forEach(
          target.workspaceIds,
          (workspaceId) =>
            workspaces
              .addMember(workspaceId, userId)
              .pipe(
                Effect.flatMap((workspace) =>
                  auditMember(actor, "workspace.member_added", workspace, record),
                ),
              ),
          { discard: true },
        );
      }
      yield* settings.audit({
        ...actorFields(actor),
        action: "user.created",
        targetUserId: userId,
        targetEmail: record.email,
        detail: encodeDetail({ role: record.role }),
      });
      const workspace = (yield* workspaces.listForUser(userId))[0] ?? null;
      return { user: toInstanceUser(record), workspace, temporaryPassword };
    },
  );

  const resetPassword: InstanceUsers["Service"]["resetPassword"] = Effect.fn(
    "InstanceUsers.resetPassword",
  )(function* (actor, userId, password) {
    const record = yield* requireUser(userId);
    const temporaryPassword = password ?? generateTemporaryPassword();
    yield* store.updateUser(
      userId,
      {
        passwordHash: yield* hashPassword(temporaryPassword).pipe(Effect.orDie),
        mustChangePassword: password === undefined,
      },
      yield* nowIso,
    );
    yield* auth.revokeAllForUser(userId);
    yield* settings.audit({
      ...actorFields(actor),
      action: "user.password_reset",
      targetUserId: userId,
      targetEmail: record.email,
    });
    return temporaryPassword;
  });

  return InstanceUsers.of({
    list: Effect.gen(function* () {
      const users = yield* store.listUsers();
      const byUser = new Map<string, Array<InstanceWorkspace>>();
      for (const workspace of yield* workspaces.listWithMembers) {
        const { members, ...view } = workspace;
        for (const member of members) {
          byUser.set(member.userId, [
            ...(byUser.get(member.userId) ?? []),
            { ...view, isDefault: member.isDefault },
          ]);
        }
      }
      return users.map((record) => ({
        user: toInstanceUser(record),
        workspaces: (byUser.get(record.userId) ?? []).toSorted(
          (left, right) =>
            Number(right.isDefault) - Number(left.isDefault) ||
            left.createdAt.localeCompare(right.createdAt),
        ),
      }));
    }),
    get: Effect.fn("InstanceUsers.get")((userId) =>
      requireUser(userId).pipe(Effect.flatMap(withWorkspaces)),
    ),
    create,
    update: Effect.fn("InstanceUsers.update")(function* (actor, userId, input) {
      const record = yield* requireUser(userId);
      const demoting = input.role === "member" && record.role === "admin";
      const disabling = input.disabled === true && record.disabledAt === null;
      if ((demoting || disabling) && userId === actor.user.id) {
        return yield* new InstanceBadRequestError({
          message: "You can't remove your own admin access or disable your own account.",
        });
      }
      if ((demoting || disabling) && record.role === "admin") {
        const admins = yield* activeAdmins;
        if (admins.length <= 1) {
          return yield* new InstanceBadRequestError({
            message: "The instance needs at least one active admin.",
          });
        }
      }
      const now = yield* nowIso;
      const enabling = input.disabled === false && record.disabledAt !== null;
      yield* store.updateUser(
        userId,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(disabling ? { disabledAt: now } : enabling ? { disabledAt: null } : {}),
        },
        now,
      );
      if (disabling) {
        yield* auth.revokeAllForUser(userId);
        yield* workspaces.stopAllForUser(userId);
      }
      if (enabling) {
        yield* workspaces.startAllForUser(userId);
      }
      yield* settings.audit({
        ...actorFields(actor),
        action: disabling ? "user.disabled" : enabling ? "user.enabled" : "user.updated",
        targetUserId: userId,
        targetEmail: record.email,
        detail: encodeDetail(input),
      });
      return yield* requireUser(userId).pipe(Effect.flatMap(withWorkspaces));
    }),
    resetPassword,
    remove: Effect.fn("InstanceUsers.remove")(function* (actor, userId) {
      const record = yield* requireUser(userId);
      if (userId === actor.user.id) {
        return yield* new InstanceBadRequestError({
          message: "You can't delete your own account.",
        });
      }
      if (
        record.role === "admin" &&
        record.disabledAt === null &&
        (yield* activeAdmins).length <= 1
      ) {
        return yield* new InstanceBadRequestError({
          message: "The instance needs at least one active admin.",
        });
      }
      yield* auth.revokeAllForUser(userId);
      yield* workspaces.detachUser(userId);
      yield* store.deleteUser(userId);
      yield* settings.audit({
        ...actorFields(actor),
        action: "user.deleted",
        targetUserId: userId,
        targetEmail: record.email,
      });
    }),
    bootstrap: Effect.gen(function* () {
      if (Option.isNone(config.bootstrapAdmin)) return;
      if ((yield* store.listUsers()).length > 0) return;
      const admin = config.bootstrapAdmin.value;
      yield* create(
        null,
        { email: admin.email, name: "Administrator", role: "admin" },
        { password: Redacted.value(admin.password), mustChangePassword: true },
      );
      yield* Effect.logInfo("Created the first admin from O3_ADMIN_EMAIL.", { email: admin.email });
    }),
  });
});

export const layer = Layer.effect(InstanceUsers, make);
