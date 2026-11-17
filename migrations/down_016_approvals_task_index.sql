-- Down migration for 016_approvals_task_index.sql (Wave 6A).
--
-- Drops the index added by 016. Safe: it is only an index (no data).
-- Apply manually, e.g.:
--   sqlite3 control.db < down_016_approvals_task_index.sql
-- or via the runner: migrations.run_down_migration(conn, "016").
DROP INDEX IF EXISTS idx_approvals_task_id;
