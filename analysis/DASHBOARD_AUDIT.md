# AI Bridge Web Dashboard Audit

**Date:** 18 Nov 2026 (read-only investigation; no source files modified, no packages installed, no dev server or build run, test suite not executed)
**Repo:** `~/workspace/ai-bridge-main/` — local HEAD `e5eff11`; GitHub main `40a3ba9d`
**Dashboard:** `apps/dashboard/` — React 18 + TypeScript + Vite + Tailwind 4
**Scope:** routes/pages, components, real-vs-mock/demo data, missing features vs the backend API surface, code quality. Five parallel read-only tracks; contradictions resolved by re-reading code (see §10).

**How to read this report.** Every substantive claim cites an exact file path and line number. Claims are marked **VERIFIED** (read in code), **INFERENCE** (reasoned from code, not directly observed), or **UNKNOWN** (could not be determined read-only). Line numbers are as-read in this checkout; the repo has no git history here, so "changed since the 17 Nov audit" is established by comparing file contents to that audit's quoted literals, not by commit diff. Runtime behaviour (rendering, network, auth flows) was **not** observed — no browser or dev server was run.

---

## 1. Executive summary

### Verdict: LIVE-backed when signed in; DEMO only by explicit opt-in

The prior audit's headline finding (D-01, "demo is the default") is **FIXED**. The dashboard now defaults to `#/login`, gates all 14 demo views behind an explicit opt-in acknowledgement, and never shows seed data on the live home (`#/live`). When signed in, the dashboard is genuinely wired to the FastAPI control plane across devices, tasks, policies, audit, workflows, WebRTC, terminal, MCP/OAuth, AI, and fleet operations.

That verdict has three important qualifications:

1. **The 40-device seed still ships as the store's initial state.** `src/state/dashboardStore.ts:722-755` initialises the store with `SEED_DEVICES` (40 fake devices) and other fixtures *before* any auth. An unauthenticated user who clicks "Explore demo workspace" still sees a convincing fake fleet — now labelled with an interstitial and an amber "SAMPLE DATA · DEMO" banner, but the fake data is present from first render.
2. **The 14 demo views are hybrid, not purely live.** When signed in they are mostly live-backed, but several sub-features stay demo-only even in live mode (vision-canvas fallback, desktop audio, fake webhook fixtures, simulated broadcast progress). The only fully live-only surface is `#/live` (`LiveControlView.tsx:53`).
3. **Two live-mode controls fabricate things.** "Add client / Test Handshake & Sign Token" builds a fake JWT in the browser (`ConnectionsView.tsx:518-533`), and "Rotate secret" promises rotation while doing nothing (`ConnectionsView.tsx:458-476,706`). Both are reachable while signed in and are not demo-gated.

### Headline numbers (verified by direct count in this audit)

| Item | Value | Source |
|---|---|---|
| Routes (hash views) | 16 `ViewId`s | `src/state/navigation.ts:3-9` |
| View files | 28 (18 top-level + 10 live panels) | `src/views/`, `src/views/live/` |
| View code | 19,516 lines | `wc -l` on `src/views/**/*.tsx` |
| Largest views | `AiApiHubView.tsx` 2,804; `LiveDesktopView.tsx` 2,468; `Device360View.tsx` 1,454 | `wc -l` |
| API client | `src/api.ts`, 545 lines, ~140 methods, 54 distinct `/api` paths | `wc -l`; grep count 140 keys; grep 54 paths |
| Store | `src/state/dashboardStore.ts`, 1,347 lines | `wc -l` |
| Backend routes | ~215 decorators enumerated (Track 4: 216; independent grep: 214) | `src/ai_bridge/control/` |
| Seeded demo devices | 40 | `dashboardStore.ts:117` |
| i18n | 20 locales, 47 messages, only 7 files call `t()` | `src/i18n/catalogs.ts:22-42`; import grep |
| Unit-test call sites (textual) | 423 `it(`/`test(` in `src/tests/`; 48 in `e2e/` | grep count; suite **not run** |

### Prior audit (17 Nov 2026, `analysis/09_DASHBOARD_ARCHITECTURE_AUDIT.md`) — reconciliation

| Prior finding | Status now | Evidence |
|---|---|---|
| D-01 demo is the default | **FIXED** | Default `#/login`; `gateDemoView` (`dashboardStore.ts:58-61`); session-only ack (`dashboardStore.ts:22,44-49`); interstitial (`AppShell.tsx:36-54`) |
| D-02 fabricated Merkle verification | **FIXED** | Hardcoded root `0x7fa281…`, `chainValid`, `blocksChecked: 14920` gone; `AuditTrailView.tsx:7-10,59-62,97-109` reports verification unavailable |
| D-03 fake provider cards/keys | **FIXED** | `sk-ant-api03-***9a4` etc. gone; `AiApiHubView.tsx:280-282,311-319` — providers start `not_configured`, driven by `GET /api/settings/ai` |
| D-04 unlabelled fake vision canvas | **PARTLY FIXED** | Canvas still a simulated desktop, but now prominently labelled (`TaskQueueVisionView.tsx:1231-1235`) |
| D-07 localStorage token fallback | **FIXED** | Tokens are sessionStorage-only; legacy localStorage copies deleted by `clearCredentials()` (`api.ts:66-87`) |
| D-08 tokens in URLs | **FIXED** | SSE uses fetch + header auth (`api.ts:288-293`); WebSocket uses single-use 60 s stream tickets (`api.ts:123-125,502-508`) |
| D-12 desktop audio placeholder | **STILL TRUE** | `LiveDesktopView.tsx:205,1426-1427` — WASAPI capture not shipped |
| 40 seeded devices / "Sarah Jenkins" operator | **STILL TRUE (in substance)** | Seeds still initial state (`dashboardStore.ts:117,749-755`); now gated + labelled rather than default |
| "No `node_modules/` or `dist/`" | **NOW WRONG** | Both now present under `apps/dashboard/` |

---

## 2. Routes & pages

### 2.1 Routing mechanism (VERIFIED)

There is **no router library**. `apps/dashboard/package.json` lists no `react-router`; grep for `react-router|BrowserRouter|HashRouter|Routes|useNavigate|useParams` across `src/` returns nothing. Routing is **hash + store state**:

- `src/state/navigation.ts:3-9` — `viewIds: ViewId[]` (16 ids).
- `src/state/navigation.ts:11-17` — `readRoute()` parses `window.location.hash` as `#/<view>?device=<id>`; unknown/missing hash → `{view:"login"}`.
- `src/state/navigation.ts:20-24` — `writeRoute()` uses `history.pushState`; only `device-360-system` ever gets `?device=` (`dashboardStore.ts:1104`).
- `src/App.tsx:148-182` — `renderActiveView()` is a `switch (currentView)`; `src/types/dashboard.ts:7-22` is the closed `ViewId` union.
- `src/main.tsx:19-29` — entry awaits `consumeIdentityRedirectAsync()` then `dashboardStore.syncRoute()`; no `<Router>` wrapper.
- `src/state/dashboardStore.ts:1331-1332` — `popstate`/`hashchange` → `syncRoute()`.

Auth gating is **not** route-level (no role guard). It is the demo/live split in `dashboardStore.ts`: `DEMO_VIEWS` = the 14 demo routes (`:23-36`); `gateDemoView()` (`:58-60`) returns `login` for any demo view when there is no token/session token **and** no session demo acknowledgement (`DEMO_ACK_KEY`, `:22,45-49`); applied in the constructor (`:724`), `setCurrentView` (`:1097-1104`), and `syncRoute` (`:1111-1116`). `login` and `live` are never gated. Role gating exists only *inside* `#/live` panels (e.g. `ApprovalsPanel canDecide={... role==="admin"}` in `LiveWorkspace.tsx:110`).

### 2.2 Route table (all 16 routes — VERIFIED)

| Path (hash) | View component | Switch case | Purpose | Status |
|---|---|---|---|---|
| `#/login` | `LoginView` | `App.tsx:150-151` (also early return `:186-187`) | Sign-in (admin token / user+pass / OIDC) + health probe + "Explore demo workspace" | Live (154 lines) |
| `#/live` | `LiveControlView` | `App.tsx:189` (early return; **no `case "live"`** in the switch) | Live-only control-plane home; 9 sections; never shows seed data | Live (621 lines) |
| `#/overview` | `OverviewView` | `App.tsx:152-153` | Fleet summary counts/cards, recent tasks/failures, live metrics overlay when signed in | Live (246 lines) |
| `#/devices` | `DevicesView` | `App.tsx:154-155` | Device inventory table, enrollment, enroll/revoke/delete | Live (940 lines) |
| `#/device-360-system?device=<id>` | `Device360View` | `App.tsx:156-157` | Per-device telemetry gauges, Processes/Apps/Sockets/Daemons tabs, fingerprint drawer, kill/daemon/reboot | Live (1,454 lines) |
| `#/task-queue-and-vision` | `TaskQueueVisionView` | `App.tsx:158-159` | Task dispatch studio + queue + Set-of-Marks vision inspector | Live, with labelled in-view placeholder (see §2.4) |
| `#/live-desktop-studio` | `LiveDesktopView` | `App.tsx:160-161` | WebRTC remote-desktop studio: stream canvas, dual-cursor HUD, takeover bar, file transfer, clipboard, SoM | Live (2,468 lines); audio toggle is a placeholder |
| `#/interactive-terminal` | `TerminalView` | `App.tsx:162-163` | Interactive PTY terminal: real session when signed in; labelled local simulation when signed out | Live (803 lines) |
| `#/autonomous-workflows` | `WorkflowsView` | `App.tsx:164-165` | Workflows list/detail/builder/templates/schedules; wrapper only (`live ? <WorkflowsLive/> : <WorkflowsDemoView/>`, `:676-679`) | Live (681 lines) |
| `#/fleet-operations` | `FleetOperationsView` | `App.tsx:166-167` | Fleet ops hub: triggers, schedules, broadcast, rolling update, fleet version | Live (1,253 lines) |
| `#/ai-api-and-agents` | `AiApiHubView` | `App.tsx:168-169` | AI providers & agents hub: connectors, AI settings, MCP servers, agents, chat/execution studio | Live (2,804 lines, largest) |
| `#/human-approvals` | `HumanApprovalsView` | `App.tsx:170-171` | Approval queue: approve/deny/replan/delete, AST command-diff inspector, decision history | Live (792 lines) |
| `#/security-policies` | `SecurityPoliciesView` | `App.tsx:172-173` | Policies, versions, simulate, webhooks/alerts, backups, users/RBAC/tenants; wrapper only (`live ? <LiveSecurityPolicies/> : <SecurityPoliciesDemo/>`, `:731-734`) | Live (736 lines) |
| `#/audit-trail` | `AuditTrailView` | `App.tsx:174-175` | Append-only audit ledger, filters, export; verification reported unavailable | Live (470 lines) |
| `#/mcp-and-oauth` | `ConnectionsView` | `App.tsx:176-177` | MCP & OAuth hub: connections, OAuth clients, direct `/mcp` `tools/list` probe, gateway secret rotation UI | Live (1,213 lines) |
| `#/diagnostics-and-logs` | `DiagnosticsLogsView` | `App.tsx:178-179` | Service diagnostics + systemd/log stream, regex search, live service logs when signed in | Live (718 lines) |

**No route is a stub, empty, or "coming soon" page.** Grep for `coming soon|TODO|FIXME|lorem|under construction|not implemented` across `views/`, `shell/`, `App.tsx`, `state/`, `types/` returns **zero page-level hits** (only HTML input `placeholder="…"` attributes and the two labelled in-view placeholders in §2.4).

**Sub-routes inside `#/live` (not top-level routes).** `src/views/live/LiveWorkspace.tsx:16-27` defines its own query-string routing on the same `#/live` hash: `?section=devices|tasks|approvals|notifications|audit|policies|connections|logs|users` (default `devices`), `?device=<id>`, `?tab=details|tasks|terminal|desktop` (default `details`); unknown section → `devices`, unknown tab → `details`.

