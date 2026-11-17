# 15 — Testing and Reliability Report (AI Bridge v0.3.0)

**Scope:** Every test file in the repo, every test-count claim, and every test actually executed
in this environment — plus reliability-relevant findings (in-memory state, single-worker limits).
**Method:** Static counting (`grep -c 'def test_'`, regex counts of `it(`/`test(` in TS),
reading of test harnesses, and safe read-only execution only. **No packages were installed.**
No deployment scripts were run. No production service was contacted.
**Environment:** Python 3.12.3, Node v24.22.1, npm 10.9.4, no `node_modules` in
`apps/dashboard/`, no `pytest` module, no `mcp`/`fastapi`/`pydantic`/`httpx` modules
(verified by import attempts — see §4).
**Status labels:** VERIFIED = observed; INFERRED = reasoned from code; NOT FOUND = searched for.

---

## 1. Executive summary

- **Python tests: 403 `def test_` functions in 58 files (9,197 lines)** — VERIFIED by grep.
  **Zero of them were executed via pytest in this environment** because `pytest` is not
  installed and installing it was out of scope. This is a *blocked* result, not a pass.
- **Dashboard "356 tests, 100% passed" (TEST_READY.md): the arithmetic is correct**
  (7+6+7+6+155+155+10+10 = 356 `it(` calls in the files `run-all-tests.ts` imports), but
  **310 of the 356 (Tiers 1–2) never execute application code** — they assert on inline
  literals defined inside the test itself (e.g. `const token = 'ai_bridge_sec_adm_99182a4'`).
  The suite was **not executed here** (no `node_modules`, no `tsx` binary).
- **Playwright e2e: 48 `test(` cases in 6 specs** — not executed here (no `node_modules`,
  no Playwright browsers); they require a running dashboard dev server.
- **Challenger/Tier-5 suites (31 + ~13 + 15 cases + a static compliance audit) exist but are
  NOT wired into `npm test`** — `run-all-tests.ts` does not import them.
- **One real functional check was performed without pytest:** 13/13 assertions equivalent to
  `test_policy.py` (6), `test_tasks.py` (2), and part of `test_workspace.py`/`test_security.py`
  passed against the actual `policy`/`workspace`/`tasks` modules via a namespace-package shim
  that bypasses `ai_bridge/__init__.py` (which requires `httpx`). This validates the policy
  engine's core behaviour; it is **not** a pytest run and must not be reported as one.
- **`py_compile` passed on all 161 Python files (exit 0)** — syntax only, no behaviour.
- **Reliability (from docs + code structure):** emergency-stop and OIDC pending state are
  in-process memory; the control plane is documented as single-worker-only; the rate limiter
  is per-process unless Redis is configured. These are INFERRED-from-docs risks for the
  reliability track to verify in code.

---

## 2. Python test inventory (VERIFIED counts)

Total: **58 files, 403 `def test_` functions, 9,197 lines.**

### 2.1 Root + integration + security + e2e

| File | Lines | `def test_` | Imports (notable) |
|---|---|---|---|
| `tests/test_control_plane.py` | 337 | 29 | fastapi TestClient, `control.app` |
| `tests/test_security.py` | 20 | 3 | `ai_bridge.security` |
| `tests/test_tasks.py` | 12 | 2 | `ai_bridge.tasks` |
| `tests/test_windows_v1_architecture.py` | 165 | 5 | `ai_bridge`, `control.v1_routes` |
| `tests/test_windows_v2_architecture.py` | 197 | 6 | `ai_bridge` |
| `tests/integration/test_control_plane.py` | 121 | 6 | fastapi, `control.app` |
| `tests/integration/test_mcp_http_roundtrip.py` | 70 | 2 | fastapi, `control.combined` |
| `tests/integration/test_mcp_stdio.py` | 45 | 1 | subprocess-based (no ai_bridge import) |
| `tests/integration/test_security_batch.py` | 126 | 7 | fastapi, `control.app` |
| `tests/integration/test_workspace_operations.py` | 104 | 5 | fastapi, `control.app` |
| `tests/security/test_security_hardening.py` | 76 | 9 | `ai_bridge.policy/security` |
| `tests/e2e/test_enrollment_flow.py` | 31 | 1 | fastapi TestClient; encodes the full enroll → task → agent → result → audit → revoke flow |

