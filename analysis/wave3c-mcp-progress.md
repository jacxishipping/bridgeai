# Wave 3C Track C — MCP client, shell/terminal/browser hardening, SDK, Phase 5 build-now features

- **Track:** Wave 3C Track C
- **Repo:** `/home/hatch/workspace/ai-bridge-main`, base commit `19747b2`
- **Date:** 2026-11-17
- **Scope kept:** only `src/ai_bridge/control/mcp_client.py`, `src/ai_bridge/client.py`,
  `src/ai_bridge/terminal_manager.py`, `src/ai_bridge/browser_tools.py`,
  `src/ai_bridge/browser_isolation_os.py`, `src/ai_bridge/vision.py`,
  new `src/ai_bridge/policy_simulation.py`, new `tests/unit/test_wave3c_sdk.py`.
  Nothing outside this set was edited (no commit, no pip install, no reset/rebase).
  Other modified files visible in `git status` belong to parallel tracks.

## 1. F-06-15 — proper MCP client (`control/mcp_client.py`) — DONE

- **Finding:** outbound client sent `tools/list` first, no `initialize`, no
  `Mcp-Session-Id`, no pagination (report 06 §7).
- **Change:** new `MCPClient` class — `initialize()` offers protocol versions
  `2025-06-18` → `2025-03-26` → `2024-11-05`, requires the server to select
  one of them, stores `Mcp-Session-Id` + `serverInfo`/`capabilities`, sends
  `notifications/initialized` (id-less, fire-and-forget). `list_tools(cursor)`
  returns one page + `nextCursor`; `list_all_tools()` follows cursors, bounded
  at 50 pages with loop detection. `call_tool()` parses MCP content/`isError`.
  Module functions `fetch_mcp_tools` / `execute_mcp_tool` keep their exact
  signatures and callers (`control/mcp_routes.py`, `control/ai_api.py`,
  `control/custom_agents.py`); they run `initialize()` best-effort and fall
  back to legacy mode when a server does not implement it (logged, not fatal)
  so minimal/older servers and the existing OAuth-test fakes keep working.
  `MCPErrorCode` enum + `MCPClientError(code, status_code)` is the small
  shared error taxonomy (FR-06, MCP half).
- **Tests:** initialize negotiates `2025-06-18` + stores `sess-123`; pagination
  `a` → cursor `c1` → `b`; legacy server without initialize still works;
  unsupported version `1999-01-01` rejected with code `protocol`.
- **Rollback:** revert `control/mcp_client.py`; callers use the same signatures.

## 2. F-06-13 — DPoP / PAR evaluation — EVALUATED, NOT IMPLEMENTED (deliberate)

- **Evidence:** `grep -i "par|dpop|pushed_authorization"` over
  `deployment/oauth/gateway.py` and `src/ai_bridge/control/mcp_oauth.py`
  returns **no hits**. The gateway implements OAuth 2.1 / PKCE (S256, DCR,
  refresh rotation) only: no `/oauth/par` (RFC 9126) endpoint, no DPoP
  (RFC 9449) proof verification, no sender-constraining beyond device
  binding (`gateway.py:969-990` `/internal/verify`).
- **Decision:** do NOT half-implement crypto. A client-side DPoP proof or PAR
  request has no server side to talk to; shipping half of it would be
  security theatre and a false claim. The evaluation is recorded in the
  `mcp_client.py` module docstring. **Revisit when the gateway gains PAR;**
  that is a gateway-track decision, not a client one.
- **Status:** closed as "evaluated, intentionally not implemented".

## 3. F-04-07 — one shell contract (`terminal_manager.py`) — DONE

