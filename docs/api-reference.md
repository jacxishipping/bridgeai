# API reference (control plane, v0.2 snapshot — incomplete for v0.3)

> **Status:** this file is a v0.2-era snapshot, not a complete v0.3
> reference. It documents the core device/task/approval/audit routes
> only. It does NOT document `/api/v1/*` sessions, OIDC
> (`/api/auth/oidc/*`), policies (`/api/policies`), users, backups, or
> WebRTC routes that exist in `control/app.py` / `v1_routes.py`. Do not
> rely on it as a complete endpoint list; the route table in
> `analysis/03_SOURCE_CODE_INVENTORY.md` and the code are authoritative
> until this file is rewritten from the 142 routes in `control/app.py`.

Base: `http://127.0.0.1:8000`. Admin header: `X-Admin-Token`.
Device header: `X-Device-Token`.
- `GET /health` — status + emergency-stop flag (no auth).
- `POST /api/devices/enroll` (admin) `{name, hostname?, os?, tenant?}` -> `{device_id, device_token}` (token shown once).
- `GET /api/devices?tenant=` (admin) — list (no token hashes returned).
- `POST /api/devices/{id}/revoke` (admin).
- `POST /api/tasks` (admin) `{device_id, tool, args, tenant?}` -> `{task_id, status, tier, approval_id?}`. Tier-4 -> `needs_approval`.
- `GET /api/tasks`, `GET /api/tasks/{id}`, `POST /api/tasks/{id}/cancel` (admin).
- `GET /api/approvals`, `POST /api/approvals/{id}/decide` (admin) `{decision: approved|denied}`.
- `GET /api/audit?tenant=&tool=` (admin).
- `POST /api/emergency-stop`, `POST /api/emergency-stop/clear` (admin).
- `POST /api/agent/heartbeat`, `GET /api/agent/tasks/next`, `POST /api/agent/tasks/{id}/result` (device token).
All list endpoints cap at 200-500 rows. Errors are JSON `{detail: ...}`
and never include tokens or credentials.
