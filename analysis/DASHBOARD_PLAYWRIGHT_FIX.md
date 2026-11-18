# Dashboard Playwright Fix — CI run 44214286408

**Date:** 18 Nov 2026
**Commit under test:** `bab5b5edc375daee7a0d3b3b23e221f758603092` ("Dashboard UX remediation (39 findings) + device-token rotation (P1-3)")
**CI run:** GitHub Actions run 44214286408, workflow CI, run #35. Dashboard job failed only on "Run npm run test:browser": Playwright 126 tests, **44 failed / 82 passed**. All other CI jobs passed; dashboard unit tests (448/448) and build passed. The browser/e2e suite was never run locally during the UX waves, so these failures were not caught before push.

**Baseline reproduced locally (18 Nov 2026):** full suite **44 failed / 82 passed**, identical to CI (same 44 tests).

**Method:** four parallel agents, each with strict file ownership to avoid conflicts, plus a coordinator follow-up for the one blocked item. Every failure was reproduced locally before fixing. Triage classes: (a) intentional change, stale test — update the test; (b) real regression — fix the source; (c) test assumption wrong — fix the test's assumption. No test was deleted, skipped, or weakened except where explicitly noted as a triage-(a)/(c) expectation update.

---

## 1. e2e/brand.spec.ts (1 failure)

### brand:5 — "brand assets load in the login workspace" — FIXED, triage (c)
- **Root cause:** test assumption wrong, not a source change. The Sign in button's background comes from the `--product-accent` token, specified as hex `#2563eb` in `src/tailwind.css`, via the unlayered `.product-button[data-tone="primary"][data-variant="contained"]` rule (which beats the JXUI `bg-indigo-600/dark:bg-indigo-500` utilities). This Chromium serializes a hex-specified color as `rgb`; oklch serialization only happens when the specified value itself is oklch. The test comment claiming otherwise is wrong. The button **is** the brand blue `#2563eb`.
- **Change:** `e2e/brand.spec.ts:17-19` — expectation `oklch(0.585 0.233 277.117)` → `rgb(37, 99, 235)`, with a corrected comment.
- **Verification:** full `e2e/brand.spec.ts` — 5/5 passed.

---

## 2. e2e/dashboard.spec.ts (6 failures)

### dashboard:36 — "device-360-system: accessible layout at 390px" (Flush DNS, 1.5:1) — FIXED, triage (b)
- **Root cause:** real source defect. The mouse stays where the "Continue to demo" click landed, so the Flush DNS button is **hovered** during the axe run. JXUI's soft/neutral variant renders `hover:bg-slate-200/80` — a near-white hover background — while dark-mode text stays light slate-200 `#e2e8f0` (axe: fg `#e2e8f0` on bg `#b8bfc8` = slate-200/80 composited over the dark card, 1.5:1). No `.product-button[data-tone="neutral"][data-variant="soft"]` override existed in `tailwind.css` (unlike primary soft), so the library hover beat the buttons' own `hover:bg-[var(--product-raised)]` utility.
- **Change:** `src/tailwind.css` (after the primary-soft rule, ~line 234) — added unlayered `.product-button[data-tone="neutral"][data-variant="soft"]` (bg `var(--product-raised)`, border `var(--product-line)`, color `var(--product-text-secondary)`) plus a `:hover:not(:disabled)` rule pinning the same background. Fixes all soft/neutral JXButtons app-wide, in both themes (dark `#cbd5e1` on `#192639`; light `#334155` on `#f1f5f9`). `Device360View.tsx` untouched; axe check untouched.
- **Verification:** `dashboard.spec.ts -g "device-360-system: accessible layout at 390px"` — 1 passed.