- **Finding:** three divergent shell paths (`tools._run_argv`,
  `execution.TaskRunner` allowlisted registry, this module's PTY spawn) with
  different timeout/kill/env policies (report 04 F-04-07).
- **Change:** `ShellSpec` dataclass (argv only, cwd, timeout, env extras,
  kill grace) + `run_shell_command(spec)` — the single entry point for
  one-shot shell execution in this module: `shell=False`, new process group,
  minimal scrubbed env via `clean_shell_env()` (allowlist `PATH/HOME/LANG/
  TERM/...`, secrets scrubbed — same shape as `execution.py`'s clean env),
  output truncated to 20k chars. `TerminalSession._start_process` now uses
  `clean_shell_env()` instead of its own ad-hoc blocklist. `execution.py`'s
  allowlisted registry is **not** duplicated (interactive terminal input is
  by design arbitrary shell text); the contract is about *how* a shell is
  spawned/killed, and that is documented in the module.
- **Rollback:** revert `terminal_manager.py`.

## 4. F-04-11 — SIGKILL escalation (`terminal_manager.py`) — DONE

- **Change:** `terminate_process_group(proc, grace_seconds=2.0)` — SIGTERM to
  the process group, wait the grace period, then SIGKILL the group
  (Windows: `taskkill /F /T`). Used by `run_shell_command()` on timeout and
  by `TerminalSession.close()` (replacing terminate-then-kill of the single
  pid). A child that ignores SIGTERM is still reaped by SIGKILL.
- **Note / follow-up:** `execution.py:TaskRunner._kill` is still SIGTERM-only
  and `tools._run_argv` still uses `proc.kill()` on timeout; both files are
  outside this track's scope. They should adopt `terminate_process_group`
  (or an equivalent) in a later track — recorded here, not silently fixed.
- **Tests:** a SIGTERM-ignoring child is killed on timeout (<10 s for a
  30 s sleep); `terminate_process_group` directly reaps such a process.

## 5. F-04-16 — bounded terminal sessions (`terminal_manager.py`) — DONE

- **Finding:** unbounded `_TERMINAL_SESSIONS`, no TTL/eviction (report 04).
- **Change:** `AI_BRIDGE_MAX_TERMINAL_SESSIONS` (default 32),
  `AI_BRIDGE_TERMINAL_SESSION_IDLE_TTL_SEC` (default 1800). `create_…`
  prunes dead/idle sessions first, then evicts + closes the oldest idle
  session at the cap; `get_`/`list_` prune; `prune_terminal_sessions()`
  closes evicted sessions (process group terminated) outside the lock.
  `terminal_session_limits()` reports the active bounds.
- **Tests:** cap 2 → creating a 3rd session evicts the oldest; idle session
  past TTL is pruned and `is_alive` becomes False.

## 6. F-04-14 — browser isolation (`browser_isolation_os.py`, `browser_tools.py`) — DONE

- **Finding:** detection-only (`shutil.which`); `bwrap` without seccomp or
  read-only workspace bind; requested-but-unavailable sandbox silently
  returned the bare argv (report 04 F-04-14).
- **Change:**
  - `chromium_launch_wrapper_argv()` now **fails closed**: requested
    netns/gVisor with missing tooling raises `BrowserIsolationError`
    instead of silently returning unwrapped argv. Only escape is the
    explicit documented opt-out `AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX=1`.
  - `require_browser_sandbox()` raises when `AI_BRIDGE_BROWSER_REQUIRE_SANDBOX=1`
    and no sandbox can be established, or when netns/gVisor was requested
    but unavailable; `browser_tools._ensure_browser()` calls it before launch.
  - bwrap argv hardened: `--cap-drop ALL`, `--new-session`, `--die-with-parent`,
    read-only binds for `/usr`, `/lib`, `/lib64`, `/etc/resolv.conf`,
    `--proc`, `--dev`, `--tmpfs /tmp`.
  - Honesty: `describe_os_browser_isolation()` now reports `enforced`
    (True only when a wrapper will actually be applied) and `seccomp:
    "none"` — **no seccomp-BPF filter is shipped in this tree**, and that is
    stated in the docstring, the report dict, and `browser_isolation_report()`
    (`isolation_enforced`). Detection is not presented as isolation anywhere.
- **Caveat:** existing test `test_browser_netns_wrapper_argv` still passes
  here because `unshare` exists on this host; on a host with neither
  `bwrap` nor `unshare`, `chromium_launch_wrapper_argv` with
  `AI_BRIDGE_BROWSER_NETNS=1` now raises instead of passing through — that
  behaviour change is the point of the fix (fail closed), and the test's
  `or wrapped == [...]` fallback documents the old behaviour.
- **Tests:** mode `none` → `enforced` False, `seccomp` `"none"`; requested
  but tooling mocked away → raise; opt-out → pass-through; require flag → raise.

## 7. F-04-19 — token handling in the SDK (`client.py`) — DONE

- **Change:** token is loaded from `AI_BRIDGE_TOKEN_FILE` (unreadable file
  fails closed) → `AI_BRIDGE_ADMIN_TOKEN` → `AI_BRIDGE_TOKEN`; stored in
  memory only. `_request()` strips any token/secret/password/api-key-like
  query parameter (token never in a URL), sends the token only as
  `Authorization: Bearer` (+ legacy `X-Admin-Token`) headers, redacts the
  token value from error messages and `details` (`_redact()`), and
  `__repr__` shows `token='***'`. Unused `import httpx` removed; the
  docstring's hard-coded prod host changed to `http://127.0.0.1:8000`.
  `.token` attribute is unchanged (existing test asserts `sdk.token ==
  "test-token"`).
- **Tests:** token never appears in URL/repr; server echo of the token in a
  500 body is redacted from message and details.

## 8. F-04-20 — signed updates in-function — DONE (no path exists; gate added)

- **Finding:** no update path exists in this track's seven files (verified by
  grep: no `git checkout`/fetch, no download-and-apply, no
  `update_fleet_agent` in `client.py`, `terminal_manager.py`,
  `browser_tools.py`, `browser_isolation_os.py`, `control/mcp_client.py`,
  `vision.py`, `policy_simulation.py`). The only download,
  `browser_download_file`, writes a user-requested file to the workspace and
  executes/applies nothing — not an update path.
- **Change:** `policy_simulation.require_signed_update()` and
  `AIBridgeClient.verify_signed_update_manifest()` delegate to
  `ai_bridge.updates.load_signed_manifest` (read-only reuse of the Ed25519
  helpers — signature verified BEFORE any fetch/download/checkout) and raise
  `PermissionError` when unconfigured or invalid. Any future update path in
  these files must call this gate first and refuse on any exception.
- **Tests:** unconfigured gate raises `PermissionError`.

## 9. F-04-13 — one locked browser context per session/device + evaluate allowlist (`browser_tools.py`) — DONE

- **Finding:** process-global singleton browser shared across sessions/devices,
  no lock; `browser_evaluate` ran arbitrary JS with no URL allowlist.
- **Change:**
  - Per-session state: module globals now describe only the **active**
    session; every other session's Playwright objects (pw/browser/context/
    page/profile/console/failed logs) live in `_BROWSER_SESSIONS`, keyed
    `session:<id>` or `device:<id>`. `_browser_session_scoped` decorator
    swaps the active session in under `_BROWSER_LOCK` (browser ops are
    serialised) and swaps back afterwards; all public `browser_*` functions
    are decorated. Callers pass `session_id=`/`device_id=` kwargs or use
    `use_browser_session()`; callers that pass nothing keep the historical
    `"default"` session. `close_browser_session()` / `close_all_browser_sessions()`
    / `list_browser_sessions()` added; `_page_info`/`browser_session_info`
    report `session_key`.
  - URL allowlist: `AI_BRIDGE_BROWSER_EVALUATE_ALLOWLIST` (comma-separated
    hosts, suffix-matched). `browser_evaluate` checks the current page URL
    against it and raises `ValueError` when disallowed. When the var is
    unset the historical allow-all behaviour remains, but
    `browser_session_info()` reports `evaluate_allowlist_configured: False`
    explicitly. `browser_navigate` / `browser_new_page` now reject
    non-`http(s)` URLs (`file:///etc/passwd` etc.).
