-- Migration 014: canonical stream_tickets table (D-08 follow-up, Wave 3A).
--
-- The Wave 2 fix-up created this table inline in db.py SCHEMA (SQLite
-- fresh installs) plus ensure_stream_tickets_table() for older databases.
-- This migration makes it a first-class schema object so PostgreSQL
-- deployments — whose schema comes from migrations alone, never from
-- SCHEMA — get the table too, and so the table's existence is tracked
-- in schema_migrations like every other table.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, so SQLite databases that
-- already have the table from SCHEMA just record the version.
-- Column types use DOUBLE PRECISION (the migration-file convention);
-- the runner adapts them to REAL on SQLite.
CREATE TABLE IF NOT EXISTS stream_tickets (
  ticket_hash TEXT PRIMARY KEY, actor TEXT NOT NULL,
  tenant TEXT NOT NULL DEFAULT 'default', device_id TEXT NOT NULL,
  session_id TEXT NOT NULL, expires_at DOUBLE PRECISION NOT NULL,
  used INTEGER NOT NULL DEFAULT 0, created_at DOUBLE PRECISION NOT NULL);
CREATE INDEX IF NOT EXISTS idx_stream_tickets_expires ON stream_tickets(expires_at);
-- Down migration: DROP TABLE stream_tickets (+ delete the 014 row).
-- Full SQL lives in down_014_stream_tickets.sql (same directory).
-- After running the down migration manually, also run:
--   DELETE FROM schema_migrations WHERE version = '014';
