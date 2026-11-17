-- Down migration for 014_stream_tickets.sql (Wave 3A).
--
-- WARNING: drops the stream_tickets table and every ticket in it.
-- Outstanding tickets are single-use credentials with a 60 s TTL, so
-- dropping them only forces dashboard clients to mint fresh tickets;
-- no durable data is lost. Run while the control plane is stopped.
-- Apply manually, e.g.:
--   sqlite3 control.db < down_014_stream_tickets.sql
-- or via the runner: migrations.run_down_migration(conn, "014").
DROP TABLE IF EXISTS stream_tickets;
DELETE FROM schema_migrations WHERE version = '014';
