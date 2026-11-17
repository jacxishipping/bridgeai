-- Migration 015: referential integrity + enum CHECKs + handoff columns (DB-02, PERF-07, PERF-11).
--
-- * tasks.handoff_id / tasks.parent_task_id columns + indexes (PERF-07:
--   supervisor.handoff_status() used to full-table-scan tasks and filter
--   on args_json in Python; it now queries WHERE handoff_id=?).
-- * PERF-11: tasks(status, updated_at) index (the tenant/created_at one
--   already exists since migration 004).
-- * Foreign keys (DB-02): approvals.task_id -> tasks, task_events.task_id
--   -> tasks, telemetry.device_id -> devices, sessions.username ->
--   users(username), all ON DELETE CASCADE, so deleting a device / task /
--   user can no longer leave orphaned rows. tasks.device_id deliberately
--   has NO foreign key: 'local' is a virtual device with no devices row;
--   device deletion must use db.delete_device_cascade(), which explicitly
--   cleans a device's tasks/telemetry/events/approvals in one transaction.
-- * CHECKs (DB-02): tasks.status / tasks.tier / users.role /
--   devices.status / approvals.status enums, verified against every
--   status assignment in src/ai_bridge/control/*.py before writing.
--
-- Engine split: PostgreSQL gets ALTER TABLE ... ADD CONSTRAINT (the
-- native form); SQLite cannot add a constraint to an existing table,
-- so each constrained table is rebuilt (new table -> INSERT ... SELECT
-- -> DROP -> RENAME), the same pattern down_013 already uses.
--
-- @foreign-keys: off
--   The rebuilds run with SQLite FK enforcement off (toggled by the
--   runner outside the transaction — the pragma is a no-op inside one):
--   dropping a parent table with enforcement on would cascade-delete
--   its child rows (verified empirically, 2026-11-17).
--
-- Orphan cleanup runs first: rows whose parent is already gone are
-- deleted (they are unreachable — fleet health joins devices, handoff
-- status joins tasks — so nothing visible is lost).
-- Idempotency: every statement is IF NOT EXISTS / guarded, and the
-- runner skips statements whose @requires-table is absent, so this
-- file also applies to the minimal pre-013-style test databases.

-- --- A. New columns + indexes (both engines) -------------------------------
-- @requires-table: tasks
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS handoff_id TEXT;
-- @requires-table: tasks
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id TEXT;
-- @requires-table: tasks
CREATE INDEX IF NOT EXISTS idx_tasks_handoff_id ON tasks(handoff_id);
-- @requires-table: tasks
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task ON tasks(parent_task_id);
-- @requires-table: tasks
CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at);
-- These two indexes existed in db.py SCHEMA but in no migration; adding
-- them here so a migrations-only boot (DB-03) matches a SCHEMA boot.
-- @requires-table: devices
CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(token_hash);
-- @requires-table: policies
CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_version ON policies(version);
-- task_submissions.created_at exists in SCHEMA but in no migration (004
-- created the table without it); add it here so the two boots match.
-- The default is dialect-specific: strftime() does not exist in Postgres.
-- @only: sqlite
-- @requires-table: task_submissions
ALTER TABLE task_submissions ADD COLUMN IF NOT EXISTS created_at REAL NOT NULL DEFAULT (strftime('%s','now'));
-- @only: postgres
-- @requires-table: task_submissions
ALTER TABLE task_submissions ADD COLUMN IF NOT EXISTS created_at DOUBLE PRECISION NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW());

-- --- B. Orphan cleanup (both engines) --------------------------------------
-- @requires-table: task_events
-- @requires-table: tasks
DELETE FROM task_events WHERE task_id NOT IN (SELECT id FROM tasks);
-- @requires-table: telemetry
-- @requires-table: devices
DELETE FROM telemetry WHERE device_id NOT IN (SELECT id FROM devices);
-- @requires-table: approvals
-- @requires-table: tasks
DELETE FROM approvals WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks);
-- @requires-table: sessions
-- @requires-table: users
DELETE FROM sessions WHERE username NOT IN (SELECT username FROM users);

-- --- C. PostgreSQL: native constraints --------------------------------------
-- @only: postgres
-- @requires-table: tasks
ALTER TABLE tasks ADD CONSTRAINT chk_tasks_status CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'needs_approval'));
-- @only: postgres
-- @requires-table: tasks
ALTER TABLE tasks ADD CONSTRAINT chk_tasks_tier CHECK (tier IS NULL OR (tier >= 1 AND tier <= 4));
-- @only: postgres
-- @requires-table: users
ALTER TABLE users ADD CONSTRAINT chk_users_role CHECK (role IN ('viewer', 'operator', 'admin'));
-- @only: postgres
-- @requires-table: devices
ALTER TABLE devices ADD CONSTRAINT chk_devices_status CHECK (status IN ('online', 'offline', 'revoked'));
-- @only: postgres
-- @requires-table: approvals
ALTER TABLE approvals ADD CONSTRAINT chk_approvals_status CHECK (status IN ('pending', 'approved', 'denied', 'expired'));
-- @only: postgres
-- @requires-table: approvals
-- @requires-table: tasks
-- DEFERRABLE INITIALLY DEFERRED: task_service.create_task inserts the
-- approval row BEFORE the task row in one transaction, so the FK is
-- checked at commit, not at statement time. Cascade + orphan protection
-- still hold at commit.
ALTER TABLE approvals ADD CONSTRAINT fk_approvals_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
-- @only: postgres
-- @requires-table: task_events
-- @requires-table: tasks
ALTER TABLE task_events ADD CONSTRAINT fk_task_events_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;
-- @only: postgres
-- @requires-table: telemetry
-- @requires-table: devices
ALTER TABLE telemetry ADD CONSTRAINT fk_telemetry_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE;
-- @only: postgres
-- @requires-table: sessions
-- @requires-table: users
ALTER TABLE sessions ADD CONSTRAINT fk_sessions_user FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE;

-- --- D. SQLite: table rebuilds with the same constraints --------------------
-- @only: sqlite
-- @requires-table: tasks
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, tenant TEXT NOT NULL DEFAULT 'default',
  tool TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '{}', tier INTEGER,
  status TEXT NOT NULL DEFAULT 'queued', result TEXT DEFAULT '',
  approval_id TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0, handoff_id TEXT, parent_task_id TEXT,
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'needs_approval')),
  CHECK (tier IS NULL OR (tier >= 1 AND tier <= 4)));
-- @only: sqlite
-- @requires-table: tasks
INSERT INTO tasks_new (id, device_id, tenant, tool, args_json, tier, status, result, approval_id, created_at, updated_at, epoch, handoff_id, parent_task_id)
  SELECT id, device_id, tenant, tool, args_json, tier, status, result, approval_id, created_at, updated_at, epoch, handoff_id, parent_task_id FROM tasks;
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
CREATE INDEX IF NOT EXISTS idx_tasks_handoff_id ON tasks(handoff_id);
-- @only: sqlite
-- @requires-table: tasks
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task ON tasks(parent_task_id);
-- @only: sqlite
-- @requires-table: tasks
CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at);

-- @only: sqlite
-- @requires-table: approvals
CREATE TABLE approvals_new (
  id TEXT PRIMARY KEY, task_id TEXT, tool TEXT, reason TEXT,
  tenant TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL, decided_by TEXT,
  expires_at REAL, decided_at REAL, policy_version INTEGER NOT NULL DEFAULT 0,
  CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED);
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
  detail_json TEXT, created_at REAL NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE);
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
  memory_percent REAL, disk_percent REAL, recorded_at REAL NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE);
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
  expires_at REAL NOT NULL, created_at REAL NOT NULL,
  FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE);
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
  created_at REAL NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
  CHECK (role IN ('viewer', 'operator', 'admin')));
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
  capabilities_json TEXT NOT NULL DEFAULT '[]', mtls_fingerprint TEXT,
  CHECK (status IN ('online', 'offline', 'revoked')));
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

-- Down migration: rebuilds without constraints (SQLite) / DROP CONSTRAINT +
-- DROP COLUMN (PostgreSQL) + index cleanup. Full SQL lives in
-- down_015_foreign_keys.sql (same directory).
-- After running the down migration manually, also run:
--   DELETE FROM schema_migrations WHERE version = '015';