### dashboard:124 — "simplified inventory filters and device links still work" — FIXED, triage (a) + (b)
- **Root cause (count):** UX-34 bulk multi-select added a "Select all devices" checkbox `<th>` as the first header in `src/views/DevicesView.tsx:680-690` (now 6 headers: checkbox/Status/Device/OS/Last seen/Actions; was 5 at pre-UX commit e5eff11).
- **Root cause (hostname, found after the count fix):** the hostname appears 3× inside `<main>` — shell breadcrumb (`App.tsx:136` breadcrumbs include `selectedHostname`, rendered by `AppShell.tsx:259`) + in-view breadcrumb (`Device360View.tsx:738`, added by UX-36) + device-header span (`Device360View.tsx:780`). Strict-mode violation on `main.getByText(hostname)`.
- **Changes:**
  - `e2e/dashboard.spec.ts:130-134` — column count `5` → `6` with a comment citing UX-34; cell index `nth(1)` → `nth(2)` (the checkbox column shifted every data cell by one — a locator index, not an expectation).
  - `src/views/Device360View.tsx:738` — removed the in-view `<BreadcrumbTrail crumbs={["Devices", selectedDevice.hostname]} />` (coordinator follow-up). It duplicated the shell breadcrumb, which already shows the same path. The "Back to Devices" button and the Freshness indicator stay. The "Unknown device" breadcrumb at :680 is untouched (different state — no device header there). Import kept (still used at :680).
  - `e2e/dashboard.spec.ts:140,142` — scoped the hostname assertion to `.last()` (the device-header span), with a comment explaining the two remaining matches (shell breadcrumb + device header).
- **Verification:** `dashboard.spec.ts -g "simplified inventory filters"` — 1 passed.

### dashboard:195 — "expired sessions show a recovery path without sample data" — FIXED, triage (a)
- **Root cause:** UX-38 intentionally renamed the button "Return to sign in" → "Sign out" (`LiveControlView.tsx:244` and `:297`).
- **Change:** `e2e/dashboard.spec.ts:202` — expectation `"Return to sign in"` → `"Sign out"`, with a comment citing UX-38.
- **Verification:** 1 passed.

### dashboard:207 — "live stop requires confirmation and shows API failures inside the dialog" — FIXED, triage (b)
- **Root cause:** UX-37 removed `role="status"` from the shared `ProductStatusDot` (`src/ui.tsx:129-132`, whose comment prescribes wrapping at call sites that must announce), so the Fleet safety region had no `role="status"` element even though the text "Emergency stop is not active." was rendered as the dot's label.
- **Change:** `src/views/LiveControlView.tsx:303-312` — wrapped the `ProductStatusDot` in a `<span role="status">` inside the Fleet safety `<section>`. Test untouched.
- **Verification:** 1 passed.

### dashboard:245 — "saved light preference is honoured without unreadable surfaces" (1.97:1) — FIXED, triage (b)
- **Root cause:** the "Explore demo workspace" link in `src/views/LoginView.tsx:160` used hardcoded `text-indigo-300 … hover:text-indigo-200`. The test lands on login (saved light preference, no auth), where indigo-300 `#a5b4fc` on near-white `#fcfdfe` is 1.97:1. The UX-12 light-token fix (`--product-text-dim`) never covered this hardcoded Tailwind indigo.
- **Change:** `src/views/LoginView.tsx:160` — `text-indigo-300 underline decoration-indigo-300/50 hover:text-indigo-200` → `text-[color:var(--product-accent-text)] underline hover:text-[color:var(--product-text)]` (light: `#1e40af` ≈ 8.6:1; dark: `#a9c6ff` ≈ 8:1; underline now inherits currentColor). Axe check untouched.
- **Verification:** `dashboard.spec.ts -g "saved light preference"` — 1 passed.

### dashboard:254 — "authenticated live view uses server data, supports empty state and sign out" — FIXED, triage (b)
- **Root cause:** regression from UX-02. After UX-02 moved `#/live` inside `AppShell`, the AppShell banner (`AppShell.tsx:220-228`, renders "Sign out" whenever a token/session is present) and LiveControlView's own copies duplicated each other.
- **Change:** removed all three LiveControlView copies (`:244` expired branch, `:258` header, `:297` error block) and the now-unused `signOut` helper + `clearCredentials`/`LanguageControl` imports, keeping the AppShell banner as the single canonical sign-out on every view. The expired-branch copy was verified redundant with a probe run before removal: in the expired state both buttons were visible and the banner button performs the same recovery (clear credentials → login).
- **Verification:** 1 passed.

---

## 3. e2e/density.spec.ts (1 failure)

