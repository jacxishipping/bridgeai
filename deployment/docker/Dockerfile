FROM python:3.12-slim AS base
# Postgres client tools for the backup/restore drill (scripts/backup_restore.py
# needs pg_dump/psql/pg_restore/createdb on PATH).
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
# The control plane embeds the OAuth gateway on PaaS (combined.py loads
# deployment/oauth/gateway.py relative to the repo root), so it must be in
# the image too — without it the container crashes on boot with
# ModuleNotFoundError: No module named 'gateway'.
COPY deployment/oauth ./deployment/oauth
# The Postgres boot runs migrations from the repo-root migrations/
# directory (migrations.py refuses to start without it, DB-08).
COPY migrations ./migrations
# Ops scripts (backup/restore drill) — also used by the Render cron job.
COPY scripts ./scripts
RUN pip install --no-cache-dir -e .

FROM base AS dev
RUN pip install --no-cache-dir watchfiles
EXPOSE 8000

FROM base AS production
# Render overrides with $PORT at runtime; the app binds 0.0.0.0:$PORT when set.
EXPOSE 8000
CMD ["python", "-m", "ai_bridge.control"]
