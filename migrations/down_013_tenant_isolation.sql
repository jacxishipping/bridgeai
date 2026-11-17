-- Down migration for 013_tenant_isolation.sql (MANUAL — NOT run by the
-- migration runner: this file is deliberately named down_013_* so it does
-- not match the runner's ^\d+_*.sql glob in src/ai_bridge/control/migrations.py).
--
-- SQLite cannot DROP COLUMN for a NOT NULL column with a DEFAULT on older
-- versions, so each affected table is rebuilt without the 013 column and its
-- data copied across. This is a full, explicit rebuild (not a commented
-- sketch): run the whole script with sqlite3, e.g.
--   sqlite3 control.db < down_013_tenant_isolation.sql
-- then verify with:
--   PRAGMA table_info(users); PRAGMA table_info(sessions);
--   PRAGMA table_info(approvals); PRAGMA table_info(tasks);
-- and remove the migration record:
--   DELETE FROM schema_migrations WHERE version = '013';
--
-- RISK NOTE (honest): rebuilding drops and recreates the four tables. The
-- INSERT ... SELECT statements preserve every row and every pre-013 column
-- value; the two indexes on the rebuilt tables (idx_tasks_device_status,
-- idx_approvals_task_id) are recreated below because DROP TABLE drops its
-- indexes. No other index touches these four tables. Foreign keys are
-- disabled for the rebuild and re-enabled at the end; there are no FK
-- constraints declared on these tables in the inline SCHEMA, so no FK
-- data is at risk. Take a file-level backup of control.db BEFORE running
-- this script (cp control.db control.db.pre-013-down), and run it while
-- the control plane is stopped so no worker writes mid-rebuild.
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;
CREATE TABLE users_new (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer',
  created_at REAL NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
INSERT INTO users_new (id, username, password_hash, salt, role, created_at, disabled)
  SELECT id, username, password_hash, salt, role, created_at, disabled FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE TABLE sessions_new (
  token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL,
  expires_at REAL NOT NULL, created_at REAL NOT NULL);
INSERT INTO sessions_new (token_hash, username, role, expires_at, created_at)
  SELECT token_hash, username, role, expires_at, created_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE TABLE approvals_new (
  id TEXT PRIMARY KEY, task_id TEXT, tool TEXT, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL, decided_by TEXT,
  expires_at REAL, decided_at REAL, policy_version INTEGER NOT NULL DEFAULT 0);
INSERT INTO approvals_new (id, task_id, tool, reason, status, created_at, decided_by, expires_at, decided_at, policy_version)
  SELECT id, task_id, tool, reason, status, created_at, decided_by, expires_at, decided_at, policy_version FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, tenant TEXT NOT NULL DEFAULT 'default',
  tool TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '{}', tier INTEGER,
  status TEXT NOT NULL DEFAULT 'queued', result TEXT DEFAULT '',
  approval_id TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL);
INSERT INTO tasks_new (id, device_id, tenant, tool, args_json, tier, status, result, approval_id, created_at, updated_at)
  SELECT id, device_id, tenant, tool, args_json, tier, status, result, approval_id, created_at, updated_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX IF NOT EXISTS idx_tasks_device_status ON tasks(device_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_task_id ON approvals(task_id);
COMMIT;
PRAGMA foreign_keys = ON;
DELETE FROM schema_migrations WHERE version = '013';