- **Tests:** allowlist matching (exact, subdomain, suffix-attack
  `example.com.evil.com` rejected); evaluate on a disallowed URL raises and
  never calls `page.evaluate`; navigate rejects `file:` without launching;
  session swap machinery keeps two sessions' pages distinct.

## 10. FR-01 — policy simulation (`policy_simulation.py`, new) — DONE

- **Change:** `simulate_policy_decision(tool, policy, actor, device_id,
  approval_granted, is_admin, device_revoked)` calls `policy.decide()`
  directly and returns `{tool, tier, tier_name, allowed, needs_approval,
  reason, rule, actor, device_id, executed: False}` — `rule` names the
  deciding rule (e.g. `tier4_requires_approval_and_admin`). `simulate_tool_call`
  alias; `simulate_batch()` for a list of hypothetical calls. It never
  executes anything: no `dispatch()`, no task queue, no tool implementation.
- **No control endpoint** — deliberately not added (this track may not touch
  `control/app.py`). Wiring an HTTP endpoint is a **Wave 4 follow-up**.
- **Tests:** Tier 4 without approval → denied + `needs_approval`; Tier 4
  with approval + admin → allowed; denied/unknown tools; batch; `executed`
  is always False.

## 11. FR-03 — task result projection (`client.py`) — DONE (client half)

- **Change:** `project_task_summaries(tasks, preview_chars=200)` — pure
  function returning only id/task_id/name/status/device/timestamps/
  returncode plus a truncated `result_preview`; the full `result`/`output`/
  `stdout`/`stderr` text is never copied into the output.
  `AIBridgeClient.list_tasks()` + `list_task_summaries()` use it.
