# Dashboard P1 remediation — P1-3 (device-token rotation + mTLS fingerprint)

**Date:** 18 Nov 2026 (~01:07 UTC)
**Scope:** P1-3 ONLY. P1-4 (user deletion + password change/reset) was dropped mid-wave because James did it himself — see "P1-4 — scope change" below. Nothing in this wave implements, modifies, or tests P1-4.
**Source findings:** `DASHBOARD_AUDIT.md` §5.2.3, §5.4.1, §7 (P1-3, P1-4).
**Work split:** backend worker + dashboard worker in parallel against a fixed API contract; coordinator verified the combined tree itself (see "Final verification").

## Final verification (combined tree, coordinator's own runs, 18 Nov 2026 ~01:07 UTC)

| Check | Result |
|---|---|
| Backend `pytest tests/unit/test_p1_device_identity.py tests/unit/test_architecture_phase4_routers.py tests/unit/test_api_reference.py tests/unit/test_phase3_fleet_ops.py` | **33 passed, 0 failed** (new module 4; route snapshot 19; api-reference 3; fleet ops 7) |
| Dashboard `npx tsc -b` (apps/dashboard) | **exit 0** |
| Dashboard `npm test` (full suite) | **448/448 pass** (434 baseline + 14 new P1-3), 0 failed; `test:i18n` 4/4 |
| Dashboard `npm run build` | **clean** (built in 7.62 s) |
| `window.confirm` / `window.prompt` in dashboard `src/` | **0 calls** (doc comments only) |
| P1-4 remnants in tree | **0** — grep for `me/password`, `reset-password`, `delete_user`, `change_password`, `reset_password`, `PasswordChangeIn`, `PasswordResetIn`, `deleteUser`, `changeMyPassword`, `resetUserPassword` over `src/`, `tests/`, `apps/dashboard/src/` returns zero hits (excluding the dashboard test file's negative assertions, which assert those wrappers do *not* exist) |

No test was deleted, skipped, or weakened. No deployment, no production or live-device contact, per authorization.

## P1-3 — Admin-side device-token rotation + mTLS fingerprint management — CLOSED

### Backend

**`POST /api/devices/{device_id}/rotate-token`** — `src/ai_bridge/control/routers/devices.py:168` (`rotate_device_token`, :169–~201).
- Admin only via `require_role("admin")` (401 unauthenticated, 403 viewer/operator). 404 unknown **or revoked** device with the refresh endpoint's exact wording `"Device not found or revoked."`; tenant check via `_require_row_tenant` (cross-tenant → 404, no oracle).
- Reuses the enrollment issuance path, not a second one: new `secrets.token_urlsafe(32)`; `UPDATE devices SET token_hash=?, token_issued_at=?, token_expires_at=?` with `issued = dbmod.now()`, `expires = issued + device_ttl_days * 86400` (default 7 days, env `AI_BRIDGE_DEVICE_TOKEN_TTL_DAYS`).
- Old token dies immediately: the new hash replaces the stored one in the same commit, and `device_routing.clear_verify_cache()` is called best-effort (same pattern as revoke) so the old token is not usable until the 5 s cache TTL would otherwise expire it.
- Audit action `rotate_device_token` with `tenant=row tenant`.
- 200: `{"device_id", "device_token", "token_expires_at", "token_ttl_days", "note": "Old token is invalid immediately. Store the new token securely; it will not be shown again."}`

**`POST /api/devices/{device_id}/mtls-fingerprint` clear extension** — `src/ai_bridge/control/routers/devices.py:796` (`set_device_mtls_fingerprint`).
- Auth/404 unchanged (admin; `_require_device_tenant`; 404 unknown/revoked device).
- Both keys missing → 400 `"fingerprint required"` (unchanged). A key that is present but normalizes to empty (via `device_mtls.normalize_fingerprint`) → **CLEAR**: `set_device_fingerprint(conn, device_id, "")` sets the column NULL, audit action `clear_mtls_fingerprint`, returns `{"ok": true, "device_id", "mtls_fingerprint": null}`. Presence — not truthiness — is the test, so `{"fingerprint": ""}` clears instead of 400ing. Non-empty → set as before, audit `set_mtls_fingerprint`, unchanged response shape.
- No schema change was needed: the `mtls_fingerprint` column already exists on `devices` (lazy-added by `device_mtls.ensure_mtls_column`).

**Role decision (documented):** rotation is `admin`, not `operator`. Sibling credential operations (enroll, revoke, delete, update device) are all admin; refresh telemetry (read-only diagnostics) is operator. Reissuing a device credential is a credential operation, so it follows the enroll/revoke side. The same reasoning keeps the fingerprint endpoint admin-only (unchanged).

**Tests** — new `tests/unit/test_p1_device_identity.py` (4 tests): rotate success (old token → 401 on heartbeat, new token → 200); rotate 401/403-viewer/403-operator/404-unknown/404-revoked; mTLS set-then-clear (verified against the DB column, including clear via the alternate `mtls_fingerprint` key); mTLS 400-missing-keys/404-unknown/401. Route snapshot updated with the single entry `("POST", "/api/devices/{device_id}/rotate-token")` (`tests/unit/test_architecture_phase4_routers.py:202`, count comment 228 → 229). `docs/api-reference.md` regenerated via `scripts/generate_api_reference.py` (`api-reference.md:136`).
- Side effect of regeneration (pre-existing doc drift, not this wave's change): the previously-missing `POST /api/fleet/broadcast/{batch_id}/cancel` row (from the UX-23 wave) was also added. Count is now 229 = 228 + rotate-token. No other doc changes.

**CSRF note:** rotate-token called with a session token needs `X-CSRF-Token` (minted from `GET /api/auth/csrf-token`), like every other session-token POST. Legacy admin-token calls are CSRF-exempt. The dashboard's `api.call()` handles this.

### Dashboard

**`src/api.ts`** — two wrappers + typed results, following the existing `call()` patterns (auth + CSRF handled by `call()`; `ApiError` carries `.status` and the server detail):
- `rotateDeviceToken(deviceId)` → `POST /api/devices/{id}/rotate-token` (`:332`; `RotateDeviceTokenResult` `:277`)
- `setDeviceMtlsFingerprint(deviceId, fingerprint)` → `POST /api/devices/{id}/mtls-fingerprint`, body `{fingerprint}` (`:335`; `SetMtlsFingerprintResult` `:290`). Empty string is sent verbatim for clear, per the contract.

**`src/state/tokenExpiry.ts` (new, 56 lines)** — shared expiry logic so both views and the tests agree: `TOKEN_EXPIRY_WARNING_HOURS = 72` (`TOKEN_EXPIRY_WARNING_MS`), `tokenExpiryStatus()` / `tokenExpiryLabel()`. Threshold documented in a code comment: default token TTL is 7 days, so 72 h gives time to rotate. `token_expires_at` is epoch seconds (backend `devices.py:58` — `issued + ttl_days * 86400`); millisecond values are tolerated defensively. Boundary is inclusive: exactly 72 h out counts as "expiring".

**`src/types/dashboard.ts:90`** — `tokenExpiresAt?: number` (epoch seconds) added to `EnrolledDevice`. **`src/state/dashboardStore.ts:949`** — `syncWithBackend` now maps `d.token_expires_at` onto it (previously dropped).

**`src/views/DevicesView.tsx`**
- Rotate token button per row (`:888` desktop, `:896` icon-only mobile), gated on live + admin.
- Hold-to-confirm `ConfirmDestructive` (`requireHold`, tone warning, label "Rotate token", `:1161`) — consequence states the old token dies immediately and the new one is shown once. On success: show-once modal (`:1161+`) with the token in a readonly field + Copy button + expiry date; dismissed via "Done — I copied it" or modal close, which clears it from component state (`setRotatedToken(null)`). Never persisted (no localStorage/store/URL — asserted by test P1-3.9). Success/failure via `pushNotice`; `refreshLive()` after rotation so the row expiry updates.
- Expiry badge on each row (`:767-772`): `StatusBadge` error "Token expired" / warning "Token expiring soon", from `tokenExpiryStatus(device.tokenExpiresAt)`.
- Sort by token expiry (`:91`, `:207-216`, option `:616`): expired → expiring → valid → no expiry reported, hostname tie-break.

**`src/views/Device360View.tsx`**
- Real fingerprint: the overview effect now captures the device row (`overviewDevice`, `:202`, `:256-264`) and the Security Fingerprint card renders `overviewDevice?.mtls_fingerprint` (`:1569`), with "Not reported" when absent. The seeded `telemetry.fingerprintSha256` display is gone (its only remaining occurrence is the fallback telemetry object's default at `:164`, never rendered as the fingerprint). The overview payload shape is `overview.device.mtls_fingerprint` (`devices.py` — `device_data = dict(row)` of `SELECT *`).
- Set fingerprint (`:1577-1620`): text input + Save, admin-only; hex with optional colons/spaces accepted (backend normalizes — `device_mtls.normalize_fingerprint` strips non-hex); input prefilled with the current value; empty input is refused client-side with a notice pointing at Clear. On success the card updates from the response.
- Clear fingerprint (`:1605-1619` + `ConfirmDestructive` `:1837`): sends the contract's explicit empty fingerprint; on success the card shows "Not reported".
- Rotate token button in the fast-action ribbon (`:854`, admin-only) + hold-to-confirm dialog (`:1770`) + the same show-once modal pattern (`:1790+`, separate input id `rotated-device-token-360`).
- Token-expiry row in the fingerprint card (expiry date + badge) and expiry badge in the device header, both from `selectedDevice.tokenExpiresAt`.
- Admin gating: both views fetch `api.me()` once when live and show the admin-only controls only when `role === "admin"`, fail-closed on error. The server still enforces admin on every call — the UI gate is convenience, not the control. This works for admin-token auth too (`me()` returns `role: "admin"` for the legacy token).

**Tests** — `src/tests/p1-3-device-identity.test.ts` (new, 14 tests, P1-3.1–P1-3.14), wired into `src/tests/run-all-tests.ts` as step [9/13]:
- P1-3.1: real wrapper calls against a stubbed `fetch` — exact URLs/methods/bodies (rotate path, fingerprint set with `aa:bb:cc`, clear with `""`, URL-encoding of `dev/1`), plus 404 surfacing as `ApiError` with status 404 + server detail. (Both stub scenarios live in one `it` callback deliberately — the harness starts `it` callbacks without awaiting each in turn, so two stub-fetch tests interleaved and stole each other's stub; this was the one failure in the first full run, fixed by merging, no test weakened.)
- P1-3.2: source-level wrapper/path presence. P1-3.3–P1-3.8: expiry logic at the 72 h boundary (expired at/past now; expiring at exactly 72 h inclusive and 1 s inside; valid 1 s beyond and at 7 days; `none` for missing/zero/NaN; ms tolerance; labels).
- P1-3.9–P1-3.14: source-level view wiring (hold-to-confirm rotate + show-once modal + state cleared on dismiss + no `localStorage.setItem`; badge labels + sort option; real `overviewDevice?.mtls_fingerprint` + old seeded display expression absent; Set/Clear wiring; store/type mapping; no `window.confirm`/`window.prompt` in either view; no P1-4 surface exists).

### Deviation flagged by the dashboard worker — RESOLVED

The dashboard worker flagged that the *then-current* backend code 400d an empty fingerprint, so Clear would surface a 400 instead of clearing. The parallel backend worker landed the contract change in the same wave: the coordinator verified in `devices.py:796-825` that an explicitly empty fingerprint now clears (NULL + `clear_mtls_fingerprint` audit + `mtls_fingerprint: null`). No deviation remains; the dashboard sends `""` verbatim and the backend clears it.

## P1-4 — scope change (done by James, NOT by this wave)

Mid-wave, James did P1-4 (user deletion + password change/reset) himself. Both workers were ordered to stop P1-4 immediately and discard it:
- **Backend:** the three endpoints (`DELETE /api/auth/users/{username}`, `POST /api/auth/me/password`, `POST /api/auth/users/{username}/reset-password`), their pydantic models, the rate-limit-list entry, the three route-snapshot entries, and the P1-4 test module were all removed. `git status` confirms `src/ai_bridge/control/routers/auth.py` and `src/ai_bridge/control/app.py` are **unmodified**; stale `__pycache__` for the removed module was deleted.
- **Dashboard:** the three api wrappers (`deleteUser`, `changeMyPassword`, `resetUserPassword`) and their result interfaces were reverted out of `src/api.ts`. `src/views/live/AccountsPanel.tsx` was never edited in this session.
- **Verification (coordinator):** grep over `src/`, `tests/`, `apps/dashboard/src/` for every P1-4 identifier returns **zero hits** (excluding the dashboard test file's negative assertions that those wrappers do not exist). No P1-4 code, test, snapshot entry, or doc entry from this wave remains in the tree. James's own P1-4 implementation is not in this repo tree and was not reviewed here.

## Files changed (this wave)

- Backend: `src/ai_bridge/control/routers/devices.py` (+53/−3), `docs/api-reference.md`, `tests/unit/test_architecture_phase4_routers.py` (snapshot +1 entry), new `tests/unit/test_p1_device_identity.py`.
- Dashboard: `src/api.ts`, `src/state/dashboardStore.ts`, `src/types/dashboard.ts`, `src/views/DevicesView.tsx`, `src/views/Device360View.tsx`, `src/tests/run-all-tests.ts` (step renumbering 12 → 13), new `src/state/tokenExpiry.ts`, new `src/tests/p1-3-device-identity.test.ts`.
- (`src/ai_bridge/control/routers/workflows.py` and `tests/unit/test_phase3_fleet_ops.py` also show as modified in `git status` — those are the prior UX-23 wave's changes, not this wave's.)

## Named leftovers

1. **`src/views/live/DeviceWorkspace.tsx:34` — stale copy (one line).** The live device panel still says "Device token has expired. Rotate its token through the server's authenticated agent flow or re-enroll it." An admin rotate action now exists; that copy should point at the new Rotate token action in DevicesView/Device360View. Outside this wave's file scope (live-panel file); follow-up one-liner.
2. **`api.me()` extra fetch per mount** of DevicesView/Device360View (one additional `GET /api/auth/me` each) for the admin gate. Trivial load, unobserved live.
3. **The seeded `telemetry.fingerprintSha256` default** (`Device360View.tsx:164`) still exists as a fallback object value but is never rendered as the fingerprint. Harmless; removing it is a cleanup, not a fix.

## UNVERIFIED (needs a running backend and/or browser)

- Rotate round-trip against the real endpoint (new token returned once, old token dead immediately, expiry updated in the list).
- Fingerprint set/clear round-trip (displayed value matching the stored fingerprint) and the "Not reported" state after clear.
- Expiry badge rendering (expired/expiring/valid states, 72 h boundary in the UI) and token-expiry sort order in the browser.
- Show-once modal copy flow (clipboard write, dismiss clears state, token absent from storage/URL after dismiss).
- Admin gating against live roles (operator/viewer must not see Rotate/Set/Clear; admin-token auth must see them).

## Tally

| Status | Count | Findings |
|---|---|---|
| **CLOSED** | **1** | P1-3 (device-token rotation + mTLS fingerprint management) |
| **DONE BY JAMES (not this wave)** | **1** | P1-4 (user deletion + password change/reset) |
| **DEFERRED** | 0 | — |

Production verdict remains **NO-GO** (unchanged by this work).
