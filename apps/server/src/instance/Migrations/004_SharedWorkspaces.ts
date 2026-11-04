import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Dropping o3_workspaces cascades into its child tables, so their rows are set aside first.
  yield* sql`
    CREATE TEMP TABLE o3_members_carry AS
    SELECT workspace_id, user_id, is_default, created_at FROM o3_workspaces
  `;
  yield* sql`CREATE TEMP TABLE o3_auth_members_carry AS SELECT * FROM o3_auth_group_members`;
  yield* sql`
    CREATE TABLE o3_workspaces_next (
      workspace_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      status_message TEXT,
      container_id TEXT,
      tailnet_hostname TEXT,
      image TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      limits_json TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      disk_usage_bytes INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // Every user's first workspace was labelled "Default"; in one shared list it takes their name.
  yield* sql`
    INSERT INTO o3_workspaces_next (
      workspace_id, label, slug, status, status_message, container_id, tailnet_hostname, image,
      tools_json, limits_json, secret_hash, disk_usage_bytes, created_at, updated_at
    )
    SELECT
      w.workspace_id,
      CASE WHEN w.label = 'Default' THEN substr(trim(u.name), 1, 40) ELSE w.label END,
      w.slug, w.status, w.status_message, w.container_id, w.tailnet_hostname, w.image,
      w.tools_json, w.limits_json, w.secret_hash, w.disk_usage_bytes, w.created_at, w.updated_at
    FROM o3_workspaces w JOIN o3_users u ON u.user_id = w.user_id
  `;
  yield* sql`DROP TABLE o3_workspaces`;
  yield* sql`ALTER TABLE o3_workspaces_next RENAME TO o3_workspaces`;
  yield* sql`
    CREATE TABLE o3_workspace_members (
      workspace_id TEXT NOT NULL REFERENCES o3_workspaces(workspace_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES o3_users(user_id) ON DELETE CASCADE,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    )
  `;
  yield* sql`CREATE INDEX o3_workspace_members_by_user ON o3_workspace_members(user_id, created_at)`;
  yield* sql`
    CREATE UNIQUE INDEX o3_workspace_members_one_default
    ON o3_workspace_members(user_id) WHERE is_default = 1
  `;
  yield* sql`INSERT INTO o3_workspace_members SELECT * FROM o3_members_carry`;
  yield* sql`DELETE FROM o3_auth_group_members`;
  yield* sql`INSERT INTO o3_auth_group_members SELECT * FROM o3_auth_members_carry`;
  yield* sql`DROP TABLE o3_members_carry`;
  yield* sql`DROP TABLE o3_auth_members_carry`;
});
