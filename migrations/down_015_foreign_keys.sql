-- Down migration for 015_foreign_keys.sql (Wave 3A).
--
-- WARNING: removes the foreign keys / CHECKs added by 015 and drops the
-- tasks.handoff_id / tasks.parent_task_id columns. Rows are preserved
-- (rebuilds copy every row); only the constraints and the two columns
-- go away. Run while the control plane is stopped.
-- Apply manually, e.g.:
--   sqlite3 control.db < down_015_foreign_keys.sql
-- or via the runner: migrations.run_down_migration(conn, "015").
--
-- @foreign-keys: off

-- --- PostgreSQL: drop constraints + columns --------------------------------
-- @only: postgres
-- @requires-table: approvals
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS fk_approvals_task;
-- @only: postgres
-- @requires-table: task_events
ALTER TABLE task_events DROP CONSTRAINT IF EXISTS fk_task_events_task;
-- @only: postgres
-- @requires-table: telemetry
ALTER TABLE telemetry DROP CONSTRAINT IF EXISTS fk_telemetry_device;
-- @only: postgres
-- @requires-table: sessions
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS fk_sessions_user;
-- @only: postgres
-- @requires-table: tasks
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS chk_tasks_status;
-- @only: postgres
-- @requires-table: tasks
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS chk_tasks_tier;
-- @only: postgres
-- @requires-table: users
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_users_role;
-- @only: postgres
-- @requires-table: devices
ALTER TABLE devices DROP CONSTRAINT IF EXISTS chk_devices_status;
-- @only: postgres
-- @requires-table: approvals
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS chk_approvals_status;
-- @only: postgres
-- @requires-table: tasks
ALTER TABLE tasks DROP COLUMN IF EXISTS handoff_id;
-- @only: postgres
-- @requires-table: tasks
ALTER TABLE tasks DROP COLUMN IF EXISTS parent_task_id;
-- @only: postgres
DROP INDEX IF EXISTS idx_tasks_handoff_id;
-- @only: postgres
DROP INDEX IF EXISTS idx_tasks_parent_task;
-- @only: postgres
DROP INDEX IF EXISTS idx_tasks_status_updated;

-- --- SQLite: rebuilds without constraints / without the two columns --------
-- @only: sqlite
-- @requires-table: tasks
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, tenant TEXT NOT NULL DEFAULT 'default',
  tool TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '{}', tier INTEGER,
  status TEXT NOT NULL DEFAULT 'queued', result TEXT DEFAULT '',
  approval_id TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0);
-- @only: sqlite
-- @requires-table: tasks
INSERT INTO tasks_new (id, device_id, tenant, tool, args_json, tier, status, result, approval_id, created_at, updated_at, epoch)
  SELECT id, device_id, tenant, tool, args_json, tier, status, result, approval_id, created_at, updated_at, epoch FROM tasks;
-- @only: sqlite
-- @requires-table: tasks
DROP TABLE tasks;
-- @only: sqlite
-- @requires-table: tasks_new
ALTER TABLE tasks_new RENAME TO tasks;
-- @only: sqlite
-- @requires-table: tasks
CREATE INDEX IF NOT EXISTS idx_tasks_device_status ON tasks(device_id, status);
-- @only: sqlite
-- @requires-table: tasks
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_created ON tasks(tenant, created_at DESC, id);
-- @only: sqlite
-- @requires-table: tasks
DROP INDEX IF EXISTS idx_tasks_handoff_id;
-- @only: sqlite
-- @requires-table: tasks
DROP INDEX IF EXISTS idx_tasks_parent_task;
-- @only: sqlite
-- @requires-table: tasks
DROP INDEX IF EXISTS idx_tasks_status_updated;

-- @only: sqlite
-- @requires-table: approvals
CREATE TABLE approvals_new (
  id TEXT PRIMARY KEY, task_id TEXT, tool TEXT, reason TEXT,
  tenant TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL, decided_by TEXT,
  expires_at REAL, decided_at REAL, policy_version INTEGER NOT NULL DEFAULT 0);
-- @only: sqlite
-- @requires-table: approvals
INSERT INTO approvals_new (id, task_id, tool, reason, tenant, status, created_at, decided_by, expires_at, decided_at, policy_version)
  SELECT id, task_id, tool, reason, tenant, status, created_at, decided_by, expires_at, decided_at, policy_version FROM approvals;