### 2.2 Unit tests (`tests/unit/`, 46 files)

| File | Lines | `def test_` |
|---|---|---|
| `test_phase8_deep.py` | 394 | 21 |
| `test_phase9_deep.py` | 222 | 18 |
| `test_installer_diagnostics.py` | 168 | 14 |
| `test_windows_installer.py` | 236 | 14 |
| `test_ai_api.py` | 431 | 13 |
| `test_windows_app_runtime.py` | 170 | 12 |
| `test_microsoft365.py` | 131 | 11 |
| `test_orchestration_phases.py` | 224 | 11 |
| `test_browser_intelligence.py` | 160 | 10 |
| `test_phase3_desktop_autonomy.py` | 161 | 10 |
| `test_phase4_streaming_and_updater.py` | 386 | 9 |
| `test_windows_diagnose.py` | 195 | 9 |
| `test_install_package.py` | 104 | 8 |
| `test_phases_456_deep.py` | 154 | 8 |
| `test_aci_desktop_deepening.py` | 182 | 7 |
| `test_feature_batch.py` | 279 | 7 |
| `test_gui_app.py` | 193 | 7 |
| `test_mai_multi_agent.py` | 208 | 7 |
| `test_residuals_security_platform.py` | 92 | 7 |
| `test_serverai_mcp_orchestration.py` | 175 | 7 |
| `test_windows_p0_p2_gaps.py` | 137 | 7 |
| `test_agent_linux.py` | 92 | 6 |
| `test_device_policy.py` | 236 | 6 |
| `test_device_routing.py` | 115 | 6 |
| `test_enhanced_features.py` | 161 | 6 |
| `test_execution.py` | 45 | 5 |
| `test_gateway_binding.py` | 127 | 5 |
| `test_desktop_gui_tools.py` | 149 | 5 |
| `test_phase1_approvals_and_vision.py` | 220 | 6 |
| `test_phase2_workflows.py` | 177 | 6 |
| `test_phase3_fleet_ops.py` | 206 | 6 |
| `test_phase7_deep.py` | 184 | 6 |
| `test_platform_enhancements.py` | 536 | 6 |
| `test_policy.py` | 30 | 6 |
| `test_chatgpt_mcp_discovery.py` | 78 | 3 |
| `test_diagnose_doc_sync.py` | 192 | 3 |
| `test_dual_engine_migrations.py` | 55 | 3 |
| `test_gui_config_security.py` | 85 | 3 |
| `test_combined_embed.py` | 74 | 2 |
| `test_mcp_admin_fleet.py` | 84 | 1 |
| `test_mcp_oauth2.py` | 175 | 2 |
| `test_offline_spool.py` | 57 | 2 |
| `test_observability_alerts.py` | 68 | 4 |
| `test_device_dashboard.py` | 191 | 4 |
| `test_launch_app_paths.py` | 99 | 4 |
| `test_workspace.py` | 55 | 4 |

(Counts VERIFIED by `grep -c 'def test_'` per file; subtotal unit = 327; root+integration+security+e2e = 76; total 403.)

**Counting caveats (VERIFIED):**
- `def test_` counts test *functions*, not test *cases*: parametrised tests, loops, and
  fixtures are not expanded. The true case count could differ.
- No `tests/conftest.py` exists (NOT FOUND); shared fixtures, if any, live inside test files
  (e.g. `test_workspace.py` defines its own `ws` fixture).
- pytest config is in `pyproject.toml` only: `pythonpath = ["src", "."]`,
  `testpaths = ["tests"]`, `addopts = ["--import-mode=importlib"]`; dev extra is
  `pytest>=8.0, ruff>=0.4, Pillow>=10.0`.

### 2.3 What the Python tests cover (by filename — INFERRED, not executed)