**Navigation.** Defined in `src/shell/navigation.ts:10-24` (15 entries, 5 groups: Overview, Fleet, Execute, Govern, Integrate) and rendered by `SidebarNav.tsx:23-53`. All 15 nav items are sidebar-reachable. `device-360-system` is nested under Devices and hidden until Devices (or itself) is selected (`SidebarNav.tsx:23,30-31,41`), but is also reachable via device-row clicks (`DevicesView.tsx:552,565`), Command Palette device search (`CommandPaletteModal.tsx:40-42`), and direct hash. `login` is the only `ViewId` absent from `navigationItems`, but is linked from the sidebar footer when signed out (`SidebarNav.tsx:83-86`), the Command Palette (`:38`), the AppShell demo banner (`AppShell.tsx:147`), and empty states in several views. **No true orphan routes.**

**Default/landing route:** `#/login` (`navigation.ts:15` fallback; store constructor gates via `gateDemoView`, `dashboardStore.ts:724-725`). Post-auth landing is `#/live` (`LoginView.tsx:60-65`; OIDC redirect rewrites to `#/live`, `api.ts:166-167`). Demo entry is an explicit click: "Explore demo workspace" → `#/overview` (`LoginView.tsx:141`).

**404 handling: none.** There is no 404 page, catch-all route, or "not found" view. Unknown hashes silently resolve to `#/login` (`navigation.ts:15`); grep for `404|not found|page not found` in `views/`, `shell/`, `App.tsx`, `state/navigation.ts` finds only API-status handling. Unknown `LiveWorkspace` sections/tabs likewise fall back silently (`LiveWorkspace.tsx:22-27`).

### 2.3 Views directory (VERIFIED — every file, one line)

`src/views/` (18 `.tsx`): `LoginView` (154) sign-in + demo entry; `OverviewView` (246) fleet summary; `DevicesView` (940) inventory + enrollment; `Device360View` (1,454) single-device telemetry/actions; `TaskQueueVisionView` (1,450) task queue + vision inspector; `LiveDesktopView` (2,468) WebRTC studio; `TerminalView` (803) PTY / demo simulation; `WorkflowsView` (681) live/demo wrapper; `WorkflowsDemoView` (899) demo-only seeded plans/canvas, rendered only by `WorkflowsView.tsx:678`; `FleetOperationsView` (1,253) broadcast/triggers/schedules/updates; `AiApiHubView` (2,804) providers/agents/MCP/chat; `HumanApprovalsView` (792) approval queue + diff inspector; `SecurityPoliciesView` (736) live/demo wrapper; `SecurityPoliciesDemo` (843) demo-only seeded policies, header `:1` "DEMO-ONLY … Never mount in live mode", rendered only by `SecurityPoliciesView.tsx:733`; `AuditTrailView` (470) ledger + export; `ConnectionsView` (1,213) MCP/OAuth hub; `DiagnosticsLogsView` (718) diagnostics + logs; `LiveControlView` (621) live-only home.

`src/views/live/` (9 panels + 2 helpers, all live-only, reachable only inside `#/live`): `LiveWorkspace.tsx` (141) section/tab router; `Inventory.tsx` (128) live device list + enroll; `DeviceWorkspace.tsx` (83) live per-device workspace; `TasksPanel.tsx` (125) live task list/history + composer; `TaskComposer.tsx` (82) task submission (`taskTools` at `:6`); `ApprovalsPanel.tsx` (72) approve/deny; `ManagementPanels.tsx` (157) `AuditPanel`/`PoliciesPanel`/`ConnectionsPanel`/`LogsPanel`; `AccountsPanel.tsx` (55) user/RBAC management (also reused in demo-mode policies view, `SecurityPoliciesView.tsx:725`); `NotificationsPanel.tsx` (24) live notifications; `shared.tsx` (104) `useRead` fetch helper, `Field`, `Pagination`, `Empty`; `preferences.ts` (60) per-account saved filters (localStorage).

`src/shell/`: `AppShell.tsx` (172) layout + live/demo banner + demo-warning interstitial modal + command palette; `SidebarNav.tsx` (88); `TopHeader.tsx` (98) with emergency-stop hold-to-confirm; `CommandPaletteModal.tsx` (72) Ctrl/⌘K palette (navigation + device search only, executes nothing); `navigation.ts` (nav definition).

### 2.4 Dead routes / in-view placeholders (VERIFIED)

- **Dead routes: none as routes.** Two dead *code paths* inside the router: `App.tsx:150-151` `case "login"` is **unreachable** — `App.tsx:186-187` returns `<LoginView/>` early before `renderActiveView()` is ever invoked. `App.tsx:180-181` `default: return <OverviewView/>` is reachable only for a runtime `currentView` outside the closed `ViewId` union (e.g. corrupted store state); in typed code it never fires, and it duplicates `#/overview`.
- **In-view placeholders (not whole pages) — 2 verified:**
  1. **Vision canvas** — `TaskQueueVisionView.tsx:1231-1235`: when no live frame exists the canvas renders a hardcoded simulated Ubuntu desktop, with an amber banner "SIMULATED — no live frame. This is a placeholder desktop, not a real device screen." SoM marks labelled "Simulated Marks — placeholder positions" (`:1324`, `:1352`).
  2. **Desktop audio** — `LiveDesktopView.tsx:205`: "Audio: mute toggle only; live WASAPI Opus capture is not shipped (silent/opt-in placeholder)"; user-facing title at `:1426-1428` repeats this and cites `AI_BRIDGE_DESKTOP_AUDIO=1`.

---

## 3. Components

### 3.1 Headline (VERIFIED)

The dashboard has almost no component layer. `src/components/` holds only **2 files**. Shared UI lives in `src/ui.tsx` (391 lines) and `src/views/live/shared.tsx` (104 lines); everything else is 14 monolithic demo views (246–2,804 lines each) plus the live workspace, with most UI written inline rather than extracted.

### 3.2 Component table

**`src/components/` — only 2 files exist:**

| Component | File:line | Shared / page-specific | Purpose | Status |
|---|---|---|---|---|
| `Freshness` | `components/Freshness.tsx:5` | Shared | Relative/absolute "Updated … ago" + stale indicator | Live — used only in `LiveControlView.tsx:9`, `OverviewView.tsx:15` |
| `PageEmpty` | `components/PageEmpty.tsx:5` | Shared | Centred empty state with primary/secondary action, optional demo badge | Live — used in 6 views |

**`src/ui.tsx` — local JXUI adapter / shared primitives (all shared, 391 lines):** `JXAlert` (`:47`), `JXButton` (`:53`, most-used primitive, ~387 refs), `ProductMetricCard` (`:61`, only `DevicesView`/`OverviewView`), `ProductGlass` (`:98`), `ProductStatusDot` (`:107`), `ProductSegmented` (`:142`, only `DevicesView`/`HumanApprovalsView`; comment notes JXUI `SegmentedControl` is a Daily/Weekly stub), `ProductModePill` (`:184`), `ProductNotice` (`:211`, only `DevicesView`/`HumanApprovalsView`), `ProductStepProgress` (`:232`, only `ConnectionsView`/`DevicesView`), `ProductToolbar` (`:272`, only `Device360View`), `JXStack` (`:280`), `JXGridItem` (`:286`), `JXCard` (`:297`), `JXCardHeader` (`:302`), `JXBadge` (`:312`, label wrapper only — no status→tone logic), `JXTextField` (`:318`), `JXTabs` (`:323`, only `DevicesView`/`Device360View`, with arrow-key navigation), `JXLinearProgress` (`:346`, native `<progress>`), `GlassModal` (`:352`, native `<dialog>` with focus trap/Escape/backdrop-close, ~20 call sites). Re-exports (`:28-45`) from `@jacxishippingorg/jx-ui-react` — see dead re-exports in §3.3.

**`src/shell/` (shared):** `AppShell` (`AppShell.tsx:33`), `CommandPaletteModal` (`:7`), `SidebarNav` (`:9`), `TopHeader` (`:11`).

**Root-level shared controls:** `App` (`App.tsx:51`); `Brand`/`BrandArt` (`Brand.tsx:4,12`); `DensityControl` (`DensityControl.tsx:10`); `LanguageControl` (`LanguageControl.tsx:6`); `ThemeControl` (`ThemeControl.tsx:31`, plus `initializeTheme`/`applyTheme`/`getResolvedTheme`).

**`src/views/` — page-specific views (each one exported component; no sub-components extracted).** See §2.3 for the per-file list. Notable: `WorkflowsView` contains internal `WorkflowsLive` (`:60`); `SecurityPoliciesView` contains internal `LiveSecurityPolicies` (`:56`).

**`src/views/live/` — live-only, shared within `#/live`.** `LiveWorkspace` (`:30`), `Inventory` + internal `Enrollment` (`Inventory.tsx:58,9`), `DeviceWorkspace` + internal `DeviceDetails` (`DeviceWorkspace.tsx:62,7`), `TasksPanel` + internal `TaskEvents`/`TaskResult` (`TasksPanel.tsx:49,7,34`), `TaskComposer` (`:16`), `ApprovalsPanel` (`:6`), `AccountsPanel` (`:7`), `AuditPanel`/`PoliciesPanel`/`ConnectionsPanel`/`LogsPanel` (`ManagementPanels.tsx:6,40,92,142`), `NotificationsPanel` (`:6`), and `shared.tsx` helpers (`Field`, `ReadState`, `Pagination`, `Payload`, `Empty`, `useRead` with generation counter and visibility-aware 5 s polling at `:45`, plus `time`/`deviceName`/`deviceStatus`/`taskStatus` maps). **This is the best-shared code in the dashboard; demo views do not use it.**

### 3.3 Stub / dead / placeholder components (VERIFIED)

**No view/component renders nothing, returns `null` as its whole render, or is a bare placeholder `div`.** The `return null` hits are legitimate guards (e.g. `CommandPaletteModal.tsx:44` when closed; `HumanApprovalsView.tsx:85,502` conditional rows).

- **Dead re-export — `TiltCard`:** imported and re-exported at `ui.tsx:25,44`, zero JSX uses anywhere in `src/`. `AdaptiveGlass` and `NumberCounter` are only used inside `ui.tsx` itself (`:84,100`), so as public re-exports they are also unused (INFERENCE: likely kept for future/external use, not proven).
- **Dead export — `getResolvedTheme`:** exported at `ThemeControl.tsx:14`; no caller outside that file. `initializeTheme` is live (`main.tsx:22`).
- **Audio toggle is a dead control:** `LiveDesktopView.tsx:205,1426-1427` (see §2.4).
- **Vision canvas is a labelled placeholder, not a stub component:** `TaskQueueVisionView.tsx:1231-1240` (see §2.4).
- **No imported-but-never-rendered component found** among the named components — every exported view/panel is rendered by `App.tsx`, `LiveWorkspace.tsx`, or its wrapper view. `SecurityPoliciesDemo`/`WorkflowsDemoView` are rendered only on the signed-out branch (`SecurityPoliciesView.tsx:733`, `WorkflowsView.tsx:678`) — live by design, dead in live mode.

### 3.4 Duplicated logic (VERIFIED — file:line pairs)

