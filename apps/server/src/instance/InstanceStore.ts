import {
  InstanceAuditEvent,
  InstanceUserId,
  InstanceUserRole,
  InstanceWorkspaceLimits,
  InstanceWorkspaceStatus,
} from "@t3tools/contracts/instance";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";

import Migration0001 from "./Migrations/001_InstanceCore.ts";

export class InstanceStoreError extends Schema.TaggedError<InstanceStoreError>()(
  "InstanceStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Instance database operation failed: ${this.operation}`;
  }
}

export const UserRecord = Schema.Struct({
  userId: InstanceUserId,
  email: Schema.String,
  name: Schema.String,
  role: InstanceUserRole,
  passwordHash: Schema.String,
  mustChangePassword: Schema.BooleanFromBit,
  disabledAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastLoginAt: Schema.NullOr(Schema.String),
});
export type UserRecord = typeof UserRecord.Type;

export const WorkspaceRecord = Schema.Struct({
  userId: InstanceUserId,
  slug: Schema.String,
  status: InstanceWorkspaceStatus,
  statusMessage: Schema.NullOr(Schema.String),
  containerId: Schema.NullOr(Schema.String),
  tailnetHostname: Schema.NullOr(Schema.String),
  image: Schema.String,
  tools: Schema.fromJsonString(Schema.Array(Schema.String)),
  limits: Schema.fromJsonString(InstanceWorkspaceLimits),
  secretHash: Schema.String,
  tailscaleDeviceId: Schema.NullOr(Schema.String),
  diskUsageBytes: Schema.NullOr(Schema.Int),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type WorkspaceRecord = typeof WorkspaceRecord.Type;

const decodeUsers = Schema.decodeUnknownEffect(Schema.Array(UserRecord));
const decodeWorkspaces = Schema.decodeUnknownEffect(Schema.Array(WorkspaceRecord));
const encodeWorkspace = Schema.encodeEffect(WorkspaceRecord);
const encodeTools = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeLimits = Schema.encodeSync(Schema.fromJsonString(InstanceWorkspaceLimits));
const decodeAudit = Schema.decodeUnknownEffect(Schema.Array(InstanceAuditEvent));

export interface AuditInput {
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly action: string;
  readonly targetUserId?: string | null;
  readonly targetEmail?: string | null;
  readonly detail?: string | null;
  readonly ipAddress?: string | null;
}

export type UserPatch = Partial<
  Pick<
    UserRecord,
    "name" | "role" | "passwordHash" | "mustChangePassword" | "disabledAt" | "lastLoginAt" | "email"
  >
>;

export type WorkspacePatch = Partial<
  Omit<WorkspaceRecord, "userId" | "slug" | "createdAt" | "updatedAt">
>;

export class InstanceStore extends Context.Service<
  InstanceStore,
  {
    readonly listUsers: () => Effect.Effect<ReadonlyArray<UserRecord>, InstanceStoreError>;
    readonly getUser: (
      userId: string,
    ) => Effect.Effect<Option.Option<UserRecord>, InstanceStoreError>;
    readonly findUserByEmail: (
      email: string,
    ) => Effect.Effect<Option.Option<UserRecord>, InstanceStoreError>;
    readonly insertUser: (user: UserRecord) => Effect.Effect<void, InstanceStoreError>;
    readonly updateUser: (
      userId: string,
      patch: UserPatch,
      updatedAt: string,
    ) => Effect.Effect<void, InstanceStoreError>;
    readonly deleteUser: (userId: string) => Effect.Effect<void, InstanceStoreError>;
    readonly listWorkspaces: () => Effect.Effect<
      ReadonlyArray<WorkspaceRecord>,
      InstanceStoreError
    >;
    readonly getWorkspace: (
      userId: string,
    ) => Effect.Effect<Option.Option<WorkspaceRecord>, InstanceStoreError>;
    readonly insertWorkspace: (
      workspace: WorkspaceRecord,
    ) => Effect.Effect<void, InstanceStoreError>;
    readonly updateWorkspace: (
      userId: string,
      patch: WorkspacePatch,
      updatedAt: string,
    ) => Effect.Effect<void, InstanceStoreError>;
    readonly getSetting: (key: string) => Effect.Effect<Option.Option<string>, InstanceStoreError>;
    readonly putSetting: (
      key: string,
      valueJson: string,
    ) => Effect.Effect<void, InstanceStoreError>;
    readonly appendAudit: (
      event: AuditInput & { readonly at: string },
    ) => Effect.Effect<void, InstanceStoreError>;
    readonly listAudit: (input: {
      readonly beforeId: number | undefined;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<InstanceAuditEvent>, InstanceStoreError>;
  }
>()("t3/instance/InstanceStore") {}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const USER_COLUMNS = `
  user_id AS "userId", email, name, role, password_hash AS "passwordHash",
  must_change_password AS "mustChangePassword", disabled_at AS "disabledAt",
  created_at AS "createdAt", updated_at AS "updatedAt", last_login_at AS "lastLoginAt"`;

const WORKSPACE_COLUMNS = `
  user_id AS "userId", slug, status, status_message AS "statusMessage",
  container_id AS "containerId", tailnet_hostname AS "tailnetHostname", image,
  tools_json AS "tools", limits_json AS "limits", secret_hash AS "secretHash",
  tailscale_device_id AS "tailscaleDeviceId", disk_usage_bytes AS "diskUsageBytes",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const USER_PATCH_COLUMNS: Record<keyof UserPatch, string> = {
  name: "name",
  role: "role",
  email: "email",
  passwordHash: "password_hash",
  mustChangePassword: "must_change_password",
  disabledAt: "disabled_at",
  lastLoginAt: "last_login_at",
};

const WORKSPACE_PATCH_COLUMNS: Record<keyof WorkspacePatch, string> = {
  status: "status",
  statusMessage: "status_message",
  containerId: "container_id",
  tailnetHostname: "tailnet_hostname",
  image: "image",
  tools: "tools_json",
  limits: "limits_json",
  secretHash: "secret_hash",
  tailscaleDeviceId: "tailscale_device_id",
  diskUsageBytes: "disk_usage_bytes",
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const fail =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new InstanceStoreError({ operation, cause })));

  const selectUsers = (where: string, params: ReadonlyArray<unknown>) =>
    sql
      .unsafe(`SELECT ${USER_COLUMNS} FROM o3_users ${where}`, params)
      .pipe(Effect.flatMap(decodeUsers));

  const selectWorkspaces = (where: string, params: ReadonlyArray<unknown>) =>
    sql
      .unsafe(`SELECT ${WORKSPACE_COLUMNS} FROM o3_workspaces ${where}`, params)
      .pipe(Effect.flatMap(decodeWorkspaces));

  const patchRow = (
    table: string,
    columns: Record<string, string>,
    patch: Record<string, unknown>,
    updatedAt: string,
    userId: string,
  ) => {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    const assignments = [...entries.map(([key]) => `${columns[key]} = ?`), "updated_at = ?"];
    const values = entries.map(([, value]) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
    return sql.unsafe(`UPDATE ${table} SET ${assignments.join(", ")} WHERE user_id = ?`, [
      ...values,
      updatedAt,
      userId,
    ]);
  };

  return InstanceStore.of({
    listUsers: Effect.fn("InstanceStore.listUsers")(() =>
      selectUsers("ORDER BY created_at ASC", []).pipe(fail("listUsers")),
    ),
    getUser: Effect.fn("InstanceStore.getUser")((userId) =>
      selectUsers("WHERE user_id = ?", [userId]).pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        fail("getUser"),
      ),
    ),
    findUserByEmail: Effect.fn("InstanceStore.findUserByEmail")((email) =>
      selectUsers("WHERE email_normalized = ?", [normalizeEmail(email)]).pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        fail("findUserByEmail"),
      ),
    ),
    insertUser: Effect.fn("InstanceStore.insertUser")((user) =>
      sql`
        INSERT INTO o3_users (
          user_id, email, email_normalized, name, role, password_hash, must_change_password,
          disabled_at, created_at, updated_at, last_login_at
        ) VALUES (
          ${user.userId}, ${user.email}, ${normalizeEmail(user.email)}, ${user.name}, ${user.role},
          ${user.passwordHash}, ${user.mustChangePassword ? 1 : 0}, ${user.disabledAt},
          ${user.createdAt}, ${user.updatedAt}, ${user.lastLoginAt}
        )
      `.pipe(Effect.asVoid, fail("insertUser")),
    ),
    updateUser: Effect.fn("InstanceStore.updateUser")((userId, patch, updatedAt) =>
      patchRow("o3_users", USER_PATCH_COLUMNS, patch, updatedAt, userId).pipe(
        Effect.andThen(
          patch.email === undefined
            ? Effect.void
            : sql`UPDATE o3_users SET email_normalized = ${normalizeEmail(patch.email)} WHERE user_id = ${userId}`,
        ),
        Effect.asVoid,
        fail("updateUser"),
      ),
    ),
    deleteUser: Effect.fn("InstanceStore.deleteUser")((userId) =>
      sql`DELETE FROM o3_users WHERE user_id = ${userId}`.pipe(Effect.asVoid, fail("deleteUser")),
    ),
    listWorkspaces: Effect.fn("InstanceStore.listWorkspaces")(() =>
      selectWorkspaces("ORDER BY created_at ASC", []).pipe(fail("listWorkspaces")),
    ),
    getWorkspace: Effect.fn("InstanceStore.getWorkspace")((userId) =>
      selectWorkspaces("WHERE user_id = ?", [userId]).pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        fail("getWorkspace"),
      ),
    ),
    insertWorkspace: Effect.fn("InstanceStore.insertWorkspace")((workspace) =>
      encodeWorkspace(workspace).pipe(
        Effect.flatMap(
          (row) => sql`
            INSERT INTO o3_workspaces (
              user_id, slug, status, status_message, container_id, tailnet_hostname, image,
              tools_json, limits_json, secret_hash, tailscale_device_id, disk_usage_bytes,
              created_at, updated_at
            ) VALUES (
              ${row.userId}, ${row.slug}, ${row.status}, ${row.statusMessage}, ${row.containerId},
              ${row.tailnetHostname}, ${row.image}, ${row.tools}, ${row.limits}, ${row.secretHash},
              ${row.tailscaleDeviceId}, ${row.diskUsageBytes}, ${row.createdAt}, ${row.updatedAt}
            )
          `,
        ),
        Effect.asVoid,
        fail("insertWorkspace"),
      ),
    ),
    updateWorkspace: Effect.fn("InstanceStore.updateWorkspace")((userId, patch, updatedAt) =>
      Effect.gen(function* () {
        const encoded: Record<string, unknown> = { ...patch };
        if (patch.tools !== undefined) encoded.tools = encodeTools(patch.tools);
        if (patch.limits !== undefined) encoded.limits = encodeLimits(patch.limits);
        yield* patchRow("o3_workspaces", WORKSPACE_PATCH_COLUMNS, encoded, updatedAt, userId);
      }).pipe(fail("updateWorkspace")),
    ),
    getSetting: Effect.fn("InstanceStore.getSetting")((key) =>
      sql<{
        readonly value: string;
      }>`SELECT value_json AS "value" FROM o3_settings WHERE key = ${key}`.pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0]?.value)),
        fail("getSetting"),
      ),
    ),
    putSetting: Effect.fn("InstanceStore.putSetting")((key, valueJson) =>
      sql`
        INSERT INTO o3_settings (key, value_json) VALUES (${key}, ${valueJson})
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json
      `.pipe(Effect.asVoid, fail("putSetting")),
    ),
    appendAudit: Effect.fn("InstanceStore.appendAudit")((event) =>
      sql`
        INSERT INTO o3_audit_events (
          at, actor_user_id, actor_email, action, target_user_id, target_email, detail, ip_address
        ) VALUES (
          ${event.at}, ${event.actorUserId}, ${event.actorEmail}, ${event.action},
          ${event.targetUserId ?? null}, ${event.targetEmail ?? null}, ${event.detail ?? null},
          ${event.ipAddress ?? null}
        )
      `.pipe(Effect.asVoid, fail("appendAudit")),
    ),
    listAudit: Effect.fn("InstanceStore.listAudit")(({ beforeId, limit }) =>
      sql
        .unsafe(
          `SELECT event_id AS "id", at, actor_user_id AS "actorUserId", actor_email AS "actorEmail",
             action, target_user_id AS "targetUserId", target_email AS "targetEmail", detail,
             ip_address AS "ipAddress"
           FROM o3_audit_events ${beforeId === undefined ? "" : "WHERE event_id < ?"}
           ORDER BY event_id DESC LIMIT ?`,
          beforeId === undefined ? [limit] : [beforeId, limit],
        )
        .pipe(Effect.flatMap(decodeAudit), fail("listAudit")),
    ),
  });
});

const runInstanceMigrations = Migrator.make({});

/** Instance tables live beside the reused T3 tables, under their own migration history. */
const layerMigrations = Layer.effectDiscard(
  runInstanceMigrations({
    table: "o3_instance_migrations",
    loader: Migrator.fromRecord({ "1_InstanceCore": Migration0001 }),
  }),
);

export const layer = Layer.effect(InstanceStore, make).pipe(Layer.provide(layerMigrations));
