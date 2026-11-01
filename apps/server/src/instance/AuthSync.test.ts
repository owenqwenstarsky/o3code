import * as NodeServices from "@effect/platform-node/NodeServices";
import { InstanceUserId, InstanceWorkspaceId } from "@t3tools/contracts/instance";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AuthSync from "./AuthSync.ts";
import * as InstanceStore from "./InstanceStore.ts";

const layerAuthSync = AuthSync.layer.pipe(
  Layer.provideMerge(InstanceStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "o3-auth-sync-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const at = "2026-01-01T00:00:00.000Z";

const insertWorkspace = (workspaceId: string) =>
  InstanceStore.InstanceStore.pipe(
    Effect.flatMap((store) =>
      store.insertWorkspace({
        workspaceId: InstanceWorkspaceId.make(workspaceId),
        label: workspaceId,
        slug: workspaceId,
        status: "running",
        statusMessage: null,
        containerId: null,
        tailnetHostname: null,
        image: "o3code/workspace:test",
        tools: [],
        limits: { cpus: 1, memoryMb: 512, pids: 256 },
        secretHash: "unused",
        diskUsageBytes: null,
        createdAt: at,
        updatedAt: at,
      }),
    ),
  );

const insertUser = (userId: string) =>
  InstanceStore.InstanceStore.pipe(
    Effect.flatMap((store) =>
      store.insertUser({
        userId: InstanceUserId.make(userId),
        email: `${userId}@acme.test`,
        name: userId,
        role: "member",
        passwordHash: "unused",
        mustChangePassword: false,
        disabledAt: null,
        createdAt: at,
        updatedAt: at,
        lastLoginAt: null,
      }),
    ),
  );

const credential = (token: string) => JSON.stringify({ token });

it.layer(layerAuthSync)("AuthSync", (it) => {
  it.effect(
    "shares one credential per provider and rejects stale writes with the current copy",
    () =>
      Effect.gen(function* () {
        const sync = yield* AuthSync.AuthSync;
        yield* insertUser("alice");
        yield* insertUser("bob");
        yield* insertWorkspace("ws-alice");
        yield* insertWorkspace("ws-bob");
        yield* insertWorkspace("ws-outside");

        const group = yield* sync.createGroup("Team Claude");
        expect((yield* sync.createGroup(" team claude ").pipe(Effect.flip))._tag).toBe(
          "InstanceConflictError",
        );
        // Across users, as the admin decides.
        yield* sync.setWorkspaceGroup("ws-alice", group.id);
        yield* sync.setWorkspaceGroup("ws-bob", group.id);
        expect((yield* sync.listGroups)[0]?.workspaceIds).toEqual(["ws-alice", "ws-bob"]);

        const first = yield* sync.push({
          workspaceId: "ws-alice",
          provider: "claude",
          baseVersion: 0,
          content: credential("a1"),
        });
        expect(first).toMatchObject({ accepted: true, current: { version: 1 } });

        // Bob wrote from a stale version, so Alice's copy wins and comes back to him.
        const stale = yield* sync.push({
          workspaceId: "ws-bob",
          provider: "claude",
          baseVersion: 0,
          content: credential("b1"),
        });
        expect(stale).toMatchObject({
          accepted: false,
          current: { version: 1, content: credential("a1") },
        });

        yield* sync.push({
          workspaceId: "ws-bob",
          provider: "claude",
          baseVersion: 1,
          content: credential("b2"),
        });
        expect(yield* sync.pull("ws-alice", [{ provider: "claude", version: 1 }])).toEqual({
          groupId: group.id,
          files: [{ provider: "claude", version: 2, content: credential("b2") }],
        });
        // Content travels only when the caller's copy is older.
        expect(yield* sync.pull("ws-alice", [{ provider: "claude", version: 2 }])).toEqual({
          groupId: group.id,
          files: [{ provider: "claude", version: 2 }],
        });

        // A sign-out is a version too.
        yield* sync.push({
          workspaceId: "ws-alice",
          provider: "claude",
          baseVersion: 2,
          content: null,
        });
        expect((yield* sync.pull("ws-bob", [])).files).toEqual([
          { provider: "claude", version: 3, content: null },
        ]);

        // A workspace outside every group neither reads nor writes.
        expect(yield* sync.pull("ws-outside", [])).toEqual({ groupId: null, files: [] });
        expect(
          yield* sync.push({
            workspaceId: "ws-outside",
            provider: "claude",
            baseVersion: 3,
            content: credential("x"),
          }),
        ).toEqual({ groupId: null, accepted: false, current: null });

        // Leaving keeps nothing on the instance side tied to the workspace.
        yield* sync.setWorkspaceGroup("ws-bob", null);
        expect(yield* sync.pull("ws-bob", [])).toEqual({ groupId: null, files: [] });
      }),
  );

  it.effect("stores credentials encrypted and drops them with the group", () =>
    Effect.gen(function* () {
      const sync = yield* AuthSync.AuthSync;
      const sql = yield* SqlClient.SqlClient;
      yield* insertUser("carol");
      yield* insertWorkspace("ws-carol");
      const group = yield* sync.createGroup("Carol");
      yield* sync.setWorkspaceGroup("ws-carol", group.id);
      yield* sync.push({
        workspaceId: "ws-carol",
        provider: "codex",
        baseVersion: 0,
        content: credential("secret-refresh-token"),
      });
      const raw = yield* sql<{ readonly content: string }>`
        SELECT content_encrypted AS "content" FROM o3_auth_group_files WHERE group_id = ${group.id}
      `;
      expect(raw[0]?.content).not.toContain("secret-refresh-token");
      expect((yield* sync.pull("ws-carol", [])).files[0]?.content).toBe(
        credential("secret-refresh-token"),
      );

      yield* sync.deleteGroup(group.id);
      expect(yield* sync.pull("ws-carol", [])).toEqual({ groupId: null, files: [] });
      const leftover = yield* sql`SELECT 1 FROM o3_auth_group_files WHERE group_id = ${group.id}`;
      expect(leftover).toEqual([]);
    }),
  );
});