Policy, workspace confinement, execution sandboxing, device routing, MCP stdio/HTTP round-trips,
OAuth2, orchestration phases 1–9, desktop autonomy, fleet ops, streaming/updater, Windows
installer/diagnose/app-runtime, GUI app, Linux agent, offline spool, migrations (dual-engine),
Microsoft 365 connector, browser intelligence, AI API, multi-agent (MAI), approvals/vision,
workflows, security hardening. **Notably thin:** only 1 e2e test, 2 MCP stdio/HTTP tests,
1 enrollment-flow test; no load/soak test in `tests/` (soak scripts live in `scripts/k6/` and
`scripts/locust/` and are not pytest tests).

### 2.4 C++ test

`windows-agent/tests/test_windows_agent.cpp` — a single `main()` with 6 numbered `assert`-based
checks (DPAPI protect/unprotect, authenticated named pipe, plus 4 more sections — file not fully
read in this track; the native track owns it). Wired in `CMakeLists.txt` as CTest target
`NativeWindowsAgentTests` (`ai_bridge_tests` executable). **Windows-only; not executable in this
Linux environment. NOT EXECUTED.**

---

## 3. Dashboard test inventory (VERIFIED counts)

### 3.1 The `npm test` path — `package.json`

```json
"test": "tsx src/tests/run-all-tests.ts && npm run test:i18n",
"test:i18n": "tsx --test src/tests/catalogs.test.ts",
"test:browser": "playwright test"
```

### 3.2 `run-all-tests.ts` suite — the "356 tests" (VERIFIED arithmetic)

Counting `it('…')` calls (regex `\bit\(\s*['\`]`) per file imported by `run-all-tests.ts`:

| Suite | File | `it(` calls | TEST_READY.md claim | Match? |
|---|---|---|---|---|
| R1 tech stack | `r1-tech-stack.test.ts` | 7 | 7 | ✅ |
| R2 & R3 anti-AI | `r2-r3-anti-ai.test.ts` | 6 | 6 | ✅ |
| R4 reconstruction | `r4-reconstruction.test.ts` | 7 | 7 | ✅ |
| R5 functional state | `r5-functional-state.test.ts` | 6 | 6 | ✅ |
| Tier 1 feature coverage | `tier1-feature-coverage.test.ts` | 155 | 155 | ✅ |
| Tier 2 boundary/corner | `tier2-boundary-corner.test.ts` | 155 | 155 | ✅ |
| Tier 3 combinations | `tier3-combinations.test.ts` | 10 | 10 | ✅ |
| Tier 4 scenarios | `tier4-scenarios.test.ts` | 10 | 10 | ✅ |
| **TOTAL** | | **356** | **356** | ✅ arithmetic |

**But the evidentiary value is weak (VERIFIED by reading the test bodies):**
- **Tier 1 (155) and Tier 2 (155) import NOTHING except the local harness**
  (`import { describe, it, expect, setSuite } from './harness.js'`). They contain **zero**
  references to `dashboardStore` or any `../` application module (grep count 0).
  Each test constructs its own literal data and asserts on it, e.g. Tier 1 F1.1:
  `const token = 'ai_bridge_sec_adm_99182a4'; … expect(authResult.authenticated).toBeTruthy();`
  Tier 2 F1-E2: `const hugeToken = 'a'.repeat(9000); expect(hugeToken.length > 8192).toBe(true);`
  These tests **pass by construction** regardless of what the application does; they cannot fail
  unless the literal or the assertion itself is wrong. They are specification-reenactment
  scripts, not tests of the dashboard.
- **R1–R4 are static source scans** (real checks, but of *text*, not behaviour): they read files
  with `node:fs` and assert e.g. `fluent2.css`/`jxui.css` do not exist, no `style={{` in `src/`,
  no purple/pink gradients, all 15 screens defined. These can genuinely fail and are the most
  valuable part of the suite — but they verify *source text*, not runtime behaviour.
- **R5 checks file existence/content** via `fs` (e.g. `dashboardStore.ts` exists) plus inline
  literals; it does not import the store either (grep: 0 imports of `dashboardStore`, 4 textual
  mentions as path strings).
