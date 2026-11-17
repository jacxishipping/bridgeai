# FINAL TEST RESULTS — AI Bridge Remediation

**Date:** 2026-11-17 · **Repo:** `~/workspace/ai-bridge-main` · **Head:** `61faa67` (Wave 4)
**Test commands:** Python: `TMPDIR=~/workspace/tmp .venv/bin/python -m pytest tests/ -q -p no:cacheprovider` · Dashboard: `cd apps/dashboard && npm test && npm run build` (plus `npm run test:i18n` as part of the `npm test` chain).

**Headline:** Python **750 passed / 5 skipped / 12 failed** at Wave 4; **Wave 5B (17 Nov 2026): 784 passed / 5 skipped / 11 failed**; dashboard **430/430 passed + 3/3 i18n** (unchanged through Wave 5B); **Playwright 126/126 passed locally** (Wave 5B — first ever full Playwright run). The 11 Python failures are a strict subset of the pre-existing baseline 12 — no new failure was introduced by any wave, and no test was deleted or disabled to make the suite pass.

## 1. Full-suite history (parent-verified runs)

| Stage | Commit | Passed | Failed | Skipped | Note |
|---|---|---|---|---|---|
| Pristine baseline (as received) | `79c010e` | 389 | 12 | 5 | pytest had never been run on this tree before (audit finding TST-01) |
| Wave 1 | `726bed2` | 467 | 12 | 5 | +78, zero new failures |
| Wave 2 | `3712b81` | 502 | 12 | 5 | +35, zero new failures |
| Wave 2 fix-up | `19747b2` | 513 | 12 | 5 | +11, zero new failures |
| Wave 3 | `88ad591` | 743 | 12 | 5 | +230, zero new failures |
| Wave 4 | `61faa67` | **750** | **12** | **5** | +7, zero new failures |
| Wave 5A | `c7d33d24` | 776 | 12 | 5 | +26, zero new failures (one swap vs baseline: flaky `test_concurrent_claim_and_cancel_under_load` tripped at 5.03 s, `test_capture_desktop_bettercam_uses_monitor_index` passed) |
| Wave 5B | *(this commit)* | **784** | **11** | **5** | +7 new tests (10-step E2E + 6 failure/recovery, all passing) + 1 flipped: `test_capture_desktop_bettercam_uses_monitor_index` passed, so the failing set is the baseline 12 minus that test; flaky `test_concurrent_claim_and_cancel_under_load` passed this run |

Final run: `12 failed, 750 passed, 5 skipped, 1 warning in 572.13s (0:09:32)` — log: `~/workspace/tmp/pytest-wave4.log`. The per-wave totals are not strictly comparable as a trend line (different scopes were reported by different waves — `tests/unit` vs `tests/unit` + `tests/security` vs `tests/` — and sibling waves landed tests in the same tree), but the invariant across every parent-verified full run is the same: **the FAILED list is byte-for-byte the baseline 12**.

