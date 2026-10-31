import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE o3_users (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      email_normalized TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disabled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    )
  `;
  // One workspace per user; the row outlives its container so a recreate keeps identity.
  yield* sql`
    CREATE TABLE o3_workspaces (
      user_id TEXT PRIMARY KEY REFERENCES o3_users(user_id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      status_message TEXT,
      container_id TEXT,
      tailnet_hostname TEXT,
      image TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      limits_json TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      tailscale_device_id TEXT,
      disk_usage_bytes INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE o3_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE o3_audit_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor_user_id TEXT,
      actor_email TEXT,
      action TEXT NOT NULL,
      target_user_id TEXT,
      target_email TEXT,
      detail TEXT,
      ip_address TEXT
    )
  `;
});
