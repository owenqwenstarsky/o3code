// @effect-diagnostics nodeBuiltinImport:off -- Effect's Crypto has no AES-GCM.
import * as NodeCrypto from "node:crypto";

import {
  InstanceAuthGroupId,
  InstanceConflictError,
  InstanceNotFoundError,
  InstanceWorkspaceId,
  type InstanceAuthGroup,
  type InstanceAuthSyncProvider,
  type InstanceAuthSyncPullResult,
  type InstanceAuthSyncPushResult,
} from "@t3tools/contracts/instance";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { InstanceStore, InstanceStoreError } from "./InstanceStore.ts";

const ENCRYPTION_KEY_SECRET = "o3-auth-sync-key";

type AuthSyncError = InstanceNotFoundError | InstanceConflictError | InstanceStoreError;

/**
 * Sign-in sync groups. Each group holds one copy of each agent CLI's credential file, versioned
 * so concurrent workspace writes resolve to one winner.
 */
export class AuthSync extends Context.Service<
  AuthSync,
  {
    readonly listGroups: Effect.Effect<ReadonlyArray<InstanceAuthGroup>, InstanceStoreError>;
    readonly createGroup: (name: string) => Effect.Effect<InstanceAuthGroup, AuthSyncError>;
    readonly renameGroup: (
      groupId: string,
      name: string,
    ) => Effect.Effect<InstanceAuthGroup, AuthSyncError>;
    /** Members keep their current sign-ins as private copies. */
    readonly deleteGroup: (groupId: string) => Effect.Effect<InstanceAuthGroup, AuthSyncError>;
    readonly setWorkspaceGroup: (
      workspaceId: string,
      groupId: string | null,
    ) => Effect.Effect<void, AuthSyncError>;
    readonly pull: (
      workspaceId: string,
      known: ReadonlyArray<{
        readonly provider: InstanceAuthSyncProvider;
        readonly version: number;
      }>,
    ) => Effect.Effect<InstanceAuthSyncPullResult, InstanceStoreError>;
    readonly push: (input: {
      readonly workspaceId: string;
      readonly provider: InstanceAuthSyncProvider;
      readonly baseVersion: number;
      readonly content: string | null;
    }) => Effect.Effect<InstanceAuthSyncPushResult, InstanceStoreError>;
  }
>()("t3/instance/AuthSync") {}

interface GroupRow {
  readonly groupId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FileRow {
  readonly provider: InstanceAuthSyncProvider;
  readonly version: number;
  readonly contentEncrypted: string | null;
}

const normalizeName = (name: string) => name.trim().toLowerCase();

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* InstanceStore;
  const secrets = yield* ServerSecretStore;
  const crypto = yield* Crypto.Crypto;

