# FINAL PRODUCTION READINESS — AI Bridge Remediation

**Date:** 2026-11-17 · **Repo:** `~/workspace/ai-bridge-main` · **Head:** `61faa67` (Wave 4)
**Prior verdict (report 21, 17 Nov 2026): NO-GO for any production use.**

## Verdict: NO-GO for any production use — unchanged

The remediation closed all 16 P0 bypasses in code, moved the Python suite from 389 to 750 passing tests, made the dashboard honest and its suite real, and made multi-worker operation substantially safer in code. That is genuine, verified progress. It is **not** production readiness, because the conditions report 21 set for a GO have not all been met: one gate condition is outright unmet (the 4-worker load test), six are partial, and the required independent re-audit, 10-step E2E, Postgres restore drill, and WebRTC E2E with a real browser peer have not happened. 17 register rows remain open (2 P1, 15 P2) and 38 are partially closed.

**Wave 5A addendum (17 Nov 2026, this commit):** the rate-limiter lockout P1 found live during the load test is fixed in code (admit-only recording, atomic Lua, both sync + async paths; regression tests pass on new code and fail on old code — see gate 15); P1s F-04-15, F-04-22, F-05-04, F-06-12 are closed in code with tests; F08-02/03/04/07 are closed in C++ source but **uncompiled** (no Windows toolchain here — the Windows build + `ai_bridge_tests` run is still required); F-04-01 (durable approvals) and SEC-06 (plaintext-secret migration) are closed; residuals P-11, the v1 WS `?token=` fallback, the `main.tsx` sync OIDC wrapper, the plain-text enrollment token, and the `AI_BRIDGE_INSECURE_TLS=1` hatch are closed. **No gate flips to MET in this wave** (gate 15 still needs the live re-soak; gate 17's migration has not yet run against a live DB), so the tally below is unchanged and the verdict stays **NO-GO**.

The system is now a **strong lab / staging candidate**: it can be run locally, single-worker against SQLite, on machines and data you can afford to lose, with no production credentials and no unattended Tier-3/4 execution — the same acceptable uses report 21 §5 listed, now on a much sounder codebase. It must not be deployed to production, must not be pointed at a production fleet, and must not run unattended Tier-3/4 execution against real devices.

## 1. The 20 gate conditions (report 21 §3), evaluated one by one

### Phase 0 — stop the bleeding

| # | Gate condition | Verdict | Evidence |
|---|---|---|---|
| 1 | Delete `AI_BRIDGE_HTTP_ALLOW_ANON` / `AI_BRIDGE_MCP_DISABLE_DNS_PROTECTION` off-switches (R-P0-01) | **MET** | Zero grep hits in `server.py`; `--unsafe-allow-anon` CLI flag only, refused in production (`server.py:73,2226`) |
| 2 | Delete `term-*` auto-approval (R-P0-04) | **MET** | Branch deleted from `next_task` (Wave 2A); tests `test_term_task_without_approval_not_auto_approved` |
| 3 | Tier 3 off by default; no default secrets; compose refuses to start without secrets (R-P0-14/15) | **MET** | `AI_BRIDGE_ALLOW_TIER3=${…:-0}` (`docker-compose.prod.yml:31`), `=0` in CFN; zero grep hits for the known default secrets; fail-fast `${VAR:?…}`. Caveat: a real `docker compose up` was never run here (no Docker daemon) — the refuse-to-start behaviour is verified by config assertions + `test_deployment_config.py`, not by booting |
| 4 | HTTPS redirect; `/metrics` authenticated; installer without `curl -k` (P-03/04/09) | **MET** | `return 301` (`nginx.conf:77`); `auth_request /internal/verify` on `/metrics` (`nginx.conf:141,184`); zero `curl -k` in installers. Caveats: `nginx -t` never run (no nginx binary); installer live-enrollment never exercised against a plane with a valid certificate |
| 5 | CI runs the Python suite and publishes the log (TST-01) | **PARTIALLY MET** | CI job exists (Wave 1A, `.github/workflows/ci.yml` — pytest with JUnit/log artifacts). **No GitHub CI run has been observed.** Local runs are published as logs (this report set + `~/workspace/tmp/pytest-wave4.log`) |

### Phase 1 — close the bypasses

| # | Gate condition | Verdict | Evidence |
|---|---|---|---|
| 6 | `unrestricted` + Tier-4 rules fixed; Linux agent restrictive by default; agent merge intersection-only (R-P0-02/07/08) | **MET** | `grant_unrestricted_policy()` (`policy.py:301`); Tier 4 always needs approval (`policy.py:255-261`); Linux default ceiling 2; intersection-only merge |
| 7 | Local execution on the plane host removed or admin-only + audited (R-P0-03) | **MET** | Off by default; admin + `AI_BRIDGE_ALLOW_LOCAL_EXECUTION=1` + approval for Tier ≥3. Pure DB reads stay available to operators (deliberate) |
| 8 | All 109 tools tiered + gated by one wrapper gate (R-P0-05, R-P1-05) | **MET** | 5 tools tiered; 109/109 wrappers behind `_gated` (AST-verified); one registry holds 149 entries (Wave 3B correction of the brief's 144) |
| 9 | MCP audit logging live through one writer (R-P0-06) | **PARTIALLY MET** | Writer live (`audit_writer.py`); gate audits every invocation; `GET /api/audit/verify` exists. **Not one writer in practice:** `mcp_oauth.py:173` and `task_service.py:389` still call `dbmod.audit` directly (HEAD-verified); `audit.py::audit_event` is dead code; audit-write failure does not block execution (availability trade-off) |
| 10 | v1 + workflow + terminal approval gates uniform (R-P0-10/11, R-P0-04) | **MET** | Single task service for `/api/tasks`, `/api/v1/tasks`, `ai_api`; workflow steps run as owner with per-step approval default on; `term-*` branch deleted |
| 11 | Tenant bound to the session server-side (R-P0-12) | **MET** | Migration 013; session-derived tenant; mismatch → 403; cross-tenant read → 404. Carve-out: pseudo-device `"local"` is not tenant-scoped |
| 12 | View-only + takeover enforced agent-side (R-P0-13) | **MET** | Agent-side default-deny + takeover in the input path; plane endpoint returns `mode`/`permissions`/`human_takeover_active` (HEAD-verified, `routers/webrtc.py:320,390-391`). Caveat: no live remote-agent E2E was run |
| 13 | Signed updates on all paths (R-P0-16); fake IDR deleted (R-P0-09) | **PARTIALLY MET** | Signed pinned-git updates on fleet/installer/container paths; fake IDR deleted from the encoder. **Not live-tested:** no signed release manifest exists; no dry run with a test keypair; `repo_dir` defaults to process cwd; the C++ change is uncompiled (no Windows toolchain) |

### Phase 2 — multi-worker + data safety

| # | Gate condition | Verdict | Evidence |
|---|---|---|---|
| 14 | Scheduler atomic claim; fencing tokens; result guard; OIDC/CSRF/e-stop in shared state; WS fan-out via Redis pub/sub (DIST-01/03/04/05, F07-04) | **PARTIALLY MET** | All mechanisms are in code and unit-tested: atomic scheduler claim (exactly-one-winner test), epoch fencing (stale → 409), result guard, OIDC `_PENDING` in the settings table, CSRF on by default with a shared secret, e-stop read from durable state at submission/claim/workflow/scheduler, Redis pub/sub fan-out with outage warning. **Live verification 17 Nov 2026 (staging, 4 workers):** scheduler fires exactly once per tick (PASS); Redis fan-out 10/10 cancels delivered cross-worker, median 337 ms (PASS); rate limit proven shared via Redis, 1,199 allowed in 60 s ≈ 1,193/min matching the configured 1,200/min (PASS). **Still not live-proven:** OIDC cross-worker flow (staging OIDC not configured; code-verified only that the exchange-code store is DB-backed at startup) |
| 15 | 4-worker load test passes with the configured rate limit (PERF-02) | **NOT MET** | Live load test run 17 Nov 2026 (staging, 4 × Starter): k6 soak VUS=20, 5 min — claim p95 201 ms (threshold < 5,000 ms PASSED), but http_req_failed 91.41%, all 429s: the soak drove ~93 req/s through one admin token capped at 1,200/min, so it measured the limiter, not plane capacity. **New P1 found live:** the Redis sliding window records rejected requests too (`durable_ratelimit.py` zadd-before-count), so under sustained overload the window never drains — confirmed: after a 60 s hammer (5,917 requests, 1,199 admitted, 4,718 rejected) and 30 s of silence, a single request still got 429. **Wave 5A — code fix done, re-soak still pending:** `durable_ratelimit.py` now records only admitted requests, atomically via a Lua script (prune → count → add only if under limit) on both sync and async paths, with an admit-only pipeline fallback for clients without `eval`; regression tests `tests/unit/test_ratelimit_lockout.py` (5 tests: sync, async, pipeline-fallback sync+async, window sliding) pass on the new code and fail on the old code (stash-verified). A pipeline-fallback bug found by the existing `test_distributed_phase2.py` async tests (rejected-path TTL refresh called `client.expire`, which the async fake lacks) was fixed the same way. **Still NOT MET:** the re-soak with one token per VU has not been run (later phase). OIDC cross-worker flow not live-proven (see gate 14) |
| 16 | Tested Postgres backup/restore; FKs; single schema source + CI PG boot; atomic audit chain + verifier (DB-01/02/03/05) | **PARTIALLY MET** | FKs/CHECKs in migration 015 (SQLite-verified); schema parity script `PARITY OK — 47 objects` (SQLite); atomic audit insert in one transaction (HEAD-verified, `db.py:777-812`); verifier exists (`db.py:724`). **Proven live 17 Nov 2026 (staging):** plane booted on Postgres, all 15 migrations 001–015 applied; backup/restore drill PASSED end-to-end (pg_dump → restore into fresh DB → verify migrations = 15 → drop drill DB, "DRILL OK"); three drill-tooling bugs found and fixed in the process (pg-client 17 vs server PG 18; createdb/dropdb DSN handling; pg_restore `--no-privileges`). **Still not done:** CI Postgres boot test; schema parity against Postgres |
| 17 | Secrets encrypted at rest; child env allowlisted (SEC-06/07) | **PARTIALLY MET** | Fernet encryption at rest (HEAD-verified, `fernet1:` prefix); minimal clean child env (HEAD-verified). **Wave 5A — migration code done, live run pending:** `mcp_oauth.py::migrate_plaintext_secrets` re-encrypts every non-`fernet1:` `auth_token`/`oauth_client_secret`/`oauth_refresh_token` (per-row errors, idempotent); CLI `scripts/migrate_mcp_secrets_to_fernet.py` (exit 2 on errors, never prints values); best-effort boot hook in `create_app` (never fails boot); verified end-to-end on a scratch DB (3 secrets migrated, re-run migrates 0) + tests in `tests/unit/test_wave5a_remediation.py`. **Still PARTIALLY MET:** the migration has not yet run against a live DB — it executes automatically at the next plane boot (the boot hook), which is a later phase's verification, not this wave's (staging must not be touched here) |

### Phase 3 — honesty

| # | Gate condition | Verdict | Evidence |
|---|---|---|---|
| 18 | Demo off by default; fake Merkle verification and fake provider cards deleted (D-01/02/03) | **MET** | Login-first routing + interstitial; hardcoded Merkle root / `blocksChecked: 14920` / hardcoded keys and latencies deleted (grep-verified 0 hits). Positive demo-entry path unverified in a real browser |
| 19 | Dashboard test suite rewired to real modules; Tier 5 included (TST-04/05) | **MET** | Tier 1/2 import real modules; Tier 5 + challenger wired in; `npm test` 430/430 + i18n 3/3 (parent-verified) |
| 20 | Docs corrected; one status per feature (DOC sweep) | **MET** | Wave 2B sweep: test counts, Fluent 2 → JX-UI, SECURITY.md v0.3.x, single mTLS/OIDC/macOS statements, `ORIGINAL_REQUEST.md` citation removed, threat-model updated. (The api-reference rewrite is claimed by Wave 2B as part of the sweep; its completeness was not re-checked line-by-line for this report.) |

**Gate tally: 13 MET, 6 PARTIALLY MET, 1 NOT MET.** (Unchanged by Wave 5A — gates 15 and 17 gained code fixes, but neither flips until the live re-soak / live-DB migration run happens in a later phase.)

### Re-verification required before a GO (report 21 §3, final paragraph)

| Required re-verification | Status |
|---|---|
| Fresh, independent audit pass over the P0/P1 fixes (not a self-review) | **NOT DONE** — every verification in this remediation was performed by the same agent chain that made the changes, or its parent |
| 10-step E2E workflow (brief Part 10) passing against a local plane | **NOT DONE** — no such test exists (TST-09 open) |
| 4-worker load test | **NOT DONE** (see gate 15) |
| Postgres restore drill | **NOT DONE** (see gate 16) |
| WebRTC E2E test with a real browser peer | **NOT DONE** — unit tests with fake senders only; aiortc not installed |
| Full Python + dashboard suites with published logs | **DONE** — 776 passed / 12 pre-existing failures + 430/430 dashboard; logs retained (`FINAL_TEST_RESULTS.md`, `~/workspace/tmp/pytest-wave5a.log`). Wave 5A added 26 tests (all passing); the 12 failures are the known baseline set — one swap: the documented flaky `test_concurrent_claim_and_cancel_under_load` tripped its 5.0 s wall-clock bound at 5.03 s (all 30 tasks claimed exactly once), while `test_capture_desktop_bettercam_uses_monitor_index` passed this run |

## 2. Verdict per area (report 21 §1, re-scored)

| Area | Audit verdict | Now | Blocking items remaining |
|---|---|---|---|
| Security | NO-GO | **NO-GO** | F08-02/03/04/07 fixed in C++ source but uncompiled; header-trust mTLS; no independent re-audit. Wave 5A closed F-04-15, F-04-22, F-05-04, F-06-12, P-11, v1 WS token fallback in code |
| Authentication | NO-GO | **NO-GO** | PKCE now required (S256, Wave 5A); stdio bearer-less by design; plaintext token remnants (native); no live OIDC E2E |
| Authorisation | NO-GO | **CONDITIONAL** (code) | Gates uniform in code; `"local"` carve-out; gate's peeked-approval admin derivation; operator v1 routes deliberately ungated for mTLS — needs the independent review before it can be called GO |
| Database | NO-GO | **NO-GO** | No Postgres boot/restore drill; pool deferred; `tasks.device_id` deliberately has no FK |
| Distributed reliability | NO-GO | **NO-GO** | No live two-worker verification; no load test; DIST-08 residual (0.5 s poll still writes a `task_events` row per call) |
| WebRTC / desktop control | NO-GO | **NO-GO** | No live peer run; C++ uncompiled; F08-07 DLL surface fixed in code (default-deny + per-session arming) but uncompiled; dual stacks unconsolidated (OV-03) |
| Dashboard | NO-GO as shipped default | **CONDITIONAL GO for the live workspace** | Live workspace is honest and tested (430/430); e2e still tests the demo by design and was never run; `main.tsx` sync OIDC wrapper removed and enrollment token masked (Wave 5A) |
| Deployment | NO-GO | **NO-GO** | P-11 closed and `AI_BRIDGE_INSECURE_TLS=1` hatch removed (Wave 5A); CFN heredoc anomaly; no live deploy/boot verification (no Docker daemon, no nginx binary); P-07/P-08/P-12/P-15 open |
| Testing | NO-GO | **CONDITIONAL** | Suite is real and green (750 + 430/430); no e2e, no failure/recovery tests, C++ tests never run, flaky timing test unquarantined |
| Documentation | NO-GO as a trust source | **CONDITIONAL** | Sweep done; api-reference rewrite not re-checked line-by-line; some residuals (see DOC rows) |
| MCP implementation | NO-GO | **CONDITIONAL** (code) | Gate + audit + tiers live; PKCE now required (Wave 5A); DPoP/PAR absent; stateless HTTP (F-06-16) untouched |
| Platform agents | NO-GO | **CONDITIONAL** (code) | Worker thread + heartbeat + drain + 401 classification done; GUI rebase infeasible (behaviours adopted in place); macOS never run; Windows GUI drain unexecuted |

"CONDITIONAL (code)" means: the code change is in place and locally tested, but the condition that would make it a GO (live verification, independent review, or both) has not been met.

## 3. Updated scorecard (report 22 scale, self-assessed)

Scores are the remediation team's self-assessment on report 22's 1–10 scale, from code inspection + local test evidence only. They are **not** an independent audit and must not be cited as one. C++ (5) is unchanged because no Windows build exists to justify raising it.

| Category | Audit (report 22) | Now | Reasoning |
|---|---|---|---|
| Architecture | 4/10 | **6/10** | `app.py` split into 9 routers; one registry, one limiter, one task service, one audit writer (mostly); route snapshot identical. Still two WebRTC stacks, two MCP surfaces in places, and in-process state that constrains multi-worker operation |
| Python code quality | 4/10 | **6/10** | God modules split; error taxonomy; structured redaction; Settings cached/validated. Still: dead `audit.py::audit_event`, remaining duplication, regex SQL replaced only in Wave 4 |
| C++ code quality | 5/10 | **5/10** | Code improved (fake IDR gone, CHECK() tests, single-instance guards, honest `StartSession`) but **uncompiled and unrun** — no evidence to raise the score |
| Frontend architecture | 5/10 | **6/10** | Honest default, real test suite, stream tickets, CSRF on session POSTs. Held back by demo-only e2e |
| MCP implementation | 4/10 | **6/10** | One gate on all tools, audit live, proper outbound client with `initialize`, error taxonomy. Held back by no DPoP/PAR, stateless HTTP, no resources/prompts |
| Security | 3/10 | **5/10** | All 16 P0 bypasses closed in code; audit real and atomic; secrets encrypted and scrubbed. Held back by the native surface (fixed in source, uncompiled) and zero live verification |
| Authentication | 4/10 | **5/10** | Legacy token off, CSRF on, OIDC exchange-code flow, 401 split, PKCE required (Wave 5A). Held back by stdio bearer-less by design, native plaintext remnants |
| Authorisation | 3/10 | **6/10** | Uniform gates, tenant bound, agent cannot widen. Held back by the `"local"` carve-out, the gate's peeked-approval derivation, ungated operator v1 routes |
| Database architecture | 4/10 | **5/10** | FKs/CHECKs, parity script, atomic chain + verifier, backup CLI, retention jobs. Held back by Postgres untested, pool deferred, no PITR |
| Distributed reliability | 3/10 | **5/10** | Atomic claim, fencing, fan-out code, progress heartbeats, idempotency everywhere. Held back by no live multi-worker verification and no load test |
| WebRTC implementation | 4/10 | **5/10** | View-only/takeover enforced in code, RTCP ABR, ICE gate, held-button release. Held back by no live peer run and uncompiled C++ |
| Performance | 4/10 | **5/10** | List projection, indexes, single-query fleet health, COUNT-first prune. Held back by pool deferred and no load test or benchmark |
| Scalability | 3/10 | **4/10** | Multi-worker operation is safer in code; still no evidence above ~20 devices and no load harness |
| Testing | 2/10 | **6/10** | 750 Python tests passing with published logs; dashboard suite real (430/430). Held back by no e2e, no failure/recovery tests, C++ tests never run, flaky timing test |
| Maintainability | 4/10 | **6/10** | Splits + consolidation + taxonomy + parity tooling. Held back by dead code, remaining duplication, and the audit-writer split |
| Documentation | 4/10 | **6/10** | Sweep done; one status per feature for mTLS/OIDC/macOS; counts corrected. Held back by the unrechecked api-reference rewrite and doc residuals |
| Production readiness | 2/10 | **4/10** | A much stronger lab system: all P0s closed in code, suite green, honest dashboard. Still NO-GO — the gate conditions in §1 are not all met and the required re-verification has not happened |

## 4. What must happen before the verdict can change

In order, each with its evidence requirement:

1. **Windows build + `ai_bridge_tests` run** (F08-01 and all C++ claims). Until this passes, the one partially-closed P0 and the partially-closed native rows cannot be called closed — including the Wave 5A native rows F08-02/03/04/07 (code complete, uncompiled).
2. **Postgres boot + backup/restore drill** (DB-01/02/03/05). Boot the plane from migrations alone on Postgres; run `scripts/backup_restore.py` end-to-end; run `scripts/check_schema_parity.py` against Postgres.
3. **Two-worker Redis fan-out + 4-worker load test** (DIST-03, PERF-02, gate 15). Prove the scheduler fires once, cancels reach agents on other workers, OIDC completes across workers, and the effective rate limit equals the configured limit.
4. **WebRTC E2E with a real browser peer** (F13-03, F13-07, F13-10). Prove view-only/takeover enforcement and the ICE gate against a live peer.
5. **10-step E2E workflow against a local plane** (TST-09) + failure/recovery tests (TST-10) + Playwright e2e updated to the exchange-code flow and run (TST-13).
6. **Close the remaining open P1s**: TST-09/10 (E2E — see item 5). The Wave 5A wave closed the other open P1s in code: F-04-15, F-04-22, F-05-04, F-06-12, F08-02/03/04/07 (C++ source, build pending — see item 1), plus P-11, the v1 WS token fallback, and the `main.tsx` sync OIDC wrapper.
7. **Fresh, independent audit pass** over the P0/P1 fixes (not a self-review) — the report 21 requirement. Only after 1–6 does an independent pass have something complete to review.

## 5. Acceptable uses (unchanged from report 21 §5, now on a stronger codebase)

- Local single-worker development against SQLite, on a machine with no production credentials, no production data, and no network exposure (bind `127.0.0.1`; do not set `AI_BRIDGE_HTTP_ALLOW_ANON`, `AI_BRIDGE_ALLOW_TIER3`, or `unrestricted` — the first of these no longer works at all).
- Studying the codebase; running the test suite locally (it now runs: 776 passed, logs published).
- Demoing the dashboard's seeded demo **as a demo**, entered explicitly and labelled as such, with no implication that the numbers are a real fleet.

**Not acceptable:** any production deployment, any production fleet, any production credentials, any unattended Tier-3/4 execution against real devices, any deployment of the native Windows agent before a Windows build + sealed-config E2E run.