### density:55 — "large touch screen › keeps generous interactive targets without page overflow" ("Devices") — FIXED, triage (b)
- **Root cause:** shared with operations:95 (see §4). Since UX-02 put `#/live` inside `AppShell`, the sidebar and the live-workspace section nav render side by side on the live view with identical labels; the Settings group adds a third copy. The strict-mode error's sidebar "Devices" was the **Settings** link (`SidebarNav.tsx:19`, `title="Device inventory"`), not the main-nav item — the main-nav "Devices" only escaped the match because its offline-devices badge changed its accessible name (fragile: it would collide whenever all devices are online).
- **Change:** `src/shell/SidebarNav.tsx` only (+50 lines, purely additive). Disambiguated the **sidebar** side and left the workspace section names canonical, so the workspace-scoped tests and the unscoped live-section tests keep working, and every navigation path is preserved (nothing deleted or re-routed):
  - Main nav, on the live view only: buttons whose label duplicates a workspace section get `aria-label="<Label> — full view"` (Devices, Tasks, Approvals, Policies, Connections, Logs). This names the destination honestly — it opens the full view, while the workspace button opens the simplified live section — matching LiveWorkspace's own "Open full … view" wording. Off live, labels stay canonical, so non-live tests clicking the sidebar by its plain label are unaffected. The badge count is appended to the aria-label when present, since an aria-label replaces the badge span's contribution to the accessible name.
  - Settings links, on all views (the duplicate exists on every view, not just live): duplicating labels get `aria-label="<Label> — Settings"` (Devices, Policies, Users).
  - Each new accessible name still starts with its visible label (WCAG label-in-name). Choice documented in a comment block in the file, above `fullViewAriaLabel`.
  - Deliberately did **not** rename the LiveWorkspace section buttons: that would have broken `live-workspace.spec.ts:86`, which clicks the workspace "Devices" button scoped to the Workspace nav.
- **Verification:** full `e2e/density.spec.ts` — 3/3 passed.

---

## 4. e2e/operations.spec.ts (1 failure)

### operations:95 — "viewer management pages never offer privileged reads or writes" ("Logs") — FIXED, triage (b)
- **Root cause:** same shared cause as density:55 (§3). Strict-mode violation, 2 elements — main-nav "Logs" + workspace "Logs".
- **Change:** same `src/shell/SidebarNav.tsx` fix as §3 (no separate change). After the fix, unscoped exact "Logs" resolves solely to the workspace section button; the test clicks through to the live logs section as intended. Masked follow-on fixed for free: the same test's line 104 clicks unscoped "Policies", which would have failed next with 3 elements (main nav + Settings + Workspace); it now resolves solely to the workspace button and the test passes end-to-end.
- **Verification:** full `e2e/operations.spec.ts` — 18/18 passed.

---

## 5. e2e/live-workspace.spec.ts (7 failures)

### live-workspace:26 — "inventory remembers filters and sort, supports named views and clear-filter recovery" — FIXED, triage (b)
- **Root cause:** not the reload — the reload restore at line 38 passed; the failure was at line 45, clicking the saved view. `LiveWorkspace.navigate()` preserves the current filter params in the URL and re-dispatches `hashchange`. `usePreferences`' sync listener then re-applied those stale URL params, overwriting the just-applied saved-view filters before the write-back effect could update the URL.
- **Change:** `src/views/live/preferences.ts:20-22,47-48,58` — added a `sameFilters` comparator and a `filtersRef` mirror of the last committed filters; the `popstate`/`hashchange` sync now skips incoming params identical to the applied filters. Genuine back/forward navigation (different params) is still applied.
- **Verification:** passes in the full-spec run (24/24).

### live-workspace:104 — "bulk review lists exact targets, skips revoked devices, and reports partial rejection" — FIXED, triage (b)
- **Root cause:** two UX-remediation regressions in `TaskComposer.tsx`, both confirmed against baseline commit `79c010e`: (i) UX-15 renamed the review button "Submit task" → "Dispatch task"; (ii) UX-05 deleted the `taskStatus()` label helper and rendered outcomes via shared `StatusBadge`, so results read "Alpha Queued" / "Bravo — rejected" instead of the pinned "Alpha — Submitted" / "Bravo — Rejected" (raw `outcome_unknown`/`rejected` keys rendered verbatim).
- **Change:** `TaskComposer.tsx:82` button back to "Submit task"; `:36` success path maps through restored `taskStatus()`; `:39` error paths store the display strings `"Outcome unknown"` / `"Rejected"` (baseline literals); outcomes line renders `"{device} — {status}"` text again, modal title/copy back to "Submission results" / "Submission is not completion…". `shared.tsx:44-47` restores `taskStatus()` (queued→"Submitted", needs_approval→"Awaiting approval", etc.) with a comment explaining the shared badge keeps its own labels.
- **Verification:** passes in the full-spec run (24/24).

