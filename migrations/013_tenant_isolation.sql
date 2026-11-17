-- Migration 013: tenant isolation columns + task execution epoch (R-P0-12, F07-04/DIST-02).
-- Idempotent: ALTER TABLE ... ADD COLUMN IF NOT EXISTS (the runner in
-- src/ai_bridge/control/migrations.py strips "--" comment lines, splits on ";",
-- and skips ADD COLUMN when the column already exists on SQLite).
-- Single-tenant data migrates under "default": the NOT NULL DEFAULT 'default'
-- backfills every existing row, so no data movement is needed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default';
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS tenant TEXT NOT NULL DEFAULT 'default';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS epoch INTEGER NOT NULL DEFAULT 0;
-- Down migration: SQLite has no DROP COLUMN for these (and DROP COLUMN cannot
-- remove a NOT NULL column with a default cleanly on older SQLite), so the
-- down migration rebuilds users / sessions / approvals / tasks without the
-- new columns. Full rebuild SQL lives in down_013_tenant_isolation.sql
-- (same directory; deliberately NOT named 013_*.down.sql so the runner,
-- which globs ^\d+_*.sql, never picks it up as a migration).
-- PostgreSQL equivalent of the down migration:
--   ALTER TABLE users DROP COLUMN IF EXISTS tenant;
--   ALTER TABLE sessions DROP COLUMN IF EXISTS tenant;
--   ALTER TABLE approvals DROP COLUMN IF EXISTS tenant;
--   ALTER TABLE tasks DROP COLUMN IF EXISTS epoch;
-- After running the down migration manually, also run:
--   DELETE FROM schema_migrations WHERE version = '013';