- **Tier 3/4** likewise import only the harness and assert on inline literals.
- The harness itself (`harness.ts`, 287 lines) is a custom BDD runner: `describe` runs its
  callback synchronously; `it` is `async` and records results in a microtask; `run-all-tests.ts`
  awaits each suite runner, so results should drain before `printSummary` — INFERRED from
  reading the harness, **not verified by execution**.
- TEST_READY.md also claims "Test Execution Latency: 0.10 seconds" and "100% (356/356 passed)"
  dated 2026-11-02 on Node v26.12.1 — **not reproducible here** (see §4.3).

### 3.3 Dashboard tests NOT in `npm test` (VERIFIED)

| File | Cases (counted) | What it does | Wired into `npm test`? |
|---|---|---|---|
| `src/tests/catalogs.test.ts` | 3 `test(` (node:test) — real imports of `../i18n/catalogs` | i18n catalog completeness, locale resolution, interpolation | ✅ via `test:i18n` (so `npm test` total is really 356 + 3 = 359) |
| `src/tests/tier5-adversarial.test.ts` | 31 `await test(` calls; imports real `dashboardStore` | Adversarial: rapid view transitions, emergency-stop integrity, concurrent dispatch/approvals, malformed input, zero inline styles | ❌ NOT imported by `run-all-tests.ts` |
| `src/tests/challenger-stress.test.ts` | 15 `testCase` calls (16 matches incl. the function definition); imports real `dashboardStore` | Rapid state toggles, emergency stop, concurrent tasks | ❌ not imported; self-invoking |
| `src/tests/challenger-m1-2-stress.test.ts` | 13 `test(` calls; imports React, ReactDOMServer, `dashboardStore` | M1–M2 stress incl. server-side render | ❌ not imported; self-invoking |
| `src/tests/challenger-compliance.test.ts` | 0 counted cases; static `fs` audit of source files | Compliance audit (allowed packages, forbidden tokens) | ❌ not imported; self-invoking |

So the "356" headline **excludes** the only dashboard suites that import and exercise real
application state (Tier 5 + challenger, ~59 cases), and **includes** 310 self-referential cases.

### 3.4 Playwright e2e (`apps/dashboard/e2e/`, 6 specs, 48 `test(` cases)

| Spec | `test(` |
|---|---|
| `dashboard.spec.ts` | 14 (15 views × 2 widths accessibility/axe checks + search/keyboard) |
| `live-workspace.spec.ts` | 17 |
| `operations.spec.ts` | 7 |
| `localization.spec.ts` | 6 |
| `brand.spec.ts` | 2 |
| `density.spec.ts` | 2 |
| **Total** | **48** |

`playwright.config.ts`: `baseURL http://127.0.0.1:5173`, auto-starts `npm run dev -- --host
127.0.0.1 --strictPort`. Specs assert exactly one `h1`, no horizontal overflow, zero axe
violations, zero page errors, and a visible "Demo workspace" note on non-login views.
**Not executed here** (no `node_modules`, no Playwright browsers). Note the specs test the
**demo** workspace by design (they expect the "Demo workspace" banner).

---

## 4. Safe test execution — exact commands and results

All commands run 2026-11-17 in `/home/hatch/workspace/ai-bridge-main`, with a 60 s timeout,
no installs, no network, no writes to source (one `py_compile` run created `__pycache__`
directories; they were removed afterwards — verified 0 `__pycache__` / `*.pyc` remaining).

### 4.1 pytest collect-only (as instructed)

```text
$ timeout 60 python3 -m pytest tests/unit/test_policy.py -q --collect-only
/usr/bin/python3: No module named pytest
EXIT=1
```

```text
$ timeout 60 python3 -m pytest tests/unit/test_policy.py tests/unit/test_workspace.py -q
/usr/bin/python3: No module named pytest
EXIT=1
```

**Result: BLOCKED — pytest is not installed.** `pip list` shows a system Python with numpy/
pandas/matplotlib/pillow but no pytest, no mcp, no fastapi, no pydantic, no httpx, no redis,
no psycopg, no websockets (each confirmed by a failing `python3 -c "import <mod>"` with
`ModuleNotFoundError`). The full pytest suite therefore cannot be collected, let alone run,
in this environment. **No Python test is reported as passed/failed from pytest.**