  const fail =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new InstanceStoreError({ operation, cause })));

  // Lazily, so instances that never use sync never create the key.
  const encryptionKey = Effect.cached(
    secrets.getOrCreateRandom(ENCRYPTION_KEY_SECRET, 32).pipe(fail("authSyncKey")),
  );
  const key = yield* encryptionKey;

  const encrypt = (plain: string) =>
    key.pipe(
      Effect.map((secret) => {
        const iv = NodeCrypto.randomBytes(12);
        const cipher = NodeCrypto.createCipheriv("aes-256-gcm", secret, iv);
        const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
      }),
    );

  const decrypt = (encoded: string) =>
    key.pipe(
      Effect.flatMap((secret) =>
        Effect.try({
          try: () => {
            const raw = Buffer.from(encoded, "base64");
            const decipher = NodeCrypto.createDecipheriv(
              "aes-256-gcm",
              secret,
              raw.subarray(0, 12),
            );
            decipher.setAuthTag(raw.subarray(12, 28));
            return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
              "utf8",
            );
          },
          catch: (cause) => new InstanceStoreError({ operation: "authSyncDecrypt", cause }),
        }),
      ),
    );

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const listGroups = Effect.gen(function* () {
    const groups = yield* sql<GroupRow>`
      SELECT group_id AS "groupId", name, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM o3_auth_groups ORDER BY created_at ASC
    `;
    const members = yield* sql<{ readonly groupId: string; readonly workspaceId: string }>`
      SELECT group_id AS "groupId", workspace_id AS "workspaceId"
      FROM o3_auth_group_members ORDER BY joined_at ASC
    `;
    return groups.map((group): InstanceAuthGroup => ({
      id: InstanceAuthGroupId.make(group.groupId),
      name: group.name,
      workspaceIds: members
        .filter((member) => member.groupId === group.groupId)
        .map((member) => InstanceWorkspaceId.make(member.workspaceId)),
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    }));
  }).pipe(fail("listAuthGroups"));

  const requireGroup = (groupId: string) =>
    listGroups.pipe(
      Effect.flatMap((groups) => {
        const group = groups.find((candidate) => candidate.id === groupId);
        return group === undefined
          ? Effect.fail(new InstanceNotFoundError({ message: "Sign-in sync group not found." }))
          : Effect.succeed(group);
      }),
    );

  const assertNameFree = Effect.fn("AuthSync.assertNameFree")(function* (
    name: string,
    exceptGroupId: string | null,
  ) {
    const clash = yield* sql<{ readonly groupId: string }>`
      SELECT group_id AS "groupId" FROM o3_auth_groups WHERE name_normalized = ${normalizeName(name)}
    `.pipe(fail("findAuthGroupByName"));
    if (clash.some((row) => row.groupId !== exceptGroupId)) {
      return yield* new InstanceConflictError({
        message: `A sign-in sync group named "${name.trim()}" already exists.`,
      });
    }
  });

  const membership = (workspaceId: string) =>
    sql<{ readonly groupId: string }>`
      SELECT group_id AS "groupId" FROM o3_auth_group_members WHERE workspace_id = ${workspaceId}
    `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]?.groupId)));

  const fileRows = (groupId: string) =>
    sql<FileRow>`
      SELECT provider, version, content_encrypted AS "contentEncrypted"
      FROM o3_auth_group_files WHERE group_id = ${groupId} ORDER BY provider ASC
    `;

  const decryptContent = (row: FileRow): Effect.Effect<string | null, InstanceStoreError> =>
    row.contentEncrypted === null ? Effect.succeed(null) : decrypt(row.contentEncrypted);

  return AuthSync.of({
    listGroups,
    createGroup: Effect.fn("AuthSync.createGroup")(function* (name) {
      yield* assertNameFree(name, null);
      const groupId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const now = yield* nowIso;
      yield* sql`
        INSERT INTO o3_auth_groups (group_id, name, name_normalized, created_at, updated_at)
        VALUES (${groupId}, ${name.trim()}, ${normalizeName(name)}, ${now}, ${now})
      `.pipe(fail("createAuthGroup"));
      return yield* requireGroup(groupId);
    }),
    renameGroup: Effect.fn("AuthSync.renameGroup")(function* (groupId, name) {
      yield* requireGroup(groupId);
      yield* assertNameFree(name, groupId);
      yield* sql`
        UPDATE o3_auth_groups
        SET name = ${name.trim()}, name_normalized = ${normalizeName(name)}, updated_at = ${yield* nowIso}
        WHERE group_id = ${groupId}
      `.pipe(fail("renameAuthGroup"));
      return yield* requireGroup(groupId);
    }),
    deleteGroup: Effect.fn("AuthSync.deleteGroup")(function* (groupId) {
      const group = yield* requireGroup(groupId);
      yield* sql`DELETE FROM o3_auth_groups WHERE group_id = ${groupId}`.pipe(
        fail("deleteAuthGroup"),
      );
      return group;
    }),
    setWorkspaceGroup: Effect.fn("AuthSync.setWorkspaceGroup")(function* (workspaceId, groupId) {
      if (Option.isNone(yield* store.getWorkspace(workspaceId))) {
        return yield* new InstanceNotFoundError({ message: "Workspace not found." });
      }
      if (groupId !== null) yield* requireGroup(groupId);
      const now = yield* nowIso;
      yield* Effect.gen(function* () {
        yield* sql`DELETE FROM o3_auth_group_members WHERE workspace_id = ${workspaceId}`;
        if (groupId !== null) {
          yield* sql`
            INSERT INTO o3_auth_group_members (workspace_id, group_id, joined_at)
            VALUES (${workspaceId}, ${groupId}, ${now})
          `;
        }
      }).pipe(sql.withTransaction, fail("setWorkspaceAuthGroup"));
    }),
    pull: Effect.fn("AuthSync.pull")(function* (workspaceId, known) {
      const groupId = yield* membership(workspaceId).pipe(fail("authSyncMembership"));
      if (Option.isNone(groupId)) return { groupId: null, files: [] };
      const rows = yield* fileRows(groupId.value).pipe(fail("authSyncFiles"));
      const files = yield* Effect.forEach(rows, (row) => {
        const knownVersion = known.find((entry) => entry.provider === row.provider)?.version ?? 0;
        return row.version > knownVersion
          ? decryptContent(row).pipe(
              Effect.map((content) => ({ provider: row.provider, version: row.version, content })),
            )
          : Effect.succeed({ provider: row.provider, version: row.version });
      });
      return { groupId: InstanceAuthGroupId.make(groupId.value), files };
    }),
    push: Effect.fn("AuthSync.push")(function* (input) {
      const now = yield* nowIso;
      // Encrypt outside the transaction; the version check and write must be one step.
      const encrypted = input.content === null ? null : yield* encrypt(input.content);
      return yield* Effect.gen(function* () {
        const groupId = yield* membership(input.workspaceId);
        if (Option.isNone(groupId)) {
          return { groupId: null, accepted: false, current: null } as const;
        }
        const group = InstanceAuthGroupId.make(groupId.value);
        const existing = (yield* fileRows(groupId.value)).find(
          (row) => row.provider === input.provider,
        );
        const currentVersion = existing?.version ?? 0;
        if (currentVersion !== input.baseVersion) {
          return {
            groupId: group,
            accepted: false,
            current: {
              provider: input.provider,
              version: currentVersion,
              content: existing === undefined ? null : yield* decryptContent(existing),
            },
          };
        }
        const version = currentVersion + 1;
        yield* sql`
          INSERT INTO o3_auth_group_files (
            group_id, provider, version, content_encrypted, updated_by_workspace_id, updated_at
          ) VALUES (
            ${groupId.value}, ${input.provider}, ${version}, ${encrypted}, ${input.workspaceId}, ${now}
          )
          ON CONFLICT (group_id, provider) DO UPDATE SET
            version = excluded.version,
            content_encrypted = excluded.content_encrypted,
            updated_by_workspace_id = excluded.updated_by_workspace_id,
            updated_at = excluded.updated_at
        `;
        return {
          groupId: group,
          accepted: true,
          current: { provider: input.provider, version, content: input.content },
        };
      }).pipe(
        sql.withTransaction,
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(new InstanceStoreError({ operation: "authSyncPush", cause })),
        }),
      );
    }),
  });
});

export const layer = Layer.effect(AuthSync, make);