1. **SSE via `fetch` + `ReadableStream.getReader()` — 5 independent copies, no shared hook:** `LiveControlView.tsx:159-173` (activity), `TerminalView.tsx:226-241`, `WorkflowsView.tsx:125-153`, `AiApiHubView.tsx:486` (chat stream), `dashboardStore.ts:786-788` (events stream). Each re-implements auth headers, reader loop, reconnect. `useRead` (`views/live/shared.tsx:45`) covers polling `fetch` only, not SSE.
2. **Two parallel empty-state components:** `PageEmpty` (`components/PageEmpty.tsx:5`, demo views) vs `Empty` (`views/live/shared.tsx:102`, live panels) — same purpose, different APIs/styling; demo views never use `Empty`, live panels never use `PageEmpty`.
3. **Two parallel device-detail implementations:** `Device360View.tsx:107` (1,454 lines, demo/store-driven) vs `DeviceWorkspace.tsx:62` + `DeviceDetails` (`:7`, live-only). Same feature, separate code.
4. **Two parallel policy/workflow implementations (live vs demo):** `LiveSecurityPolicies` (`SecurityPoliciesView.tsx:56`) vs `SecurityPoliciesDemo.tsx:80` (843 lines); `WorkflowsLive` (`WorkflowsView.tsx:60`) vs `WorkflowsDemoView.tsx:289` (899 lines, `PLANS_DATA` fixtures at `:76`).
5. **Status→presentation mapping re-implemented per view:** `TaskQueueVisionView.tsx:639` (`getStatusBadge`, local only), `views/live/shared.tsx:35` (`taskStatus` label map), `DevicesView.tsx:493-505` (online/warn/offline tone), `DiagnosticsLogsView.tsx:358` (level colour), plus inline ternaries (e.g. `AiApiHubView.tsx:2426`, `SecurityPoliciesView.tsx:439,457`). `JXBadge` (`ui.tsx:312`) is only a label wrapper — there is no shared status-badge component.
6. **Timestamp formatting, three ways:** `views/live/shared.tsx:32` (`time()` via `formatDate`), `WorkflowsView.tsx:45` (`new Date(ts*(ts<1e12?1000:1)).toLocaleString()`), `AiApiHubView.tsx:1960` (same inline pattern); `Freshness.tsx:28-40` has its own relative-time logic.
7. **Direct `fetch` bypassing `api.ts` `call()`:** `ConnectionsView.tsx:146-177` (`/mcp` tools/list probe + OAuth discovery) and `AiApiHubView.tsx:227` (direct AI-provider call) — duplicated auth/header handling vs the single wrapper in `api.ts`. `TerminalView.tsx:227` / `WorkflowsView.tsx:150` / `LiveControlView.tsx:171` also `fetch` stream URLs directly (forced by `EventSource` not sending headers — documented in code).
8. **Per-view filter/search/pagination state:** each demo view owns its own `useState` filters (e.g. `AuditTrailView.tsx:69-72` actor/verdict/host/hash) while live panels share `useRead` + `Pagination` (`views/live/shared.tsx:45,83`). No shared table/filter component exists for demo views.
9. **Hardcoded seed-ID filter sets duplicated in shape:** `ConnectionsView.tsx:97-98` (`SEED_MCP_IDS`, `SEED_CLIENT_IDS`) and `DiagnosticsLogsView.tsx:64` (`SEED_STORE_LOG_IDS`) — each view hardcodes which seed IDs to hide in live mode.

### 3.5 Missing components per backend feature (VERIFIED — checked against `api.ts` and the file list)

"Missing" means **no dedicated, reusable component/route** — the feature is usually buried inline in a monolith view.

| Backend feature | Dedicated component? | Where it actually lives (inline) |
|---|---|---|
| Devices | Partial — no shared `DeviceCard`/`DeviceRow`/`DeviceDetail`; the two detail views duplicate each other (§3.4.3) | `DevicesView.tsx:67`, `live/Inventory.tsx:58`, `live/DeviceWorkspace.tsx:62`, `Device360View.tsx:107` |
| Tasks | Partial — no shared `TaskCard`/`TaskDetail`; rendering inline per view | Live: `TasksPanel.tsx:49`, `TaskComposer.tsx:16`; demo: `TaskQueueVisionView.tsx:148` |
| Policies | Partial — no reusable `PolicyEditor`/`PolicyVersionList`; live vs demo are separate trees | `SecurityPoliciesView.tsx:56` (live), `SecurityPoliciesDemo.tsx:80` (demo), `ManagementPanels.tsx:40` |
| Audit log | Partial — `AuditTrailView` exists, but no reusable `AuditRow`/`AuditExport`; verification is a button that reports "not verified" (`AuditTrailView.tsx:100-115`) | `AuditTrailView.tsx:49`, `ManagementPanels.tsx:6` |
| WebRTC streaming | **Missing as a component** — no `WebRTCSession`/`VideoPlayer`/`StreamControls` file; all RTC logic inline in the 2,468-line `LiveDesktopView.tsx:143` | `LiveDesktopView.tsx:143` only |
| Auth / users | Partial — no standalone Users route/view; user management is only `AccountsPanel` inside `#/live` (`LiveWorkspace.tsx:115`) and inside policies (`SecurityPoliciesView.tsx:725`); OIDC config has no component | `live/AccountsPanel.tsx:7` |
| Settings (webhook/alerts/backups/tenants/AI settings) | **Missing as a component/route** — no Settings view in `shell/navigation.ts:9-31` or `App.tsx:148-181`; settings scattered inline | Webhook/alerts/backups/tenants inside `LiveSecurityPolicies` (`SecurityPoliciesView.tsx:169-183,651-697`); AI settings inside `AiApiHubView.tsx` |
| Fleet updates | **Missing as a component** — no `FleetUpdate`/`UpdateProgress` component; `api.fleetVersion`/`api.updateFleet` (`api.ts:537-539`) called inline | `FleetOperationsView.tsx:263,455,924` (version display + rolling-update button + simulated notice `:468`) |
| Roles / supervisor | **Missing as components** — no `RoleList`/`SupervisorPanel`; `api.roles`/`enableRole`/`supervisorHandoff`/`supervisorRecover` inline in `LiveControlView` | `LiveControlView.tsx:77-80,402,489,515,543`; only other caller is `OverviewView.tsx:156` |
| Notifications | Partial — live-only `NotificationsPanel`; no demo equivalent, no reusable notification/toast component | `live/NotificationsPanel.tsx:6` |
| MCP / OAuth | Partial — no reusable `McpServerCard`/`OAuthClientRow`; inline in two views | `ConnectionsView.tsx:100`, `AiApiHubView.tsx:275` |
| Terminal | Partial — `TerminalView` is the view itself; no reusable `TerminalPane` shared with the live device workspace (which links to a terminal tab instead) | `TerminalView.tsx:147` |
| Shared table / search / filter / pagination | **Missing for demo views** — `Pagination` exists only in `views/live/shared.tsx:83`; demo views hand-roll filtering/sorting per view (§3.4.8) | — |

---

## 4. Real vs mock/demo

### 4.1 Verdict (VERIFIED)

**LIVE-backed when signed in; DEMO only by explicit opt-in.** The prior audit's headline (D-01) is fixed — the fix landed in Wave 2, commit `3712b81` ("Demo off by default (login-first + interstitial)"), per the audit history; the mechanism in current code is:

- Unknown/absent hash defaults to login: `src/state/navigation.ts:9-17`.
- Demo views gated in the store: `dashboardStore.ts:58-61` (`gateDemoView()` returns `"login"` for any of the 14 demo views with no credential **and** no explicit demo acknowledgement); applied in the constructor (`:724`) and in `setCurrentView`/`syncRoute` (`:1101-1115`).
- Acknowledgement is session-only and opt-in: `dashboardStore.ts:22,44-49` — `ai_bridge_demo_acknowledged` in `sessionStorage`, set only when navigating to a demo view from the login screen; cleared on sign-out/sign-in/401 by `clearCredentials()` (`api.ts:78-87`).
- Entry point is the login screen's explicit button: `LoginView.tsx:141-142` — "Explore demo workspace" / "Demo workspace — simulated data, not a real fleet." A successful sign-in lands on `#/live`, not the demo overview (`LoginView.tsx:62-64`).
- Unauthenticated demo entry also triggers a one-per-session interstitial modal: `AppShell.tsx:19,41` (`ai_bridge_demo_warning_seen`), plus the persistent amber "SAMPLE DATA · DEMO" banner vs green "Live control plane" banner, and `App.tsx:145-146` still appends "· Demo" to `document.title` for non-live/non-login views.

**Caveats (VERIFIED):**
1. The 40-device seed still ships as the store's *initial* state (`dashboardStore.ts:722-755` — constructor initialises `devices: SEED_DEVICES` etc. before any auth), and `syncWithBackend()` only replaces slices after sign-in. An unauthenticated user who clicks through still sees a convincing fake fleet.
2. The 14 demo views remain **hybrid**: when signed in they are mostly live-backed (via `syncWithBackend()` + direct `api.*` calls), but several sub-components stay demo-only even when live (vision canvas fallback, desktop audio, default SoM marks, fake webhook fixtures — see §4.3).
3. `#/live` is the only fully live-only surface: `LiveControlView.tsx:53` ("Live data is deliberately separate from the local demonstration store"), with 401 → expired state that never falls back to seed (`:69-70`).

### 4.2 API client — how live is configured (VERIFIED)

