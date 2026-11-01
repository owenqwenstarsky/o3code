import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0001 from "./001_InstanceCore.ts";
import Migration0002 from "./002_MultipleWorkspaces.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("002_MultipleWorkspaces", (it) => {
  it.effect("keys existing workspaces by their user's id and makes them the default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* Migration0001;
      const at = "2026-01-01T00:00:00.000Z";
      yield* sql`INSERT INTO o3_users ${sql.insert({
        user_id: "user-1",
        email: "alice@acme.test",
        email_normalized: "alice@acme.test",
        name: "Alice",
        role: "member",
        password_hash: "hash",
        must_change_password: 0,
        disabled_at: null,
        created_at: at,
        updated_at: at,
        last_login_at: null,
      })}`;
      const v1 = {
        user_id: "user-1",
        slug: "alice",
        status: "running",
        status_message: null,
        container_id: "container-1",
        tailnet_hostname: "o3-alice.tail.ts.net",
        image: "o3code/workspace:1",
        tools_json: '["claude"]',
        limits_json: '{"cpus":2,"memoryMb":4096,"pids":4096}',
        secret_hash: "secret-hash",
        tailscale_device_id: null,
        disk_usage_bytes: 1024,
        created_at: at,
        updated_at: at,
      };
      yield* sql`INSERT INTO o3_workspaces ${sql.insert(v1)}`;

      yield* Migration0002;

      const rows = yield* sql`SELECT * FROM o3_workspaces`;
      const { tailscale_device_id: _dropped, ...kept } = v1;
      assert.deepEqual(rows, [
        { ...kept, workspace_id: "user-1", label: "Default", is_default: 1 },
      ]);

      // One default per user.
      const secondDefault = yield* sql`INSERT INTO o3_workspaces ${sql.insert({
        ...kept,
        workspace_id: "ws-2",
        slug: "alice-2",
        label: "Second",
        is_default: 1,
      })}`.pipe(Effect.flip);
      assert.equal(secondDefault.reason._tag, "UniqueViolation");

      yield* sql`DELETE FROM o3_users WHERE user_id = 'user-1'`;
      assert.deepEqual(yield* sql`SELECT workspace_id FROM o3_workspaces`, []);
    }),
  );
});
