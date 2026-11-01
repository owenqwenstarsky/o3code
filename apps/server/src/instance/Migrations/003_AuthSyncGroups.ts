import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE o3_auth_groups (
      group_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_normalized TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // A workspace syncs with at most one group.
  yield* sql`
    CREATE TABLE o3_auth_group_members (
      workspace_id TEXT PRIMARY KEY REFERENCES o3_workspaces(workspace_id) ON DELETE CASCADE,
      group_id TEXT NOT NULL REFERENCES o3_auth_groups(group_id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX o3_auth_group_members_by_group ON o3_auth_group_members(group_id)`;
  // One credential file per group and provider; null content records a sign-out.
  yield* sql`
    CREATE TABLE o3_auth_group_files (
      group_id TEXT NOT NULL REFERENCES o3_auth_groups(group_id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_encrypted TEXT,
      updated_by_workspace_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_id, provider)
    )
  `;
});