- `api.ts:1-8` — base URL: `VITE_API_URL` env (baked at build time via `define` in `vite.config.ts:6-10`, empty default) → else same-origin when not on `:5173`/localhost → else `http://127.0.0.1:8000` (dev default). **No `.env` file exists in `apps/dashboard/`.** Production wiring: `render.yaml:137-138` sets `VITE_API_URL=https://ai-bridge-control.onrender.com` for the static site.
- Auth: `api.ts:66-87` — `token()`/`sessionToken()` read **sessionStorage only** (prior audit's D-07 localStorage fallback is gone; legacy localStorage copies are deleted by `clearCredentials()`). `call()` (`api.ts:227-232`) sends `X-Session-Token` (preferred, + `X-CSRF-Token` on mutations via `GET /api/auth/csrf-token`, `api.ts:99-113`) or `X-Admin-Token`; 401 clears credentials (`api.ts:241`).
- Prior D-08 (tokens in URLs) is fixed: SSE URLs carry no credential (`api.ts:288-293` — fetch + header auth instead of EventSource); WebSocket signalling uses a single-use 60 s stream ticket (`api.ts:123-125,502-508` — `mintStreamTicket()` → `POST /api/stream-ticket`, `sessionWebSocketUrl(sessionId, ticket)`).
- `api.ts:250` — the `api` object; a grep of literal paths yields **54 distinct `/api…` paths** (plus `/health`). No MSW/Mirage/mock-service-worker exists in `src/`; the only request interception is Playwright `page.route("**/api/**", …)` mocks in `e2e/` (e.g. `e2e/live-workspace.spec.ts:15-16`), i.e. test-only.

### 4.3 Per-feature data source (VERIFIED — traced fetch calls)

"Live (signed in)" means a real `api.*` fetch was traced that honours the response; "Demo" means seed/local data with no backend effect. The switch in every hybrid view is the presence of a session/admin token.

| Feature | Data source | Evidence |
|---|---|---|
| Landing / auth | **Live** | `LoginView.tsx:50-53` `probeControlHealth()` (`GET /health`); `:62-64` `authenticate()` → `refreshLive()` → `#/live`; `api.ts:192-196` token branch `GET /api/auth/me`; OIDC via `api.ts` `oidcConfigured`/`oidcLogin`/code exchange |
| Live control plane (`#/live`) | **Live only** | `LiveControlView.tsx:74-81` `Promise.all([api.me(), api.health(), api.devices(), api.fleetHealth(), api.liveActivity(), api.desktopCapabilities(), api.roles()])`; SSE `:159-171`; panels: `TasksPanel.tsx:56,60`, `ApprovalsPanel.tsx:8,24`, `AccountsPanel.tsx:8,32-33`, `TaskComposer.tsx:34`, `DeviceWorkspace.tsx:8,47`, `ManagementPanels.tsx:7,20,41,81,93,132,144`, `NotificationsPanel.tsx:7`, `Inventory.tsx:19` |
| Device list (demo views) | **Hybrid** | List is store-driven (`DevicesView.tsx:68-74`); store replaced live by `syncWithBackend` (`dashboardStore.ts:813`, `api.devices()` + `api.fleetTelemetry()`); mutations live: `DevicesView.tsx:220-223` `api.enroll`, `:244-246` `api.revoke`, `:263-265` `api.deleteDevice`; demo branches only set notices, e.g. `:253` "Simulated revocation", `:846-867` "Simulate key generation" / "Preview only · no key is issued" |
| Device detail / 360 | **Hybrid** | Live reads: `Device360View.tsx:183-184` `api.deviceTelemetry(id, 20)`, `:192` `api.deviceOverview(id)`; live actions: `:375` `api.refreshDeviceTelemetry`, `:391` `api.updateDeviceAgent`, `:406` `api.updateDevice`, `:448-472` kill via `dispatchTask` → `run_shell` `kill -15`/`taskkill /F`, `:476-491` daemon via `run_shell` `systemctl`/`sc`; demo: `:370-371` "(demo snapshot)", `:386-387` "Demo agent upgrade simulated", `:401-402` "synchronized locally", `:499-517` deterministic fake PID `1000 + ((len*137 + …) % 8000)` + "simulated in demo mode". Live telemetry fields the backend doesn't report render as 0/`"not reported"` |
| Task execution & history | **Hybrid** | Live dispatch: store `dispatchTask` → `api.submitTask` (`POST /api/tasks`, Idempotency-Key); live history: `TaskQueueVisionView.tsx:438-442` `api.taskHistory({q,status,device_id,tenant,page})`, `:532,550` task detail/events, `:290-292` `api.cancelTask`, `:310-312` `api.deleteTask`, `:328-330` `api.clearTasks`, `:385-387,425-426` `api.updateTask`; demo branches: "Simulated cancellation/deletion/clearing" (`:290-339`). Demo-view task list is store-driven (`:178` `useServerHistory && isLive ? historyTasks : storeTasks`) |
| Policies (+ webhook/alerts/backups/tenants/users) | **Live when signed in; separate demo tree when not** | `SecurityPoliciesView.tsx:732-733` — `live ? <LiveSecurityPolicies/> : <SecurityPoliciesDemo/>`. Live: `:127` `api.policies()` + `api.policyHistory()`, `:144` `api.devices()`/`api.me()`, `:163` `api.devicePolicy`, `:219,230-231` `api.setDevicePolicy`/`resetDevicePolicy`, `:265` `api.simulatePolicy`, `:287` `api.deletePolicyVersion`, `:298,309` webhook get/set/test, `:597,604-605` alerts config/test/deliveries, `:650-651,671,696-697` backups create/list/download/restore, `:183` tenants; `AccountsPanel.tsx:8,32-33` users CRUD |
| Audit log | **Hybrid — rows live-synced, export live, verification NOT live** | Rows via store `syncWithBackend` from `api.audit()`; export live: `AuditTrailView.tsx:136` `api.exportAudit()` (`GET /api/audit/export`); verification honestly "unavailable": `AuditTrailView.tsx:59-62,105-121`. **New finding:** that claim is now stale — the backend *does* expose `GET /api/audit/verify` (`src/ai_bridge/control/routers/audit.py:73-76`, registered `src/ai_bridge/control/app.py:2177,2233`), but `api.ts` has no verify method and no dashboard file calls it |
| WebRTC / desktop streaming | **Live when signed in (Windows-only); demo placeholders otherwise** | `LiveDesktopView.tsx:1103-1140` `handleStartWebrtc` refuses non-live and non-Windows; `:1117` `api.createSessionV1`, `:1140` poll `api.getSessionV1` for offer, `:1157` `api.getIceServersV1()` (fallback STUN `stun:stun.l.google.com:19302`, `:1163`), `:1314` `api.postAnswerV1`, `:1268` `api.postIceV1`, `:1322-1323` `api.mintStreamTicket` + `new WebSocket(api.sessionWebSocketUrl(sid, ticket))`; frames fallback `:682-684` `api.desktopFrame`, monitors `:713-718`, files `:429,530`, input `:788-951` gated on `isLiveMode() && controlMode === "takeover"`, quality `:282-283,1341-1342`, recording seal `:665-666`. Demo: `:80,164` `INITIAL_WINDOWS` fake window list, `:657-664` seal "simulated", `:196` client-side `BITRATE_LADDER_KBPS`, `:1984` "Remote Operating System Canvas Simulation" fallback canvas, `:205,1426-1427` audio placeholder |
| Terminal | **Live PTY when signed in; labelled local simulation otherwise** | Live: `TerminalView.tsx:310-313` `api.createTerminalSession`/`listTerminalSessions`, `:387` `api.writeTerminalInput`, `:370` `api.resizeTerminal`, `:204`/`222-226` close + SSE via `api.terminalStreamUrl` with header auth; demo: `:36` `DEMO_TERMINAL_LINES`, `:408` `"[demo] Simulated output only — … was not run anywhere."`, `:473` "Demo: reconnect simulated", `:533` banner "Demo mode: this terminal is a local simulation" |
| Workflows | **Live when signed in; separate demo tree when not** | `WorkflowsView.tsx:677-681` — `live ? <WorkflowsLive/> : <WorkflowsDemoView/>`. Live: `:101` `api.workflows()`/`workflowTemplates()`/`aiTools("raw")`/`devices()`/`schedules()`, `:138,176` `api.workflowDetail`, `:150` SSE `api.streamWorkflowUrl`, `:227-228` cancel, `:238-239` retry, `:249` delete, `:261,272` template create/delete, `:286` `api.scheduleWorkflow`, `:323,328` `api.submitWorkflow`, `:556,571,585` schedule run-now/toggle/delete |
| Fleet operations / updates | **Hybrid** | Live config: `FleetOperationsView.tsx:258-264` `api.triggers()`/`schedules()`/`fleetVersion()`/`fleetDesktopFrames()`; live actions: `:357-387` `api.fleetBroadcast` + `api.broadcastStatus` polling, `:453-455` `api.updateFleet`, `:475-477` `api.createTrigger`, `:513-515,530-532,553-571,584-586,619-653` trigger/schedule create/delete/toggle/test/run-now; demo: `:440-447` broadcast progress faked with `setTimeout(1200)`, `:468` "Simulated fleet agent rolling update across N nodes" |
| AI providers & agents / MCP & OAuth | **Hybrid — provider cards now live/not-configured (D-03 fixed)** | Live settings: `AiApiHubView.tsx:619-624` `api.getAiSettings()`/`aiTools("raw")`/`aiFleet()`; save/clear `:679,701` `api.saveAiSettings`; ping measures real latency `:1135-1157`; execute live `:1222-1241` `api.aiAgent`/`api.aiExecute`; agents `:713-715,975,989,1015,1028,1042,1058,1070,1093-1094,1108,1124`; MCP `:723-760,814,833,870,910,923,936,952`; chat `:460-474,524` `api.aiChat` + SSE `api.aiChatStreamUrl`. MCP/OAuth view: `ConnectionsView.tsx:205-209` `api.connections()`, `:460-483` `api.deleteOAuthClient`, `:925,935` `api.updateOAuthClient`, plus direct `fetch` `tools/list` probe `:146-177` and OAuth discovery `:177-200` (bypass `api.ts`) |
| Human approvals | **Hybrid** | List from store (live-synced via `api.approvals()` in `syncWithBackend`); decisions live via store `resolveApproval` → `api.decide`; direct live calls `HumanApprovalsView.tsx:246-248` `api.replanApproval`, `:262-264` `api.deleteApproval`; demo: `:156` local `historyRecords` when not live, `:725` "Deny sample request", `:774` hold 600 ms demo vs 900 ms live |
| Overview / diagnostics & logs | **Hybrid** | Overview counts store-derived (`OverviewView.tsx:20-23,33-39`); live overlays only: `:44-45` `api.metricsSummary()` + `api.liveActivity(20)`, `:156-157` `api.supervisorRecover`. Diagnostics live: `:157-161` `api.logs(service, lines)`, `:181-193` polling + `refreshLive`; demo: `:331-332` `defaultLogs` when not live, `:346` hardcoded `30.72` MB ring-buffer value, `:64` seed log IDs filtered out when live |
| Settings (no dedicated view) | **Live (inside AI hub + Policies)** | AI settings as above; webhook/alerts/backups/tenants in `LiveSecurityPolicies`. No separate settings route exists |

### 4.4 Mock / seed / fake-data inventory (VERIFIED)

**Seed store — `src/state/dashboardStore.ts`** (still present, initial state; replaced wholesale only after auth by `syncWithBackend`, `dashboardStore.ts:813`, 9-call `Promise.all` of `me/health/devices/fleetTelemetry/tasks/approvals/audit/connections/workflows`, 50 ms after mount + every 15 s when `autoPollEnabled`, `dashboardStore.ts:764-772`, plus SSE-triggered full re-sync `dashboardStore.ts:777-808`):

- `:30-67` `createTelemetry()` — deterministic fake telemetry, e.g. `cpuPercent = 18 + (index*7)%55`, fake fingerprint `` `sha256:${(index*9876543210+…).toString(16).padStart(64,"0")}` ``.
- `:117` `SEED_DEVICES` — **40 devices** (`Array.from({length: 40})`): 1 showcase `srv-us-east-412` (`:128-129`), 11 `srv-win-prod-*`, 6 `ws-fin-win-*`, 6 `cad-gpu-win-*`, 6 `srv-us-west-*`, 4 `k8s-node-worker-*`, 2 `gpu-infer-h100-*`, 4 `mac-builder-m3-*`.
- `:306` `SEED_APPROVALS` — 3 fake approvals (`APR-4891/4892/4893`, incl. `rm -rf /opt/cache/node-modules-backup`, `iptables -F`).
- `:364` `SEED_TASKS` — 8 fake tasks (`TSK-89209…89216`).
- `:475` `SEED_WORKFLOWS` — 1 fake workflow `WF-1092`.
- `:529` `SEED_AUDIT_EVENTS` — 4 fake audit events, blocks `1492016-1492019`, with plausible-looking hashes e.g. `"d9a4f2108b1e43cb98016b01e38921a4fa0c558913b8e434220b22f0981e4b3c"`.
- `:577` `SEED_MCP_CONNECTIONS` — 4 (`mcp-stream-01…04`); `:629` `SEED_OAUTH_CLIENTS` — 3 (`client-cur-891`, `client-cld-104`, `client-py-092`); `:663` `SEED_LOGS` — 4 (`log-1…log-4`).
- `:749-755` operator profile `"Sarah Jenkins", "Lead SecOps Engineer", "sarah.j@security.internal"`, `gatewayLatencyMs: 14`.
- `:1150-1347` (tail methods `triggerEmergencyStop`/`resumeFleet`/`resolveApproval`/`dispatchTask`) — demo branches mutate local state and prepend fake audit events whose "SHA-256" is `` `sha256:${Date.now().toString(16).padStart(64,"0")}` `` (a timestamp, not a hash). Live branches call `api.emergencyStop/emergencyClear/decide/submitTask` and re-sync, throwing on failure.
- Live-mapping honest gaps (in `syncWithBackend`): fields the backend doesn't report stay 0/`"not reported"` — `cpuClockGhz: 0`, `networkRxMbps/TxMbps: 0`, `swap*: 0`, `tpmStatus: "inactive"`, `certExpiryDays: 0`, `fingerprintSha256: "unknown"`.

**Fixed fakes (present in the 17 Nov audit, gone now — VERIFIED by grep returning no hits in `src/views|src/state|src/api.ts|src/shell`):**
- Hardcoded Merkle root `0x7fa281b94d…`, `blocksChecked: 14920`, tautological `chainValid` — removed; `AuditTrailView.tsx:59-62` documents the removal, `:105-121` reports verification unavailable. (Only remaining hits are in `src/tests/*.test.ts` asserting their absence, e.g. `tier1-feature-coverage.test.ts:1106-1107`.)
- Fake provider keys `sk-ant-api03-***9a4`, `sk-proj-***410f`, `AIzaSy***71b9`, fixed latencies, `gemini-ultra`/`o1-preview` — removed; `AiApiHubView.tsx:276-305` `PROVIDER_DESCRIPTORS` now carry only id/name/defaultModel/endpoint, `status: "not_configured"`, `latencyMs: null`, `keyMasked: null` (except Ollama "No key required"); `:281` "there is no demo data in this list anymore."

**Remaining mock/fake/placeholder locations (current code, VERIFIED):**
- `src/views/TaskQueueVisionView.tsx:65` `DEFAULT_SOM_MARKS` (static SoM boxes); `:1221-1236` vision canvas fallback — now labelled (D-04 fix is labelling only), but the fake desktop underneath is unchanged: `:1236` "Top Simulated OS Bar", fake terminal `systemctl status ai-bridge-agent` / "WebSocket channel: verified (TLS 1.3)", fake "Packets/Sec" chart, "IPC Channel: OK • 14ms" (`:1236-1300`). It renders whenever no live frame exists, **including in live mode** when the frame fetch fails.
- `src/views/LiveDesktopView.tsx:80-88` `INITIAL_WINDOWS` (bash PID 1042, VS Code Server, Docker, System Monitor); `:164` used when not live; `:205,1426-1427` audio placeholder; `:657-664` recording seal in demo is a notice, not a seal; `:1984` "Remote Operating System Canvas Simulation" fallback canvas; `:196` client-side `BITRATE_LADDER_KBPS`.
- `src/views/TerminalView.tsx:36` `DEMO_TERMINAL_LINES` (fake Ubuntu MOTD etc.); `:408,473,533` as in table.
- `src/views/WorkflowsDemoView.tsx:383` "Demo data: sign in to plan and run real workflows. Everything below is a seeded preview."; `:663` "Simulated Canvas Graphic & Reticle".
- `src/views/SecurityPoliciesDemo.tsx:1` "DEMO-ONLY: seeded fixtures (fake hashes, webhooks). Rendered only when no credentials are present. Never mount in live mode."; `:197-228` fake webhook channels incl. masked URLs `https://discord.com/api/webhooks/112/***441`, `https://outlook.office.com/webhook/***teams`.
- `src/views/ConnectionsView.tsx:97-98` `SEED_MCP_IDS` / `SEED_CLIENT_IDS` (used to filter seed rows out when live, `:294,348`); `:240-250` hardcoded `demoSessions` ("Demo-only AI Client Sessions (never displayed in live mode)"); `:235-237,458-476` gateway-secret rotation — **live branch only refetches connections and shows a notice** ("Gateway secrets are managed by the control plane…"), demo branch fabricates success ("Master Gateway Secret successfully rotated. New ephemeral keys deployed…"); no rotation endpoint is called in either branch.
- `src/views/DiagnosticsLogsView.tsx:218-260+` `defaultLogs` (hardcoded structured logs, e.g. `log-01` mTLS handshake `srv-us-east-412`, `2026-11-02T14:28:09`); `:346` `30.72` MB when not live.
- `src/views/FleetOperationsView.tsx:440-447,468` simulated broadcast/fleet-update (see table); local rule/schedule cards are store-derived when not live (`:250-290` load only runs when live).
- `src/views/DevicesView.tsx:846-867` enrollment preview / "Simulate key generation" (no token issued); `src/views/Device360View.tsx:370-402,499-517` demo telemetry/agent/metadata/daemon (see table).
- `src/views/AiApiHubView.tsx:209,224,247` SDK snippets hardcode example URLs `https://bridge.internal/v1`, `https://bridge.internal/api/ai/execute` (static example text, not credentials); `:305` Ollama default `http://localhost:11434/v1` (env `VITE_OLLAMA_URL` override); `:287,293` provider endpoints are the real public Anthropic/OpenAI/Gemini API URLs (descriptors only).
- `src/App.tsx:57` fallback hostname `"srv-us-east-412"` (seed primary node) when no device is selected.
- `src/views/ConnectionsView.tsx:111`, `src/views/DevicesView.tsx:171`, `src/api.ts:8` — dev fallback `http://127.0.0.1:8000`; `vite.config.ts:6-10` — `VITE_PUBLIC_IP` default `"your-aws-ip"`.

---

## 5. Missing features & gaps (dashboard vs backend)

### 5.1 Method (VERIFIED)

Backend surface enumerated by grepping all `@router/@app` decorators in `src/ai_bridge/control/routers/*.py`, `v1_routes.py`, `mcp_routes.py`, `workspace_routes.py`, `ai_api.py`, `custom_agents.py`: **~215 routes** (Track 4: 216 = 215 decorators + 1 `api_route` for immutable audit, `routers/audit.py:56`; independent grep: 214 — difference is decorator-form edge cases, not a substantive gap). Dashboard surface enumerated from `apps/dashboard/src/api.ts` (~140 methods) plus per-view `api.*` usage and direct `fetch()` calls. Template-matching the two sets gives **47 backend routes with no dashboard reference**; each was classified by reading the handler (auth model, deprecation, duplication) rather than counted blindly.

**Headline:** coverage of the *dashboard-relevant* backend is broad — devices, tasks, approvals, policies, workflows, triggers/schedules, fleet broadcast/update, backups, alerts, MCP servers, custom agents, AI settings, terminal, WebRTC v1 sessions are all wired. The genuine gaps are concentrated in **governance (audit verification/retention), identity lifecycle (user delete/password, device-token rotation, mTLS), fleet search at scale, M365, and production-readiness visibility** — plus two live-mode buttons that promise actions with no backend endpoint at all.

### 5.2 Backend capabilities with NO dashboard UI — prioritised by user impact (VERIFIED)

1. **Audit-chain verification + retention — HIGH.** `GET /api/audit/verify` (`routers/audit.py:73`, real implementation `db.verify_audit_chain`, `src/ai_bridge/control/db.py:724`) and `POST /api/audit/retention` (`audit.py:78`, deletes rows older than N days, refused with 409 when WORM/SIEM export is required but unconfigured). No `api.ts` wrapper, no caller; grep for `retention`/`verify` in `apps/dashboard/src/` (outside tests) finds nothing. **Worse, `AuditTrailView.tsx:6-8,56-59,103-106` explicitly tells the user the opposite** — "the control plane exposes NO audit-chain verification result" / "Not verified — no cryptographic verification available" — a stale claim from before the endpoint existed. The view's honesty banner is now itself inaccurate: verification *is* available and is never called. Retention matters because audit tables grow unboundedly and the only deletion path is a raw API call.
2. **Server-side fleet inventory search/pagination — MEDIUM-HIGH (scales with fleet size).** `GET /api/fleet/inventory` (`workspace_routes.py:74`) supports `q`, `status`, `group`, `tag`, `page`, `page_size` (25/100) with a `device_metadata` join. Dashboard never calls it; `DevicesView.tsx:129-169` fetches the entire fleet via `GET /api/devices` (which has no pagination/filter params, `devices.py:112-143`) and filters/sorts client-side. At 40 devices this is invisible; at hundreds it is a load and UX problem, and group/tag filtering — although the data exists (`list_devices` returns `group`/`tags`, `devices.py:112-143`) — has no UI control at all.
3. **Device identity lifecycle: mTLS fingerprint + token rotation — MEDIUM-HIGH (security).** `POST /api/devices/{device_id}/mtls-fingerprint` (`devices.py:754`) has no dashboard caller; the fingerprint is only *displayed* (`Device360View.tsx:1343`, "Not reported" when absent). Separately, enrollment promises the token "expires and must be rotated" (`devices.py:109`, `token_expires_at` returned by list), but the only rotation endpoint is agent-self-service `POST /api/agent/rotate` (`agent.py:235`, device-token + mTLS auth) — **there is no admin-side rotate/reissue endpoint and no rotate/expiry-warning UI** in `DevicesView.tsx`/`Device360View.tsx` (the `RotateCcw` icons there are "Flush DNS" and "Reset Filters"). An admin cannot reissue a compromised or expiring device credential from the dashboard.
4. **Microsoft 365 connector — MEDIUM (if the feature is meant to be managed).** `GET/POST/DELETE /api/connectors/m365/*` (`auth.py:213-245`: status, login start returning `authorize_url`, callback, disconnect). Zero dashboard references; `ConnectionsView.tsx` covers only MCP servers + OAuth clients. *INFERENCE, not verified:* M365 may be intentionally CLI-managed; but as a shipped backend capability it is invisible in the only management UI.
5. **Production readiness / health detail — MEDIUM (ops).** `GET /health/ready` (`health.py:59`, embeds the full production checklist) and `GET /health/production-checklist` (`health.py:90`, operator role) plus `GET /health/live` (`:54`) have no UI. Dashboard calls only `GET /health` (`api.ts:251`) and `GET /api/metrics/summary`. An operator cannot see *why* the plane reports not-ready, or the readiness checklist, from the dashboard; `DiagnosticsLogsView.tsx` shows logs only.
6. **Per-tool policy dry-run — LOW-MEDIUM.** `POST /api/policy/simulate` (`admin.py:150`, FR-01: returns the `decide()` outcome — allowed/needs-approval/reason/rule — for one hypothetical `{tool, policy?, approval_granted?, device_id?…}` call) vs. the dashboard's whole-policy simulation `POST /api/policies/simulate` (`admin.py:140`; `SecurityPoliciesView.tsx:260-268,509`). An admin can preview a policy's tier table but cannot ask "would *this* tool on *this* device, right now, need approval?"
7. **Approval reason edit — LOW.** `PUT /api/approvals/{approval_id}` (`tasks.py:479`, reason-only, pending approvals only, 400 if you try to change status). Dashboard offers decide/replan/delete only (`HumanApprovalsView.tsx`). Trivial to add; low user impact.
8. **v1 device status — LOW (mostly covered).** `GET /api/v1/devices/{device_id}/status` (`v1_routes.py:342`) adds `active_user`, `ip_address`, `agent_version`, `human_takeover_active` over what `Device360View.tsx` gets from `GET …/overview`. The takeover flag in particular has no dedicated UI surfacing (it appears only implicitly via session mode in `LiveDesktopView.tsx`).
9. **Task result-only fetch — NOT A GAP in practice.** `GET /api/tasks/{task_id}/result` (`tasks.py:127`) is unused, but `GET /api/tasks/{id}` still returns `result` by documented contract (`tasks.py:98-127` comment) and `TaskQueueVisionView.tsx:538-541` reads it. Listed only for completeness; no UI work needed.
10. **Not gaps (VERIFIED, do not action):** legacy desktop WebRTC endpoints (deprecated/410, `webrtc.py:212-230`); `live.jpg` (equivalent of `desktop/frame`); v1 task/policy/audit duplicates (external-client variants); agent-only endpoints; OIDC/MCP-OAuth callbacks (browser redirects); OpenAI-compatible `/v1/chat/completions` + `/v1/models` (external-client surface; dashboard correctly uses `/api/ai/*`).

**Other backend capabilities confirmed wired (VERIFIED, for completeness):** device list/enroll/revoke/update/delete + policy get/set/reset + overview/telemetry/refresh (`devices.py:51,112,143,168,209,223,263,293,309,526,572`); fleet telemetry/health/version/desktop-capabilities (`devices.py:592,657,669,683`); fleet notifications (`workspace_routes.py:131`); fleet broadcast (`workflows.py:468,550`); fleet/single-device update (`workflows.py:841`, `devices.py:710`); tasks list/get/create/cancel/update/delete/clear + history + events (`tasks.py:49,89,98,127,143,159,174,231,244,256`); approvals list/decide/replan/delete (`tasks.py:256,267,303,501`); policies CRUD + history + whole-policy simulate (`admin.py:115,126,134,140,228,243`); audit list/export (`audit.py:26,60`); emergency stop/clear (`admin.py:50,61`); webhook settings/test (`admin.py:71,77,91`); alerts config/test/deliveries (`admin.py:435,447,466,484`); backups list/create/restore/download (`admin.py:490,501,523,534`); tenants list (`admin.py:624`, names only — see §5.4.3); connections/OAuth clients rename/revoke (`admin.py:253,320,351`); service logs (`admin.py:372`); live events/activity streams (`admin.py:407`, `workflows.py:444,453`); MCP tool policies (`admin.py:607,614`); MCP servers CRUD/sync/OAuth/execute + templates + OAuth discovery (`mcp_routes.py:218,226,236,245,378,560,601,657,674`); auth login/logout/me/CSRF (`auth.py:38,48,64,69`); OIDC login/configured/exchange (`auth.py:100,106,191`); users create/list/update (`auth.py:257,284`, `workspace_routes.py:32`); roles list/enable (`workflows.py:413,421`); workflows CRUD/cancel/retry/schedule/stream + templates (`workflows.py:61,82,98,112,142,163,179,196,214,254,298`); triggers/schedules (`workflows.py:602-804`); supervisor handoff/status/recover (`workflows.py:336,379,391`); AI tools/execute/agent/chat/settings (`ai_api.py:1653,1675,1900,2398,2448,2522,2600,2357`); custom agents CRUD/run/ask/runs/memory (`custom_agents.py:1203-1475`); desktop frame/fleet frames/monitors/input (`webrtc.py:44,83,116,187`); WebRTC v1 sessions incl. offer/answer/ICE/terminate/quality/clipboard/recording/ice-servers (`v1_routes.py:589,725,734,747,794,820,850,873,956,968`); device files/UI elements/monitors v1 (`v1_routes.py:393,423,438,452,490`); installers `GET /install.sh`, `GET /install.ps1` (`health.py:30,36`, as links in `DevicesView.tsx:174-178,673`).

**Partial coverage (VERIFIED):** device metadata (group/tags) — `PUT /api/devices/{id}/metadata` (`workspace_routes.py:54`) is called only from `live/DeviceWorkspace.tsx`; **no group/tag filter in `DevicesView.tsx`** (filters are status/platform/search/sort only, `:81-169`). Audit export date range — `GET /api/audit/export?since&until` (`audit.py:60`); `api.exportAudit()` (`api.ts:315`) takes no args; `AuditTrailView.tsx:79-80,116,159-194` filters/exports client-side only. Tenants — `GET /api/tenants` called and names listed (`SecurityPoliciesView.tsx:105,183,714-720`) but **no tenant switcher** (see §5.4.3). Health — only `/health` is called (`api.ts:251`); no UI for `/health/live`, `/health/ready`, `/health/production-checklist` (see §5.2.5). Metrics — `GET /metrics` (`health.py:102`) has no dashboard reference; the dashboard-facing `GET /api/metrics/summary` (`health.py:115`) *is* used (`api.ts:269`; `OverviewView.tsx`).

### 5.3 Dashboard affordances with NO backend support (VERIFIED)

Resolved all ~140 `api.ts` call targets against the ~215 backend routes (after normalising `${…}` template params and query strings): **every `api.ts` call has a matching backend route** — the six apparent mismatches in a naive diff were query-string artefacts. The unsupported affordances are therefore **not** in `api.ts`; they are buttons/handlers that never call the backend:

1. **"Add client" / "Test Handshake & Sign Token" fabricates a JWT client-side — HIGH (misleading).** `ConnectionsView.tsx:518-533` (`handleSignToken`, invoked from buttons at `:718` and `:1070`): builds `header.payload.signature` in the browser with a hardcoded fake signature `sig = "MEQCID3k8e8...ed25519"` and displays it as a generated token. **No `POST /api/connections/clients` endpoint exists** (backend has only GET/PUT/DELETE, `admin.py:253,320,351`); real dynamic registration exists only as a third-party `registration_endpoint` discovered via `mcp_oauth.py:322-385` / used in `mcp_routes.py:402`, which the dashboard never calls. The displayed "token" is not a credential and cannot authenticate anything. (Live in the signed-in view, not demo-gated.)
2. **"Rotate secret" rotates nothing — MEDIUM.** `ConnectionsView.tsx:458-476,706`: in live mode it only re-fetches `api.connections()` and shows the notice "Gateway secrets are managed by the control plane… Refreshed active token state."; in demo mode it fabricates "Master Gateway Secret successfully rotated…". No secret-rotation endpoint exists anywhere in the backend (grep for `rotate_secret`/secret rotation: zero). Prior audit `09_…:231` flagged this as *inferred*; it is now **verified**. Note the live-mode notice is arguably honest ("managed by the control plane") — the defect is the button label promising rotation.
3. **"Capture snapshot" claims a PNG that is never produced — LOW.** `LiveDesktopView.tsx:948-957`: sets the notice "High-res desktop frame buffer captured (3840×2160 PNG)" but only calls `fetchLiveFrame(1.0, 85)` (i.e. `GET …/desktop/frame`) and clears the notice after 2.5 s; nothing is saved or downloaded, and no 3840×2160 PNG exists. The backend *does* provide the frame — the missing part is the artefact the notice promises.
4. **Demo-mode simulated actions are excluded from this section** (mock/demo track owns them: e.g. `DevicesView.tsx:255,274`, `TaskQueueVisionView.tsx:301-339`, `FleetOperationsView.tsx:468` "Simulated fleet agent rolling update"). They are labelled as simulated in the UI and were not re-litigated here.

### 5.4 Product-level gaps (each checked genuinely absent — VERIFIED by grep)

1. **No user deletion or password change/reset — anywhere.** Backend: users are create (`auth.py:257`), list (`:284`), PATCH role/disabled (`workspace_routes.py:32`); grep for a delete-user or password-change endpoint: zero. Dashboard: `live/AccountsPanel.tsx` offers only Add user / Edit (role + disable checkbox); grep for "change password / reset password / forgot password" in `apps/dashboard/src/`: zero. A compromised or departing account can only be *disabled*, never removed, and a user cannot rotate their own password. (Both sides missing — a backend endpoint plus UI are both needed.)
2. **No OAuth-client creation in UI or API.** `ConnectionsView.tsx:637,983` directs the admin to run `scripts/setup_mcp_chatbots.py`. How checked: no `POST /api/connections/clients` in `admin.py:253-371`; no create-client button/handler in `ConnectionsView.tsx` (only rename via `updateOAuthClient` at `:922-925` and revoke at `:940-943`).
3. **No tenant switching.** `GET /api/tenants` is called and names are listed (`SecurityPoliciesView.tsx:105,183,714-720`), but grep for `setTenant/currentTenant/switchTenant` or a tenant selector in `apps/dashboard/src/`: zero. Tasks carry the *device's* tenant automatically (`live/TaskComposer.tsx:34` passes `device.tenant`); an admin with access to multiple tenants cannot switch scope from the dashboard. (Backend note: non-legacy sessions see only their own tenant, `admin.py:624-640`, so this is partly a backend scoping decision, not purely a UI gap — INFERENCE.)
4. **No bulk device actions.** `DevicesView.tsx` has per-row revoke/delete and a single `selectedDeviceId` (store, `:69-70,492,551,564`); grep for bulk/select-all/checkbox multi-select: zero. No "revoke all offline", "update all Windows nodes", or multi-select — the fleet-wide operations that exist are the separate broadcast/update endpoints, not row-level bulk selection.
5. **No audit export date-range UI** (from §5.2): backend supports `since`/`until` (`audit.py:60`); `api.exportAudit()` takes no arguments and `AuditTrailView.tsx:116,159-194` exports only the client-side filtered set. For a large audit table the only way to bound an export is a raw API call.
6. **No group/tag-based fleet filtering** (from §5.2.2): metadata (group/tags) is settable (`live/DeviceWorkspace.tsx` → `PUT …/metadata`) and returned by device list, but `DevicesView.tsx` filters only by status/platform/free-text. How checked: filter state at `DevicesView.tsx:81-169` enumerated — no group/tag state exists.
7. **No M365, readiness, or metrics UI** — see §5.2.4, §5.2.5, and the `GET /metrics` row in §5.2. How checked: zero dashboard references to `m365`, `health/ready`, `production-checklist`, `/metrics` (only `/api/metrics/summary` is used).
8. **Not a gap (checked, present):** global search / command palette exists (`shell/AppShell.tsx:117,166`, Ctrl+K); installer commands are shown after enrollment (`DevicesView.tsx:174-178`); session recording get/seal is wired (`LiveDesktopView.tsx:665-666`); clipboard sync, quality change, file upload/download, UI-element query are all wired in `LiveDesktopView.tsx`.

---

## 6. Code quality / consistency (brief)

### 6.1 State management (VERIFIED)

**One hand-rolled singleton store, no store library, no React Context, no server-state library.** Zero `createContext`/`useContext`/`useReducer` matches in `src/` (excluding tests), and `package.json` has no zustand/redux/react-query dependency.

- **Global store:** `src/state/dashboardStore.ts` (1,347 lines). Class `DashboardStore` (line ~722) holds all fleet state in one mutable object, notifies via a `Set<() => void>` listener set, and exposes `useDashboardStore(selector)` (line ~1335) built on `useSyncExternalStore`. Exported singleton `dashboardStore` (line ~1318).
- **Contents:** 40 seeded demo devices (`SEED_DEVICES`, line ~145), seeded approvals/tasks/workflows/audit/MCP/OAuth/logs, plus live-sync via `syncWithBackend()` (15 s `setInterval` + SSE event stream, `startEventStream` ~line 786). Live data *replaces* seed data when authenticated; demo mode mutates the seeds locally (e.g. `dispatchTask`, `resolveApproval`).
- **Routing state:** separate tiny module `src/state/navigation.ts` (hash read/write, `viewIds` list, 16 ids) — the store imports it. Navigation items live in `src/shell/navigation.ts` (15 nav entries + labels/icons).
- **Local UI state:** per-component `useState` everywhere (filters, modals, loading flags); `src/views/live/preferences.ts` holds a `usePreferences` hook (localStorage-backed filters) used by `LiveWorkspace.tsx` and `Inventory.tsx`. This is a second, smaller state pattern alongside the store — mild inconsistency, but scoped to the live workspace.
- **i18n state:** a second `useSyncExternalStore` mini-store in `src/i18n/index.ts` (module-level `locale` + listeners) — a third state mechanism, again small and self-contained.
- **Consistency verdict:** consistent for the main data (everything reads the one store — 20 files import `useDashboardStore`/`dashboardStore`, including all 18 top-level views; verified via grep), but there are three parallel mechanisms (dashboard store, live-workspace preferences hook, i18n locale store) rather than one. No competing global stores.

### 6.2 API client centralisation (VERIFIED)

**Mostly centralised, with documented exceptions.** `src/api.ts` (545 lines) exports one `api` object (~140 methods) over a single private `call()` helper (auth headers, CSRF token fetch, 15 s timeout, `ApiError` with `uncertain` flag for mutating requests). Base URL resolution (`VITE_API_URL` → same-origin → `http://127.0.0.1:8000`) is in one place.

Ad-hoc `fetch`/`WebSocket` outside `api.ts` (verified by grep, excluding tests): `dashboardStore.ts:786` (SSE via fetch+ReadableStream — justified, `EventSource` can't send auth headers; URL built by `api`); `LiveControlView.tsx:171`, `WorkflowsView.tsx:150`, `TerminalView.tsx:227` (same SSE justification); `LiveDesktopView.tsx:1323` (`new WebSocket(api.sessionWebSocketUrl(sid, ticket))` — justified); `AiApiHubView.tsx:474` (SSE, URL from `api`). **True bypasses (third-party URLs, necessarily outside the control-plane client, but duplicating header/timeout handling):** `AiApiHubView.tsx:227` (direct call to an AI provider endpoint) and `ConnectionsView.tsx:146,177` (direct fetches to an MCP server URL and an OAuth metadata URL). No `axios`, `XMLHttpRequest`, or `EventSource` anywhere. Note: `api.login()` uses a raw `fetch` instead of `call()` (it predates auth headers, so arguably correct), and `api.health`/`api.oidcConfigured` use raw fetch with their own timeouts — three parallel fetch styles inside the "central" client itself.

### 6.3 Error / loading / empty-state patterns (VERIFIED)

**Inconsistent — three patterns coexist, no shared error component.**

- **Shared empty-state component exists and is used:** `src/components/PageEmpty.tsx` (`role="status"`, title/description/action, optional "Sample data mode" badge) — used in 9 places: `ConnectionsView.tsx:643`, `DevicesView.tsx:471`, `LiveControlView.tsx:285,563,576`, `OverviewView.tsx:79`, `TerminalView.tsx:549`, `LiveDesktopView.tsx:1446,1458`.
- **Shared freshness/loading component:** `src/components/Freshness.tsx` (`role="status"`, "Refreshing…"/"Not loaded"/relative time + stale detection) — used by `LiveControlView.tsx:268` and elsewhere.
- **Per-view ad-hoc error state:** `LiveControlView.tsx:51-52,70,154` (`error`/`loading` useState); `LoginView.tsx:33,66` (sign-in error string); `DevicesView.tsx:105,298,910-911` (dispatch errors shown in a `JXAlert severity="success"` titled "Dispatch Status" — **an error message rendered inside a success-styled alert**, `DevicesView.tsx:910`); `AiApiHubView.tsx:175` (`describeError()` helper, 40 catch mentions); `LiveDesktopView.tsx` (38 catch mentions, most thorough).
- **Views with no visible error handling:** `OverviewView.tsx` — zero matches for `error`/`Error` in the whole file; it renders only store data, so a failed backend sync is invisible except via the shell's stale indicator. `AuditTrailView.tsx` — exactly one `catch` (line 154, silent `catch {}` around export); no error UI. `SecurityPoliciesDemo.tsx` and `WorkflowsDemoView.tsx` — zero catch/setError mentions, but both are demo-only fixture renderers, so this is by design, not a gap.
- **Dead error signal (VERIFIED):** the store sets `gatewayStatus: "degraded"` on sync failure (in `syncWithBackend`'s catch), but **no view or shell component reads `gatewayStatus`** — grep finds zero consumers outside the store. The only failure surfacing is `Freshness` staleness (age-based, not error-based).
- **Loading:** mostly via the `JXButton loading` prop (per-action spinners, e.g. `ConnectionsView.tsx:694`, `DiagnosticsLogsView.tsx:437`) plus `role="status"` text in `LiveControlView.tsx:297` ("Loading your control plane…"). No global skeleton/loading convention.

### 6.4 Accessibility (VERIFIED — static source inspection only; no axe run, no screen-reader/keyboard testing)

175 `aria-*`/`role=` occurrences in `src/` (excluding tests) — the shell and shared components are good; individual views are mixed.

**Good examples:** `src/shell/SidebarNav.tsx:17` — `<nav aria-label="Main navigation">`; `:38` pending-count badge has `aria-label`; `src/shell/CommandPaletteModal.tsx:49,58,61` — proper combobox/listbox/option roles, `aria-expanded`, `aria-autocomplete`; `:18-25` Escape/arrow-key handling; `src/ui.tsx:129` (`ProductStatusDot`) — `role="status"` wrapper; `src/tailwind.css:129` — global `:focus-visible { outline: 2px solid var(--product-focus-ring); outline-offset: 3px; }`; `src/ui.tsx:8,328,352` — `GlassModal` uses native `<dialog>` (focus trap, inert background, Escape); `src/views/WorkflowsView.tsx:411` — clickable card is `role="button" tabIndex={0}` with Enter-key handler; `src/LanguageControl.tsx:26-30` — search input wrapped in a real `<label>`; RTL support via `document.documentElement.dir` (`src/i18n/index.ts:13`); `src/i18n/index.ts:12` — sets `document.documentElement.lang` on locale change.

**Bad / inconsistent examples:**
- **Color-only status dots:** `ProductStatusDot` without a `label` renders only a colored pulsing dot — `src/components/Freshness.tsx:14,22,42`, `src/shell/AppShell.tsx:132,143`, `src/shell/TopHeader.tsx:52` all call it label-less (the dot is the *only* status indicator in those spots; the `role="status"` span has no text content when label is omitted).
- **Placeholder-only inputs (no label, no aria-label):** `src/views/AuditTrailView.tsx:307-320` — "Search target host..." and "Filter by hash..." inputs have only `placeholder` (placeholders are not accessible names; the sibling `<select>`s at `:284,296` do have `aria-label`). Same pattern likely in other views (15 `<input` matches across views; spot-checked `AiApiHubView.tsx:2100` checkbox *is* correctly wrapped in a `<label>`).
- **Hardcoded `lang="en" dir="ltr"` on status text** in `src/LanguageControl.tsx:22,44,45` and `src/views/LiveControlView.tsx:297` — English strings explicitly marked as English even when the UI locale is e.g. Persian; deliberate (untranslated copy) but means screen readers get English announcements in a non-English UI.
- `src/views/DevicesView.tsx:460-464` — table headers are plain `<th>` with no `scope` attributes.

### 6.5 i18n coverage (VERIFIED)

**Narrow by design, but the catalog itself has a gap.**

- **Languages:** 20 locales — `en, ar, bn, zh-Hans, zh-Hant, fr, de, he, hi, id, ja, ko, fa, pt, ru, es, ta, tr, ur, vi` (`src/i18n/catalogs.ts:22-42`), with RTL dirs for ar/he/fa/ur. **47 messages** in the `messages` array (`catalogs.ts:6-13`).
- **Coverage is intentionally partial:** the file header (`catalogs.ts:1-7`) states "Core navigation/sign-in translations. Operational and safety copy stays in English until reviewed." Only shell chrome is translated.
- **Who actually uses it (VERIFIED):** only **7 files** import `useLanguage`: `DensityControl.tsx`, `LanguageControl.tsx`, `ThemeControl.tsx`, `views/LiveControlView.tsx`, `views/LoginView.tsx`, `views/live/LiveWorkspace.tsx`, `views/live/shared.tsx`. All other 16 top-level views and 8 of 10 live panels never call `t()`. (A naive `t("` grep gives false positives — `setX("")`, `createElement("a")`, `split("?")` — the import grep is authoritative.)
- **Hardcoded English is the norm in views:** e.g. `views/OverviewView.tsx:63` "Fleet overview", `:148` "Recent failures", `:183` "Recent tasks", `:185` "View all"; `views/DevicesView.tsx:432-434` "Hostname/Latency/Heartbeat", `:460-464` "Status/Device/Last seen/Actions"; `views/LiveControlView.tsx:297` "Loading your control plane…". This matches the stated policy, but means ~95% of visible UI strings are untranslated.
- **Catalog gap (VERIFIED by reading all 19 rows):** the last 5 messages — "Theme", "Switch to light theme", "Switch to dark theme", "Light", "Dark" — are **left in English in every non-English row** (`catalogs.ts`, e.g. ar row lines ~40-41, fa, zh-Hans, etc.). The catalog test (`src/tests/catalogs.test.ts:6-19`) only checks row length, non-emptiness, and token matching — it cannot catch untranslated strings, so this passes CI silently. `ThemeControl.tsx:56` uses `t("Switch to light theme")`, so the theme toggle is untranslated in all 19 locales.
- **Test:** `catalogs.test.ts` (node:test, run via `npm run test:i18n`) covers row completeness, token parity, locale resolution (`pt-BR`→`pt`, `zh-TW`→`zh-Hant`, invalid→`en`), and interpolation safety.

### 6.6 Dead code (VERIFIED)

- **Not dead (verified):** `SecurityPoliciesDemo.tsx` and `WorkflowsDemoView.tsx` look orphaned but are imported as the demo-mode branches — `SecurityPoliciesView.tsx:8,733` and `WorkflowsView.tsx:9,678`. Both export a named and a default export (e.g. `SecurityPoliciesDemo.tsx:80,841`) — redundant dual exports, but both are live code.
- **`stitch_design_system_implementation/`** (14 subdirs + `design.md`): design-reference material only. No source file imports it; the only references are test files explicitly *excluding* it from directory scans (`r1-tech-stack.test.ts:97`, `r2-r3-anti-ai.test.ts:29`, `r4-reconstruction.test.ts:60`). Dead weight in the repo, not in the bundle.
- **Committed build/test artifacts:** `dist/` (built JS/CSS bundles, e.g. `dist/assets/index-CjR-8keK.js`) and `test-results/` exist in the tree. Whether they are git-tracked could not be verified (no git history in this checkout) — flagging as suspected committed artifacts, not confirmed.
- **No TODO/FIXME/XXX/HACK markers** anywhere in `src/` (excluding tests). Only one commented-out code line found: `src/views/DevicesView.tsx:205` (`// <TOKEN> placeholder variants …`) — a comment, not dead code.
- **Unused exports:** all 19 named exports in `src/ui.tsx` are used elsewhere (lowest: `ProductToolbar` 3 uses, `ProductStepProgress` 4 uses — checked by grep). `SEED_DEVICES`/`SEED_APPROVALS`/`SEED_TASKS` are imported by tests (`tier1-feature-coverage.test.ts:41-43`) as well as the store. `BrandArt` (`src/Brand.tsx`) is used only by `LoginView.tsx`. `src/hooks/useScrollShadow.ts` is used by 8 views — live.

### 6.7 Test / TypeScript / lint setup (measured counts — VERIFIED by counting, suite NOT run)

- **TypeScript:** `tsconfig.json` — `strict: true`, `target ES2020`, `moduleResolution: bundler`, `noEmit: true`, `skipLibCheck: true`. **But `src/tests` is excluded from type-checking** (`"exclude": ["src/tests"]`) — test code is not type-checked by `tsc -b` (it runs via `tsx`, which strips types without checking).
- **Lint:** **none.** No ESLint/Prettier/Stylelint config, no lint script in `package.json`. The only static checks are `tsc -b` (in `build`) and the custom test runner.
- **Scripts (`package.json`):** `dev` (vite), `build` (`tsc -b && vite build`), `preview`, `test` (`tsx src/tests/run-all-tests.ts && npm run test:i18n`), `test:i18n` (`tsx --test src/tests/catalogs.test.ts`), `test:browser` (playwright). No test framework dependency — tests use a **custom harness** (`src/tests/harness.ts`: hand-rolled `describe`/`it`/`expect`, `test = it` at line 99) over `node:assert/strict`, plus `ReactDOMServer` rendering for view tests. Playwright + `@axe-core/playwright` for e2e (6 spec files).
- **Counts actually measured (textual, not executed):** view files **28** (18 top-level + 10 live); 16 routes in `viewIds`; unit-test files **13** `*.test.ts` in `src/tests/` + `harness.ts` + `run-all-tests.ts` (15 files, 6,540 lines total); `it(` call sites in `src/tests/*.test.ts`: **386**; `test(` call sites: **37** (incl. `catalogs.test.ts`); combined **423**. Per-file `it(`: tier1 159, tier2 160, tier3 12, tier4 11, tier5 5, r1 8, r2-r3 8, r4 7, r5 6, challenger-stress 2, challenger-m1-2 4, challenger-compliance 4, catalogs 0. E2E: **48** `test(`/`it(` occurrences across 6 files in `e2e/`. Test files import only: `dashboardStore`, `navigation`/`state/navigation`, `i18n/catalogs`, `types/dashboard`, `fs`/`path` (static source scans), and `ReactDOMServer` — i.e. **tests exercise the store, routing, i18n catalogs, and static source properties; they render views server-side but do not mount/interact with views in a browser** (except Playwright e2e). No test file imports any individual view component for unit testing — view coverage is via R4 reconstruction tests (string/structure checks) and Playwright.
- **Pass/fail unknown:** the suite was **not run** in this audit, so pass/fail and real assertion counts are unknown. The prior audit's "310/356 tests assert on literals" was not re-verified. A prior Wave 7 run reported the dashboard suite passing (430/430) — **not re-verified here**; note the textual count (423 call sites) does not match 430, so the 430 figure likely counts a different set (e.g. including e2e or i18n) and should not be quoted as the unit-test count.

---

## 7. Prioritised findings

Severity: **P0** = critical security/data-loss or system-breaking; **P1** = major security, trust, or governance defect; **P2** = significant product/maintainability gap; **P3** = minor / polish. **No P0 was found** — the dashboard's prior P0-class demo-fabrication issues (D-01/D-02/D-03) are fixed in code.

### P1 — major (fix first)

| # | Finding | Evidence |
|---|---|---|
| P1-1 | **"Add client / Test Handshake & Sign Token" fabricates a JWT in the browser and presents it as a credential.** A signed-in admin can believe they generated a real token. No `POST /api/connections/clients` exists; real registration is a third-party `registration_endpoint` the dashboard never calls. | `ConnectionsView.tsx:518-533` (fake `sig = "MEQCID3k8e8...ed25519"`), buttons `:718`, `:1070`; backend only GET/PUT/DELETE (`admin.py:253,320,351`); `mcp_oauth.py:322-385`, `mcp_routes.py:402` |
| P1-2 | **Audit verification exists server-side but the dashboard claims it doesn't and never calls it.** The view's honesty banner ("the control plane exposes NO audit-chain verification result") is now inaccurate, and the audit ledger can never be verified from the UI. Retention (unbounded audit growth) also has no UI. | Backend `GET /api/audit/verify` (`routers/audit.py:73`, `db.py:724`), `POST /api/audit/retention` (`audit.py:78`); view claims the opposite (`AuditTrailView.tsx:6-8,56-59,103-106`); no `api.ts` wrapper/caller |
| P1-3 | **No admin-side device-token rotation or mTLS fingerprint management.** Enrollment promises tokens expire and must be rotated, but the only rotation endpoint is agent-self-service; an admin cannot reissue a compromised or expiring device credential from the dashboard. Fingerprint is display-only. | `POST /api/devices/{id}/mtls-fingerprint` (`devices.py:754`) — no dashboard caller; `POST /api/agent/rotate` (`agent.py:235`) agent-only; `Device360View.tsx:1343` ("Not reported"); token expiry promise (`devices.py:109`) |
| P1-4 | **No user deletion or password change/reset — backend or dashboard.** A compromised or departing account can only be *disabled*, never removed; a user cannot rotate their own password. | Backend: create/list/PATCH only (`auth.py:257,284`, `workspace_routes.py:32`); dashboard: `live/AccountsPanel.tsx` Add/Edit only; grep for delete-user/change-password: zero both sides |
| P1-5 | **"Rotate secret" button promises rotation and does nothing (live mode).** It only re-fetches connections and shows a notice; no rotation endpoint exists. The demo branch fabricates a success message. | `ConnectionsView.tsx:458-476,706`; grep for `rotate_secret`/secret rotation: zero in backend |

### P2 — significant

| # | Finding | Evidence |
|---|---|---|
| P2-1 | **40-device seed still ships as the store's initial state.** An unauthenticated user who opts into demo sees a convincing fake fleet from first render; demo views are hybrid, so seed-derived values can persist for anything a view doesn't fetch live. | `dashboardStore.ts:117,722-755`; `syncWithBackend` replaces only devices/tasks/approvals/audit/logs/MCP/OAuth/workflows (`:813`); live-mapping gaps stay 0/`"not reported"` |
| P2-2 | **Vision canvas renders a fake desktop in live mode when the frame fetch fails.** Now labelled, but a live-mode operator can still be shown a simulated Ubuntu desktop instead of an error/empty state. | `TaskQueueVisionView.tsx:1221-1236,1236-1300` |
| P2-3 | **No server-side fleet inventory search/pagination.** Dashboard fetches the entire fleet and filters client-side; group/tag filtering has no UI control at all despite the data existing. | `GET /api/fleet/inventory` (`workspace_routes.py:74`) — zero dashboard hits; `DevicesView.tsx:129-169` client-side over `GET /api/devices` (`devices.py:112-143`) |
| P2-4 | **No production-readiness / health-detail UI.** Operator cannot see *why* the plane reports not-ready or the readiness checklist from the dashboard. | `GET /health/ready` (`health.py:59`), `GET /health/production-checklist` (`:90`), `GET /health/live` (`:54`) — no UI; only `/health` called (`api.ts:251`) |
| P2-5 | **No M365 connector UI** (conditional on product intent — may be intentionally CLI-managed; INFERENCE). A shipped backend capability is invisible in the only management UI. | `GET/POST/DELETE /api/connectors/m365/*` (`auth.py:213-245`); zero dashboard references |
| P2-6 | **No tenant switching.** Tenants are listed but an admin with multiple tenants cannot switch scope; tasks carry the device's tenant automatically. | `GET /api/tenants` listed (`SecurityPoliciesView.tsx:105,183,714-720`); grep for `setTenant/currentTenant/switchTenant`: zero |
| P2-7 | **No bulk device actions.** Per-row revoke/delete only; no multi-select, "revoke all offline", or "update all Windows nodes". | `DevicesView.tsx` single `selectedDeviceId` (`:69-70,492,551,564`); grep for bulk/select-all: zero |
| P2-8 | **No audit export date-range UI.** Backend supports `since`/`until`; the dashboard exports only the client-side filtered set. | `GET /api/audit/export?since&until` (`audit.py:60`); `api.exportAudit()` takes no args (`api.ts:315`); `AuditTrailView.tsx:116,159-194` |
| P2-9 | **No per-tool policy dry-run.** Admin can preview a whole policy's tier table but cannot ask "would *this* tool on *this* device, right now, need approval?" | `POST /api/policy/simulate` (`admin.py:150`) — no wrapper; whole-policy only (`admin.py:140`; `SecurityPoliciesView.tsx:260-268,509`) |
| P2-10 | **Desktop audio capture not shipped** (labelled placeholder, not a silent fake). | `LiveDesktopView.tsx:205,1426-1427` |
| P2-11 | **No OAuth-client creation (UI or API).** Admin is told to run a script. | No `POST /api/connections/clients`; `ConnectionsView.tsx:637,983` directs to `scripts/setup_mcp_chatbots.py` |
| P2-12 | **Duplicated live/demo implementations and scattered logic.** 5 independent SSE implementations; two device-detail views; two policy/workflow trees; two empty-state components; no shared status-badge or table/filter component; status/timestamp mapping re-implemented per view. | §3.4 (all file:line pairs) |
| P2-13 | **i18n is shell-chrome-only (~95% of view strings hardcoded English) and the catalog has 5 untranslated theme strings in all 19 locales that the catalog test cannot catch.** | `catalogs.ts:1-7,22-42`; only 7 files import `useLanguage`; theme strings English in every non-English row; `catalogs.test.ts:6-19` checks only length/non-emptiness/token parity |
| P2-14 | **No shared Settings view/route.** Settings are scattered inline across the AI hub and Policies view; there is no single place for webhook/alerts/backups/tenants/AI settings. | No Settings view in `shell/navigation.ts:9-31` or `App.tsx:148-181`; settings inline in `SecurityPoliciesView.tsx:169-183,651-697` and `AiApiHubView.tsx` |

### P3 — minor / polish

| # | Finding | Evidence |
|---|---|---|
| P3-1 | **"Capture snapshot" notice promises a 3840×2160 PNG that is never produced.** It only re-fetches the frame and clears the notice after 2.5 s. | `LiveDesktopView.tsx:948-957` |
| P3-2 | **Dead `gatewayStatus: "degraded"` signal.** The store sets it on sync failure but no view or shell component reads it; failure surfacing is age-based staleness only. | `dashboardStore.ts` (`syncWithBackend` catch); grep: zero consumers outside the store |
| P3-3 | **No 404 page; two dead router code paths.** Unknown hashes silently resolve to `#/login`; `case "login"` in `App.tsx` is unreachable (early return); `default:` duplicates `#/overview`. | `navigation.ts:15`; `App.tsx:150-151,180-181,186-187` |
| P3-4 | **No lint config; tests excluded from `tsc`; custom test harness.** Only static checks are `tsc -b` (in `build`) and a hand-rolled runner. | No ESLint/Prettier config; `tsconfig.json` excludes `src/tests`; `src/tests/harness.ts` |
| P3-5 | **Accessibility inconsistencies.** Color-only status dots with no accessible name; placeholder-only inputs with no label; plain `<th>` without `scope`; English strings hardcoded `lang="en"` in non-English UI. | `Freshness.tsx:14,22,42`, `AppShell.tsx:132,143`, `TopHeader.tsx:52`; `AuditTrailView.tsx:307-320`; `DevicesView.tsx:460-464`; `LanguageControl.tsx:22,44,45`, `LiveControlView.tsx:297` |
| P3-6 | **Error rendered inside a success-styled alert; two views lack error UI.** Dispatch errors shown in `JXAlert severity="success"`; `OverviewView.tsx` has zero `error` handling; `AuditTrailView.tsx` has one silent `catch {}`. | `DevicesView.tsx:910`; `OverviewView.tsx` (zero `error` matches); `AuditTrailView.tsx:154` |
| P3-7 | **Dead re-exports and exports.** `TiltCard` re-exported but never used; `getResolvedTheme` exported but never called; `AdaptiveGlass`/`NumberCounter` only used inside `ui.tsx` itself. | `ui.tsx:25,44,84,100`; `ThemeControl.tsx:14` |
| P3-8 | **Approval reason edit missing** (backend `PUT /api/approvals/{id}` exists; dashboard offers decide/replan/delete only). | `tasks.py:479`; `HumanApprovalsView.tsx` |
| P3-9 | **v1 device status (richer) not used** — `active_user`, `ip_address`, `agent_version`, `human_takeover_active` not surfaced; `Device360View` uses `GET …/overview` instead. | `v1_routes.py:342`; `Device360View.tsx` |
| P3-10 | **Suspected committed build/test artifacts and dead design-reference weight.** `dist/` and `test-results/` exist in the tree; `stitch_design_system_implementation/` (14 subdirs) is imported by nothing. Git-tracked status **not verified** (no git history in this checkout). | `apps/dashboard/dist/`, `test-results/`; `stitch_design_system_implementation/`; test-file exclusions at `r1-tech-stack.test.ts:97`, `r2-r3-anti-ai.test.ts:29`, `r4-reconstruction.test.ts:60` |

---

## 8. Recommended next steps (ordered)

1. **P1-1 / P1-5 (trust):** Remove or gate the fabricated-JWT and rotate-secret controls until real endpoints exist; a button must not present a fake credential or a fake success as real.
2. **P1-2 (governance):** Wire `GET /api/audit/verify` into `api.ts` and `AuditTrailView`, correct the stale "no verification" copy, and add a retention control (with the WORM/SIEM 409 surfaced).
3. **P1-3 / P1-4 (identity):** Add an admin-side device-token rotate/reissue endpoint + expiry warnings, and a user delete / password-change endpoint + UI (both need backend + dashboard work).
4. **P2-1 (demo hygiene):** Don't initialise the store with the 40-device seed when no demo acknowledgement exists (or initialise empty and load seeds only on explicit demo entry), so an unauthenticated first render cannot be mistaken for a fleet.
5. **P2-3 / P2-7 / P2-8 (fleet at scale):** Adopt `GET /api/fleet/inventory` (server search/pagination + group/tag filter), add bulk device actions, and pass `since`/`until` through `api.exportAudit()`.
6. **P2-12 (maintainability):** Extract a shared SSE hook, a shared status-badge and table/filter/pagination component, and collapse the duplicated live/demo device-detail and policy/workflow trees behind one implementation.
7. **P2-13 (i18n):** Translate the 5 theme strings in all 19 locales and strengthen `catalogs.test.ts` to fail on untranslated (identical-to-English) strings; decide whether operational copy stays English-by-policy or gets translated.
8. **P2-4 (ops visibility):** Add a readiness/health panel surfacing `/health/ready` and `/health/production-checklist`.

---

## 9. Method, scope, and unknowns

**Method.** Five parallel read-only tracks (routes/pages; components; real-vs-mock; gaps vs backend; code quality), each reading source and grepping for evidence, then synthesised here. The prior audit `analysis/09_DASHBOARD_ARCHITECTURE_AUDIT.md` was read as background only and re-verified claim-by-claim against current code (§1 table). Two numeric discrepancies between tracks were resolved by direct counting: `api.ts` has ~140 methods (Track 4 said ~128 call targets, Track 5 said ~150 methods — different counting methods); backend routes are ~215 (Track 4: 216; independent grep: 214). View code is 19,516 lines by direct `wc -l` (Track 5's 20,437 used a different file set — the 19,516 figure is the one measured here).

**Scope limits (what this audit did NOT do).**
- No dev server, build, or browser run — runtime behaviour (rendering, network, auth flows, OIDC redirect landing, demo-acknowledgement persistence across tabs, whether `App.tsx` `default:` ever fires) is **inferred from code only**, not observed.
- Test suite **not run** — pass/fail and real assertion counts are unknown; the 423 figure is a textual count of `it(`/`test(` call sites.
- `tsc -b` / Vite build **not run** — whether the code currently type-checks/builds clean is unknown.
- Whether `dist/` and `test-results/` are git-tracked is **not verified** (no git history in this checkout).
- Accessibility findings are from static source inspection only — no axe run, no screen-reader/keyboard testing (the Playwright suite includes `@axe-core/playwright` but was not executed).
- `Device360View.tsx:720-731` references `magic-install.sh` / `magic-install.ps1` as install commands, while the backend serves `/install.sh` and `/install.ps1` (`health.py:30,36`). Whether `magic-install.*` paths resolve (rewrite? static asset? 404?) was **not verified** — flagged, not asserted.
- Login call chain not fully traced end-to-end (`LoginView.tsx` → store → `api.ts`-internal helper at `api.ts:204`); no claim is made about it beyond the `api.ts` wrappers all having callers.
- M365 intent (dashboard-managed vs CLI-only) is a product decision not recorded in the code read; §5.2.4 is conditional on that.
- The `t("` false-positive trap (noted in §6.5) means any i18n claim based on a plain `t(` grep is unreliable; the "7 files" figure is from import grep and is verified.
- Whether the 5 untranslated theme strings are a deliberate placeholder or an oversight is not stated anywhere in the source; the catalog test's inability to detect it is a verified fact.
- The prior audit's `handleSimulateIntent` in `LiveDesktopView.tsx` no longer exists in current source (grep: no match); the `agent_intent` data-channel handler (`:1189`) remains, but whether a demo-only intent fabrication survives elsewhere was not traced.

**Files created by this audit.** This report only: `~/workspace/ai-bridge-main/analysis/DASHBOARD_AUDIT.md`. No source files were modified.