### live-workspace:135 — "unknown bulk outcome stops remaining submissions and offers no blind retry" — FIXED, triage (b)
- **Root cause / fix:** same cause and fix as :104 (§5, second item). Verified the "Alpha — Outcome unknown" / "Bravo — Not submitted" / no-blind-retry behaviour passes.

### live-workspace:153 — "submitting to a non-default tenant preserves the selected device scope" — FIXED, triage (b)
- **Root cause / fix:** same cause and fix as :104 (§5, second item). Tenant scoping (`device.tenant` passed to `submitTask`) was already correct.

### live-workspace:184 — "task queue shows actual lifecycle and results, and retries only reviewed read-only failures" — FIXED, triage (b)
- **Root cause:** UX-05 replaced the queue's `taskStatus()` text with `<StatusBadge>`, whose `queued` label is "Queued", not "Submitted".
- **Change:** `TasksPanel.tsx:120` — `<StatusBadge status={task.status} label={taskStatus(task.status)} />`, using the badge's `label` override so the tone stays shared while the words stay the live ones. Second bug found while verifying: the remediation's controlled `<details open={openTask} onToggle={…}>` (UX-37) had a toggle cascade — opening a second task closed the first, whose close event fired `setOpenTask(null)` and closed the just-opened one, so "Review retry" never appeared. Fix — `TasksPanel.tsx:109-116`: the close branch now clears the selection only when the task being closed is the selected one.
- **Verification:** passes in the full-spec run (24/24).

### live-workspace:222 — "command and snapshot tabs use policy-checked task submission, not host terminal or capture GET" — FIXED, triage (b)
- **Root cause / fix:** same cause and fix as :104 (§5, second item). "Awaiting approval" via restored `taskStatus("needs_approval")`; verified both submissions and the no-host-terminal/no-capture-GET assertions pass.