### 4.2 `py_compile` (syntax check only)

```text
$ python3 -m py_compile src/ai_bridge/policy.py src/ai_bridge/workspace.py \
    src/ai_bridge/security.py src/ai_bridge/tasks.py src/ai_bridge/tools.py \
    src/ai_bridge/config.py src/ai_bridge/execution.py src/ai_bridge/diagnostics.py \
    src/ai_bridge/client.py src/ai_bridge/server.py src/ai_bridge/audit.py
py_compile core EXIT=0

$ python3 -m py_compile $(find src agents tests integrations deployment -name '*.py')
py_compile ALL EXIT=0
```

**Result: all 161 Python files compile (exit 0).** This proves syntactic validity only — it
does not execute any code and says nothing about behaviour, imports at runtime, or
correctness. (Side effect: `__pycache__` dirs were created and then deleted; verified clean.)

### 4.3 Manual functional check (no pytest) — 13/13 passed

Because `from ai_bridge.policy import …` fails in this environment (`src/ai_bridge/__init__.py:8`
imports `.client`, which imports `httpx` — VERIFIED traceback: `ModuleNotFoundError: No module
named 'httpx'`), the check loaded the package as a namespace package (no `__init__.py`
execution) with `PYTHONDONTWRITEBYTECODE=1`:

```python
pkg = types.ModuleType("ai_bridge"); pkg.__path__=["src/ai_bridge"]; sys.modules["ai_bridge"]=pkg
from ai_bridge.policy import Policy, decide
from ai_bridge import workspace
from ai_bridge.tasks import run_diagnostic
```

Results (all against the real modules, temp workspace dir):

```text
PASS tier1 allowed
PASS tier4 needs approval+admin
PASS tier4 approval+admin allowed
PASS tier4 approval w/o admin denied
PASS unknown tool denied
PASS desktop disabled by default
PASS revoked device denied
PASS frozen policy raises
PASS tier3 blocked when disabled
PASS workspace create/read
PASS overwrite refused
PASS arbitrary diagnostic rejected
PASS unknown diagnostic rejected
SUMMARY 13/13 passed
EXIT=0
```

These 13 assertions mirror `tests/unit/test_policy.py` (6 tests), `tests/test_tasks.py`
(2 tests), and part of `tests/unit/test_workspace.py` (overwrite refusal) — but they were
**not** run through pytest and did not use pytest fixtures (`monkeypatch`, `tmp_path`);
the workspace test used a real `tempfile.mkdtemp()` + `AI_BRIDGE_WORKSPACE` env var.
Report them as "manual functional spot-check: 13/13 passed", never as "pytest passed".

### 4.4 Dashboard test execution — BLOCKED

- `ls apps/dashboard/node_modules` → **No such file or directory**; `node_modules/.bin/tsx`
  absent. `npm test` cannot run (`tsx` is a devDependency, not installed).
- `npx tsx` would fetch from the network — **not attempted** (no installs per task).
- Node v24.22.1 is present, but `run-all-tests.ts` imports `./harness.js` (a `.ts` file
  referenced with a `.js` suffix), so Node's native type-stripping cannot run it directly
  without `tsx`. **Result: dashboard suite NOT EXECUTED here; 356/356 pass claim NOT
  re-verified.** Static analysis (§3.2) is the only evidence available in this environment.
- Playwright e2e: also blocked (no `node_modules`, no browsers, no dev server).

### 4.5 C++ test — NOT EXECUTED (Windows-only)

`windows-agent/tests/test_windows_agent.cpp` requires Windows APIs (DPAPI, named pipes) and a
CMake/MSVC build; this is a Linux VM. CI job `windows-native-webrtc` builds it on
`windows-latest` — that CI run was not observed here.

---

## 5. Per-file classification (Python)

Classification is based on what was **actually observed in this environment**, not on what CI
would do:

| Class | Count | Meaning |
|---|---|---|
| **Not executed — blocked (no pytest)** | **58 / 58** | Every Python test file. `python3 -m pytest` fails with `No module named pytest` (exit 1). |
| **Additionally blocked — direct import of an unavailable third-party package** | **31 / 58** | Files importing `fastapi`/`starlette`/`mcp`/`httpx`/`redis`/`psycopg`/`aiortc`/`PIL`/`websockets`/`pydantic` at module scope (grep-verified list below). |
| **Additionally blocked — transitive import via `ai_bridge/__init__.py` → `httpx`** | most of the rest | Any file doing `from ai_bridge…` / `import ai_bridge…` triggers `__init__.py` → `client.py` → `httpx` (VERIFIED traceback). Only files with **no** `ai_bridge` import escape this. |
| **No `ai_bridge` import (collectable in principle if pytest existed)** | 8 | `tests/integration/test_mcp_stdio.py`, `tests/unit/test_diagnose_doc_sync.py`, `tests/unit/test_gui_config_security.py`, `tests/unit/test_installer_diagnostics.py`, `tests/unit/test_offline_spool.py`, `tests/unit/test_windows_app_runtime.py`, `tests/unit/test_windows_diagnose.py`, `tests/unit/test_gateway_binding.py` (last one still directly imports fastapi — so 7 truly import-clean, all unexecuted). |
| Passed / Failed / Skipped (pytest) | **0** | None observed. Do not report any pytest result for this repo from this environment. |
| Not implemented (empty/stub test files) | 0 found | No test file with 0 `def test_` was found; the thinnest are `test_mcp_admin_fleet.py` (1 test) and `test_enrollment_flow.py` (1 test). |

Files directly importing unavailable third-party packages (31, VERIFIED by grep):
`tests/e2e/test_enrollment_flow.py`, `tests/integration/test_control_plane.py`,
`test_mcp_http_roundtrip.py`, `test_security_batch.py`, `test_workspace_operations.py`,
`tests/test_control_plane.py`, `tests/unit/test_ai_api.py`, `test_chatgpt_mcp_discovery.py`,
`test_combined_embed.py`, `test_device_dashboard.py`, `test_device_policy.py`,
`test_device_routing.py`, `test_enhanced_features.py`, `test_feature_batch.py`,
`test_gateway_binding.py`, `test_gui_app.py`, `test_mai_multi_agent.py`,
`test_mcp_oauth2.py`, `test_microsoft365.py`, `test_observability_alerts.py`,
`test_orchestration_phases.py`, `test_phase1_approvals_and_vision.py`,
`test_phase2_workflows.py`, `test_phase3_desktop_autonomy.py`, `test_phase3_fleet_ops.py`,
`test_phase4_streaming_and_updater.py`, `test_phase7_deep.py`, `test_phase8_deep.py`,
`test_phase9_deep.py`, `test_platform_enhancements.py`, `test_residuals_security_platform.py`,
`test_serverai_mcp_orchestration.py`, `test_windows_installer.py`.

**What would unblock a real run (for the parent agent, not done here):** create a venv and
`pip install -e ".[dev]"` per `pyproject.toml` (pytest, mcp, fastapi, uvicorn, pydantic, psutil,
httpx, websockets, cryptography, python-multipart, redis, psycopg) — then `pytest -q` from the
repo root. That is an install step and was explicitly out of scope for this track.

---

## 6. Test-count claims vs verified counts

| Claim | Source | Verified |
|---|---|---|
| "Execute full test suite (75 tests)" | `README.md` (Verification & Testing) | ❌ **Wrong.** 403 `def test_` functions counted. No 75 anywhere in the tree except this line. |
| "`pytest -q` = 29 passed" (v0.2.0, 2026-10-24) | `CHANGELOG.md` | ⚠️ **Historical, unverifiable here.** 29 ≠ 403 current tests; presumably the suite grew after v0.2, or the 29 was a subset. No run log in the repo. |
| "Tests: 33 passed (4 new security-batch tests)" (v0.3.0) | `CHANGELOG.md` | ⚠️ **Historical, unverifiable here.** 33 ≠ 403. Same caveat. |
| "Total Automated Test Cases: 356; 100% (356/356 passed); 0.10 seconds" | `TEST_READY.md` | ⚠️ **Arithmetic correct; execution not re-verified; 310/356 are self-referential** (§3.2). 0.10 s for 356 tests is consistent with tests that do no I/O — it is evidence *for* the self-referential reading. |
| "31 features × 5 = 155" per tier | `TEST_READY.md` / `TEST_INFRA.md` | ✅ Count correct (155 `it(` per tier file). Content caveat as §3.2. |
| CI runs `pytest -v` + dashboard `npm test` + Playwright | `.github/workflows/ci.yml` | ✅ Workflow file exists with 4 jobs (test, macos-agent, windows-native-webrtc, dashboard). **No CI run output is present in this tree** — the badge in README cannot be verified offline. |
| "M6: Pass 100% E2E tests (Tiers 1-4) & adversarial hardening (Tier 5) — DONE" | `PROJECT.md` | ❌ **Tier 5 is not in the runner** (§3.3); "E2E" here means the custom harness, not browser E2E. |

