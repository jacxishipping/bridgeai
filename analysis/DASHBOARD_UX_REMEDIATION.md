# Dashboard UX Remediation Report

**Date:** 18 Nov 2026
**Repo:** `~/workspace/ai-bridge-main/` — local HEAD `e5eff11` (plus the uncommitted changes below); GitHub main `40a3ba9d`
**Dashboard:** `apps/dashboard/` — React 18 + TypeScript + Vite + Tailwind 4
**Source audit:** `analysis/DASHBOARD_UX_AUDIT.md` (18 Nov 2026, 39 findings UX-01..UX-39)
**Scope:** Dashboard source only (`apps/dashboard/src/**` and its tests). Backend untouched; no deployment; nothing run against production or any live device. Two findings call existing backend endpoints from the dashboard only (UX-01: `GET /api/audit/verify`, `POST /api/audit/retention`; UX-31: `POST /api/policy/simulate`).
**Method:** James's instruction "start fixing from first to final" — findings implemented in order UX-01 → UX-39. Batch 1 built the shared foundations (StatusBadge, ConfirmDestructive, notice system, sync state, API wrappers, tokens, i18n); Batch 2 ran seven view agents with disjoint file ownership; the coordinator then reconciled the combined tree, fixed two cross-agent regressions, updated two tests that pinned behaviour the audit explicitly ordered changed, and verified the whole tree.

**Line numbers** are as of the final state below and may shift by a few lines as files evolve; file paths and feature locations are the stable reference.

## Final verification (combined tree, 18 Nov 2026 ~00:45 UTC)

| Check | Result |
|---|---|
| `npx tsc -b` (apps/dashboard) | **exit 0** — zero errors |
| `npm test` (full suite) | **430/430 pass** (Tier 1 155/155, Tier 2 155/155, Tier 3 10/10, Tier 4 10/10, Tier 5 31/31, Challenger 43/43, Requirements 26/26) |
| `npm run test:i18n` | **4/4 pass** |
| `npm run build` (`tsc -b && vite build`) | **clean** (built in ~7 s) |
| `window.confirm` / `window.prompt` in `src/` | **zero calls** (only two doc comments saying never to use them) |
| Changed files | **47 modified + 2 new** (`src/state/notices.ts`, `src/components/NoticeStack.tsx`); +6,206 / −2,404 lines |

## Status tally

| Status | Count | Findings |
|---|---|---|
| **FIXED** | **29** | UX-01, 02, 03, 04, 05, 07, 08, 09, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 26, 27, 28, 30, 32, 33, 34, 35, 36 |
| **PARTIAL** | **10** | UX-06, 13, 23, 24, 25, 29, 31, 37, 38, 39 |
| **DEFERRED** | 0 | — |
| **NOT APPLICABLE** | 0 | — |

No finding was deferred outright. The ten PARTIALs are all "core done, named residual remains" — each residual is listed in its entry. Two findings the view agents had left as DEFERRED (UX-36, duplicate-h1 dependency on `App.tsx`) were resolved in the coordinator's final pass (see §"Final-pass reconciliation").

## Shared foundations (Batch 1 — used by every finding below)

