# Operations
- Health: `GET /health` on the plane; `GET /api/devices` shows online/offline.
- Logs: `journalctl -u ai-bridge-*`; audit via `GET /api/audit`.
- Emergency stop: dashboard button or `POST /api/emergency-stop` (admin
  token). Clears with `POST /api/emergency-stop/clear`. While active,
  new tasks are rejected (403) and agents report `emergency_stop: true`.
- Upgrades: `git fetch --tags && git checkout vX.Y.Z`, reinstall the venv,
  restart services, re-run `pytest -q`. Roll back the same way to the
  previous tag; the SQLite/Postgres schema was additive in v0.2, but that
  has NOT been re-verified for the v0.3 migrations (002–012) — before a
  rollback, restore from a tested backup (`pg_dump` / `control.db` copy,
  see below) rather than assuming a checkout alone is safe.
- Backups: workspace backups live in `<workspace>/.ai-bridge-backups/`
  (timestamped ZIPs). Copy them off-device; also back up `control.db`
  (or `pg_dump ai_bridge`) nightly.
- Rate limiting: 30 req/min per IP on auth endpoints; 1200/min per authenticated token, 300/min per unauthenticated IP otherwise (60 s windows). For production,
  add proxy-level limiting and per-tenant quotas.
