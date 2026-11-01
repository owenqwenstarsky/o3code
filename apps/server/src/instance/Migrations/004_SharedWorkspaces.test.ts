import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0001 from "./001_InstanceCore.ts";
import Migration0002 from "./002_MultipleWorkspaces.ts";
import Migration0003 from "./003_AuthSyncGroups.ts";
import Migration0004 from "./004_SharedWorkspaces.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("004_SharedWorkspaces", (it) => {
  it.effect("moves ownership into memberships and keeps workspaces past their users", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* Migration0001;
      yield* Migration0002;
      yield* Migration0003;
      const at = "2026-01-01T00:00:00.000Z";
      const user = (id: string, name: string) => ({
        user_id: id,
        email: `${id}@acme.test`,
        email_normalized: `${id}@acme.test`,
        name,
        role: "member",
        password_hash: "hash",
        must_change_password: 0,
        disabled_at: null,
        created_at: at,
        updated_at: at,
        last_login_at: null,
      });
      yield* sql`INSERT INTO o3_users ${sql.insert(user("alice", "Alice"))}`;
      yield* sql`INSERT INTO o3_users ${sql.insert(user("bob", "Bob"))}`;
      const workspace = (id: string, userId: string, label: string, isDefault: number) => ({
        workspace_id: id,
        user_id: userId,
        label,
        is_default: isDefault,
        slug: id,
        status: "running",
        status_message: null,
        container_id: null,
        tailnet_hostname: null,
        image: "o3code/workspace:1",
        tools_json: "[]",
        limits_json: '{"cpus":2,"memoryMb":4096,"pids":4096}',
        secret_hash: "secret-hash",
        disk_usage_bytes: null,
        created_at: at,
        updated_at: at,
      });
      yield* sql`INSERT INTO o3_workspaces ${sql.insert(workspace("alice", "alice", "Default", 0))}`;
      yield* sql`INSERT INTO o3_workspaces ${sql.insert(workspace("ws-front", "alice", "Front", 1))}`;
      yield* sql`INSERT INTO o3_workspaces ${sql.insert(workspace("bob", "bob", "Default", 1))}`;
      yield* sql`INSERT INTO o3_auth_groups ${sql.insert({
        group_id: "g1",
        name: "Team",
        name_normalized: "team",
        created_at: at,
        updated_at: at,
      })}`;
      yield* sql`INSERT INTO o3_auth_group_members ${sql.insert({
        workspace_id: "ws-front",
        group_id: "g1",
        joined_at: at,
      })}`;

      yield* Migration0004;

      assert.deepEqual(
        yield* sql`SELECT workspace_id, label FROM o3_workspaces ORDER BY workspace_id`,
        [
          { workspace_id: "alice", label: "Alice" },
          { workspace_id: "bob", label: "Bob" },
          { workspace_id: "ws-front", label: "Front" },
        ],
      );
      assert.deepEqual(
        yield* sql`
          SELECT workspace_id, user_id, is_default FROM o3_workspace_members ORDER BY workspace_id
        `,
        [
          { workspace_id: "alice", user_id: "alice", is_default: 0 },
          { workspace_id: "bob", user_id: "bob", is_default: 1 },
          { workspace_id: "ws-front", user_id: "alice", is_default: 1 },
        ],
      );
      assert.deepEqual(yield* sql`SELECT workspace_id FROM o3_auth_group_members`, [
        { workspace_id: "ws-front" },
      ]);

      // One default per user still holds.
      const secondDefault = yield* sql`
        UPDATE o3_workspace_members SET is_default = 1 WHERE workspace_id = 'alice'
      `.pipe(Effect.flip);
      assert.equal(secondDefault.reason._tag, "UniqueViolation");

      yield* sql`INSERT INTO o3_workspace_members ${sql.insert({
        workspace_id: "ws-front",
        user_id: "bob",
        is_default: 0,
        created_at: at,
      })}`;
      yield* sql`DELETE FROM o3_users WHERE user_id = 'alice'`;
      assert.equal((yield* sql`SELECT workspace_id FROM o3_workspaces`).length, 3);
      assert.deepEqual(yield* sql`SELECT workspace_id, user_id FROM o3_workspace_members`, [
        { workspace_id: "bob", user_id: "bob" },
        { workspace_id: "ws-front", user_id: "bob" },
      ]);

      yield* sql`DELETE FROM o3_workspaces WHERE workspace_id = 'ws-front'`;
      assert.deepEqual(yield* sql`SELECT workspace_id FROM o3_workspace_members`, [
        { workspace_id: "bob" },
      ]);
    }),
  );
});