Wave 5B full run (17 Nov 2026, `TMPDIR=~/workspace/tmp .venv/bin/python -m pytest tests/ -q -p no:cacheprovider`, 629.49 s): **`11 failed, 784 passed, 5 skipped`**. The 11 failures are a strict subset of the baseline 12 below: `tests/unit/test_aci_desktop_deepening.py::test_capture_desktop_bettercam_uses_monitor_index` (#5) **passed** this run, so it is no longer in the failing set. No new failure appeared; no test was deleted, skipped, or weakened. Total reconciles: 776 (Wave 5A) + 7 new + 1 flipped = 784; 793 baseline total + 7 new = 800.

## 2. The 12 pre-existing failures (unchanged since baseline)

All 12 fail identically on the pristine `79c010e` baseline and on every wave head. They are environment/dependency causes, not regressions. Causes below are the waves' attributions (missing PIL/ruff/xdotool, Windows-only expectations, Firecrawl/connector API keys, httpx proxy-env issue, legacy-WebRTC header); the author re-verified the failure *list* against the Wave 4 log, not each individual cause.

| # | Test | Attributed cause |
|---|---|---|
| 1 | `tests/test_windows_v1_architecture.py::test_native_windows_dll_metrics_and_screen_capture` | Windows-only expectations (native DLL / screen capture on a Linux host) |
| 2 | `tests/test_windows_v1_architecture.py::test_desktop_mcp_tools_and_human_takeover_enforcement` | Windows-only expectations |
| 3 | `tests/test_windows_v1_architecture.py::test_webrtc_disconnect_releases_held_keys` | Windows-only expectations |
| 4 | `tests/test_windows_v2_architecture.py::test_v2_clipboard_synchronization_and_policy` | Windows-only expectations |
| 5 | `tests/unit/test_aci_desktop_deepening.py::test_capture_desktop_bettercam_uses_monitor_index` | Missing PIL / Windows-only capture path |
| 6 | `tests/unit/test_browser_intelligence.py::test_firecrawl_crawl_requires_key` | Firecrawl API key not present in this environment |
| 7 | `tests/unit/test_enhanced_features.py::test_screen_capture_desktop_dimensions` | Missing PIL / xdotool |
| 8 | `tests/unit/test_execution.py::test_subprocess_linter_runs_cross_platform` | Missing `ruff` binary |
| 9 | `tests/unit/test_phase9_deep.py::test_legacy_webrtc_session_deprecation_header` | Legacy-WebRTC header expectation |
| 10 | `tests/unit/test_phases_456_deep.py::test_connectors_fail_without_api_key` | Connector API keys not present |
| 11 | `tests/unit/test_phases_456_deep.py::test_dispatch_registers_firecrawl_and_browserbase_tools` | Firecrawl/Browserbase keys not present |
| 12 | `tests/unit/test_serverai_mcp_orchestration.py::test_http_client_reused_across_api_calls` | httpx proxy-env artifact — the Wave 4 log shows `httpx.InvalidURL: Invalid port: ':1]'` from the environment's proxy variables |

**The flaky 13th test.** `test_concurrent_claim_and_cancel_under_load` is a wall-clock assertion (`elapsed < 5.0`) that fails intermittently under load on this 1.5-CPU host (observed 5.09 s, 6.28 s, 6.5 s, 7.06 s vs the 5.0 s bound). Wave 3A proved it pre-existing by running it in a clean worktree at `19747b2` (fails there too, 6.28 s); Wave 3C re-ran it on pristine `19747b2` and it failed 1 of 3 times, and interleaved patched/pristine runs both failed (7.06 s vs 6.52 s). **Its bound was NOT loosened and the test was NOT modified by any wave.** It passed in the final Wave 4 run (hence 12, not 13, failures) and is recorded here as a known-flaky pre-existing test, not as a regression. It should be quarantined or given a load-aware bound by a future wave — not silently deleted.

## 3. Dashboard suite

| Stage | Result |
|---|---|
| Audit (as received) | 356 claimed; 364 in-scope / 375 on disk by the synthesis's grep; Tier 1/2 self-referential (310/356 asserting on in-test literals); Tier 5 + challenger unwired |
| Wave 2B | `npm test` 407/430 (23 stale demo-default expectations); i18n 3/3 separately; `npm run build` exit 0; `tsc --noEmit` exit 0 |
| Wave 2 fix-up | **430/430 + 3/3 i18n, exit 0** (21 expectations updated to the login-first contract, none deleted; 1 real bug fixed in `Device360View`) |
| Wave 3 | 430/430 (parent-verified) |
| Wave 4 | **430/430 + 3/3 i18n, exit 0** (parent-verified by running `npm test`; output: `[✓] All 430 test cases executed cleanly and passed!`) |
| Wave 5B | **430/430 + 3/3 i18n, exit 0; `npm run build` exit 0** (run 17 Nov 2026 on the final tree incl. the `src/App.tsx` header fix; Tier 5 test 1.5 still passes — it checks the view-id strings appear in `App.tsx`, which they do in the route switch) |
| Playwright e2e (Wave 5B, first ever full run, 17 Nov 2026) | **126/126 passed in 6.0 min** (brand 5, dashboard 44, density 3, live-workspace 24, localization 32, operations 18) — local run against the vite dev server; Chromium 156.0.8078.4 (Playwright 1.64.1, installed manually via curl because the Node downloader fails through the egress proxy). The OIDC test was rewritten to the exchange-code flow; 40 failures on the first run were all pre-existing test/app drift (demo gating, hold-to-confirm, health-gated sign-in, stale expectations) — fixed test-side except one real app bug (duplicate `<h1>` on 4 views, fixed in `src/App.tsx`). The interactive-terminal 390 px axe failure seen once was flaky (passed 2/2 in isolation and in the full run). One environment note: in this VM, `npx`/`npm` fail with `EPERM` writing log files and `vite` fails writing its config temp file when run as a direct child of the agent shell (a sandbox quirk: after the process reads overlay files, file writes fail); the runs that pass are launched without stdout redirection and with `NPM_CONFIG_LOGS_MAX=0`, letting Playwright spawn the dev server itself. |

Dashboard test counts by suite (as reported by Wave 2B, parent re-verified on disk): Tier 1 155, Tier 2 155, Tier 5 31, challenger-stress 15, challenger-m1-2-stress 27, challenger-compliance 43 — the master runner total is 430 including i18n-adjacent checks; `npm test` total incl. i18n is 433. (The audit's 356/364/375 counts and Wave 2B's 356 `it(` re-count disagree; both are superseded by the 430 figure, which is the count of tests that actually execute and pass.)

## 4. What the new tests cover (361 added)

- **P0 gates:** env-var bypass removal, Tier-4 approval, `unrestricted` provenance, 109/109 wrapper gating, tier coverage, audit-writer redaction/hash-chain/fallback, term-* approval, tenant isolation (9 tests), workflow approval (5), signed updates (7), stream tickets (11), agent policy merge (14), WebRTC view-only (12).
- **Phase 2:** DB phase 2 (23: migrations 014/015, FKs/CHECKs, parity script, backup/restore drill, retention jobs), distributed phase 2 (16: async limiter, Redis fan-out with fake broker, idempotency, stuck-handoff sweeper, progress heartbeat).
- **Phase 4:** architecture phase 4 (110: router snapshot of 220 (method, path) pairs diffed empty, tools-package API compatibility, error taxonomy, redaction, SSRF validation, Settings caching/validation).
- **Phase 5 / agents / WebRTC / SDK:** agent reliability (23: spool DLQ, drain, heartbeat-during-hung-task, 401 classification), WebRTC phase 3 (22: RTCP ABR labelling, held-button release, stale-session refusal, ICE gate), Wave 3C SDK (36: MCP client initialize/pagination, shell contract, browser sandbox fail-closed, OCR hardening, SDK token hygiene), Wave 4 wiring (7: WS legacy-token rejection, OIDC exchange flow, list projection + `/result`, policy-simulate endpoint, limiter import source, `to_pg_sql` translation).
- **Deployment config:** 18 tests (`test_deployment_config.py` — compose fail-fast, nginx redirect/metrics/auth_request, installer `curl -k` removal, CI).

Three existing tests were rewritten in Wave 1B because they asserted the vulnerable behaviour; 21 dashboard expectations were updated in the Wave 2 fix-up to the login-first contract. **No test was deleted, disabled, or weakened to make the suite pass in any wave; no security check was disabled.**

## 5. The `/tmp` incident (environment lesson)

`/tmp` on this host is a 512 MB tmpfs. During Wave 3, bench databases, pristine-tree extractions, and pytest `tmp_path` fixtures filled it to 100%, which made two full-suite runs invalid (40 then 141 failures: `OSError` in `tmp_path` fixtures, truncated `.pyc` writes — `EOFError: marshal data too short` — and pytest exiting 120 with empty logs). Wave 3C diagnosed it, re-ran the comparison in isolated git worktrees on the home disk with `TMPDIR` off `/tmp`, and reproduced the published baseline exactly (pristine `19747b2`: 513 passed / 12 failed; patched: 593 passed / 13 failed with the flaky timing test). Before the parent's Wave 3 verification run, `/tmp` was cleaned (bench DBs, pristine extractions, parity scratch dirs — ~490 MB freed, back to 2% used) and all subsequent full runs used `TMPDIR=~/workspace/tmp`. **Lesson recorded:** never run the full suite with the default `TMPDIR` on this host; the tmpfs is too small for this repo's test footprint.

## 6. Tests NOT run (evidence gaps)

| Test / verification | Why not | What would unblock it |
|---|---|---|
| Playwright e2e (`apps/dashboard/e2e/`, 126 cases) | ~~Never run in any wave; `dashboard.spec.ts:134` still asserts the old OIDC fragment flow and would fail against the new exchange-code flow~~ **RUN in Wave 5B (17 Nov 2026): 126/126 passed locally** — spec updated to the exchange-code flow first; see §3 |
| Windows `ai_bridge_tests` (C++ `test_windows_agent.cpp`, incl. new §[7/7]) | No Windows host/toolchain (no MSVC/clang-cl, no Windows SDK) | A Windows host or Windows CI runner |
| Postgres boot / backup-restore drill / migration parity on Postgres | No Postgres server/binaries (`psql`, `pg_dump`, `createdb` absent) | A Postgres instance; run `scripts/check_schema_parity.py` + `scripts/backup_restore.py` against it |
| Two-worker Redis fan-out / 4-worker load test | No Redis server/binary; no load-test harness (PERF-01 pool deferred) | Redis + a second gunicorn worker + a load harness |
| Live aiortc peer / WebRTC E2E with a real browser peer | aiortc not installed; no live plane-agent pair exercised | Install aiortc; run a real peer against the plane |
| Live Ollama / LangChain / OpenAI / Anthropic / Copilot tenant | No live services/tenant | Credentials + a live tenant (explicitly out of scope for this remediation) |
| Live deploy / enrollment / `nginx -t` | No Docker daemon, no nginx binary, no live plane | A staging host with Docker + nginx |
| GitHub CI run | No GitHub run triggered | Push to a remote and observe a CI run |
| 10-step E2E workflow (brief Part 10) | ~~No such test exists (TST-09 open)~~ **Written and passing in Wave 5B:** `tests/e2e/test_workflow_10step.py` (1 test, 10 asserted steps, local plane) |
| Failure/recovery tests (crash/restart/DB failure/races) | ~~No such tests exist (TST-10 open)~~ **Written and passing in Wave 5B:** `tests/e2e/test_failure_recovery.py` (6 tests, each verified against the implementation before asserting) |

## 7. Test evidence integrity

- Every full-suite number in §1 is from a run executed by the parent agent (not copied from a wave's report) with the log retained (`~/workspace/tmp/pytest-wave4.log` for the final run; earlier runs were reported by the parent at each wave boundary).
- Wave 4 Track A's own "DONE" claims rested on `py_compile` + stdlib exercises + diff review only (its VM had no pytest/fastapi/httpx/pydantic and `pip install` was forbidden); the parent's full-suite runs are the verification for that track.
- The Wave 3 full-suite numbers from the individual waves are not directly comparable (different trees: 3A 632/13, 3B 743/12 merged tree, 3C 593/13 worktree-only); the parent-verified combined-tree numbers (743 at Wave 3, 750 at Wave 4) are the authoritative ones.
- The one warning in the final run is a `StarletteDeprecationWarning` (`httpx` with `starlette.testclient` is deprecated; install `httpx2` instead) — cosmetic, not a failure.
