import {
  InstanceBadRequestError,
  InstanceConflictError,
  InstanceNotFoundError,
  type InstanceCreateUserRequest,
  type InstanceUpdateUserRequest,
  InstanceUserId,
  type InstanceUserWithWorkspace,
  type InstancePrincipalShape,
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
    readonly list: Effect.Effect<ReadonlyArray<InstanceUserWithWorkspace>, InstanceStoreError>;
    readonly get: (userId: string) => Effect.Effect<InstanceUserWithWorkspace, UsersError>;
    readonly create: (
      actor: InstancePrincipalShape | null,
      input: InstanceCreateUserRequest,
      options?: { readonly password?: string; readonly mustChangePassword?: boolean },
    ) => Effect.Effect<
      InstanceUserWithWorkspace & { readonly temporaryPassword: string },
      UsersError
    >;
    readonly update: (
      actor: InstancePrincipalShape,
      userId: string,
      input: InstanceUpdateUserRequest,
    ) => Effect.Effect<InstanceUserWithWorkspace, UsersError>;
    readonly resetPassword: (
      actor: InstancePrincipalShape | null,
      userId: string,
      password?: string,
    ) => Effect.Effect<string, UsersError>;
    readonly remove: (
      actor: InstancePrincipalShape,
      userId: string,
      deleteData: boolean,
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

  const withWorkspace = (record: UserRecord) =>
    workspaces.get(record.userId).pipe(
      Effect.map((workspace): InstanceUserWithWorkspace => ({
        user: toInstanceUser(record),
        workspace: Option.getOrNull(workspace),
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

  const create: InstanceUsers["Service"]["create"] = Effect.fn("InstanceUsers.create")(
    function* (actor, input, options) {
      if (Option.isSome(yield* store.findUserByEmail(input.email))) {
        return yield* new InstanceConflictError({
          message: "A user with this email already exists.",
        });
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
      const workspace = yield* workspaces.provision({
        userId,
        email: record.email,
        tools: input.tools ?? instanceSettings.defaultTools,
        limits: input.limits ?? instanceSettings.defaultLimits,
      });
      yield* settings.audit({
        ...actorFields(actor),
        action: "user.created",
        targetUserId: userId,
        targetEmail: record.email,
        detail: encodeDetail({ role: record.role, tools: workspace.tools }),
      });
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
      const all = yield* workspaces.list;
      return users.map((record) => ({
        user: toInstanceUser(record),
        workspace: all.get(record.userId) ?? null,
      }));
    }),
    get: Effect.fn("InstanceUsers.get")((userId) =>
      requireUser(userId).pipe(Effect.flatMap(withWorkspace)),
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
        yield* workspaces.stopAndKeep(userId);
      }
      if (enabling) {
        yield* workspaces.action(userId, "start").pipe(Effect.ignore);
      }
      yield* settings.audit({
        ...actorFields(actor),
        action: disabling ? "user.disabled" : enabling ? "user.enabled" : "user.updated",
        targetUserId: userId,
        targetEmail: record.email,
        detail: encodeDetail(input),
      });
      return yield* requireUser(userId).pipe(Effect.flatMap(withWorkspace));
    }),
    resetPassword,
    remove: Effect.fn("InstanceUsers.remove")(function* (actor, userId, deleteData) {
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
      yield* workspaces.remove(userId, deleteData);
      yield* store.deleteUser(userId);
      yield* settings.audit({
        ...actorFields(actor),
        action: "user.deleted",
        targetUserId: userId,
        targetEmail: record.email,
        detail: encodeDetail({ deleteData }),
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
