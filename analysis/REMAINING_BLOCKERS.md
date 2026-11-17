# Remaining Blockers (FINAL, 2026-11-17)

Everything below was still true at head `61faa67`. **Wave 5A (17 Nov 2026, same day) closed in code:** P1s F-04-15, F-04-22, F-05-04, F-06-12; F08-02/03/04/07 in C++ source (build-unverified — see below); F-04-01 (durable approvals); SEC-06 (plaintext-secret migration code); the rate-limiter lockout P1 (W5A-01, code fix + regression tests, re-soak pending); and residuals P-11, v1 WS `?token=` fallback, `main.tsx` sync OIDC wrapper, plain-text enrollment token, `AI_BRIDGE_INSECURE_TLS=1` hatch. The items below are what is **still** open after Wave 5A. Full detail and evidence: `analysis/FINAL_IMPLEMENTATION_REPORT.md` §7, `FINAL_SECURITY_REASSESSMENT.md` §4–§5, `FINAL_PRODUCTION_READINESS.md` §4.

## Environment limits (this VM — none of these were available during remediation)

- **No Windows host/toolchain:** all C++ changes are inspection-verified only. A Windows build + `ai_bridge_tests` run is required before any native deployment — especially to confirm the libdatachannel API names used in Wave 3C. Do NOT deploy the DPAPI-sealed installer to native fleets until C++ unseal is tested on Windows.
- **No Docker daemon:** compose fail-fast verified by YAML parse + config assertions only, not by booting. `nginx -t` never run.
- **No Postgres server/binaries:** migrations 013/014/015, FKs/CHECKs, the parity script, and the backup CLI were verified on SQLite only. Postgres boot + backup/restore drill unverified.
- **No Redis server:** cross-worker fan-out tested with an injected fake broker only. Two-worker verification + 4-worker load test never run.
- **No live Ollama/LLM, no Copilot tenant, no live aiortc peer, no live control-plane check of dashboard changes** (tsc + build + unit tests only).
- **No GitHub CI run observed** (CI job exists; no run triggered).
- **`/tmp` is a 512 MB tmpfs:** full-suite runs must use `TMPDIR=~/workspace/tmp` (see `FINAL_TEST_RESULTS.md` §5 — the tmpfs filled to 100% during Wave 3 and invalidated two suite runs).

## Open register rows (17)

**P1 (2):** TST-09 (no e2e / MCP round-trip / OAuth2 coverage), TST-10 (no failure/recovery tests; soak scripts unwired).
**P2 (15):** F-04-10, F-04-18/F13-11 (TURN default shared secret), F-05-08 (DB rate-limit fallback still non-atomic read-modify-write — HEAD-verified), F-05-09, F-05-12/SEC-12, F-06-16 (stateless HTTP, no SSE/resumable sessions), I-05 (Copilot untested), PERF-08 (0.5 s execution-state poll still writes a `task_events` row per call), TST-13 (Playwright e2e tests the demo by design), TST-14 (C++ tests never run), P-07 (no lockfile/hashes), P-08 (deploy scripts duplicated, no health gate), P-12 (three default control URLs), P-15 (Render labelled/test-only topology), OV-03 (two WebRTC stacks coexist).

## Partially closed items with named residuals (38 — see FINAL_IMPLEMENTATION_REPORT.md §2 for all)

The highest-priority residuals: F08-01 (fake IDR deleted but uncompiled — the one partially-closed P0); F08-05/06/08/09/10/11/12/14/16 and F13-05/F08-13 (C++ code only, uncompiled); **F08-02/03/04/07 (Wave 5A: supervisor, pipe replay protection, pipe-reply reading, DLL default-deny — code complete, Windows build + `ai_bridge_tests` run still pending)**; **W5A-01 rate-limiter lockout (Wave 5A: admit-only Lua fix + regression tests pass; live re-soak with one token per VU still pending)**; DB-01/02/03 (Postgres half untested); DIST-03/PERF-02/DIST-07 (live multi-worker verification missing); INV-12 (audit-writer split: `mcp_oauth.py:173`, `task_service.py:389` still call `dbmod.audit` directly); F-05-06/SEC-09 (mTLS header-trust unchanged; no-op unless `AI_BRIDGE_DEVICE_MTLS=1`); DIST-08 (0.5 s poll flood); F07-03 (GUI rebase infeasible; behaviours adopted in place).