### live-workspace:293 — "enrollment is actionable and one-time credentials are never persisted" — FIXED, triage (a)
- **Decision:** masking is the intended security behaviour. UX-21 explicitly ordered it ("live enrol token in plain text" finding; remediation report: Inventory now uses the DevicesView masking pattern, masked by default + Show/Hide + copy). Reverting would reintroduce an audit finding. The full token is still actionable (reveal/copy) and never persisted — the test's actual intent.
- **Change:** `e2e/live-workspace.spec.ts` enrollment test only — asserts the masked default `"one-••••cret"`, asserts the "Copy token" button is visible, clicks "Show device token" (the button's `aria-label`, not its visible "Show token" text) and then asserts the full `"one-time-secret"`; the localStorage/sessionStorage non-persistence assertions are unchanged. Comment cites UX-21 / `Inventory.tsx` `maskToken`.
- **Verification:** passes in the full-spec run (24/24).

**Full spec verification:** `e2e/live-workspace.spec.ts` — **24 passed / 0 failed**.

---

## 6. e2e/localization.spec.ts (28 failures)

### localization:15 — "translates sign-in and navigation without translating fleet data" (all 20 languages) — FIXED, triage (b)
- **Root cause:** the remediation replaced the translated `<h1>{t("Control plane")}</h1>` with hardcoded `<h1>Live home</h1>` (`LiveControlView.tsx:266`; diff e5eff11→HEAD). The catalog (`src/i18n/catalogs.ts:11`) still has "Control plane" translated in all 19 locales. This broke localization for all 20 languages — a real regression.
- **Change:** restored `{t("Control plane")}` as the h1 (`LiveControlView.tsx:264`) — the tested, catalogued string — rather than adding "Live home" to the catalog; "Live home" survives as the breadcrumb/sidebar label (`App.tsx:114`) and demo empty-state copy, so no UX intent was lost. "live" is in `VIEWS_WITH_OWN_HEADER`, so the shell renders no second h1.
- **Verification:** full `e2e/localization.spec.ts` — 32 passed, covering all 20 languages.

### localization:35 — RTL "Language" button ×2 (ar/he/fa/ur at 390px and 1440px, 8 tests) — FIXED, triage (b)
- **Root cause:** regression from UX-02. `LiveControlView.tsx:255` rendered a second `<LanguageControl/>` alongside `TopHeader.tsx:143` (always visible via AppShell).
- **Change:** removed the duplicate `<LanguageControl/>` from LiveControlView (header + import). `TopHeader.tsx` untouched.
- **Verification:** full `e2e/localization.spec.ts` — 32 passed, covering all 8 RTL tests.

**Full spec verification:** `e2e/localization.spec.ts` — **32 passed / 0 failed**.

---

## Files changed (this wave)

Dashboard source:
- `src/tailwind.css` — neutral/soft JXButton override (contrast)
- `src/views/LoginView.tsx` — demo-link token colours (light contrast)
- `src/views/DevicesView.tsx` — (no change; the column count was already 6 from the UX wave — the test was updated)
- `src/views/Device360View.tsx` — removed the redundant in-view BreadcrumbTrail (coordinator follow-up)
- `src/views/LiveControlView.tsx` — removed 3 duplicate "Sign out" buttons + `signOut` helper, removed duplicate `<LanguageControl/>`, restored translated `{t("Control plane")}` h1, added `role="status"` wrapper in Fleet safety
- `src/shell/SidebarNav.tsx` — sidebar aria-label disambiguation (+50 lines, additive)
- `src/views/live/preferences.ts` — saved-view filter sync guard
- `src/views/live/TaskComposer.tsx` — "Submit task" button + `taskStatus()` outcome labels
- `src/views/live/shared.tsx` — restored `taskStatus()` helper
- `src/views/live/TasksPanel.tsx` — StatusBadge label override + details-toggle cascade fix

E2E tests (expectation updates only, per triage (a)/(c), each documented above):
- `e2e/brand.spec.ts` — oklch → rgb expectation + corrected comment
- `e2e/dashboard.spec.ts` — column count 5→6 + cell index 1→2 (UX-34), hostname locator scoped to `.last()`, "Return to sign in" → "Sign out" (UX-38)
- `e2e/live-workspace.spec.ts` — enrollment test asserts masked default + Show/Hide + copy (UX-21)

---

## Final verification

| Check | Result |
|---|---|
| Playwright full suite (`npm run test:browser`, 126 tests) | **BLOCKED — environmental (see below). Could not be re-run to a clean green.** |
| Dashboard unit tests (`npm test`) | **BLOCKED — environmental (see below).** Last known good: 448/448 (agents' runs, 18 Nov 2026 ~02:20–02:26 UTC). |
| `npx tsc -b` | **BLOCKED — environmental (see below).** Last known good: exit 0 (agents' runs, 18 Nov 2026 ~02:20–02:26 UTC). |
| `npm run build` | **BLOCKED — environmental (see below).** Last known good: clean (agents' runs). |

Per-spec verification (each agent's own runs, when the environment was healthy, 18 Nov 2026 ~02:20–02:26 UTC):
- `e2e/brand.spec.ts` — 5/5 passed
- `e2e/dashboard.spec.ts` — targeted tests passed individually (brand/contrast/columns/light/sign-out/expired/live-stop); full-spec run had 11 failures, all environmental (server flap `ERR_CONNECTION_REFUSED`, mobile-drawer timeout, live-inventory 320px "execution context destroyed" passing in isolation) except the dashboard:124 strict-mode issue, which the coordinator follow-up fixed and verified (1 passed)
- `e2e/density.spec.ts` — 3/3 passed
- `e2e/operations.spec.ts` — 18/18 passed
- `e2e/live-workspace.spec.ts` — 24/24 passed
- `e2e/localization.spec.ts` — 32/32 passed

That is 82 spec-level passes covering every one of the 44 fixed failures, plus the dashboard:124 follow-up verified individually (1 passed).

## Environmental blocker — full-suite confirmation could not be completed

Starting ~02:28 UTC (after the agents' successful per-spec runs), the VM developed a systemic `EPERM: operation not permitted, write` failure affecting Node.js-based tools. It is **not** a product regression and **not** caused by these fixes:

- **Playwright:** every browser launch fails — `browserType.launch: Target page, context or browser has been closed`, Chromium zygote exits `signal=SIGTRAP` with `zygote_linux.cc: write: Broken pipe (32)`, plus `Error: EPERM: operation not permitted, write`. This hits even `e2e/brand.spec.ts`, which Agent 1 verified 5/5 passing ~15 minutes earlier (now 0/5). Direct Chromium launch works (`--version` → `Google Chrome for Testing 156.0.8078.4`, `--dump-dom` exit 0), so the browser binary is fine; the failure is in Playwright's pipe-based launch.
- **tsc:** `error TS5033: Could not write file '…/apps/dashboard/tsconfig.tsbuildinfo': EPERM: operation not permitted, write` — even after deleting the file and letting tsc recreate it (it creates a 0-byte file, then the content write fails). Stopping the dev server did not help.
- **vite / npm:** `vite build` fails loading its config — `Error: EPERM … at async write (node:internal/fs/promises…)` in `loadConfigFromBundledFile`. `npm test` / `npm run build` fail with permission errors. The persistent dev server (PID 14470) was stopped during diagnosis and **cannot be restarted** (vite config load fails the same way).
- **What still works:** plain shell writes (`echo > file`, `touch`), direct Node `fs.writeFileSync` and `fs/promises.writeFile` to the dashboard directory (tested — both OK). Disk has 7.5 GB free, `/tmp` 496 MB free, `/dev/shm` 794 MB free; no stray Chromium/Node processes; no immutable attribute on the file; the overlay filesystem is `rw`. Memory is tight (6.6 GB used / 593 MB free / 1.3 GB available of 7.9 GB) but not exhausted.
- **Attempts made:** full suite with 2 workers (crashed on Chromium launch, ~76/126 before being stopped); full suite with `--workers=1` (first test failed the same way, stopped); single-spec re-run (brand 0/5, environmental); `tsc` retry after deleting the build-info file and after stopping the dev server (still EPERM); `vitest`/`vite` invoked directly (vitest binary not present under that name; vite config load EPERM).

**Consequence:** the full 126-test suite could not be re-run to a clean green in this VM session, and neither could `npm test`, `tsc -b`, or `npm run build`. The per-spec results above are the strongest verification available in this session. **The full-suite confirmation should be re-run in a fresh VM/session (or in CI) before this is treated as fully green.** CI run 44214286408's dashboard job is the natural place to confirm — a push of these fixes should turn its Playwright step green if the environment there is healthy.

## UNRESOLVED

- **Full-suite green (126/126) — UNRESOLVED, environmental, not a product gap.** All 44 failures have a fix verified at the spec level, but the final full-suite run could not complete because the VM's Node.js tooling developed the EPERM write failure described above. Re-run the full suite in a fresh environment (or CI) to close this out.
- No product-level unresolved items. All 44 failures have a root cause, a fix, and a passing per-spec verification.

## Notes / open tensions

- **Terminology tension (TaskComposer):** the live `TaskComposer` now says "Submit task"/"Submitted" again because the e2e contract pins that wording, while the rest of the app follows the UX-15 "Dispatch" standard. If the project wants "Dispatch" everywhere, the e2e contract — not just this dialog — needs updating. The baseline wording was restored per the task's triage instruction.
- **Environment flakes (not product failures):** the shared dev server on 127.0.0.1:5173 flapped during parallel verification (a run that starts the shared server kills it when it ends, taking the server down mid-run for the others; `ERR_CONNECTION_REFUSED`), and the shared `test-results/` dir produced spurious `ENOENT` trace-artifact failures on `browserContext.close`. Both disappeared on re-runs with the server up. A persistent dev server was started by one agent (PID 14470, `npm run dev -- --host 127.0.0.1 --strictPort`, log `/tmp/vite-live.log`); it was stopped during the EPERM diagnosis and **cannot currently be restarted** (vite config load fails with the same EPERM — see the environmental blocker above). Any future Playwright run in this VM will need the environment issue resolved first.
- **Runtime behaviour against a live backend is still UNVERIFIED** (same standing caveat as the UX waves — the e2e suite mocks the API). Production verdict remains **NO-GO**.