---

## 7. Untested / thinly tested critical paths (INFERRED from file sizes vs test counts)

These are code-level hypotheses for the reliability/security tracks to confirm, not proven gaps:

| Critical path | Code size | Test evidence |
|---|---|---|
| `control/app.py` (all 143 routes: auth, enrollment, tasks, approvals, audit, policies, sessions, OIDC, backups) | 5,147 lines | `test_control_plane.py` (29 tests) + integration files; no test file approaches route-level coverage; most tests need fastapi (blocked here) |
| `control/ai_api.py` + `custom_agents.py` (custom agents, memory, failures) | 3,939 lines | `test_ai_api.py` (13), `test_mai_multi_agent.py` (7), `test_phase7_deep.py` (6) |
| `webrtc_stream.py` (sessions, ICE/TURN, DataChannel input, key-release) | 1,348 lines | `test_phase9_deep.py` (18), `test_phase4_streaming_and_updater.py` (9) — no live WebRTC test in `tests/`; the live check is `scripts/libwebrtc_e2e_harness.py` (CI-only, Windows) |
| `control/mcp_oauth.py` + `oidc.py` (OAuth 2.1, PKCE, device binding) | 525 lines | `test_mcp_oauth2.py` (**2 tests**), `test_chatgpt_mcp_discovery.py` (3) — thinnest coverage relative to risk |
| `control/dispatch.py` + `device_routing.py` (task dispatch, long-poll, cancel) | ~1,000 lines | `test_device_routing.py` (6), `test_serverai_mcp_orchestration.py` (7); soak scripts in `scripts/k6|locust/` are not wired into pytest |
| `control/db.py` + 12 migrations (dual SQLite/Postgres) | 525 + 278 lines | `test_dual_engine_migrations.py` (**3 tests**) |
| `server.py` (109 MCP tools) | 1,701 lines | `test_mcp_stdio.py` (1 test), `test_mcp_http_roundtrip.py` (2 tests) — per-tool schema/validation coverage is effectively absent |
| `browser_tools.py` + connectors | 1,075 + 993 lines | `test_browser_intelligence.py` (10) — Playwright-dependent paths cannot run without a browser |
| `agents/common/poller.py` (claim/lease, backoff, rotation, offline spool) | 534 + 131 lines | `test_agent_linux.py` (6), `test_offline_spool.py` (2) |
| `windows-agent/` C++ (DXGI, MF encoder, IPC, WebRTC) | 3,433 lines | 1 C++ test file, 6 asserts, Windows-only |
| End-to-end happy path (enroll → task → execute → result → audit → revoke) | — | **1 test** (`tests/e2e/test_enrollment_flow.py`) |
| Failure/recovery (agent crash, server restart, DB failure, duplicate task, cancel races) | — | **No dedicated tests found** by filename; `scripts/k6/claim_cancel_soak.js` + `scripts/locust/claim_cancel_soak.py` exist but are soak scripts, not pytest tests, and were not executed |

## 8. Reliability notes (docs + structure; code verification belongs to sibling tracks)

- **Single-worker constraint (VERIFIED in docs):** `docs/production-readiness.md` — "The existing
  control plane keeps emergency stop and OIDC pending state in process memory: use one worker,
  and do not assume those states survive restart." A restart loses emergency-stop state; a
  second worker would not see it. This is the single most important reliability finding.
