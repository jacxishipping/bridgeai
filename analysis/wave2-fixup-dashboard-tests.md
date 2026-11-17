# Wave 2 fixup — dashboard tests (2026-11-17)

Repo: `/home/hatch/workspace/ai-bridge-main`, on top of the Wave 2B state
(`analysis/wave2b-progress.md` §2 baseline). No commit made. No packages
installed. Only these files touched by this fixup:

- `apps/dashboard/src/tests/challenger-stress.test.ts`
- `apps/dashboard/src/tests/challenger-m1-2-stress.test.ts`
- `apps/dashboard/src/tests/tier5-adversarial.test.ts`
- `apps/dashboard/src/views/Device360View.tsx`

Explicitly untouched per task scope: `apps/dashboard/src/api.ts` and
`apps/dashboard/src/views/LiveDesktopView.tsx` (`git diff` for both is
empty; `wsAuthQuerySuffix` / `sessionWebSocketUrl` left exactly as is for
the separate stream-ticket task). No test deleted; test-case markers per
file identical before/after (challenger-stress 16, m1-2 16, tier5 35 by
`grep -cE "testCase\(|[^a-z]test\(|await test\("`).

## Result

| Run | Before | After |
|---|---|---|
| `npm test` in `apps/dashboard` (runner + `test:i18n`) | exit 1 — 407/430 passed, 23 failed; i18n not reached (`&&` chain) | **exit 0 — 430/430 passed, 3/3 i18n passed (433 total)** |
| `npm run build` | exit 0 (Wave 2B) | **exit 0, "✓ built in 8.27s"** |

Standalone suites after fix: challenger-stress 15/15, challenger-m1-2
27/27, tier5 31/31.

## How the 23 failures were decided

The Wave 2B baseline said 19 demo-default + 2 decidedBy + 1 telemetry +
1 font-mono. The actual failing list is 18 demo-gating + 1 listener
side-effect of gating + 2 decidedBy + 1 Device360 + 1 font-mono = 23.
The deciding evidence for the gating cluster: Tier 1 F3.3
(`tier1-feature-coverage.test.ts:223-229`) is the canonical D-01
contract — in Node there is no `window`, so no credentials and no demo
acknowledgement exist, and `setCurrentView()` to a demo view resolves to
`"login"` while `live` never gates. A browser-session shim
(`window` + `sessionStorage`) was considered and rejected: it would let
demo navigation succeed and break F3.3, and the store singleton is
constructed at import time. So the navigation expectations were updated
to the login-first contract, keeping each test's structure and its
non-navigation assertions (viewMeta coverage, 300-transition determinism,
listener counts) intact.

## Per-failure log

### Challenger Stress (2)

| # | Test | Root cause | Decision / change |
|---|---|---|---|
| 1 | 2.2: Resolve APR-4891 as approved | Expectation `decidedBy: 'operator:sarah.j'` vs store. `resolveApproval()` stamps `decidedBy: "operator:admin"` (`dashboardStore.ts:1233`); `operator:sarah.j` only appears as the seed request *invoker* (`dashboardStore.ts:406,454`). | **Expectation updated** — `challenger-stress.test.ts:119`: `'operator:sarah.j'` → `'operator:admin'`, with comment. |
| 2 | 4.1: Store notification fires listeners on state change | D-01 side effect, not a store bug: `setCurrentView('live-desktop-studio')` from `login` gates to `login`, and `setCurrentView` correctly does not notify on a no-op (`dashboardStore.ts:1108-1110`, `if (currentView === gated) return`). Listener count stayed 0. | **Test updated (not weakened)** — `challenger-stress.test.ts` 4.1 rewritten to drive a real change via never-gated `'live'` (login→live fires), use state-relative values for device/palette/auto-poll so the counts don't depend on earlier suites, keep all 4 count assertions + the no-change and unsubscribe assertions, assert the gated `overview`→`login` resolution, and restore pre-test state afterwards. |

### Challenger M1.2 (15)

| # | Tests | Root cause | Decision / change |
|---|---|---|---|
| 3 | 1.1: All 15 navigation routes can be dispatched | Every demo route gates to `login` unauthenticated in Node (D-01 / F3.3). | **Expectation updated** — `challenger-m1-2-stress.test.ts` 1.1: loop now asserts each dispatch resolves to `'login'` and the reset lands on `'login'`; no-throw + deterministic-state property preserved. |
| 4–17 | 4.1–4.14: Route "overview" … "diagnostics-and-logs" dispatches cleanly | Same D-01 gating; each asserted `currentView === route`. | **Expectation updated** — same file, §4 loop: assert `currentView === 'login'`; the App.tsx `viewMeta` (title/breadcrumbs) assertion in each test is **unchanged** and still proves the route is declared. 4.15 (`login`) already passed, untouched. |

Note: M1.2 5.4 (empty-devices finding for App.tsx) already passed and
was not changed. Its finding text still names App.tsx lines 62/81/536;
Tier 5 4.5 already verifies App.tsx uses the defensive
`selectedDevice?.hostname || "srv-us-east-412"` fallback.