-- @only: sqlite
-- @requires-table: approvals
DROP TABLE approvals;
-- @only: sqlite
-- @requires-table: approvals_new
ALTER TABLE approvals_new RENAME TO approvals;
-- @only: sqlite
-- @requires-table: approvals
CREATE INDEX IF NOT EXISTS idx_approvals_task_id ON approvals(task_id);

-- @only: sqlite
-- @requires-table: task_events
CREATE TABLE task_events_new (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event TEXT NOT NULL,
  detail_json TEXT, created_at REAL NOT NULL);
-- @only: sqlite
-- @requires-table: task_events
INSERT INTO task_events_new (id, task_id, event, detail_json, created_at)
  SELECT id, task_id, event, detail_json, created_at FROM task_events;
-- @only: sqlite
-- @requires-table: task_events
DROP TABLE task_events;
-- @only: sqlite
-- @requires-table: task_events_new
ALTER TABLE task_events_new RENAME TO task_events;
-- @only: sqlite
-- @requires-table: task_events
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);

-- @only: sqlite
-- @requires-table: telemetry
CREATE TABLE telemetry_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
  tenant TEXT NOT NULL DEFAULT 'default', cpu_percent REAL,
  memory_percent REAL, disk_percent REAL, recorded_at REAL NOT NULL);
-- @only: sqlite
-- @requires-table: telemetry
INSERT INTO telemetry_new (id, device_id, tenant, cpu_percent, memory_percent, disk_percent, recorded_at)
  SELECT id, device_id, tenant, cpu_percent, memory_percent, disk_percent, recorded_at FROM telemetry;
-- @only: sqlite
-- @requires-table: telemetry
DROP TABLE telemetry;
-- @only: sqlite
-- @requires-table: telemetry_new
ALTER TABLE telemetry_new RENAME TO telemetry;
-- @only: sqlite
-- @requires-table: telemetry
CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON telemetry(device_id, recorded_at DESC);

-- @only: sqlite
-- @requires-table: sessions
CREATE TABLE sessions_new (
  token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL,
  tenant TEXT NOT NULL DEFAULT 'default',
  expires_at REAL NOT NULL, created_at REAL NOT NULL);
-- @only: sqlite
-- @requires-table: sessions
INSERT INTO sessions_new (token_hash, username, role, tenant, expires_at, created_at)
  SELECT token_hash, username, role, tenant, expires_at, created_at FROM sessions;
-- @only: sqlite
-- @requires-table: sessions
DROP TABLE sessions;
-- @only: sqlite
-- @requires-table: sessions_new
ALTER TABLE sessions_new RENAME TO sessions;

-- @only: sqlite
-- @requires-table: users
CREATE TABLE users_new (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer',
  tenant TEXT NOT NULL DEFAULT 'default',
  created_at REAL NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
-- @only: sqlite
-- @requires-table: users
INSERT INTO users_new (id, username, password_hash, salt, role, tenant, created_at, disabled)
  SELECT id, username, password_hash, salt, role, tenant, created_at, disabled FROM users;
-- @only: sqlite
-- @requires-table: users
DROP TABLE users;
-- @only: sqlite
-- @requires-table: users_new
ALTER TABLE users_new RENAME TO users;

-- @only: sqlite
-- @requires-table: devices
CREATE TABLE devices_new (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT, os TEXT,
  tenant TEXT NOT NULL DEFAULT 'default', token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline', last_seen REAL,
  policy_json TEXT NOT NULL DEFAULT '{}', revoked INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, token_expires_at REAL, token_issued_at REAL,
  capabilities_json TEXT NOT NULL DEFAULT '[]', mtls_fingerprint TEXT);
-- @only: sqlite
-- @requires-table: devices
INSERT INTO devices_new (id, name, hostname, os, tenant, token_hash, status, last_seen, policy_json, revoked, created_at, token_expires_at, token_issued_at, capabilities_json, mtls_fingerprint)
  SELECT id, name, hostname, os, tenant, token_hash, status, last_seen, policy_json, revoked, created_at, token_expires_at, token_issued_at, capabilities_json, mtls_fingerprint FROM devices;
-- @only: sqlite
-- @requires-table: devices
DROP TABLE devices;
-- @only: sqlite
-- @requires-table: devices_new
ALTER TABLE devices_new RENAME TO devices;
-- @only: sqlite
-- @requires-table: devices
CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(token_hash);
-- @only: sqlite
-- @requires-table: devices
CREATE INDEX IF NOT EXISTS idx_devices_tenant_name ON devices(tenant, name, id);

DELETE FROM schema_migrations WHERE version = '015';