## Deferred (3)

PERF-01/DB-04 (connection pool — needs checkout refactor + load harness), F-06-13 (DPoP/PAR — deliberate, gateway has no PAR/DPoP), F08-15 (hand-rolled JSON — deliberate keep with written justification).

## Non-register items still open

- **Playwright e2e:** `dashboard.spec.ts:134` still asserts the old OIDC fragment flow; e2e was never run.
- **Dead code:** `audit.py::audit_event` has zero callers (Wave 4 left it in place; parent may delete).
- **`_run_argv` cancellation leak (pre-existing):** `TaskCancelled` orphans the child — `except TaskCancelled: raise` with no kill (`tools/shell.py`). Timeout path fixed in Wave 4; cancellation path was out of scope.
- **`AI_BRIDGE_INSECURE_TLS=1` — CLOSED (Wave 5A):** the hatch was removed from `deployment/linux/run-agent.sh` (curl calls are now plain; private CAs go via `CURL_CA_BUNDLE`/`--cacert`); no other `INSECURE_TLS` reference remains in the repo.
- **Enrollment token in plain text — CLOSED (Wave 5A):** `apps/dashboard/src/views/DevicesView.tsx` now shows the enrolled token masked (first 4 + `••••` + last 4) with a Show/Hide toggle; the install-command `<pre>` shows `<TOKEN>`; Copy still copies the real command as an explicit user action.
- **CFN UserData quoted-heredoc issue:** `deployment/aws/cloudformation.yml:385` writes literal `$(aws ssm get-parameter …)` strings into `.env.production`, which compose will not evaluate (flagged by Wave 1A, unverified, untouched).
- **Pseudo-device `"local"` not tenant-scoped** (governed by role + R-P0-03 gate instead; `task_service.py:233-238`).
- **Signed-update `repo_dir` defaults to process cwd** (`tools/fleet.py:159-160`).
- **No signed release manifest exists yet** — the signed-update path has never been dry-run with a test keypair.
- **SSRF carve-out:** 198.18.0.0/15 deliberately not blocked (sandbox DNS wildcard; see F-05-17/SEC-11).
- **Flaky test:** `test_concurrent_claim_and_cancel_under_load` fails intermittently under load (pre-existing; bound NOT loosened; quarantine or load-aware bound needed — do not delete).
- **Audit-write failure does not block tool execution** (availability trade-off; fail-closed audit deferred and never revisited).
- **Gate carve-out:** a peeked local approval satisfies Tier-4 admin at the MCP gate (documented in Wave 1C; needs independent review).

## What must happen before the production verdict can change

1. Windows build + `ai_bridge_tests` run. 2. Postgres boot + backup/restore drill. 3. Two-worker Redis fan-out + 4-worker load test. 4. WebRTC E2E with a real browser peer. 5. 10-step E2E workflow + failure/recovery tests + Playwright e2e updated and run. 6. Close the remaining open P1s (TST-09, TST-10 — E2E, other phases; the other Wave 5A P1s and residuals are closed in code). 7. Fresh, independent audit pass (not a self-review). See `FINAL_PRODUCTION_READINESS.md` §4.

## Rollback

- Git: `79c010e` baseline → `726bed2` Wave 1 → `3712b81` Wave 2 → `19747b2` Wave 2 fix-up → `88ad591` Wave 3 → `61faa67` Wave 4. Revert any wave with `git revert <commit>`; full rollback is `git checkout 79c010e`.
- Original zip hash: `bed477c750c9b782891678d44efe156c4f7b8dad07e765a4f8b011298d282d5c`.