- **Rate limiting is per-process memory by default** (`docs/operations.md`: "120 req/min per
  token/IP in-process. For production, add proxy-level limiting"); Redis-backed durable
  limiting exists (`control/durable_ratelimit.py`) but is opt-in via `AI_BRIDGE_REQUIRE_REDIS` /
  `AI_BRIDGE_MULTI_HOST`.
- **Agent polling:** bounded exponential backoff 2 s → 60 s cap (`docs/remote-access.md`); tasks
  stay `queued` while a device is offline; optional WS side-channel (`agent_channel.py`) with
  HTTP long-poll fallback (`docs/implementation-status.md`).
- **Idempotency:** `POST /api/tasks` accepts `Idempotency-Key` (1–128 ASCII); concurrent equal
  requests create one task/approval; reuse with different args → 409
  (`docs/production-readiness.md`). No automatic expiry of submission records.
- **Backups:** workspace backups are local timestamped ZIPs in `<workspace>/.ai-bridge-backups/`;
  DB backup via `python -m ai_bridge.control.backup` with integrity verification
  (`docs/production-readiness.md`, `control/backup.py`).
- **No test evidence in this tree** for: multi-worker behaviour, server-restart recovery,
  Redis failover, Postgres failover, duplicate-task races under concurrency, or agent-crash
  recovery. CI (`ci.yml`) runs the unit suite, not the soak scripts.

## 9. Findings

| # | Finding | Severity / class |
|---|---|---|
| TST-01 | **No Python test was executed in this environment** — pytest not installed; 58/58 files blocked | P1 — evidence gap |
| TST-02 | 31/58 Python test files directly import unavailable third-party packages (fastapi/mcp/httpx/…) | P1 — evidence gap |
| TST-03 | `ai_bridge/__init__.py` importing `httpx` blocks even stdlib-only test modules from being collected without the full dependency set | P2 — testability defect |
| TST-04 | Dashboard "356 tests, 100% pass": count correct, but 310/356 (Tiers 1–2) assert on inline literals and import no application code — they cannot detect regressions | P1 — false confidence |
| TST-05 | Tier 5 + challenger suites (~59 cases) are the only dashboard suites exercising real store state, and they are **not wired into `npm test`** | P1 — coverage gap |
| TST-06 | `npm test` total is actually 359 (356 + 3 i18n `node:test` tests), not 356 — TEST_READY.md omits the i18n suite from its total | P3 — doc nit |
| TST-07 | README "75 tests" contradicts the 403 counted and the CHANGELOG's 29/33 — three different numbers, none reproducible here | P2 — doc inconsistency |
| TST-08 | CHANGELOG release-time pass counts (29, 33) have no run logs in the repo and predate the current 403-test suite | P2 — evidence gap |
| TST-09 | Only 1 Python e2e test covers the full enroll→task→result→audit→revoke flow; only 3 tests cover MCP stdio/HTTP round-trips; only 2 cover OAuth2 | P1 — coverage gap |
| TST-10 | No tests found for failure/recovery (crash, restart, DB failure, duplicate/cancel races); soak scripts exist but are not wired into any test command | P1 — coverage gap |
| TST-11 | `py_compile` passes on all files (exit 0) — syntax is clean; this is weak evidence and must not be cited as test passage | Info |
| TST-12 | Manual spot-check: 13/13 policy/workspace/task assertions passed against real modules (namespace-shim, no pytest) — the policy engine's core behaves as documented | Info — positive |
| TST-13 | Playwright e2e (48 cases) tests the **demo** workspace by design (expects the "Demo workspace" banner) — live-workspace behaviour has no browser coverage in `e2e/` | P2 — coverage gap |
| TST-14 | C++ native tests are Windows-only (6 asserts) and were not executed here | P2 — evidence gap |
| TST-15 | Reliability: emergency-stop + OIDC state in process memory → single-worker-only, state lost on restart (per `docs/production-readiness.md`) | P1 — reliability risk |
| TST-16 | No `tests/conftest.py`; no CI run output in the tree; README CI badge unverifiable offline | P3 — process gap |
