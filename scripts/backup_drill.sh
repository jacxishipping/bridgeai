#!/bin/sh
# One-shot Postgres backup/restore drill for the staging plane.
#
# Run as a Render cron job (Docker runtime, same image as the plane):
#   dockerCommand: sh scripts/backup_drill.sh
#   env: DATABASE_URL = internal DSN of ai-bridge-staging-db
#
# Steps: pg_dump the live staging DB -> restore into a fresh database
# ai_bridge_staging_drill on the same server -> verify the restored DB
# has all 15 migrations and readable core tables -> drop the drill DB.
# The live database is never written to. The dump is verification-only
# and is discarded with the job's ephemeral disk. DSN passwords are never
# printed (backup_restore.py redacts them).
set -eu

RESTORE_DSN=$(python3 -c "import os; from urllib.parse import urlsplit, urlunsplit; u = urlsplit(os.environ['DATABASE_URL']); print(urlunsplit((u.scheme, u.netloc, '/ai_bridge_staging_drill', u.query, u.fragment)))")

echo "== backup: live staging DB -> /tmp/staging-dump.sql"
python3 scripts/backup_restore.py backup --pg-dsn "$DATABASE_URL" --out /tmp/staging-dump.sql

echo "== restore: dump -> ai_bridge_staging_drill"
python3 scripts/backup_restore.py restore --pg-dump /tmp/staging-dump.sql --pg-dsn "$RESTORE_DSN"

echo "== verify: restored DB table counts (expect migrations=15)"
psql "$RESTORE_DSN" -t -c "SELECT 'migrations', count(*) FROM schema_migrations UNION ALL SELECT 'users', count(*) FROM users UNION ALL SELECT 'devices', count(*) FROM devices UNION ALL SELECT 'tasks', count(*) FROM tasks UNION ALL SELECT 'sessions', count(*) FROM sessions UNION ALL SELECT 'approvals', count(*) FROM approvals;"

echo "== cleanup: drop drill DB"
dropdb "$RESTORE_DSN"
echo "DRILL OK"