- **Decision on home:** the helper lives in `client.py`, not
  `policy_simulation.py` (a policy module is not a coherent home for a task
  projection) and **not** in a new `fleet_analytics.py` (see §14).
- **Follow-up (Wave 4):** server-side column projection in the control-plane
  list endpoint (`SELECT` explicit columns instead of `SELECT *`) needs a
  `control/app.py` change, outside this track. This helper is the client-side
  half only; a list fetched from the server still transits in full.

## 12. FR-07 — SDK retry behaviour (`client.py`) — DONE

- **Change:** `_request()` retries bounded (`max_retries`, default 2 → max 3
  attempts, capped at 3 retries) with exponential backoff + full jitter
  (`random.uniform(0, base * 2**attempt)`), only for retryable failures
  (429 / 5xx / network errors). Writes are retried **only** when an
  idempotency key is present, so a retry can never double-execute a
  submission. `execute()` sends an `Idempotency-Key` header (fresh UUID per
  call, or the caller's `idempotency_key=` argument); the key is passed via
  a one-shot instance attribute (`_pending_idempotency_key`) rather than a
  new `_request()` kwarg so existing subclasses/mocks overriding `_request`
  keep working (this mattered: the existing `test_ai_bridge_client_sdk`
  mock broke on the first attempt with a new kwarg — fixed without touching
  that test).
- **Tests:** 503 twice then success → 3 attempts; 4xx → 1 attempt; POST
  without a key → 1 attempt; execute sends the header (auto and explicit).

## 13. FR-05 — explicit demo-mode backend flag — DONE

- **Change:** `policy_simulation.is_demo_mode()` reads only the explicit
  opt-in env vars `AI_BRIDGE_DEMO_MODE` / `AI_BRIDGE_DEMO`; returns
  `{demo_mode, source, explicit}`. Demo is never the default.
  Re-exported as `AIBridgeClient.is_demo_mode()`. The dashboard is out of
  scope for this track; this is the backend half (an explicit statement
  instead of inferring demo from seeded data).
- **Tests:** default off; `AI_BRIDGE_DEMO_MODE=1` → on with source named.

## 14. FR-06 (error taxonomy) — DONE (small, in-scope half)

- `MCPErrorCode` enum + `MCPClientError.code` in `control/mcp_client.py`;
  `AIBridgeError.code` in `client.py` mapped from HTTP status
  (`auth`/`not_found`/`conflict`/`rate_limited`/`validation`/`server`/
  `transport`/`request`). Deliberately small: no per-tool `isError` rewrite
  of the 109 server wrappers (that is `server.py`, out of scope).

## 15. FR-08 — test-suite wiring — NOT DUPLICATED

Covered by the new tests in the other tracks, per the task. No action here
beyond `tests/unit/test_wave3c_sdk.py`.

## 16. `fleet_analytics.py` — NOT CREATED (deliberate)

No genuine analytics helper belongs in this track. The FR-03 projection is
a 30-line pure function that lives coherently in `client.py`; fleet
analytics proper (FR-13) is deferred in report 19 until PERF-04 (N+1 fleet
health), DB-07 (unbounded tables) and PERF-01 (single DB connection) land.
Creating a module for one helper would be premature scaffolding.

## 17. F-04-17 (vision.py) — VERIFIED ABSENT IN WAVE 1, FIXED HERE

- **Task premise check FAILED:** the task said Wave 1 had landed F-04-17
  ("verify it is present in vision.py, do NOT redo it"). Verification
  against the repo at commit `19747b2` shows it was **not** present:
  `vision.py` still wrote the OCR script to the predictable shared path
  `$TEMP/ai_bridge_ocr.ps1` (cached in `_OCR_PS1_CACHE`) and still invoked
  PowerShell with `-ExecutionPolicy Bypass`; no grep hit for F-04-17 in
  `analysis/wave1b-progress.md` / `wave1c-progress.md`. `vision.py` is in
  this track's file set, so the fix was implemented here rather than left
  as a known TOCTOU in a file this track owns.
- **Change:** `get_ocr_script_path()` now creates a fresh per-invocation
  random path via `tempfile.mkstemp(prefix="ai_bridge_ocr_")`, mode 0600,
  writes the module-constant script, and verifies the bytes on disk match
  the constant before returning; `run_ocr()` deletes the script in a
  `finally` block, uses `-ExecutionPolicy RemoteSigned` instead of `Bypass`,
  and redacts OCR output via `security.redact_obj` before returning it.
- **Tests:** two calls return different paths, content equals the constant,
  mode is 0600, no predictable `ai_bridge_ocr.ps1` path; `run_ocr` source
  contains `RemoteSigned` and no `"Bypass"`.

## Tests — results

Command (from repo root, venv already provisioned, nothing installed):

```
.venv/bin/python -m pytest tests/unit/test_wave3c_sdk.py -q
```

**36 passed in 1.41 s.** (New file `tests/unit/test_wave3c_sdk.py`, 36 tests.)

Neighbouring suites touching these files (same command shape, not the full
suite — parent runs that after all tracks):

```
.venv/bin/python -m pytest tests/unit/test_mcp_oauth2.py tests/unit/test_ai_api.py \
  tests/unit/test_phase8_deep.py tests/unit/test_residuals_security_platform.py -q
```

**79 passed total** across `test_wave3c_sdk.py` + those four files (12.51 s).

Pre-existing failures found while checking neighbours (verified by stashing
this track's files and re-running on pristine commit `19747b2` — all three
fail identically without this track's changes, so they are not regressions):

- `tests/unit/test_browser_intelligence.py::test_firecrawl_crawl_requires_key`
  — `ValueError` from httpx URL parsing (`:1]`); firecrawl connector, untouched.
- `tests/unit/test_execution.py::test_subprocess_linter_runs_cross_platform`
  — `No module named ruff` in this venv; environment, untouched.
- `tests/unit/test_phase1_approvals_and_vision.py::test_quick_mobile_approval_lifecycle`
  and `..._deny_lifecycle` — fail on pristine code too (parallel-track
  control-plane changes or pre-existing flakiness; this track touches
  neither the approval endpoints nor their tests).
- `tests/unit/test_phase8_deep.py::test_fleet_health_requires_operator` failed
  once in a combined run but passes in isolation both with and without this
  track's changes — order-dependent flakiness, not a regression.

One failure **was** introduced by this track and fixed without touching the
existing test: `test_ai_bridge_client_sdk` broke when `execute()` passed a new
`idempotency_key` kwarg to `_request()` (the test's mock lacks that parameter).
Fixed by passing the key via the one-shot `_pending_idempotency_key`
attribute; the test now passes unmodified.

## Files changed

| File | Change |
|---|---|
| `src/ai_bridge/control/mcp_client.py` | `MCPClient` (initialize/session/pagination), taxonomy, legacy-compatible wrappers |
| `src/ai_bridge/client.py` | Token hygiene, retries + idempotency, projection helper, demo-mode re-export, signed-update gate |
| `src/ai_bridge/terminal_manager.py` | Shell contract, SIGKILL escalation, bounded sessions/TTL/eviction |
| `src/ai_bridge/browser_tools.py` | Per-session locked contexts, evaluate allowlist, URL validation, fail-closed launch |
| `src/ai_bridge/browser_isolation_os.py` | Fail-closed sandbox, hardened bwrap argv, honest `enforced`/`seccomp` reporting |
| `src/ai_bridge/vision.py` | F-04-17 OCR hardening (random 0600 script path, RemoteSigned, redaction) |
| `src/ai_bridge/policy_simulation.py` | **New.** FR-01 simulation, FR-05 demo flag, F-04-20 signed-update gate |
| `tests/unit/test_wave3c_sdk.py` | **New.** 36 tests for the above |

## Follow-ups for the parent / later tracks

1. **F-06-13:** implement DPoP/PAR only if/when the OAuth gateway gains a PAR
   endpoint and DPoP verification; client half alone is not meaningful.
2. **F-04-11:** `execution.py:TaskRunner._kill` (SIGTERM-only) and
   `tools._run_argv` (timeout `proc.kill()`) should adopt the
   SIGTERM → grace → SIGKILL group escalation; both files are out of scope here.
3. **FR-01:** add a control-plane simulation endpoint (Wave 4; needs `control/app.py`).
4. **FR-03:** server-side column projection on the task list endpoint (Wave 4;
   needs `control/app.py`).
5. **F-04-17 note:** Wave 1 progress files do not record F-04-17 as done;
   the roadmap's "Wave 1" attribution for it appears to be wrong — worth a
   one-line correction in the wave tracker.
6. **FR-13 / `fleet_analytics.py`:** revisit only after PERF-04, DB-07, PERF-01 land.
