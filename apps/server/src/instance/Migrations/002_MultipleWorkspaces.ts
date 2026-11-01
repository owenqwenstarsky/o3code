import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE o3_workspaces_next (
      workspace_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES o3_users(user_id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
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
  // Existing workspaces take their user's id, so volume names and container credentials still match.
  yield* sql`
    INSERT INTO o3_workspaces_next (
      workspace_id, user_id, label, is_default, slug, status, status_message, container_id,
      tailnet_hostname, image, tools_json, limits_json, secret_hash, disk_usage_bytes,
      created_at, updated_at
    )
    SELECT
      user_id, user_id, 'Default', 1, slug, status, status_message, container_id,
      tailnet_hostname, image, tools_json, limits_json, secret_hash, disk_usage_bytes,
      created_at, updated_at
    FROM o3_workspaces
  `;
  yield* sql`DROP TABLE o3_workspaces`;
  yield* sql`ALTER TABLE o3_workspaces_next RENAME TO o3_workspaces`;
  yield* sql`CREATE INDEX o3_workspaces_by_user ON o3_workspaces(user_id, created_at)`;
  yield* sql`
    CREATE UNIQUE INDEX o3_workspaces_one_default ON o3_workspaces(user_id) WHERE is_default = 1
  `;
});
