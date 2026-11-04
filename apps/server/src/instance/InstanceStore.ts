import {
  InstanceAuditEvent,
  InstanceUserId,
  InstanceUserRole,
  InstanceWorkspaceId,
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
import Migration0002 from "./Migrations/002_MultipleWorkspaces.ts";
import Migration0003 from "./Migrations/003_AuthSyncGroups.ts";
import Migration0004 from "./Migrations/004_SharedWorkspaces.ts";

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
  workspaceId: InstanceWorkspaceId,
  label: Schema.String,
  slug: Schema.String,
  status: InstanceWorkspaceStatus,
  statusMessage: Schema.NullOr(Schema.String),
  containerId: Schema.NullOr(Schema.String),
  tailnetHostname: Schema.NullOr(Schema.String),
  image: Schema.String,
  tools: Schema.fromJsonString(Schema.Array(Schema.String)),
  limits: Schema.fromJsonString(InstanceWorkspaceLimits),
  secretHash: Schema.String,
  diskUsageBytes: Schema.NullOr(Schema.Int),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type WorkspaceRecord = typeof WorkspaceRecord.Type;

/** A workspace as one of its members sees it. */
export const UserWorkspaceRecord = Schema.Struct({
  ...WorkspaceRecord.fields,
  isDefault: Schema.BooleanFromBit,
});
export type UserWorkspaceRecord = typeof UserWorkspaceRecord.Type;

export const MemberRecord = Schema.Struct({
  workspaceId: InstanceWorkspaceId,
  userId: InstanceUserId,
  isDefault: Schema.BooleanFromBit,
  createdAt: Schema.String,
});
export type MemberRecord = typeof MemberRecord.Type;

const decodeUsers = Schema.decodeUnknownEffect(Schema.Array(UserRecord));
const decodeWorkspaces = Schema.decodeUnknownEffect(Schema.Array(WorkspaceRecord));
const decodeUserWorkspaces = Schema.decodeUnknownEffect(Schema.Array(UserWorkspaceRecord));
const decodeMembers = Schema.decodeUnknownEffect(Schema.Array(MemberRecord));
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
  Omit<WorkspaceRecord, "workspaceId" | "slug" | "createdAt" | "updatedAt">
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
    /** The workspaces the user is a member of, default first, then oldest first. */
    readonly listWorkspacesForUser: (
      userId: string,
    ) => Effect.Effect<ReadonlyArray<UserWorkspaceRecord>, InstanceStoreError>;
    /** One workspace's members, or every membership when `workspaceId` is null. */
    readonly listMembers: (
      workspaceId: string | null,
    ) => Effect.Effect<ReadonlyArray<MemberRecord>, InstanceStoreError>;
    /** Idempotent; the workspace becomes the user's default when they have none. */
    readonly addMember: (
      workspaceId: string,
      userId: string,
      createdAt: string,
    ) => Effect.Effect<void, InstanceStoreError>;
    /** The user's oldest remaining workspace becomes their default if this one was. */
    readonly removeMember: (
      workspaceId: string,
      userId: string,
    ) => Effect.Effect<void, InstanceStoreError>;
    readonly getWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<Option.Option<WorkspaceRecord>, InstanceStoreError>;
    readonly insertWorkspace: (
      workspace: WorkspaceRecord,
    ) => Effect.Effect<void, InstanceStoreError>;
    readonly updateWorkspace: (
      workspaceId: string,
      patch: WorkspacePatch,
      updatedAt: string,
    ) => Effect.Effect<void, InstanceStoreError>;
    /** Members whose default this was fall back to their oldest remaining workspace. */
    readonly deleteWorkspace: (workspaceId: string) => Effect.Effect<void, InstanceStoreError>;
    readonly setDefaultWorkspace: (
      userId: string,
      workspaceId: string,
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
  w.workspace_id AS "workspaceId", w.label, w.slug, w.status, w.status_message AS "statusMessage",
  w.container_id AS "containerId", w.tailnet_hostname AS "tailnetHostname", w.image,
  w.tools_json AS "tools", w.limits_json AS "limits", w.secret_hash AS "secretHash",
  w.disk_usage_bytes AS "diskUsageBytes",
  w.created_at AS "createdAt", w.updated_at AS "updatedAt"`;

const MEMBER_COLUMNS = `
  workspace_id AS "workspaceId", user_id AS "userId", is_default AS "isDefault",
  created_at AS "createdAt"`;

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
  label: "label",
  status: "status",
  statusMessage: "status_message",
  containerId: "container_id",
  tailnetHostname: "tailnet_hostname",
  image: "image",
  tools: "tools_json",
  limits: "limits_json",
  secretHash: "secret_hash",
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
      .unsafe(`SELECT ${WORKSPACE_COLUMNS} FROM o3_workspaces w ${where}`, params)
      .pipe(Effect.flatMap(decodeWorkspaces));

  // Clear-then-set elsewhere keeps the partial unique index (one default per user) satisfied.
  const promoteDefault = (userId: string) => sql`
    UPDATE o3_workspace_members SET is_default = 1
    WHERE user_id = ${userId}
      AND NOT EXISTS (
        SELECT 1 FROM o3_workspace_members WHERE user_id = ${userId} AND is_default = 1
      )
      AND workspace_id = (
        SELECT workspace_id FROM o3_workspace_members WHERE user_id = ${userId}
        ORDER BY created_at ASC, workspace_id ASC LIMIT 1
      )
  `;

  const patchRow = (
    table: string,
    keyColumn: "user_id" | "workspace_id",
    columns: Record<string, string>,
    patch: Record<string, unknown>,
    updatedAt: string,
    key: string,
  ) => {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    const assignments = [...entries.map(([key]) => `${columns[key]} = ?`), "updated_at = ?"];
    const values = entries.map(([, value]) =>
      typeof value === "boolean" ? (value ? 1 : 0) : value,
    );
    return sql.unsafe(`UPDATE ${table} SET ${assignments.join(", ")} WHERE ${keyColumn} = ?`, [
      ...values,
      updatedAt,
      key,
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
      patchRow("o3_users", "user_id", USER_PATCH_COLUMNS, patch, updatedAt, userId).pipe(
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
      selectWorkspaces("ORDER BY w.created_at ASC", []).pipe(fail("listWorkspaces")),
    ),
    listWorkspacesForUser: Effect.fn("InstanceStore.listWorkspacesForUser")((userId) =>
      sql
        .unsafe(
          `SELECT ${WORKSPACE_COLUMNS}, m.is_default AS "isDefault"
           FROM o3_workspace_members m JOIN o3_workspaces w ON w.workspace_id = m.workspace_id
           WHERE m.user_id = ? ORDER BY m.is_default DESC, w.created_at ASC`,
          [userId],
        )
        .pipe(Effect.flatMap(decodeUserWorkspaces), fail("listWorkspacesForUser")),
    ),
    listMembers: Effect.fn("InstanceStore.listMembers")((workspaceId) =>
      sql
        .unsafe(
          `SELECT ${MEMBER_COLUMNS} FROM o3_workspace_members
           ${workspaceId === null ? "" : "WHERE workspace_id = ?"} ORDER BY created_at ASC`,
          workspaceId === null ? [] : [workspaceId],
        )
        .pipe(Effect.flatMap(decodeMembers), fail("listMembers")),
    ),
    addMember: Effect.fn("InstanceStore.addMember")((workspaceId, userId, createdAt) =>
      sql`
        INSERT INTO o3_workspace_members (workspace_id, user_id, is_default, created_at)
        VALUES (
          ${workspaceId}, ${userId},
          NOT EXISTS (
            SELECT 1 FROM o3_workspace_members WHERE user_id = ${userId} AND is_default = 1
          ),
          ${createdAt}
        )
        ON CONFLICT (workspace_id, user_id) DO NOTHING
      `.pipe(Effect.asVoid, fail("addMember")),
    ),
    removeMember: Effect.fn("InstanceStore.removeMember")((workspaceId, userId) =>
      sql`
        DELETE FROM o3_workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
      `.pipe(
        Effect.andThen(promoteDefault(userId)),
        sql.withTransaction,
        Effect.asVoid,
        fail("removeMember"),
      ),
    ),
    getWorkspace: Effect.fn("InstanceStore.getWorkspace")((workspaceId) =>
      selectWorkspaces("WHERE w.workspace_id = ?", [workspaceId]).pipe(
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        fail("getWorkspace"),
      ),
    ),
    insertWorkspace: Effect.fn("InstanceStore.insertWorkspace")((workspace) =>
      encodeWorkspace(workspace).pipe(
        Effect.flatMap(
          (row) => sql`
            INSERT INTO o3_workspaces (
              workspace_id, label, slug, status, status_message,
              container_id, tailnet_hostname, image, tools_json, limits_json, secret_hash,
              disk_usage_bytes, created_at, updated_at
            ) VALUES (
              ${row.workspaceId}, ${row.label}, ${row.slug},
              ${row.status}, ${row.statusMessage}, ${row.containerId}, ${row.tailnetHostname},
              ${row.image}, ${row.tools}, ${row.limits}, ${row.secretHash},
              ${row.diskUsageBytes}, ${row.createdAt}, ${row.updatedAt}
            )
          `,
        ),
        Effect.asVoid,
        fail("insertWorkspace"),
      ),
    ),
    updateWorkspace: Effect.fn("InstanceStore.updateWorkspace")((workspaceId, patch, updatedAt) =>
      Effect.gen(function* () {
        const encoded: Record<string, unknown> = { ...patch };
        if (patch.tools !== undefined) encoded.tools = encodeTools(patch.tools);
        if (patch.limits !== undefined) encoded.limits = encodeLimits(patch.limits);
        yield* patchRow(
          "o3_workspaces",
          "workspace_id",
          WORKSPACE_PATCH_COLUMNS,
          encoded,
          updatedAt,
          workspaceId,
        );
      }).pipe(fail("updateWorkspace")),
    ),
    deleteWorkspace: Effect.fn("InstanceStore.deleteWorkspace")((workspaceId) =>
      Effect.gen(function* () {
        const members = yield* sql<{ readonly userId: string }>`
          SELECT user_id AS "userId" FROM o3_workspace_members WHERE workspace_id = ${workspaceId}
        `;
        yield* sql`DELETE FROM o3_workspaces WHERE workspace_id = ${workspaceId}`;
        yield* Effect.forEach(members, (member) => promoteDefault(member.userId), {
          discard: true,
        });
      }).pipe(sql.withTransaction, fail("deleteWorkspace")),
    ),
    setDefaultWorkspace: Effect.fn("InstanceStore.setDefaultWorkspace")((userId, workspaceId) =>
      Effect.gen(function* () {
        const member = yield* sql`
          SELECT 1 FROM o3_workspace_members WHERE user_id = ${userId} AND workspace_id = ${workspaceId}
        `;
        if (member.length === 0) return;
        yield* sql`
          UPDATE o3_workspace_members SET is_default = 0
          WHERE user_id = ${userId} AND is_default = 1 AND workspace_id != ${workspaceId}
        `;
        yield* sql`
          UPDATE o3_workspace_members SET is_default = 1
          WHERE user_id = ${userId} AND workspace_id = ${workspaceId}
        `;
      }).pipe(sql.withTransaction, fail("setDefaultWorkspace")),
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
    loader: Migrator.fromRecord({
      "1_InstanceCore": Migration0001,
      "2_MultipleWorkspaces": Migration0002,
      "3_AuthSyncGroups": Migration0003,
      "4_SharedWorkspaces": Migration0004,
    }),
  }),
);

export const layer = Layer.effect(InstanceStore, make).pipe(Layer.provide(layerMigrations));