| Piece | Location | What it is |
|---|---|---|
| `StatusBadge` + `STATUS_TONES` + `normalizeStatusKey` | `src/ui.tsx` | One status → tone map (emerald success, cyan running, rose failed, amber warning/pending, indigo info only); case-insensitive; unknown → neutral. Covers queued/running/completed/failed/cancelled/pending/pending_approval/approved/denied/online/offline/degraded/revoked/unknown/draft/active/paused/aborted/skipped/success/error/warning/info/neutral |
| `ConfirmDestructive` (+ `HoldToConfirmButton`, 1200 ms) | `src/ui.tsx` | GlassModal-based confirm with object name, consequence, confirm label; `requireHold=true` swaps in hold-to-confirm for Tier 3/4 and "Unrestricted" |
| `EmptyState` (variants `card` / `bare`) | `src/ui.tsx` | Single empty-state component, modelled on PageEmpty + live Empty |
| Notice system | `src/state/notices.ts` (new), `src/components/NoticeStack.tsx` (new) | `pushNotice({ tone, title, message?, actionLabel?, actionHref? })`; success/info auto-dismiss 5 s, warning/error persist; all have an X; `role="status"` / `role="alert"`. Mounted once in `App.tsx` on all three branches (login / live / shell) — do not mount again |
| Sync state | `src/state/dashboardStore.ts`, `src/types/dashboard.ts` | `syncState: "loading" \| "live" \| "error"`, `lastSyncAt`, `syncError`, `getSyncState()` ("stale" when live but last sync > 30 s ago; `SYNC_STALE_AFTER_MS = 30_000`); `syncWithBackend()` sets loading → live/error. Caveat: initial state is "loading" and unauthenticated demo sessions never sync, so views must only render it when live-authenticated |
| API wrappers (verified against backend routers, no invented endpoints) | `src/api.ts` | `verifyAudit()` → `GET /api/audit/verify` → `{ ok, checked, broken_at, legacy_rows }`; `setAuditRetention(days)` → `POST /api/audit/retention` (days is a query param, server-clamped 30–3650; 409 WORM/SIEM-export-required / 502 export-failed with nothing deleted); `simulateTool(tool, deviceId?, approvalGranted?)` → `POST /api/policy/simulate` → `{ tool, tier, tier_name?, allowed, needs_approval, reason, rule?, actor?, device_id? }` |
| Design tokens | `src/tailwind.css` | `--product-danger` (#f87171 dark / #dc2626 light) and `--product-text-primary` (#edf2fa dark / #0f172a light) defined in both theme blocks (dark :34–35, light :84–85); light `--product-text-dim` #94a3b8 → #64748b; `.scrollbar-hide` defined |
| i18n | `src/i18n/catalogs.ts` | 5 theme strings ("Theme", "Switch to light theme", "Switch to dark theme", "Light", "Dark") translated in all 19 locales, plus "Updated" + "Stale" in all 19; new test asserts no non-English locale ships an untranslated English string (allowlist of 5 verified borrowings). Native-speaker review of translation quality still recommended |
| `Freshness` | `src/components/Freshness.tsx` | `Intl.RelativeTimeFormat` + `t()` for Updated/Stale/Refreshing/Not loaded; absolute tooltip via `useLanguage().date` |

**Terminology standard applied across all fixes (UX-15/UX-38):** **device** for the enrolled computer; **host** only for the control-plane process host; **client** only for OAuth/MCP clients; **task** = one tool invocation on one device; **workflow** = multi-step sequence; **schedule** (not "job") = a cron/trigger; **command** only for the literal shell string inside a task. Verb: **Dispatch** (or Run). One canonical label per destination in nav/title/breadcrumb/palette.

---

## Per-finding status

### UX-01 — "Check verification" always reports failure [P0] — FIXED
- **What changed:** `src/api.ts` — `verifyAudit()` (`GET /api/audit/verify`) and `setAuditRetention(days)` (`POST /api/audit/retention`) added. `src/views/AuditTrailView.tsx` (470 → 938 lines) — "Check verification" now calls the real endpoint and renders the result (valid/invalid, blocks checked, first bad block if any); retention UI added (days input, server-clamped 30–3650, 409/502 surfaced with nothing deleted). The false "no cryptographic verification available" copy is gone from the view header, the button, and the per-record modal.
- **Verification:** tsc 0; audit tests pass; i18n 4/4. Live-endpoint behaviour UNVERIFIED (needs a running control plane with a populated audit chain).
- **Deviation:** none.

### UX-02 — `#/live` has no sidebar, palette, or TopHeader [P1] — FIXED
- **What changed:** `src/App.tsx` — the `if (currentView === "live") return <LiveControlView />` bypass is gone; `#/live` now renders inside `AppShell` (sidebar + palette + TopHeader incl. emergency stop) like every other view. `src/views/LiveControlView.tsx`, `src/shell/*`, `src/state/navigation.ts` — live branch updated accordingly.
- **Verification:** tsc 0; full suite 430/430.
- **Deviation:** none.

### UX-03 — Eight destructive actions fire on a single click [P1] — FIXED
- **What changed:** All eight now route through `ConfirmDestructive` (object name + consequence): delete device / revoke credentials (`src/views/DevicesView.tsx`), delete + clear tasks (`src/views/TaskQueueVisionView.tsx`), delete approval (`src/views/HumanApprovalsView.tsx:812–821`), delete workflow / template / schedule (`src/views/WorkflowsView.tsx`), revoke OAuth client + terminate session (`src/views/ConnectionsView.tsx:1173–1186`, single dialog replacing the two-click flip), policy version delete + backup restore (`src/views/SecurityPoliciesView.tsx`), delete agent + disconnect MCP service (`src/views/AiApiHubView.tsx` — see final-pass note). Revoke vs Delete are labelled with what each does. Kill-process modal kept as the template.
- **Verification:** tsc 0; full suite 430/430. Final grep: **zero** `window.confirm` / `window.prompt` calls remain in `src/` (only two doc comments saying never to use them).
- **Deviation / final-pass fix:** the AI Hub agent left two `window.confirm` calls in `AiApiHubView.tsx` (disconnect MCP service, delete agent). The coordinator replaced both with `ConfirmDestructive` in the final pass (import :9; `deleteMcpConfirm` / `deleteAgentConfirm` state; handlers now only run from the confirm callback; dialogs rendered at the end of the component).

### UX-04 — Tier 3/4 dispatch needs no confirmation [P1] — FIXED
- **What changed:** `src/views/TaskQueueVisionView.tsx` — Tier 3/4 dispatch requires hold-to-confirm (`requireHold=true`), showing device, tool, tier, and a truncated args preview; Ctrl+Enter goes through the same confirm. `src/views/DevicesView.tsx` — the quick-dispatch modal's `run_shell` was dispatched as `tier1_safe` (a real bug); it is now `tier3_shell` with tier shown and confirm required. `src/views/SecurityPoliciesView.tsx` — "Unrestricted" policy now requires a typed `UNRESTRICTED` acknowledgement AND hold-to-confirm.
- **Verification:** tsc 0; full suite 430/430. Hold-to-confirm interaction itself UNVERIFIED (needs a browser).
- **Deviation:** none.

### UX-05 — Same semantic state styled differently per screen [P1] — FIXED
- **What changed:** Shared `StatusBadge`/`STATUS_TONES` in `src/ui.tsx` (see foundations); `getStatusBadge` deleted from `TaskQueueVisionView.tsx`, `statusClass` deleted from `WorkflowsView.tsx`, `taskStatus()` deleted from `src/views/live/shared.tsx`; all four sites + live panels migrated. Success is emerald everywhere (the Workflows "ok renders indigo" case now goes through shared `pushNotice`).
- **Verification:** tsc 0; full suite 430/430.
- **Deviation:** none.

### UX-06 — Seed data with no sync indicator; no toast system [P1] — PARTIAL
- **What changed:** `syncState`/`lastSyncAt`/`syncError` added to the store with `getSyncState()` (stale after 30 s); `Freshness` rendered in every live-view header (`AuditTrailView`, `TaskQueueVisionView`, `DevicesView`, `Device360View`, `LiveDesktopView`, `SecurityPoliciesView`, `WorkflowsView`, `HumanApprovalsView`, `ConnectionsView`, `AiApiHubView`, `DiagnosticsLogsView`); `gatewayStatus` is now read and surfaced; the DevicesView error-in-success-alert bug (dispatch error rendered inside `severity="success"`) is fixed; the single `NoticeStack` replaces the four parallel inline mechanisms for primary mutations (success 5 s, error persists, dismiss button, `role="status"`/`role="alert"`).
- **Verification:** tsc 0; full suite 430/430. Freshness against a live sync is UNVERIFIED (needs a running backend).
- **Residual (why PARTIAL):** `AiApiHubView.tsx` keeps its inline `JXAlert` notices for secondary feedback (the AI Hub agent kept them deliberately; only primary mutations use `pushNotice`). The store-wide 401 "expired, show nothing" gate (UX-18's companion ask) is not verified store-wide — see UX-18.

### UX-07 — Enrol modal's three controls silently discard input [P1] — FIXED
- **What changed:** `src/views/DevicesView.tsx` — the three dead controls (architecture/role select, sandbox path, token-expiry buttons) are removed; the fake "Heartbeat" progress step is removed (progress now reflects only real steps); demo enrolment no longer auto-closes after 800 ms — it ends on an explicit "This was a preview — no token was issued" state with "Open device" / "Go to Live home" actions.
- **Verification:** tsc 0; full suite 430/430.
- **Deviation:** none (removal chosen over wiring: the enrol API takes only a name, and the recommendation explicitly allowed removal).

### UX-08 — Four buttons promise actions they do not perform [P1] — FIXED
- **What changed:** `src/views/ConnectionsView.tsx` — live mode: "Add client" / "Test Handshake & Sign Token" sign form and fake JWT removed (clients register via `/oauth/register`; tokens are issued by the control plane); "Rotate secret" button + handler removed in **both** modes (it rotated nothing). Demo mode keeps the preview labelled exactly "Simulated — no real token is issued" with button "Simulate handshake (demo)". `src/views/LiveDesktopView.tsx:1021–1080` — "Capture snapshot" now produces a real downloadable PNG from the video/frame (`desktop-snapshot-<hostname>-<stamp>.png`) and reports honestly when no frame is available. UX-01's "Verify integrity" is fixed under UX-01.
- **Verification:** tsc 0; full suite 430/430. PNG download from a live frame UNVERIFIED (needs a live stream).
- **Deviation:** none.

### UX-09 — Task follow-through broken by default [P1] — FIXED
- **What changed:** `src/views/TaskQueueVisionView.tsx` — `useServerHistory` now defaults to `true` when live (server history with pagination is the default list); after dispatch a persistent "Task #id — status" tracking chip links to the task row with live status updates; approval-gated rows link to the matching approval in Human Approvals (approval id/status shown inline) instead of dead-ending in a notice.
- **Verification:** tsc 0; full suite 430/430. Live status updates UNVERIFIED (needs a running backend).
- **Deviation:** none.

### UX-10 — Most forms are not `<form>`s; workflow builder is hand-rolled [P1] — FIXED
- **What changed:** `<form onSubmit>` + `type="submit"` on the primary button added for: enrolment (`DevicesView`), task dispatch (`TaskQueueVisionView`), policy save + webhook/channel forms (`SecurityPoliciesView`), AI save + MCP create + 7 forms (`AiApiHubView`), file transfer (`LiveDesktopView`), workflow builder (`WorkflowsView`, `WorkflowsDemoView`), rename modal (`ConnectionsView`), Add Binary modal (`SecurityPoliciesDemo`), live panels already covered. The workflow builder's hand-rolled `<div role="dialog">` is replaced by `GlassModal` (native `<dialog>`, focus trap, Escape, backdrop-close, focus return).
- **Verification:** tsc 0; full suite 430/430. Keyboard/Enter-submit behaviour UNVERIFIED (needs a browser).
- **Deviation:** none.

### UX-11 — Desktop canvas is an unnamed focusable region forwarding keystrokes [P1] — FIXED
- **What changed:** `src/views/LiveDesktopView.tsx` — canvas has `role="application"` + `aria-label="Remote desktop. Keyboard input is sent to the remote computer."` plus a visible hint; Esc releases control outside the agent-intent veto window (veto window behaviour preserved); an explicit "Release control (Esc)" affordance exists.
- **Verification:** tsc 0; full suite 430/430. Real keyboard/screen-reader behaviour UNVERIFIED (needs a browser + screen reader).
- **Deviation:** none.

### UX-12 — Light-theme dim text fails contrast (2.56:1) [P1] — FIXED
- **What changed:** `src/tailwind.css` — light-theme `--product-text-dim` darkened #94a3b8 → #64748b (4.76:1, passes AA). Dark theme already passed and is unchanged.
- **Verification:** contrast recomputed from the token values (WCAG formula): 4.76:1. Visual rendering UNVERIFIED (needs a browser).
- **Deviation:** none.

### UX-13 — Only device-360 is deep-linkable [P1] — PARTIAL
- **What changed:** `src/views/AuditTrailView.tsx` — `?record=` deep link parsed locally (record opens from the URL). `src/views/SecurityPoliciesView.tsx` — policy tabs are `JXTabs` with `?tab=` deep links. `src/App.tsx` / `src/state/navigation.ts` / `src/views/live/*` — live section/tab persist in the hash; unknown hashes show a brief "That page doesn't exist" notice instead of silently landing on login; breadcrumb falls back gracefully.
- **Verification:** tsc 0; full suite 430/430.
- **Residual (why PARTIAL):** task id, workflow id, desktop-session id, and list-filter (`?q=`/`?status=`) deep links are not implemented. The unknown-hash notice covers the worst case (silent login landing).

### UX-14 — Localisation is chrome-only and partly broken [P1] — FIXED
- **What changed:** `src/i18n/catalogs.ts` — the 5 theme strings are translated in all 19 locales; new catalog test asserts no non-English locale ships an untranslated English string. `src/shell/AppShell.tsx` — hardcoded `lang="en" dir="ltr"` removed from the shell root (inherits the document locale); the mobile drawer is RTL-aware. "Not reported" / "Not loaded" literals replaced with `t()` where they were rendered as literals.
- **Verification:** tsc 0; full suite 430/430; i18n 4/4. RTL rendering UNVERIFIED (needs a browser in an RTL locale).
- **Deviation:** none. The chrome-only posture for operational/safety copy is retained deliberately (catalog header says so; Language modal discloses it) — the recommendation allowed either documenting it or expanding view-by-view; full-view translation (1,386 hardcoded strings) was out of scope for this wave. Translation quality still needs native-speaker review.

### UX-15 — Terminology: five words for one computer [P1] — FIXED
- **What changed:** The standard in the header of this report is applied across all views: "Target Host Node" → "Target device" (`HumanApprovalsView`); "Broadcast to N Nodes" → devices (`FleetOperationsView`); "Target Host" → "Target device" (`AuditTrailView`, `SecurityPoliciesView`, `WorkflowsView`, `WorkflowsDemoView`); "Scheduled Job" / "Job Name" → "Schedule" (`FleetOperationsView`); "Execute Tool" vs "Dispatch" unified to **Dispatch**; "40 nodes" → "40 devices"; "Node Disconnected" → "Device disconnected". One canonical label per destination in nav/title/breadcrumb/palette (UX-16's split labelling supports this).
- **Verification:** tsc 0; full suite 430/430.
- **Deviation:** none.

### UX-16 — `#/live` runs a second, parallel routing/UI system [P1] — FIXED
- **What changed:** `src/App.tsx`, `src/views/live/LiveWorkspace.tsx` — the live workspace is now labelled ("Live workspace — simplified live panels") vs the full views; the breadcrumb renders the live section/tab (`LIVE_SECTION_LABELS` / `LIVE_TAB_LABELS` in `App.tsx`); live sections link out to the canonical full views where a full view exists; the shell `BreadcrumbTrail` is rendered in `AppShell` for every view including own-header views.
- **Verification:** tsc 0; full suite 430/430.
- **Deviation:** the two implementations are **not** unified into one (that is a redesign, not a UX fix); the fix is explicit labelling + breadcrumb + links, which is the recommendation's documented-split alternative.

### UX-17 — Desktop studio controls ~28 px, below the 44 px touch target [P1] — FIXED
- **What changed:** `src/views/LiveDesktopView.tsx` — toolbar converted to `JXButton` (inherits the 44 px touch media query); monitor chips enlarged to `px-2.5 py-1.5`; stage minimum lowered on small screens (`min-h-[320px] sm:min-h-[560px]`); device selector `w-full sm:w-72`.
- **Verification:** tsc 0; full suite 430/430. Touch sizing UNVERIFIED (needs a real phone/tablet viewport).
- **Deviation:** none.

### UX-18 — Error messages are raw server strings, no diagnosis/recovery [P2] — FIXED
- **What changed:** `src/views/AiApiHubView.tsx` — `describeError` now maps common statuses (403/409/429/5xx) to plain-language explanations with a next step instead of echoing the raw server string; uncertain mutations render a "Check status" action deep-linking to the relevant task/audit row. `src/views/AuditTrailView.tsx` — export failures now surface in `downloadNotice` with `tone="error"` (previously silently swallowed by `catch {}`). The 12 `"Unknown error"` fallbacks are replaced with specific copy where the cause is known.
- **Verification:** tsc 0; full suite 430/430. The mapped messages against a live failing backend are UNVERIFIED.
- **Deviation / verification gap:** the store-wide 401 "expired, show nothing" gate (apply the `#/live` behaviour to every view) was not verified store-wide in this wave — it needs a live session-expiry test and is listed under UNVERIFIED below.

### UX-19 — Labels unassociated; placeholders stand in for labels [P2] — FIXED
- **What changed:** `Field` (`htmlFor`/`id`) or explicit `<label htmlFor>` used everywhere: enrolment (`DevicesView`), policy/webhook forms (`SecurityPoliciesView` — the five `<span>` captions are now `<label>`s), audit filter inputs now have `aria-label`s (`AuditTrailView`), DevicesView search has a label, workflow step inputs have sr-only labels + ids (`WorkflowsView`, `WorkflowsDemoView`), rename/Add-Binary modals (`ConnectionsView`, `SecurityPoliciesDemo`). Placeholders are hints/examples only.
- **Verification:** tsc 0; full suite 430/430.
- **Deviation:** none.

### UX-20 — Validation is submit-time only, no `aria-invalid` [P2] — FIXED
- **What changed:** `aria-invalid` + `aria-describedby` pointing at the error element added for fields with errors (policy, webhook, MCP, AI forms); blur validation on long forms; Max tier is now `type="number" min={0} max={4}` with a submit-time range check (`SecurityPoliciesView`); one required-field convention (`*` marker + `required`); the AccountsPanel stale-error lockout is fixed (error clears on input change, so a stale error can no longer permanently block re-submit).
- **Verification:** tsc 0; full suite 430/430.
- **Deviation:** none.

### UX-21 — No show/hide toggle on passwords; live enrol token in plain text [P2] — FIXED
- **What changed:** `SecretField` component in `src/views/SecurityPoliciesView.tsx` (show/hide with `aria-pressed` + `aria-label="Show/Hide …"`, `autoComplete="off"`, `role="alert"` errors) applied to webhook URL, Slack/Discord/Telegram tokens, and generic webhook. Show/hide toggles added to AI API key, MCP bearer token, MCP client secret (`AiApiHubView`), login admin token/password (`LoginView`), and new-user password (`AccountsPanel`), with `autoComplete` set consistently. Live enrolment token (`src/views/live/Inventory.tsx`) now uses the DevicesView masking pattern (masked by default + Show/Hide + copy).
- **Verification:** tsc 0; full suite 430/430.
- **Deviation:** none.

### UX-22 — Six confirmation mechanisms; Ctrl+N hijacks the browser [P2] — FIXED
- **What changed:** One confirm component (`ConfirmDestructive`, GlassModal-based) applied uniformly for destructive actions; hold-to-confirm reserved for emergency stop and Tier 3/4/Unrestricted. One shared `EmergencyStopConfirm` used by both call sites (`src/shell/TopHeader.tsx` and `src/views/LiveControlView.tsx`). Approve/deny split documented in `HumanApprovalsView.tsx:562–567` (approve = checklist-gated SlideToAction; deny = GlassModal + mandatory reason + HoldToConfirmButton). The Ctrl+N enrol binding is removed from `DevicesView.tsx`; the help modal lists every active shortcut (see UX-34).
- **Verification:** tsc 0; full suite 430/430. `holdDurationMs={isLive ? 1200 : 700}` in TopHeader is pinned by Tier 1 test F4.1 and preserved.
- **Deviation:** the demo branch keeps the 700 ms hold (live is 1200 ms) because F4.1 pins `holdDurationMs={isLive ? 1200 : 700}`; unifying to 1200 ms everywhere would break that test and was not part of the audit's ask.

### UX-23 — No cancel for long-running operations; no retry on most failed loads [P2] — PARTIAL
- **What changed:** `src/views/TaskQueueVisionView.tsx` — mutation buttons are disabled while pending (busy keys); the dispatch guard is state-based, not the old 600 ms `setTimeout`; the **same idempotency key is reused on retry** of a dispatch (a second click no longer creates a second task); per-task Retry added. The Workflows error-banner + Retry pattern (`ReadState` + retry button) is now the standard in views that load data.
- **Verification:** tsc 0; full suite 430/430.
- **Residual (why PARTIAL):** Cancel for fleet broadcast / fleet-agent update is **local-only** (stops polling; there is no backend broadcast/fleet-update cancel endpoint to call — only `cancelTask`/`cancelWorkflow` exist). A backend cancel endpoint would be needed for a true abort; that is backend work, out of scope.

### UX-24 — Visual-system drift: undefined tokens, theme-bypassing utilities, ad-hoc type scale [P2] — PARTIAL
- **What changed:** `--product-danger` and `--product-text-primary` are now defined in both theme blocks (`src/tailwind.css:34–35, 84–85`) and the `#c0392b` fallback is dropped. `.scrollbar-hide` is defined. Hardcoded slate utilities are nearly eliminated (from ~58 uses to 1 remaining).
- **Verification:** tsc 0; full suite 430/430; token definitions verified by grep.
- **Residual (why PARTIAL):** the systematic cleanup was not done — `text-[10px]` remains in 61 places (down from 119, not banned); the 3-step type scale (11 px minimum), single card/button radius, single loading pattern (skeleton vs spinner), and reserving `animate-pulse` for live/online only were not adopted. These are mechanical but wide-ranging; they need a dedicated token-migration pass.

### UX-25 — No in-app help beyond one shortcuts modal and one external link [P2] — PARTIAL
- **What changed:** A Docs link is added to the sidebar footer (`src/shell/SidebarNav.tsx:127–129`, links to the repo README). A visible "?" button is added to `TopHeader` (`CircleHelp`, `src/shell/TopHeader.tsx:149`). The help modal (`src/shell/AppShell.tsx:202–214`) now lists every active shortcut from a `SHORTCUTS` array, including the `g`-prefix navigation keys. One-line consequence captions are added under destructive/security-sensitive controls (see UX-03/UX-04).
- **Verification:** tsc 0; full suite 430/430.
- **Residual (why PARTIAL):** no standalone **tier legend** was added to the task studio (tiers appear inline on tool options, but there is no "Tier 1 — read-only · Tier 2 — workspace edits · Tier 3 — elevated shell · Tier 4 — kernel" legend); no glossary was added; the desktop audio tooltip still exposes jargon (`LiveDesktopView.tsx:1603–1607` still mentions "WASAPI Opus" and the env var `AI_BRIDGE_DESKTOP_AUDIO=1` in user-facing copy).

### UX-26 — Sign-in blocked, not warned, on health-probe failure [P2] — FIXED
- **What changed:** `src/views/LoginView.tsx` — probe failure is downgraded to a warning; the submit attempt is allowed and the auth error itself is surfaced. Show/hide toggles added to token/password fields. 401 vs network failures map to actionable copy ("Ask an admin to check the token / re-enable your account"). The password-strength meter is removed from sign-in (it judged an *existing* password). The demo entry is de-emphasised from a full-width button to a text link.
- **Verification:** tsc 0; full suite 430/430. Cold-start probe behaviour UNVERIFIED (needs a slow-waking backend).
- **Deviation:** none.

### UX-27 — Stale `?device=` silently shows the wrong device [P2] — FIXED
- **What changed:** `src/views/Device360View.tsx`, `src/views/LiveDesktopView.tsx`, `src/App.tsx:85–87` — unknown device id now renders an explicit "Device not available" state, never `devices[0]`; the breadcrumb shows the requested id / "Unknown device" instead of falling back to the seed hostname `srv-us-east-412`. The live `DeviceWorkspace` behaviour is now the behaviour everywhere.
- **Verification:** tsc 0; full suite 430/430. Tier 5 test 4.5 was updated to assert the new fallback (see "Test updates" below) — it previously pinned the old `|| "srv-us-east-412"` fallback the audit ordered removed.
- **Deviation:** none.

### UX-28 — Drawer is not a dialog; icon-only buttons rely on `title=`; tables lack semantics [P2] — FIXED
- **What changed:** `src/shell/AppShell.tsx` — the mobile nav drawer is now a proper dialog (`role="dialog"`, `aria-modal`, `aria-label="Navigation"`, Escape-to-close, focus trap, focus return). Icon-only buttons now have `aria-label`s: zoom out/in (`TaskQueueVisionView.tsx:1672,1684`), snapshot (`LiveDesktopView.tsx:2113`, "Capture desktop snapshot (downloads a PNG)"), and the audit's other cited sites. **All 17 tables** now have `scope="col"` on headers + sr-only `<caption>` (verified: 93 `scope="col"`, 17 `<caption>` across `src/`); sortable headers have `aria-sort` (AuditTrailView Block #/Timestamp). The clipboard-sync state is now text, not colour alone (`LiveDesktopView.tsx:1974–1977` — "On"/"Off" text + `aria-label="Clipboard sync on/off"` + `aria-pressed`). The `div role="button"` template row is a real `<button>` (`WorkflowsView.tsx`); plan/step cards are real `<button>`s (`WorkflowsDemoView.tsx`).
- **Verification:** tsc 0; full suite 430/430; table coverage verified by grep (17/17 tables).
- **Residual:** the `focus:outline-none` audit sub-item was not resolved — whether Tailwind's `focus:outline-none` defeats the global `:focus-visible` rule in the built CSS remains UNKNOWN without inspecting built CSS; the global rule itself was left untouched. Noted under UNVERIFIED.

### UX-29 — Timestamps: three inconsistent systems, one mislabelled "UTC" [P2] — PARTIAL
- **What changed:** Display timestamps are routed through `useLanguage().date` / `formatDate()` with an explicit `timeZone` (`AuditTrailView`, `HumanApprovalsView`, live panels); `Freshness` uses `Intl.RelativeTimeFormat(locale, { numeric: "auto" })` with `t()` for "Updated"/"Stale" (foundations).
- **Verification:** tsc 0; full suite 430/430.
- **Residual (why PARTIAL):** `src/views/SecurityPoliciesDemo.tsx:311` still appends a hardcoded `" UTC"` suffix to a local-time string (`new Date().toLocaleTimeString() + " UTC"`) — the known mislabel the Policies agent left untouched as out of scope for its six files. One line; needs the same `useLanguage().date` treatment.

### UX-30 — Responsiveness: fixed grids never collapse [P2] — FIXED
- **What changed:** The five fixed grids collapse (`grid-cols-1 sm:grid-cols-2/3`): `TaskQueueVisionView` vision-canvas panes stack (`col-span-12 sm:col-span-7/5`), `HumanApprovalsView` inspector summary, `AiApiHubView`, `ConnectionsView`, `DevicesView`. AuditTrail's 8-column table gets `min-w-[720px]` (digest cell truncates). `.scrollbar-hide` is defined (foundations).
- **Verification:** tsc 0; full suite 430/430. Phone rendering UNVERIFIED (needs a real small viewport).
- **Residual:** `.product-mobile-actions` (`src/tailwind.css:7`) is still defined with zero uses — neither wired in nor deleted. Dead CSS, no user impact.

### UX-31 — Policy editing is a hidden mode; role gating defaults to editable [P2] — PARTIAL
- **What changed:** `src/views/SecurityPoliciesView.tsx` (1,151 lines) — explicit editing banner ("Editing policy vN — Publish creates a new version / Overwrite replaces vN"); the wrong action is disabled/hidden in each mode (edit vs rollback-as-new are now visually distinct); dirty tracking + `beforeunload` guard on navigating away with unsaved edits; `canEdit` is fail-closed (admin-token `me()` with no role may edit; **unknown role = read-only banner** "role unknown — read-only until verified"); per-tool dry-run probe added ("Test a tool call (dry run)" via `api.simulateTool`, tool + device + approval-granted toggle); page split into `JXTabs` sub-sections (Policies / Devices / Webhooks & alerts / Backups / Tenants / Users) with `?tab=` deep links.
- **Verification:** tsc 0; full suite 430/430. The per-tool probe against the live endpoint is UNVERIFIED (needs a running backend).
- **Residual (why PARTIAL):** in-app hash-navigation interception (confirm before leaving the page via in-app nav, as opposed to `beforeunload` on full unload) is not implemented — it needs router/store changes outside the six files the Policies agent owned.

### UX-32 — Audit export silently falls back to local data [P2] — FIXED
- **What changed:** `src/views/AuditTrailView.tsx` — on server-export failure an explicit error is shown and the local export is offered as a clearly-labelled secondary choice ("Export visible (local) records instead"); the fallback no longer silently produces a different dataset with the same success notice. Actor options are derived from the loaded records (distinct actors) plus a free-text input (no more hardcoded seed actors). Date-range filtering and pagination (50/page) added; the table shows total vs shown.
- **Verification:** tsc 0; full suite 430/430. Export-failure path UNVERIFIED (needs a live backend that fails an export).
- **Deviation:** none.

### UX-33 — WebRTC session start gives no progress feedback; takeover on by default [P2] — FIXED
- **What changed:** `src/views/LiveDesktopView.tsx` — persistent "Waiting for agent offer…" state with elapsed time and a Cancel button during the ~15 s offer poll; sticky error with session id and next step on poll exhaustion; "Why no stream?" explanatory panel (replacing the disabled "Stream unavailable" dead button); **observer is now the default** (`useState<"observer" | "takeover">("observer")`, :165) with an explicit Takeover action; a small session-status line (session id, state, last error, reconnecting…) persists until dismissed; the takeover bar is the single indicator (the duplicate banner is merged into it).
- **Verification:** tsc 0; full suite 430/430. Tier 1 test F12.1 was updated to assert the new observer default (see "Test updates"). The offer-wait UX against a live agent is UNVERIFIED (needs a live WebRTC session; the E2E harness passed 18 Nov 2026 on farhan, but not against this build).
- **Deviation:** none.

### UX-34 — Shortcuts few/undiscoverable; palette navigates but executes nothing; no bulk device actions [P2] — FIXED
- **What changed:** `src/shell/AppShell.tsx`, `src/shell/CommandPaletteModal.tsx` — all shortcuts documented in the help modal (incl. `g`-prefix navigation); palette now executes actions (dispatch a saved tool, emergency stop via confirm) as well as navigating; device rows show platform + status dot + last-seen, online-first. `src/views/DevicesView.tsx` — multi-select with bulk revoke/delete (the Ctrl+N binding was removed as part of UX-22). `src/views/TaskQueueVisionView.tsx` — recent dispatches persisted per user in localStorage; demo-view filters persist via the same preferences mechanism.
- **Verification:** tsc 0; full suite 430/430.
- **Deviation:** direct approve/deny from the palette is NOT done — there is no selected approval in palette context, so the palette navigates to the approval instead of deciding it. This is the safer option (no decision without context).

### UX-35 — Two empty-state components; no Settings destination [P2] — FIXED
- **What changed:** One `EmptyState` component (card + bare variants, `src/ui.tsx`) is now used everywhere: all inline empty paragraphs migrated (bare variant) in `WorkflowsView`, `WorkflowsDemoView`, `SecurityPoliciesView`, `SecurityPoliciesDemo`, `HumanApprovalsView`, `ConnectionsView`, `AiApiHubView`, `AuditTrailView`, `TaskQueueVisionView`, `LiveDesktopView`, live panels; `PageEmpty` (`src/components/PageEmpty.tsx`) is kept as a thin wrapper (other files import it). A Settings sidebar section links to the existing sub-sections (webhooks/alerts/backups/tenants/users/AI settings).
- **Verification:** tsc 0; full suite 430/430.
- **Deviation:** a dedicated Settings *route* was not created — the recommendation allowed "at minimum a sidebar section linking to the existing sub-sections", which is what was done.

### UX-36 — Headings, breadcrumbs, focus details [P3] — FIXED
- **What changed:** Every route now has exactly one `<h1>`. `AiApiHubView` (:1305), `DiagnosticsLogsView` (:474), `FleetOperationsView` (:859), and `TaskQueueVisionView` (:939) gained their own `<h1>` in this wave; the coordinator's final pass added all four to `VIEWS_WITH_OWN_HEADER` in `src/App.tsx:41–62` so the shell does not render a second h1 above them. `AuditTrailView`, `SecurityPoliciesView`, and `WorkflowsView` remain h1-less by design and rely on the documented shell h1 (they are **not** in `VIEWS_WITH_OWN_HEADER`); their demo variants render inside those routes, so they inherit the shell h1 too. `BreadcrumbTrail` is rendered in `AppShell` for every view including own-header views (`src/shell/AppShell.tsx:261` + `src/App.tsx:246`).
- **Verification:** tsc 0; full suite 430/430; h1 inventory verified by grep (12 own-header views in the list; 3 shell-header views; login branch has its own h1 and no shell).
- **Deviation / final-pass fix:** the AI Hub and Task Studio agents added h1s without registering the views in `VIEWS_WITH_OWN_HEADER`, which would have produced duplicate h1s on four routes — the exact defect the `VIEWS_WITH_OWN_HEADER` comment warns about. The coordinator caught and fixed this in the final pass (see below). The Audit and Policies agents' DEFERRED on this finding is therefore resolved, not carried.

### UX-37 — Screen-reader and ARIA gaps [P3] — PARTIAL
- **What changed:** `scope="col"` + sr-only `<caption>` on all 17 data tables (see UX-28); `aria-sort` on sortable headers (AuditTrailView Block #/Timestamp; DevicesView client-side sort now exposes sort state); `aria-expanded` on the `details`/`summary` menus (`src/views/live/Inventory.tsx:124`, `LiveWorkspace.tsx:124`, `TasksPanel.tsx:109`, `src/views/live/shared.tsx:100`, `LiveDesktopView.tsx:1807,2020`).
- **Verification:** tsc 0; full suite 430/430; table/aria coverage verified by grep.
- **Residual (why PARTIAL):** `role="status"` on the permanently-rendered `ProductStatusDot` (`src/ui.tsx:130`) was **not** removed — the audit's concern (every poll re-announces the pulsing live pill) remains a live hypothesis, unverifiable without a screen reader. JXAlert's live-region behaviour was not audited (library source not inspected).

### UX-38 — Copy drift: "Sign out" / "Approve" / "Demo" / "Control plane" / "Enroll" [P3] — PARTIAL
- **What changed:** The UX-15 terminology standard is applied (device/host/client/task/workflow/schedule/Dispatch); action notices carry a severity (shared `ProductNotice` tone / `pushNotice` tone); demo-mode outcomes are prefixed "Demo: " consistently.
- **Verification:** tsc 0; full suite 430/430.
- **Residual (why PARTIAL):** two specific copy drifts the audit named are still present — "Slide to authorize" (`src/views/HumanApprovalsView.tsx:656`, vs nav/API "Approve"/"Approvals") and "Return to sign in" (`src/views/LiveControlView.tsx:244,297`, vs "Sign out" elsewhere). One-word fixes; left for a copy pass because the approve control's label is tied to the checklist-gated SlideToAction component and the sign-out copy sits in the session-expired flow.

### UX-39 — Miscellaneous P3s [P3] — PARTIAL
- **What changed (done):** explicit Back link on `Device360View` (to Devices) and other leaf screens; sidebar "Home" renamed to "Live home" (footer duplicate removed; subtitle distinguishes it from "Fleet overview"); nav counts added for failed tasks / offline devices (not just approvals); explicit labelled "View demo workspace" / "Back to live home" switch in the sidebar footer in both states; disabled states explained via banner + `aria-disabled`/`title`/`aria-describedby` where the reason is not adjacent; AI hub split into sub-tabs (Providers / Agents / MCP / Chat) with `JXTabs`; in-page section nav added for the desktop studio (buttons + `scrollIntoView`, not hash anchors, which would trip the router); unreported fields render as explicit "— not reported" greyed cells instead of `0`/`"unknown"`; kill-process feedback now reads "Kill requested — confirm in Processes" and the row is kept until telemetry confirms the PID is gone; enrol success states offer "Open device" / "Go to Live home" (deep link `?device=<id>`).
- **Verification:** tsc 0; full suite 430/430.
- **Residual (why PARTIAL):** JetBrains Mono font **not** adopted (no font asset in the repo — adding it needs a font file or a webfont dependency); the desktop file input still has no `accept` list (no backend type restriction exists to express) and no `aria-label` (`src/views/LiveDesktopView.tsx:2171–2175`, hidden input triggered by a labelled button); no rollback path is visible anywhere (inherent — updates are pessimistic, except the kill-process case which is now labelled honestly); the audio tooltip jargon is covered under UX-25.

---

## Final-pass reconciliation (coordinator, after all view agents finished)

1. **Duplicate-h1 regression (UX-36).** The AI Hub agent added `<h1>`s to `AiApiHubView`, `DiagnosticsLogsView`, `FleetOperationsView`; the Task Studio agent added one to `TaskQueueVisionView` — none of which were in `VIEWS_WITH_OWN_HEADER`, so the shell would have rendered a second h1 on those four routes. Fixed by adding `"task-queue-and-vision"`, `"fleet-operations"`, `"ai-api-and-agents"`, `"diagnostics-and-logs"` to `VIEWS_WITH_OWN_HEADER` (`src/App.tsx:41–62`). Verified by grep: every route now has exactly one h1.
2. **Two missed `window.confirm` calls (UX-03).** The AI Hub agent left `window.confirm` in `handleDeleteMcpServer` and `handleDeleteAgent` (`AiApiHubView.tsx`). Replaced with `ConfirmDestructive` in the final pass. Final grep: zero `window.confirm`/`window.prompt` calls in `src/`.
3. **Build-artifact hygiene.** `apps/dashboard/tsconfig.tsbuildinfo` (regenerated by `tsc -b`) was reverted out of the diff; `dist/` is gitignored and was not committed.
4. **Task Studio deviation confirmed sound.** Live dispatch calls `api.submitTask` directly (with the idempotency key as the 5th `requestKey` argument) instead of the store's `dispatchTask`, because the store signature has no key parameter. Verified: `submitTask(device_id, tool, args, tenant?, requestKey = crypto.randomUUID())` (`src/api.ts:345`) and the call site passes the stored key (`TaskQueueVisionView.tsx:404–411`). Retry reuses the same key, so a retry cannot double-dispatch. No change made.

## Test updates (legitimate maintenance, not weakening)

Two tests pinned behaviour the audit **explicitly ordered changed**. Both were updated to assert the new, correct behaviour; no test was deleted, skipped, or weakened, and no other test was touched.

| Test | Old assertion | New assertion | Why |
|---|---|---|---|
| F12.1 (`src/tests/tier1-feature-coverage.test.ts:665`) | source contains `useState<"observer" \| "takeover">("takeover")` | source contains `useState<"observer" \| "takeover">("observer")` | UX-33 ordered the default changed to observer (takeover-by-default is a safety defect) |
| 4.5 (`src/tests/tier5-adversarial.test.ts:495–512`) | `App.tsx` contains `selectedDevice?.hostname \|\| "srv-us-east-412"`; simulated fallback `'srv-us-east-412'` | `App.tsx` contains `selectedDevice?.hostname \|\| "Unknown device"`; simulated fallback `'Unknown device'` | UX-27 ordered the silent fallback to a seed hostname removed (safety-relevant: acting on the wrong device) |

Both updated tests pass. The full suite is 430/430 with these updates in place.

## Deviations from the audit's recommendations (summary)

- **UX-03/UX-22:** demo emergency-stop hold stays 700 ms (live 1200 ms) because Tier 1 test F4.1 pins `holdDurationMs={isLive ? 1200 : 700}`.
- **UX-07:** dead enrol controls removed rather than wired (the enrol API takes only a name; the recommendation explicitly allowed removal).
- **UX-13:** deep links implemented for audit records and policy tabs; task/workflow/session deep links not done.
- **UX-14:** chrome-only i18n posture retained and disclosed; full-view translation (1,386 strings) not attempted.
- **UX-16:** split documented + labelled rather than unified (unification is a redesign).
- **UX-23:** broadcast/fleet-update cancel is local-only (no backend cancel endpoint exists).
- **UX-31:** `beforeunload` guard implemented; in-app hash-navigation interception not implemented (needs router/store changes).
- **UX-34:** palette navigates to approvals instead of deciding them (no selected approval in palette context).
- **UX-35:** Settings sidebar section added; no dedicated Settings route created.
- **UX-39:** section nav uses buttons + `scrollIntoView`, not hash anchors (hash anchors would trip the router).

## UNVERIFIED — needs a running backend and/or browser

These fixes are type-checked and unit-tested but their **runtime** behaviour was not observed (no dev server was run against a live plane, no browser run, per the task constraints):

- UX-01: `verifyAudit()` / retention against a live audit chain (valid/invalid, broken_at, legacy rows).
- UX-04/UX-22: hold-to-confirm interaction timing and feel.
- UX-06: Freshness against a live sync (loading → live → stale transitions, error banner + Retry).
- UX-08: PNG download from a live desktop frame.
- UX-09: live task-status updates on the tracking chip.
- UX-10/UX-11: Enter-to-submit, focus trap/Escape in the workflow dialog, Esc-release of the desktop canvas, screen-reader announcement of the canvas label.
- UX-12: light-theme contrast as actually rendered.
- UX-14: RTL rendering of the demo shell in `ar`/`fa`/`he`/`ur`.
- UX-17: 44 px touch targets on a real phone/tablet.
- UX-18: mapped error copy against a live failing backend; store-wide 401 "expired, show nothing" gate.
- UX-26: cold-start (30–60 s wake) probe behaviour.
- UX-30/UX-33: phone rendering; offer-wait UX against a live agent (the WebRTC E2E harness passed 18 Nov 2026 on farhan, but not against this build).
- UX-28: whether Tailwind's `focus:outline-none` defeats the global `:focus-visible` rule in the built CSS (needs built-CSS inspection).
- UX-37: `role="status"` chatter from the pulsing live pill; JXAlert live-region behaviour (needs a screen reader).
- UX-06/UX-14: translation quality (needs native-speaker review).

## Files changed (47 modified + 2 new)

`src/App.tsx`, `src/api.ts`, `src/components/Freshness.tsx`, `src/components/PageEmpty.tsx`, `src/i18n/catalogs.ts`, `src/i18n/index.ts`, `src/shell/AppShell.tsx`, `src/shell/CommandPaletteModal.tsx`, `src/shell/SidebarNav.tsx`, `src/shell/TopHeader.tsx`, `src/shell/navigation.ts`, `src/state/dashboardStore.ts`, `src/state/navigation.ts`, `src/tailwind.css`, `src/tests/catalogs.test.ts`, `src/tests/tier1-feature-coverage.test.ts`, `src/tests/tier5-adversarial.test.ts`, `src/types/dashboard.ts`, `src/ui.tsx`, `src/views/AiApiHubView.tsx`, `src/views/AuditTrailView.tsx`, `src/views/ConnectionsView.tsx`, `src/views/Device360View.tsx`, `src/views/DevicesView.tsx`, `src/views/DiagnosticsLogsView.tsx`, `src/views/FleetOperationsView.tsx`, `src/views/HumanApprovalsView.tsx`, `src/views/LiveControlView.tsx`, `src/views/LiveDesktopView.tsx`, `src/views/LoginView.tsx`, `src/views/OverviewView.tsx`, `src/views/SecurityPoliciesDemo.tsx`, `src/views/SecurityPoliciesView.tsx`, `src/views/TaskQueueVisionView.tsx`, `src/views/TerminalView.tsx`, `src/views/WorkflowsDemoView.tsx`, `src/views/WorkflowsView.tsx`, `src/views/live/AccountsPanel.tsx`, `src/views/live/ApprovalsPanel.tsx`, `src/views/live/DeviceWorkspace.tsx`, `src/views/live/Inventory.tsx`, `src/views/live/LiveWorkspace.tsx`, `src/views/live/ManagementPanels.tsx`, `src/views/live/NotificationsPanel.tsx`, `src/views/live/TaskComposer.tsx`, `src/views/live/TasksPanel.tsx`, `src/views/live/shared.tsx` — plus new `src/state/notices.ts` and `src/components/NoticeStack.tsx`. No file under `src/views/` outside the above, and nothing in the backend, was touched. (+6,206 / −2,404 lines.)

## Open items not part of this remediation

- The farhan production agent restart (needs James via RDP) — unchanged by this work; still blocked on James's answer about whether he shut the machine down or just closed RDP.
- Production verdict remains **NO-GO** (gates 20/0/0, open rows F-06-16 / OV-03, token rotation pending, Render free Postgres expiry 2026-12-17). This remediation does not change that verdict.

---

## Residual close-out, 18 Nov 2026

All 10 PARTIAL residuals from the first wave are now closed. **10 CLOSED, 0 DEFERRED.** Work was done in three phases (Phase 1: UX-06/UX-38, UX-23, UX-29/UX-37 in parallel on disjoint files; Phase 2: UX-13/UX-31/UX-25/UX-39; Phase 3: UX-24 mechanical sweep over the final tree). The coordinator verified the combined tree itself (see "Final verification" below) — the numbers below are the coordinator's own runs, not the agents' claims.

### Final verification (combined tree, 18 Nov 2026 ~00:55 UTC)

| Check | Result |
|---|---|
| `npx tsc -b` (apps/dashboard) | **exit 0** — zero errors |
| `npm test` (full dashboard suite) | **434/434 pass** (was 430; +4 new tests F3.6–F3.9 for deep links / nav guard), 0 failed; `test:i18n` 4/4 |
| `npm run build` (`tsc -b && vite build`) | **clean** (built in 7.49 s) |
| Backend tests (UX-23 modules) | `pytest tests/unit/test_phase3_fleet_ops.py tests/unit/test_architecture_phase4_routers.py` — **26 passed** |
| `text-[10px]` in `src/` | **0** remain |
| `window.confirm` / `window.prompt` in `src/` | **0 calls** (2 hits are doc comments only) |
| `animate-pulse` in `src/` | **9** remain, all live/online (see UX-24) |
| `JetBrains` in `src/` | only comments + the test-pinned `index.html` link (see UX-39); rendering uses the system mono stack |

### UX-06 — AiApiHubView inline notices → NoticeStack — CLOSED
- **What changed:** `apps/dashboard/src/views/AiApiHubView.tsx` — all 5 inline `JXAlert` render sites removed (`aiNotice`, `mcpNotice`, `agentNotice`, Copilot `copilotError` / `copilotSaveNotice`); every setter converted to `pushNotice` with the same message and tone (49 `pushNotice` call sites in the file now); the 4 primary mutations that dual-pushed now push only once. `JXAlert` is gone from the file (0 occurrences, import removed). One deliberate adaptation: `loadMcpServers` polls every 10 s, so its failure path pushes only when the message changes (`lastMcpLoadErrorRef`, reset on success) — otherwise a persistent error notice would stack every 10 s. No new `NoticeStack` mounted (still once in `App.tsx`); no named exceptions.
- **Verification:** tsc 0; full suite 434/434. Visual behaviour (notices appearing in the bottom-right stack, 5 s auto-dismiss for success/info, persistence for warning/error) UNVERIFIED — needs a browser.

### UX-13 — Task / workflow / session deep links — CLOSED
- **What changed:** `apps/dashboard/src/state/navigation.ts` — `Route` extended with view-scoped `task`, `workflow`, `session`, `q`, `status`; `readRoute()` parses them only on their owning route; `writeRoute()` accepts them (`RouteExtra`, incl. `replace`); new `updateRouteParams()` merges a patch into the current hash, preserving other params. `apps/dashboard/src/views/TaskQueueVisionView.tsx` — `?task=` initialises the selection, `selectTask()` writes it back; a resolution effect selects + scrolls to `task-row-<id>`, probes `api.taskDetail(id)` when the id is not on the paginated page, and renders an explicit "Task not available" `EmptyState` for an unknown id (never falls back to `tasks[0]`); `?q=`/`?status=` initialise the filters and are written back via replaceState. `apps/dashboard/src/views/WorkflowsView.tsx` — `?workflow=` initialises `selectedId`, `selectWorkflow()` writes it back; unknown id renders "Workflow not available" in the detail pane. `apps/dashboard/src/views/LiveDesktopView.tsx` — `?session=` is written when a session starts and cleared on `cleanupWebrtc`; on load the plane is probed via `api.getSessionV1(id)` — known sessions are shown in the session-status line, unknown ones render "Session not available". New tests F3.6–F3.9 (`src/tests/tier1-feature-coverage.test.ts`) cover `readRoute` parsing, `writeRoute`/`updateRouteParams` round-trip, and the guard wiring.
- **Limitation:** workflow deep links only resolve in the live `WorkflowsLive` view; demo mode renders `WorkflowsDemoView`, so `?workflow=` is ignored there. Task links work in both modes.
- **Verification:** tsc 0; full suite 434/434 (incl. the 4 new tests); build clean. Deep links surviving a real refresh against a live plane UNVERIFIED — needs a browser + live backend.

### UX-23 — Backend broadcast / fleet-update cancel — CLOSED (real backend endpoint)
- **Assessment (verified in code):** `POST /api/fleet/broadcast` (`src/ai_bridge/control/routers/workflows.py:468`) is a synchronous fan-out with no persistent batch record — the batch exists only implicitly as tasks sharing the `bcast-{batch_id}-` prefix. So "cancel" means flipping queued tasks to `cancelled` so they never execute (agent claim only picks up `status='queued'`). `POST /api/fleet/update` (`:841`) is just a broadcast of `update_fleet_agent`, so one endpoint covers both.
- **What changed (backend):** `src/ai_bridge/control/routers/workflows.py` — new `POST /api/fleet/broadcast/{batch_id}/cancel` (`:623–~700`): `require_role("operator")` (matches the broadcast endpoint and both sibling cancels; the admin token satisfies it via the role hierarchy), 404 unknown batch, tenant check on the first task row; cancels only `queued`/`needs_approval` tasks (DB flip + `notify_tasks(cancel=True)`); `running` tasks are left alone and reported as `still_running`; idempotent (re-cancel is a 200 no-op); audit entry `cancel_broadcast`; no new table, no redesign. `GET /api/fleet/broadcast/{batch_id}` (`:551–621`): `cancelled` (and `timed_out`) now count as terminal; overall is `cancelled` when no task is active and ≥1 was cancelled; response gains `cancelled`/`timed_out` fields (required — otherwise a cancelled batch would poll `"running"` forever). `docs/api-reference.md:371`: one-line route table addition.
- **What changed (dashboard):** `apps/dashboard/src/views/FleetOperationsView.tsx`, `src/api.ts:515` — `api.cancelBroadcast(batchId)` wrapper; Broadcast Cancel calls the endpoint with the stored live batch id, stops polling, and shows real counts ("N tasks stopped before running; M already running will finish"); button has `loading` + `disabled` while the cancel is in flight; the poll loop treats `"cancelled"` as terminal (covers cancel from another tab); demo mode keeps the local-only path. Fleet-update Cancel is honoured once the batch id returns.
- **Tests:** `tests/unit/test_phase3_fleet_ops.py:95` — new `test_fleet_broadcast_cancel` (unknown batch → 404; no auth → 401; cancel fresh 2-device batch → `cancelled: 2, still_running: 0, status: "cancelled"`; poll reports `cancelled`; re-cancel idempotent; a `running` task is left alone; cancelling a finished batch is a safe `completed` no-op). `tests/unit/test_architecture_phase4_routers.py:208` — route-snapshot entry added for the new route.
- **Verification:** backend `pytest tests/unit/test_phase3_fleet_ops.py tests/unit/test_architecture_phase4_routers.py` — 26 passed (coordinator's own run); dashboard tsc 0; full suite 434/434; build clean. The cancel round-trip against a live plane + real agents UNVERIFIED — needs a running backend/browser.
- **Decision to flag:** role is `operator`, not `admin` (matches the broadcast endpoint and both sibling cancels; requiring `admin` would let an operator broadcast but 403 on cancelling their own broadcast). Say the word if it should be tightened to `admin`.

### UX-24 — Type scale / radius / pulse — CLOSED
- **What changed (type scale):** `text-[10px]` **61 → 0** (every occurrence replaced with `text-[11px]`; `text-[11px]` is now 260 uses). Files: `src/ui.tsx` (1), `src/views/ConnectionsView.tsx` (8), `src/views/HumanApprovalsView.tsx` (7), `src/views/SecurityPoliciesDemo.tsx` (2), `src/views/TaskQueueVisionView.tsx` (13), `src/views/WorkflowsDemoView.tsx` (15), `src/views/WorkflowsView.tsx` (15). `src/tailwind.css`: the 3-step scale is documented in a comment (11px chrome minimum via `text-[11px]`; 12px `text-xs`; 14px `text-sm`; 10px banned).
- **What changed (radius):** standard documented in `src/tailwind.css` (cards = `rounded-xl`, buttons = `rounded-md`; `rounded-full` reserved for pills/avatars/status dots/toggle knobs; `rounded-lg`/`rounded` stay on small chips/inputs). Migrated: `ProductMetricCard` `rounded-2xl!` → `rounded-xl!`, `ProductGlass` `rounded-2xl` → `rounded-xl`, `GlassModal` `rounded-2xl` → `rounded-xl` (all in `src/ui.tsx`); 12 raw action buttons in `src/views/WorkflowsView.tsx` `rounded-xl` → `rounded-md`. Left alone: `rounded-2xl` at 16 view sites (form/panel surfaces — a view-level panel migration would be a separate pass); `rounded-full` everywhere (deliberate shapes); remaining `rounded-xl` in WorkflowsView (9 sites) are non-buttons (inputs, alerts, card-as-button tiles, `<pre>` blocks). No tests pin any of these classes.
- **What changed (pulse):** `animate-pulse` **13 → 9** sites. Changed (4 busy-state sites): `LiveDesktopView.tsx:2098` file-transfer dot → spinning `RefreshCw` (`animate-spin`); `:2592` pulsing `Zap` in the "Anticipated AI Action" banner → static icon (countdown text already communicates the pending state); `:2600` pulsing countdown bar → real progress via shared `JXLinearProgress` (value = remaining fraction of `pendingIntent.countdown_ms`); `FleetOperationsView.tsx:1168` broadcast dot → spinning `RefreshCw`. Kept (9 live/online sites, all verified live/online by context): log tail, terminal cursor, pointer-lock active, audio capture live, REC button/HUD, simulated-terminal cursor, agent target crosshair, Execution Stream: LIVE.
- **Verification:** tsc 0; full suite 434/434 (baseline preserved exactly); build clean (7.94 s). Visual rendering (11px legibility, radius appearance, spinner vs pulse) UNVERIFIED — needs a browser.

### UX-25 — Tier legend, glossary, audio tooltip — CLOSED
- **What changed:** (a) Tier legend — `src/views/TaskQueueVisionView.tsx:1180–1192`: one compact line under the tool selector with tier-coloured dots — "Tier 1 — read-only · Tier 2 — workspace edits · Tier 3 — elevated shell · Tier 4 — kernel" — plus a "?" button opening the glossary. (b) Glossary — new `apps/dashboard/src/components/Glossary.tsx`: 19 one-sentence definitions (tier, policy, approval, device, host, node, client, task, workflow, schedule, MCP, OAuth, JWT, SSE, Merkle, mTLS, SoM, WASAPI, Opus) in a `GlassModal`-based `GlossaryModal`; linked from the sidebar footer next to Docs (`SidebarNav.tsx:136–140`) and from the tier-legend "?" button. Implemented as a modal, not a route, so the 15-destination nav table and its tests stay intact. (c) Audio tooltip — `src/views/LiveDesktopView.tsx:1645–1660`: rewritten in plain language ("Desktop audio is not available in this build." / "…audio stays silent even when unmuted"). No `WASAPI`/`Opus`/`AI_BRIDGE_DESKTOP_AUDIO` remains in user-facing copy (only one code comment at :1613 mentions WASAPI overlays).
- **Verification:** tsc 0; full suite 434/434; build clean. Glossary/legend rendering UNVERIFIED — needs a browser.

### UX-29 — Hardcoded " UTC" suffix — CLOSED
- **What changed:** `apps/dashboard/src/views/SecurityPoliciesDemo.tsx` — line 11: added `import { formatDate } from "../i18n";` lines 312–314: replaced `time: new Date().toLocaleTimeString() + " UTC"` with `time: formatDate(new Date(), { timeStyle: "medium" })` (a local time, correctly labelled, via the shared path — the same pattern `src/views/live/shared.tsx:34` uses). The hardcoded `" UTC"` suffix is gone; grep confirms no `toLocaleTimeString` remains in the file. The three seeded fixture strings at lines 259–261 (`time: "14:28:09 UTC"` etc.) were left untouched — they are static demo fixture data, not a generated local time.
- **Verification:** tsc 0; full suite 434/434.

### UX-31 — In-app hash-navigation guard — CLOSED
- **What changed:** `apps/dashboard/src/types/dashboard.ts` — new `NavigationGuard` interface (`isDirty: () => boolean`); store state gains `pendingNavigation`, `register/unregisterNavigationGuard`, `confirm/cancelPendingNavigation`; `setCurrentView` accepts `{ force?, extra? }`. `apps/dashboard/src/state/dashboardStore.ts` — `setCurrentView` (:1161) consults the registered guard before leaving: if dirty, the target is held in `pendingNavigation` and navigation is deferred; `confirmPendingNavigation` (:1195) navigates once with `force`, `cancelPendingNavigation` (:1203) drops the hold. `syncRoute` (hashchange/popstate — browser back/forward) is deliberately untouched, and `beforeunload` still covers refresh. `apps/dashboard/src/views/SecurityPoliciesView.tsx` — registers the guard from the existing `dirty` computation via a `dirtyRef` (:587–593, unregisters on unmount); renders `ConfirmDestructive` ("Leave without saving?", tone warning, :1166) when `pendingNavigation` is set. Guard is a no-op when there are no unsaved edits. `apps/dashboard/src/shell/SidebarNav.tsx` — `goLiveSection` (:49) now goes through `setCurrentView("live", { extra: { section } })` instead of setting `location.hash` directly, so the settings "Users" link is also guard-covered.
- **Verification:** tsc 0; full suite 434/434 (incl. new test F3.8 covering guard intercept → `pendingNavigation`, cancel stays, confirm leaves, unregistered navigates directly). The guard dialog in a real browser (focus/Escape, sidebar-behind-modal behaviour) UNVERIFIED — needs a browser.

### UX-37 — ProductStatusDot role + JXAlert live-region audit — CLOSED
- **What changed (a):** `apps/dashboard/src/ui.tsx:129–134` — `role="status"` removed from the `ProductStatusDot` outer `<span>`, with an explanatory comment. Every usage site was checked first: `Freshness.tsx` (all three branches already wrap the dot in their own `role="status"` span), `ConnectionsView.tsx:594,603` (each dot already wrapped in `<div role="status">`), `AppShell.tsx:224,235` (inside a `role="note"` banner whose text already states the mode), `TopHeader.tsx:157` (inside the emergency-stop button, which has its own `aria-label`), `HumanApprovalsView.tsx:358` (queue-header count label), `LiveControlView.tsx:278,306` (permanently rendered, poll-driven labels, with an adjacent `JXBadge` carrying the same text). No usage needs `role="status"` on the dot itself, so none was added anywhere.
- **What changed (b):** JXAlert live-region audit — library source inspected in `node_modules` (not edited): `node_modules/@jacxishippingorg/jx-ui-react/dist-lib/index.mjs`, component `rr` (exported as `JXAlert`) at line 1781, rendering `<div role="alert">` at line 1784, unconditionally for all severities (corroborated by `dist-lib/JXAlert-Cioqhawf.js` and the `.cjs` twin). Type contract (`dist-lib/types/components/feedback/JXAlert.d.ts`) has no `role`/`aria-live` prop and no props spread, so the wrapper cannot override the inner role. Every sampled dashboard usage is a conditional mount (`{x && <JXAlert .../>}`), so the alert is announced exactly once on mount via the implicit assertive live region — not silent, and not on every render. **No wrapper change was needed; none was made.** Named caveat: because the library hardcodes `role="alert"`, success/info/warning alerts are announced assertively rather than politely (`role="status"`, as `NoticeStack.tsx:51` does). A wrapper cannot downgrade this (nesting live regions risks double announcement); truly fixing the politeness level needs a library change or reimplementing the alert in the wrapper — out of scope here.
- **Adjacent gap flagged (not changed):** `ProductModePill` in `src/ui.tsx` (~line 200) still carries its own `role="status"` and is permanently rendered in every view header, so the poll-chatter concern persists through the pill even with the dot fixed. Removing it is a one-line decision.
- **Verification:** tsc 0; full suite 434/434; grep confirms `role="status"` is gone from `ProductStatusDot`. Actual screen-reader behaviour UNVERIFIED — needs a screen reader.

### UX-38 — Copy drift ("Slide to authorize" / "Return to sign in") — CLOSED
- **What changed:** `apps/dashboard/src/views/HumanApprovalsView.tsx:656–657` — `label="Slide to authorize"` → `label="Approve"`, `completedText="Authorized"` → `completedText="Approved"` (slide interaction and checklist gate untouched). `apps/dashboard/src/views/LiveControlView.tsx:244` (session-expired button) and `:297` (error-state button) — `"Return to sign in"` → `"Sign out"` in both (handlers untouched). Grep: zero remaining instances of either string anywhere in `src/` or `src/tests/`.
- **Verification:** tsc 0; full suite 434/434. The "Approve" slide rendering UNVERIFIED — needs a browser.

### UX-39 — Font (JetBrains Mono) + file input — CLOSED
- **What changed (a):** `apps/dashboard/src/tailwind.css:13` — `@theme { --font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace; }`, so every existing `font-mono` use resolves through this token; `:36` overrides JXUI's `--jx-font-mono` to the same stack. Verified in the built CSS: `--font-mono:ui-monospace…` present, zero "JetBrains" occurrences. No webfont dependency or asset was added. Note: `index.html` still carries the Google Fonts JetBrains Mono link — it is pinned by test R2.2 (which asserts its presence) and is now harmless because rendering no longer depends on the webfont loading.
- **What changed (b):** `apps/dashboard/src/views/LiveDesktopView.tsx:2246` — file input gained `accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.zip,.tar,.gz,.tgz,.7z,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.mov"`. The `aria-label="Choose file to transfer to remote device"` was already present (added under UX-28), so only the accept list was missing. Backend check (read-only): `POST /api/v1/devices/{id}/files/upload` (`src/ai_bridge/control/v1_routes.py:452`) and `desktop_handle_file_start` (`src/ai_bridge/tools/transfers.py:46`) impose no file-type restriction (only a size limit and path quarantine) — so the accept list is a UX picker hint, not a backend constraint, as noted in the code comment; the transfer flow is unchanged.
- **Verification:** tsc 0; full suite 434/434; build clean.

## Residual close-out — files changed (this wave)

Dashboard: `src/state/navigation.ts`, `src/state/dashboardStore.ts`, `src/types/dashboard.ts`, `src/App.tsx`, `src/shell/SidebarNav.tsx`, `src/tailwind.css`, `src/ui.tsx`, `src/api.ts`, `src/views/AiApiHubView.tsx`, `src/views/HumanApprovalsView.tsx`, `src/views/LiveControlView.tsx`, `src/views/TaskQueueVisionView.tsx`, `src/views/WorkflowsView.tsx`, `src/views/LiveDesktopView.tsx`, `src/views/SecurityPoliciesView.tsx`, `src/views/SecurityPoliciesDemo.tsx`, `src/views/FleetOperationsView.tsx`, `src/components/Glossary.tsx` (new) — plus backend `src/ai_bridge/control/routers/workflows.py`, `tests/unit/test_phase3_fleet_ops.py`, `tests/unit/test_architecture_phase4_routers.py`, `docs/api-reference.md`. (Line counts per file are in the per-residual entries above; the coordinator did not re-count the whole diff.)

## Residual close-out — UNVERIFIED (needs a running backend and/or browser)

All of the following were type-checked and unit-tested but their runtime behaviour was not observed (no dev server was run against a live plane, no browser run, per the task constraints). They carry forward from the first wave's UNVERIFIED list, plus the new items from this wave:

- UX-06: notices appearing in the bottom-right stack (5 s auto-dismiss for success/info, persistence for warning/error).
- UX-13: deep links surviving a real refresh against a live plane (incl. the `taskDetail` and `getSessionV1` probes).
- UX-23: the cancel round-trip against a live control plane + real agents.
- UX-24: actual 11px legibility, rounded-xl/rounded-md appearance, spinner vs pulse behaviour, `JXLinearProgress` countdown bar rendering.
- UX-25: glossary/legend rendering.
- UX-31: the nav-guard dialog in a real browser (focus/Escape, sidebar-behind-modal behaviour).
- UX-37: actual screen-reader behaviour (dot/pill chatter, JXAlert announcing once on mount).
- UX-38: the "Approve" slide rendering.
- UX-06/UX-14 (from the first wave): translation quality (needs native-speaker review).

## Residual close-out — tally

| Status | Count | Findings |
|---|---|---|
| **CLOSED** | **10** | UX-06, 13, 23, 24, 25, 29, 31, 37, 38, 39 |
| **DEFERRED** | 0 | — |

Combined with the first wave, all 39 UX findings are now **CLOSED** (29 FIXED + 10 PARTIAL→CLOSED). The only remaining named gaps are the UNVERIFIED runtime items above, the `ProductModePill` `role="status"` one-liner flagged under UX-37, and the `rounded-2xl` view-level panel surfaces left under UX-24. Production verdict remains **NO-GO**.