### Tier 5 (6)

| # | Test | Root cause | Decision / change |
|---|---|---|---|
| 18 | 1.1: Sequential bi-directional traversal (300 transitions) | D-01 gating (as above). | **Expectation updated** — `tier5-adversarial.test.ts` 1.1: every dispatch asserts `'login'`; 10-round × 15-view × 2-direction structure unchanged; final reset asserts `'login'`. |
| 19 | 1.2: High-velocity pseudo-random route jumping (100 transitions) | D-01 gating. | **Expectation updated** — same file, 1.2: every jump asserts `'login'`; final reset asserts `'login'`. |
| 20 | 1.6: Boundary route input handling | Only the reset failed: invalid view passes through the gate unchanged (still asserted), but reset to `overview` gates to `login`. | **Expectation updated** — same file, 1.6: invalid-view assertion kept; reset assertion `'overview'` → `'login'`. |
| 21 | 3.4: Simultaneous resolution of multiple pending approvals | Same decidedBy mismatch as #1 (`dashboardStore.ts:1233`). | **Expectation updated** — same file, 3.4: `'operator:sarah.j'` → `'operator:admin'`, with comment. (Passes whether approvals are still pending or were already resolved by challenger-stress 2.2–2.4, since re-resolution is a no-op.) |
| 22 | 4.6: White-box analysis: unhandled empty devices array in Device360View | **Real bug, partially pre-fixed**: telemetry was already `selectedDevice?.telemetry || {...}` (`Device360View.tsx:122`), but the render still dereferenced `selectedDevice.platform/hostname/arch/status/osRelease/latencyMs` unguarded (lines ~549–576, 832), so `devices === []` throws in render. The old test *asserted the bug exists* (`assert.ok(source.includes('const telemetry = selectedDevice.telemetry;'))`), so it failed once the telemetry line was fixed. | **Component fixed + test rewritten** — `Device360View.tsx`: added an `if (!selectedDevice)` early return (after all hooks) rendering a "No device available" empty state with a "View fleet inventory" button (`setCurrentView("devices")`). Test 4.6 rewritten to assert the fix: no unchecked `selectedDevice.telemetry`, optional-chaining telemetry read, `if (!selectedDevice) {` guard before the first JSX dereference (`>{selectedDevice.hostname}<`), empty-state text present; the empirical "unguarded access throws" demo is kept as the justification for the guard. First version of the rewritten test failed on a bad substring check (`{selectedDevice.hostname}` also matches inside `${...}` template literals in guarded handlers); fixed the check to the JSX form. |
| 23 | 5.7: Monospace font token consistency across operational views | **Test false positive, decided from the code (test corrected, no component change)**. Two top-level view files contain no literal `font-mono`: `LoginView.tsx` and `OverviewView.tsx`. `LoginView.tsx` is the sign-in screen — it renders no operational metrics or codes (its only `<code>` is the control-plane origin URL label), so the invariant genuinely does not apply to it. `OverviewView.tsx` *does* render metrics in monospace, but through the shared `ProductMetricCard` (string values render `font-mono` in `src/ui.tsx:87`) and `ProductModePill` (`font-mono` in `src/ui.tsx:224`); the source-text scan could not see through the component boundary. `LoginView.tsx` / `OverviewView.tsx` were outside this task's allowed files, so adding a token there was not an option. | **Test corrected (not weakened)** — same file, 5.7: `LoginView.tsx` excluded as non-operational with a comment; a view now passes if it contains `font-mono` **or** renders a shared component that renders `font-mono` (`ProductMetricCard`, `ProductModePill`); every other view still must contain the literal token. |

## Counts

- Tests updated (expectation to the D-01 / `operator:admin` contract): 21
  (challenger 2.2, challenger 4.1, m1-2 1.1 + 4.1–4.14, tier5 1.1, 1.2,
  1.6, 3.4).
- Components fixed: 1 (`Device360View.tsx` empty-state guard).
- Tests rewritten to assert the fix / correct a false positive: 2
  (tier5 4.6, tier5 5.7).
- Tests deleted: 0. Total stays 430 (runner) + 3 (i18n).

## Caveats / follow-ups (not fixed here)

- The positive D-01 path (explicit "Explore demo workspace" entry from
  the login screen, then demo navigation succeeds) cannot be exercised
  in Node — it needs a real browser `sessionStorage`. It is only covered
  by the Tier 1 F3.3 negative contract in this runner; a browser/E2E
  check remains the way to verify it.
- M1.2 5.4's finding text still says App.tsx lines 62/81/536 "assume
  devices is non-empty" even though Tier 5 4.5 verifies the defensive
  fallback there; that test passes as a historical finding record and
  was left alone.
- `git status` also shows concurrent Wave 2A modifications
  (`src/ai_bridge/...`, `windows-agent/...`, `magic-install.sh`); none
  are this fixup's. The `tsconfig.tsbuildinfo` churn from `npm run
  build` was restored with `git checkout`.
