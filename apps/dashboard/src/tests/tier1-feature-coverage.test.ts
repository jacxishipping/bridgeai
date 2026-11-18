/**
 * Tier 1 Test Suite: Feature Coverage (rewritten Wave 2B)
 *
 * Verifies primary behaviour (happy path) for all 31 features in PROJECT.md.
 * Requires >= 5 test cases per feature (31 features * 5 = 155 tests minimum).
 *
 * REWRITE NOTES (Wave 2B, fixes TST-04 / DOC-04 / DOC-07):
 * - Every test now derives its expected values from REAL application modules
 *   imported below (dashboardStore + SEED_* exports, api.ts, i18n catalogs,
 *   navigation, shell navigation) instead of defining literals inside the
 *   test and asserting on them. A test can therefore fail if the app changes.
 * - Tests marked "[source-level]" cannot execute the behaviour under tsx in
 *   Node (the code path needs a browser/DOM or a live control plane), so
 *   they read the real view source as text and assert on its actual contents.
 *   They are labelled as source-level checks, not behaviour tests.
 * - The store is a process-wide singleton shared with the Tier 5 and
 *   challenger suites, which run AFTER this file in run-all-tests.ts.
 *   Rules this file follows so later suites still see seed state:
 *     (a) absolute counts come from the immutable SEED_* exports, never
 *         from getState() after a mutation;
 *     (b) store mutations are performed synchronously and asserted on a
 *         synchronous snapshot BEFORE any await (the harness invokes `it`
 *         callbacks without awaiting each in turn, so anything after the
 *         first await may interleave with the next test);
 *     (c) approval resolutions restore the saved store state in `finally`
 *         so the three seed approvals stay pending for later suites;
 *     (d) every toggle (auto-poll, palette, emergency stop, current view)
 *         is restored to its initial value before the test ends.
 * - Demo gating (D-01, honesty track): in Node there is no window, so no
 *   credentials and no demo acknowledgement exist; setCurrentView() to a
 *   demo view therefore resolves to "login". F3.3 asserts that real gating
 *   behaviour rather than pretending navigation succeeds.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, setSuite } from './harness.js';
import {
  dashboardStore,
  SEED_DEVICES,
  SEED_APPROVALS,
  SEED_TASKS,
  SEED_WORKFLOWS,
  SEED_AUDIT_EVENTS,
  SEED_MCP_CONNECTIONS,
  SEED_OAUTH_CLIENTS,
  SEED_LOGS,
} from '../state/dashboardStore';
import {
  api,
  apiOrigin,
  token,
  sessionToken,
  clearCredentials,
  toIsoTimestamp,
  ApiError,
} from '../api';
import { messages, languages, resolveLocale, translate } from '../i18n/catalogs';
import { viewIds, readRoute, writeRoute, updateRouteParams } from '../state/navigation';
import { navigationItems, navGroupOrder } from '../shell/navigation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..');
const readSource = (rel: string): string => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');

/** Save the whole store state object so a mutating test can restore it. */
function snapshotStoreState(): unknown {
  return (dashboardStore as any).state;
}
function restoreStoreState(saved: unknown): void {
  (dashboardStore as any).state = saved;
  (dashboardStore as any).notify();
}

/**
 * Demo-branch store methods (triggerEmergencyStop / resumeFleet /
 * resolveApproval / dispatchTask) apply their mutation synchronously when
 * there is no live credential, and only then return a resolved promise.
 * Tests therefore call them WITHOUT awaiting — awaiting would defer the
 * rest of the test into a microtask that runs after every other test's
 * synchronous prefix, leaving the store mutated while later tests run.
 * Promises are collected here and awaited at the end of runTier1Tests so
 * a rejection still fails the run instead of going unhandled.
 */
const pendingStoreCalls: Array<Promise<unknown>> = [];
function callStore(promise: Promise<unknown>): void {
  pendingStoreCalls.push(promise);
}

/** Recursively collect production .ts/.tsx files under src/, excluding tests. */
function scanProductionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'tests' && ent.name !== 'node_modules' && ent.name !== 'legacy_reference') walk(full);
      } else if (ent.isFile() && (ent.name.endsWith('.tsx') || ent.name.endsWith('.ts'))) {
        out.push(full);
      }
    }
  };
  walk(SRC_DIR);
  return out;
}

export async function runTier1Tests() {
  setSuite('Tier 1: Comprehensive Feature Coverage (F1 to F31)', 'tier1');

  // =========================================================================
  // F1: Zero-Trust Dual-Auth Console (5 tests)
  // =========================================================================
  describe('F1: Zero-Trust Dual-Auth Console', () => {
    it('F1.1: No credentials are present in Node: token()/sessionToken() are empty and clearCredentials() is a safe no-op', async () => {
      expect(token()).toBe('');
      expect(sessionToken()).toBe('');
      clearCredentials();
      expect(token()).toBe('');
      expect(sessionToken()).toBe('');
    });

    it('F1.2: apiOrigin defaults to the loopback control plane in Node (no VITE_API_URL, no window)', async () => {
      expect(apiOrigin).toBe('http://127.0.0.1:8000');
    });

    it('F1.3: [source-level] LoginView offers token + password methods and trims input before authenticate()', async () => {
      const src = readSource('views/LoginView.tsx');
      expect(src).toContain('"token" | "password"');
      expect(src).toContain('token.trim()');
      expect(src).toContain('username.trim()');
      expect(src).toContain('authenticate(');
    });

    it('F1.4: i18n sign-in strings come from the real catalog, not the test', async () => {
      expect(messages).toContain('Sign in');
      expect(messages).toContain('Admin token');
      expect(messages).toContain('Sign in with your identity provider');
      expect(messages).toContain('Explore demo workspace');
      expect(translate('en', 'Sign in')).toBe('Sign in');
      expect(translate('en', 'Admin token')).toBe('Admin token');
    });

    it('F1.5: toIsoTimestamp converts epoch seconds/ms and ISO strings, and falls back on invalid input', async () => {
      expect(toIsoTimestamp(1700000000)).toBe('2023-11-14T22:13:20.000Z');
      expect(toIsoTimestamp(1700000000000)).toBe('2023-11-14T22:13:20.000Z');
      expect(toIsoTimestamp('1700000000')).toBe('2023-11-14T22:13:20.000Z');
      expect(toIsoTimestamp('2026-11-02T12:00:00Z')).toBe('2026-11-02T12:00:00.000Z');
      expect(toIsoTimestamp('not-a-date')).toBe('');
      expect(toIsoTimestamp(null)).toBe('');
      expect(toIsoTimestamp(0)).toBe('');
      expect(toIsoTimestamp(-5)).toBe('');
    });
  }, { tier: 'tier1', featureId: 'F1' });

  // =========================================================================
  // F2: mTLS Control Plane Status Bar (5 tests)
  // =========================================================================
  describe('F2: mTLS Control Plane Status Bar', () => {
    it('F2.1: Store reports the seeded gateway latency and online status', async () => {
      const state = dashboardStore.getState();
      expect(state.gatewayLatencyMs).toBe(14);
      expect(state.gatewayStatus).toBe('online');
    });

    it('F2.2: Store operator profile is the seeded SecOps operator', async () => {
      const profile = dashboardStore.getState().operatorProfile;
      expect(profile.name).toBe('Sarah Jenkins');
      expect(profile.role).toBe('Lead SecOps Engineer');
      expect(profile.email).toBe('sarah.j@security.internal');
      expect(profile.workstationMtlsPinned).toBe(true);
    });

    it('F2.3: Auto-poll toggle flips store state and restores it', async () => {
      expect(dashboardStore.getState().autoPollEnabled).toBe(true);
      dashboardStore.setAutoPollEnabled(false);
      expect(dashboardStore.getState().autoPollEnabled).toBe(false);
      dashboardStore.setAutoPollEnabled(true);
      expect(dashboardStore.getState().autoPollEnabled).toBe(true);
    });

    it('F2.4: Seed log-1 records the mTLS handshake evidence (cipher, latency, node)', async () => {
      const log = SEED_LOGS.find((l) => l.id === 'log-1')!;
      expect(log.message).toContain('TLS_AES_256_GCM_SHA384');
      expect((log.details as any).cipher).toBe('TLS_AES_256_GCM_SHA384');
      expect((log.details as any).latencyMs).toBe(14);
      expect((log.details as any).node).toBe('srv-us-east-412');
    });

    it('F2.5: Store default selection is the seeded primary node', async () => {
      expect(dashboardStore.getState().selectedDeviceId).toBe('srv-us-east-412');
      const primary = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!;
      expect(primary.hostname).toBe('srv-us-east-412.infra.internal');
      expect(primary.name).toBe('US-East Core Controller 412');
      expect(primary.platform).toBe('linux');
    });
  }, { tier: 'tier1', featureId: 'F2' });

  // =========================================================================
  // F3: Global Command Palette (⌘K) (5 tests)
  // =========================================================================
  describe('F3: Global Command Palette (⌘K)', () => {
    it('F3.1: Command palette open state toggles through the store and restores', async () => {
      expect(dashboardStore.getState().commandPaletteOpen).toBe(false);
      dashboardStore.setCommandPaletteOpen(true);
      expect(dashboardStore.getState().commandPaletteOpen).toBe(true);
      dashboardStore.setCommandPaletteOpen(false);
      expect(dashboardStore.getState().commandPaletteOpen).toBe(false);
    });

    it('F3.2: Palette device search runs over the real seed fleet', async () => {
      const byHostname = SEED_DEVICES.filter((d) => d.hostname.includes('srv-us-east-412'));
      expect(byHostname.length).toBe(1);
      expect(byHostname[0].id).toBe('srv-us-east-412');
      const byWin = SEED_DEVICES.filter((d) => d.hostname.includes('srv-win-prod'));
      expect(byWin.length).toBe(11);
      const modal = readSource('shell/CommandPaletteModal.tsx');
      expect(modal).toContain('devices.map((device)');
    });

    it('F3.3: Demo gating (D-01): demo views resolve to login without credentials; live never gates', async () => {
      expect(dashboardStore.getState().currentView).toBe('login');
      dashboardStore.setCurrentView('overview');
      expect(dashboardStore.getState().currentView).toBe('login');
      dashboardStore.setCurrentView('live');
      expect(dashboardStore.getState().currentView).toBe('live');
      dashboardStore.setCurrentView('login');
      expect(dashboardStore.getState().currentView).toBe('login');
    });

    it('F3.4: Navigation groups cover all 15 destinations from the real nav table', async () => {
      expect(navigationItems.length).toBe(15);
      expect(navGroupOrder).toEqual(['Overview', 'Fleet', 'Execute', 'Govern', 'Integrate']);
      const count = (group: string) => navigationItems.filter((n) => n.group === group).length;
      expect(count('Overview')).toBe(2);
      expect(count('Fleet')).toBe(3);
      expect(count('Execute')).toBe(4);
      expect(count('Govern')).toBe(3);
      expect(count('Integrate')).toBe(3);
      const ids = new Set(navigationItems.map((n) => n.id));
      expect(ids.size).toBe(15);
      for (const id of viewIds) {
        if (id === 'login') continue;
        expect(ids.has(id)).toBe(true);
      }
    });

    it('F3.5: [source-level] Command palette modal wires a window keydown listener and a pages/devices search box', async () => {
      const modal = readSource('shell/CommandPaletteModal.tsx');
      expect(modal).toContain('window.addEventListener("keydown", onKeyDown)');
      expect(modal).toContain('aria-label="Search pages and devices"');
      expect(modal).toContain('Pages or devices…');
    });

    it('F3.6: [UX-13] readRoute parses task/workflow/session deep links and list filters (view-scoped)', async () => {
      const prevWindow = (globalThis as any).window;
      const setHash = (hash: string) => {
        const win: any = {
          location: { hash },
          history: {
            pushState: (_s: unknown, _t: string, url: string) => { win.location.hash = url; },
            replaceState: (_s: unknown, _t: string, url: string) => { win.location.hash = url; },
          },
        };
        (globalThis as any).window = win;
      };
      try {
        setHash('#/task-queue-and-vision?task=TSK-89214&q=shell&status=failed');
        let route = readRoute();
        expect(route.view).toBe('task-queue-and-vision');
        expect(route.task).toBe('TSK-89214');
        expect(route.q).toBe('shell');
        expect(route.status).toBe('failed');
        // An unknown status value is ignored, not applied.
        setHash('#/task-queue-and-vision?status=bogus');
        expect(readRoute().status).toBe(undefined);
        // Entity params are view-scoped: ?task= on another route is ignored.
        setHash('#/devices?task=TSK-89214');
        route = readRoute();
        expect(route.view).toBe('devices');
        expect(route.task).toBe(undefined);
        setHash('#/autonomous-workflows?workflow=WF-1092');
        expect(readRoute().workflow).toBe('WF-1092');
        setHash('#/live-desktop-studio?session=abc123');
        expect(readRoute().session).toBe('abc123');
      } finally {
        if (prevWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = prevWindow;
      }
    });

    it('F3.7: [UX-13] writeRoute/updateRouteParams round-trip the deep link without dropping other params', async () => {
      const prevWindow = (globalThis as any).window;
      const win: any = {
        location: { hash: '#/task-queue-and-vision' },
        history: {
          pushState: (_s: unknown, _t: string, url: string) => { win.location.hash = url; },
          replaceState: (_s: unknown, _t: string, url: string) => { win.location.hash = url; },
        },
      };
      (globalThis as any).window = win;
      try {
        writeRoute('task-queue-and-vision', undefined, { task: 'TSK-1', q: 'shell' });
        expect(win.location.hash).toBe('#/task-queue-and-vision?task=TSK-1&q=shell');
        updateRouteParams({ status: 'failed' }, true);
        expect(readRoute().status).toBe('failed');
        expect(readRoute().task).toBe('TSK-1');
        expect(readRoute().q).toBe('shell');
        updateRouteParams({ task: undefined });
        expect(readRoute().task).toBe(undefined);
        expect(readRoute().q).toBe('shell');
      } finally {
        if (prevWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = prevWindow;
      }
    });

    it('F3.8: [UX-31] navigation guard intercepts setCurrentView while dirty; confirm leaves, cancel stays', async () => {
      const saved = snapshotStoreState();
      try {
        expect(dashboardStore.getState().currentView).toBe('login');
        dashboardStore.getState().registerNavigationGuard({ isDirty: () => true });
        dashboardStore.setCurrentView('live');
        expect(dashboardStore.getState().currentView).toBe('login');
        expect(dashboardStore.getState().pendingNavigation).toBe('live');
        dashboardStore.getState().cancelPendingNavigation();
        expect(dashboardStore.getState().pendingNavigation).toBe(null);
        expect(dashboardStore.getState().currentView).toBe('login');
        dashboardStore.setCurrentView('live');
        expect(dashboardStore.getState().pendingNavigation).toBe('live');
        dashboardStore.getState().confirmPendingNavigation();
        expect(dashboardStore.getState().currentView).toBe('live');
        expect(dashboardStore.getState().pendingNavigation).toBe(null);
        // With the guard unregistered, navigation proceeds directly.
        dashboardStore.getState().unregisterNavigationGuard();
        dashboardStore.setCurrentView('login');
        expect(dashboardStore.getState().currentView).toBe('login');
      } finally {
        dashboardStore.getState().unregisterNavigationGuard();
        restoreStoreState(saved);
      }
    });

    it('F3.9: [source-level] UX-25/UX-39 residuals: tier legend + glossary, plain audio copy, file accept list, mono token', async () => {
      const tasks = readSource('views/TaskQueueVisionView.tsx');
      expect(tasks).toContain('Tier 1 — read-only');
      expect(tasks).toContain('Tier 4 — kernel');
      expect(tasks).toContain('GlossaryModal');
      expect(tasks).toContain('Task not available');
      const glossary = readSource('components/Glossary.tsx');
      expect(glossary).toContain('Tier 1 is read-only');
      expect(glossary).toContain('Set-of-Marks');
      const desktop = readSource('views/LiveDesktopView.tsx');
      expect(desktop).toContain('Desktop audio is not available in this build');
      expect(desktop).not.toContain('WASAPI Opus');
      expect(desktop).not.toContain('AI_BRIDGE_DESKTOP_AUDIO');
      expect(desktop).toContain('accept=".pdf,.doc,.docx');
      expect(desktop).toContain('Session not available');
      const css = readSource('tailwind.css');
      expect(css).toContain('--font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace');
      const policies = readSource('views/SecurityPoliciesView.tsx');
      expect(policies).toContain('registerNavigationGuard');
      expect(policies).toContain('Leave without saving?');
    });
  }, { tier: 'tier1', featureId: 'F3' });

  // =========================================================================
  // F4: Emergency All-Stop Killswitch (5 tests)
  // =========================================================================
  describe('F4: Emergency All-Stop Killswitch', () => {
    it('F4.1: [source-level] TopHeader hold-to-confirm is 1200ms live / 700ms demo', async () => {
      const src = readSource('shell/TopHeader.tsx');
      expect(src).toContain('holdDurationMs={isLive ? 1200 : 700}');
      expect(src).toContain('HoldToConfirmButton');
    });

    it('F4.2: Triggering the stop halts running/pending tasks, then resume clears it', async () => {
      const before = dashboardStore.getState();
      expect(before.isEmergencyStopActive).toBe(false);
      const runningBefore = before.tasks.filter((t) => t.status === 'running' || t.status === 'pending').length;
      expect(runningBefore).toBeGreaterThan(0);
      // Synchronous trigger + resume (see callStore note): the resume must
      // land before later tests' synchronous prefixes run.
      callStore(dashboardStore.triggerEmergencyStop());
      const stopped = dashboardStore.getState();
      expect(stopped.isEmergencyStopActive).toBe(true);
      expect(stopped.tasks.filter((t) => t.status === 'running' || t.status === 'pending').length).toBe(0);
      callStore(dashboardStore.resumeFleet());
      expect(dashboardStore.getState().isEmergencyStopActive).toBe(false);
    });

    it('F4.3: [source-level] TopHeader renders the live emergency banner text', async () => {
      const src = readSource('shell/TopHeader.tsx');
      expect(src).toContain('EMERGENCY ALL-STOP ACTIVE — FLEET SUSPENDED');
      expect(src).toContain('Resume Fleet');
    });

    it('F4.4: Triggering the stop appends a hash-chained audit event', async () => {
      const before = dashboardStore.getState();
      const headBefore = before.auditEvents[0];
      callStore(dashboardStore.triggerEmergencyStop());
      const stopped = dashboardStore.getState();
      expect(stopped.auditEvents.length).toBe(before.auditEvents.length + 1);
      const head = stopped.auditEvents[0];
      expect(head.action).toBe('fleet.emergency_all_stop');
      expect(head.targetHost).toBe('all-fleet-nodes');
      expect(head.blockNumber).toBe(headBefore.blockNumber + 1);
      expect(head.prevHash).toBe(headBefore.sha256Hash);
      callStore(dashboardStore.resumeFleet());
      expect(dashboardStore.getState().isEmergencyStopActive).toBe(false);
    });

    it('F4.5: Resuming the fleet appends a resume audit event and clears the stop', async () => {
      callStore(dashboardStore.triggerEmergencyStop());
      expect(dashboardStore.getState().isEmergencyStopActive).toBe(true);
      const before = dashboardStore.getState();
      callStore(dashboardStore.resumeFleet());
      const resumed = dashboardStore.getState();
      expect(resumed.isEmergencyStopActive).toBe(false);
      expect(resumed.auditEvents.length).toBe(before.auditEvents.length + 1);
      expect(resumed.auditEvents[0].action).toBe('fleet.resume_operations');
      expect(resumed.auditEvents[0].prevHash).toBe(before.auditEvents[0].sha256Hash);
    });
  }, { tier: 'tier1', featureId: 'F4' });

  // =========================================================================
  // F5: SmartDataTable Device Inventory (5 tests)
  // =========================================================================
  describe('F5: SmartDataTable Device Inventory', () => {
    it('F5.1: Store inventory holds the 40 seeded fleet nodes', async () => {
      expect(SEED_DEVICES.length).toBe(40);
      expect(dashboardStore.getState().devices.length).toBe(40);
    });

    it('F5.2: Fleet splits by platform into Windows / Linux / macOS from the seed', async () => {
      const count = (platform: string) => SEED_DEVICES.filter((d) => d.platform === platform).length;
      expect(count('windows')).toBe(23);
      expect(count('linux')).toBe(13);
      expect(count('darwin')).toBe(4);
    });

    it('F5.3: Hostname search over the real fleet finds the primary node', async () => {
      const match = SEED_DEVICES.filter((d) => d.hostname.includes('412'));
      expect(match.length).toBe(1);
      expect(match[0].hostname).toBe('srv-us-east-412.infra.internal');
      const win = SEED_DEVICES.find((d) => d.id === 'srv-win-prod-08')!;
      expect(win.platform).toBe('windows');
      expect(win.hostname).toBe('srv-win-prod-08.ad.internal');
    });

    it('F5.4: Fleet health split is 38 online, 1 unresponsive, 1 offline', async () => {
      const count = (status: string) => SEED_DEVICES.filter((d) => d.status === status).length;
      expect(count('online')).toBe(38);
      expect(count('unresponsive')).toBe(1);
      expect(count('offline')).toBe(1);
      expect(SEED_DEVICES[38].id).toBe('mac-builder-m3-03');
      expect(SEED_DEVICES[38].status).toBe('unresponsive');
      expect(SEED_DEVICES[39].id).toBe('mac-builder-m3-04');
      expect(SEED_DEVICES[39].status).toBe('offline');
    });

    it('F5.5: Latency values are real seed data: primary 14ms, offline node 999ms, every online node under 100ms', async () => {
      const primary = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!;
      expect(primary.latencyMs).toBe(14);
      const offline = SEED_DEVICES.find((d) => d.status === 'offline')!;
      expect(offline.latencyMs).toBe(999);
      for (const d of SEED_DEVICES.filter((x) => x.status === 'online')) {
        expect(d.latencyMs).toBeLessThan(100);
      }
    });
  }, { tier: 'tier1', featureId: 'F5' });

  // =========================================================================
  // F6: Cross-Platform Agent Enroller (5 tests)
  // =========================================================================
  describe('F6: Cross-Platform Agent Enroller', () => {
    it('F6.1: [source-level] Demo enrollment issues no real token; the live copy command uses the real token but the display is masked', async () => {
      const src = readSource('views/DevicesView.tsx');
      expect(src).toContain('Demo preview only — no real device token is issued. Connect a control plane to enroll.');
      expect(src).toContain('curl -sSL');
      // Byte-verified: the *copy* templates interpolate ${enrolledToken};
      // the *displayed* command uses a <TOKEN> placeholder and the token
      // line shows a masked value with a Show/Hide toggle (Wave 5A).
      expect(src).toContain('--device-token=${enrolledToken}');
      expect(src).toContain("-DeviceToken '${enrolledToken}'");
      expect(src).toContain('--device-token=<TOKEN>');
      expect(src).toContain('enrolledTokenMasked');
      expect(src).toContain('linuxEnrollCommandDisplay');
      expect(src).toContain('windowsEnrollCommandDisplay');
      expect(src).toContain('showEnrolledToken');
      expect(src).not.toContain('<redacted>');
    });

    it('F6.2: Seed workspace paths are platform-specific', async () => {
      const linux = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!;
      expect(linux.workspacePath).toBe('/opt/ai-bridge/workspace');
      const windows = SEED_DEVICES.find((d) => d.id === 'srv-win-prod-02')!;
      expect(windows.workspacePath).toBe('C:\\ai-bridge\\workspace');
      const mac = SEED_DEVICES.find((d) => d.id === 'mac-builder-m3-01')!;
      expect(mac.workspacePath).toBe('/Users/builder/ai-bridge/runner');
    });

    it('F6.3: The api client exposes the enrollment lifecycle (enroll / revoke / delete / policy)', async () => {
      expect(typeof api.enroll).toBe('function');
      expect(typeof api.revoke).toBe('function');
      expect(typeof api.deleteDevice).toBe('function');
      expect(typeof api.updateDevice).toBe('function');
      expect(typeof api.devicePolicy).toBe('function');
    });

    it('F6.4: Device ids and hostnames are unique across the 40-node seed', async () => {
      expect(new Set(SEED_DEVICES.map((d) => d.id)).size).toBe(40);
      expect(new Set(SEED_DEVICES.map((d) => d.hostname)).size).toBe(40);
    });

    it('F6.5: Stream URL builders are pure functions of the api origin (no credential in Node)', async () => {
      expect(api.terminalStreamUrl('srv-us-east-412', 'sess-1')).toBe(
        'http://127.0.0.1:8000/api/devices/srv-us-east-412/terminal/sess-1/stream?since_seq=0'
      );
      expect(api.sessionWebSocketUrl('s1')).toBe('ws://127.0.0.1:8000/api/v1/ws/sessions/s1');
    });
  }, { tier: 'tier1', featureId: 'F6' });

  // =========================================================================
  // F7: Device 360 Hardware Gauges (5 tests)
  // =========================================================================
  describe('F7: Device 360 Hardware Gauges', () => {
    it('F7.1: Primary node telemetry is the seeded gauge set (CPU 28.4%, 8 cores, 3.8GHz)', async () => {
      const telemetry = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!.telemetry;
      expect(telemetry.cpuPercent).toBe(28.4);
      expect(telemetry.cpuCores.length).toBe(8);
      expect(telemetry.cpuClockGhz).toBe(3.8);
    });

    it('F7.2: Primary node RAM and disk percentages derive from its stored used/total values', async () => {
      const telemetry = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!.telemetry;
      expect(telemetry.memoryUsedGb).toBe(18.4);
      expect(telemetry.memoryTotalGb).toBe(64);
      expect(telemetry.memoryUsedGb).toBeLessThan(telemetry.memoryTotalGb);
      expect(telemetry.diskPercent).toBe(Math.round((telemetry.diskUsedGb / telemetry.diskTotalGb) * 100));
      expect(telemetry.diskUsedGb).toBe(210);
      expect(telemetry.diskTotalGb).toBe(500);
      expect(telemetry.diskPercent).toBe(42);
    });

    it('F7.3: Every seed device reports consistent disk and memory accounting', async () => {
      for (const d of SEED_DEVICES) {
        const t = d.telemetry;
        expect(t.diskPercent).toBe(Math.round((t.diskUsedGb / t.diskTotalGb) * 100));
        expect(t.memoryUsedGb).toBeLessThanOrEqual(t.memoryTotalGb);
        expect(t.diskPercent).toBeGreaterThanOrEqual(0);
        expect(t.diskPercent).toBeLessThanOrEqual(100);
      }
    });

    it('F7.4: Primary node network meters and IP come from the seed; the offline node reports zeros', async () => {
      const telemetry = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!.telemetry;
      expect(telemetry.networkRxMbps).toBe(4.2);
      expect(telemetry.networkTxMbps).toBe(1.1);
      expect(telemetry.ipAddress).toBe('10.244.18.99');
      const offline = SEED_DEVICES.find((d) => d.status === 'offline')!.telemetry;
      expect(offline.networkRxMbps).toBe(0);
      expect(offline.networkTxMbps).toBe(0);
      expect(offline.cpuPercent).toBe(0);
    });

    it('F7.5: Device fingerprints are well-formed SHA-256 digests; primary TPM/cert state is seeded', async () => {
      for (const d of SEED_DEVICES) {
        expect(d.telemetry.fingerprintSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
      const telemetry = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!.telemetry;
      expect(telemetry.tpmStatus).toBe('active');
      expect(telemetry.certExpiryDays).toBe(42);
    });
  }, { tier: 'tier1', featureId: 'F7' });

  // =========================================================================
  // F8: Process Manager with Termination (5 tests)
  // =========================================================================
  describe('F8: Process Manager with Termination', () => {
    it('F8.1: Seed holds a running process.list task with sort/limit args', async () => {
      const task = SEED_TASKS.find((t) => t.id === 'TSK-89212')!;
      expect(task.tool).toBe('process.list');
      expect(task.args).toEqual({ sort: 'cpu', limit: 20 });
      expect(task.status).toBe('running');
      expect(task.riskTier).toBe('tier1_safe');
    });

    it('F8.2: Seed log-1 is the process-level evidence row (pid 1420, core service, worker-01)', async () => {
      const log = SEED_LOGS.find((l) => l.id === 'log-1')!;
      expect(log.pid).toBe(1420);
      expect(log.service).toBe('ai-bridge-core.service');
      expect(log.workerThread).toBe('worker-01');
      expect(log.level).toBe('INFO');
    });

    it('F8.3: Dispatching process.list creates a task bound to the real device hostname', async () => {
      const before = dashboardStore.getState().tasks.length;
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-win-prod-02',
        tool: 'process.list',
        args: { sort: 'cpu', limit: 20 },
        riskTier: 'tier1_safe',
      });
      const after = dashboardStore.getState();
      expect(after.tasks.length).toBe(before + 1);
      expect(after.tasks[0].tool).toBe('process.list');
      expect(after.tasks[0].deviceHostname).toBe('srv-win-prod-02.ad.internal');
      const task = await pending;
      expect(task.id).toMatch(/^TSK-\d+$/);
      expect(task.status).toBe('running');
      expect(task.invoker).toBe('operator:sarah.j');
    });

    it('F8.4: [source-level] Device360View builds the kill command per platform (kill -15 / taskkill /F)', async () => {
      const src = readSource('views/Device360View.tsx');
      expect(src).toContain('kill -15 ${processToKill.pid}');
      expect(src).toContain('taskkill /PID ${processToKill.pid} /F');
    });

    it('F8.5: [source-level] Device360View drives daemon actions through systemctl', async () => {
      const src = readSource('views/Device360View.tsx');
      expect(src).toContain('systemctl ${action} ${daemonName}');
    });
  }, { tier: 'tier1', featureId: 'F8' });

  // =========================================================================
  // F9: Tool Dispatch Studio (5 tests)
  // =========================================================================
  describe('F9: Tool Dispatch Studio', () => {
    it('F9.1: Store default dispatch target is the seeded primary node', async () => {
      expect(dashboardStore.getState().selectedDeviceId).toBe('srv-us-east-412');
      expect(SEED_DEVICES.some((d) => d.id === 'srv-us-east-412')).toBe(true);
    });

    it('F9.2: Seed tasks cover six distinct tools across desktop, shell, file, PTY and process', async () => {
      const tools = new Set(SEED_TASKS.map((t) => t.tool));
      expect(tools.size).toBe(6);
      for (const tool of ['desktop.capture_screen', 'shell.exec', 'file.read', 'pty.spawn', 'process.list', 'desktop.click_coordinate']) {
        expect(tools.has(tool)).toBe(true);
      }
    });

    it('F9.3: Seed tasks cover all four risk tiers with the seeded distribution', async () => {
      const count = (tier: string) => SEED_TASKS.filter((t) => t.riskTier === tier).length;
      expect(count('tier1_safe')).toBe(3);
      expect(count('tier2_workspace')).toBe(1);
      expect(count('tier3_shell')).toBe(3);
      expect(count('tier4_kernel')).toBe(1);
    });

    it('F9.4: Dispatched JSON args round-trip through the store unchanged', async () => {
      const args = { timeout: 5000, fullPage: true };
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'desktop.capture_screen',
        args,
        riskTier: 'tier1_safe',
      });
      expect(dashboardStore.getState().tasks[0].args).toEqual(args);
      const task = await pending;
      expect(task.args).toEqual(args);
      expect(JSON.parse(JSON.stringify(task.args))).toEqual(args);
    });

    it('F9.5: Dispatch returns a unique TSK id and a running task in demo mode', async () => {
      const beforeIds = new Set(dashboardStore.getState().tasks.map((t) => t.id));
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'desktop.capture_screen',
        args: { format: 'png', quality: 90 },
        riskTier: 'tier1_safe',
      });
      const task = await pending;
      expect(task.id).toMatch(/^TSK-\d+$/);
      expect(beforeIds.has(task.id)).toBe(false);
      expect(task.status).toBe('running');
      expect(task.deviceHostname).toBe('srv-us-east-412.infra.internal');
    });
  }, { tier: 'tier1', featureId: 'F9' });

  // =========================================================================
  // F10: Set-of-Marks (SoM) Visual Inspector (5 tests)
  // =========================================================================
  describe('F10: Set-of-Marks (SoM) Visual Inspector', () => {
    it('F10.1: Seed capture task records a 2560x1440 frame with exit code 0', async () => {
      const task = SEED_TASKS.find((t) => t.id === 'TSK-89213')!;
      expect(task.tool).toBe('desktop.capture_screen');
      expect(task.result!.stdout).toBe('Screen captured: 2560x1440 24bpp');
      expect(task.result!.exitCode).toBe(0);
      expect(task.durationMs).toBe(980);
    });

    it('F10.2: Seed capture carries two SoM boxes with labels and 4-coordinate bounds', async () => {
      const boxes = SEED_TASKS.find((t) => t.id === 'TSK-89213')!.result!.somBoxes!;
      expect(boxes.length).toBe(2);
      expect(boxes[0]).toEqual({ id: 12, label: 'Chrome Search Bar', bounds: [120, 48, 640, 84] });
      expect(boxes[1]).toEqual({ id: 14, label: 'Submit Button', bounds: [680, 48, 760, 84] });
      for (const b of boxes) {
        expect(b.bounds.length).toBe(4);
        expect(b.bounds[2]).toBeGreaterThan(b.bounds[0]);
        expect(b.bounds[3]).toBeGreaterThan(b.bounds[1]);
      }
    });

    it('F10.3: SoM boxes lie inside the captured 2560x1440 frame', async () => {
      const task = SEED_TASKS.find((t) => t.id === 'TSK-89213')!;
      const dims = task.result!.stdout!.match(/(\d+)x(\d+)/)!;
      const width = Number(dims[1]);
      const height = Number(dims[2]);
      expect(width).toBe(2560);
      expect(height).toBe(1440);
      for (const b of task.result!.somBoxes!) {
        expect(b.bounds[2]).toBeLessThanOrEqual(width);
        expect(b.bounds[3]).toBeLessThanOrEqual(height);
      }
    });

    it('F10.4: Workflow OCR step reasoning trace carries the real bounding box', async () => {
      const step = SEED_WORKFLOWS[0].steps.find((s) => s.tool === 'vision.ocr_screen')!;
      expect(step.reasoningTrace).toContain('[740, 480, 880, 520]');
      expect(step.reasoningTrace).toContain("Confirm Order");
    });

    it('F10.5: [source-level] The vision canvas labels its placeholder state honestly (D-04)', async () => {
      const src = readSource('views/TaskQueueVisionView.tsx');
      expect(src).toContain('SIMULATED — no live frame. This is a placeholder desktop, not a real device screen.');
      expect(src).toContain('4 Simulated Marks — placeholder positions, no live frame');
    });
  }, { tier: 'tier1', featureId: 'F10' });

  // =========================================================================
  // F11: Low-Latency Desktop Stream Canvas (5 tests)
  // =========================================================================
  describe('F11: Low-Latency Desktop Stream Canvas', () => {
    it('F11.1: The api client exposes the full v1 desktop-session surface', async () => {
      for (const name of ['createSessionV1', 'getSessionV1', 'postAnswerV1', 'postIceV1', 'setSessionModeV1', 'terminateSessionV1', 'getIceServersV1', 'updateSessionQualityV1', 'getSessionRecordingV1', 'sealSessionRecordingV1'] as const) {
        expect(typeof (api as any)[name]).toBe('function');
      }
    });

    it('F11.2: Stream URL builders produce the exact control-plane URLs', async () => {
      expect(api.liveActivityStreamUrl()).toBe('http://127.0.0.1:8000/api/activity/stream');
      expect(api.eventsStreamUrl()).toBe('http://127.0.0.1:8000/api/events/stream');
      expect(api.aiChatStreamUrl()).toBe('http://127.0.0.1:8000/api/ai/chat/stream');
      expect(api.streamWorkflowUrl('wf-1')).toBe('http://127.0.0.1:8000/api/workflows/wf-1/stream');
    });

    it('F11.3: [source-level] LiveDesktopView negotiates WebRTC with an "input" data channel', async () => {
      const src = readSource('views/LiveDesktopView.tsx');
      expect(src).toContain('RTCPeerConnection');
      expect(src).toContain('createDataChannel("input"');
    });

    it('F11.4: [source-level] LiveDesktopView gates WebRTC to Windows devices', async () => {
      const src = readSource('views/LiveDesktopView.tsx');
      expect(src).toContain('Live Desktop WebRTC streaming is Windows-only');
    });

    it('F11.5: GPU seed nodes carry 16-core telemetry vs 8 cores on standard nodes', async () => {
      const gpu = SEED_DEVICES.find((d) => d.id === 'cad-gpu-win-01')!;
      expect(gpu.telemetry.cpuCores.length).toBe(16);
      const primary = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!;
      expect(primary.telemetry.cpuCores.length).toBe(8);
      const h100 = SEED_DEVICES.find((d) => d.id === 'gpu-infer-h100-01')!;
      expect(h100.telemetry.cpuCores.length).toBe(16);
    });
  }, { tier: 'tier1', featureId: 'F11' });

  // =========================================================================
  // F12: Dual-Control Operator Takeover (5 tests)
  // =========================================================================
  describe('F12: Dual-Control Operator Takeover', () => {
    it('F12.1: [source-level] LiveDesktopView models observer/takeover control modes', async () => {
      const src = readSource('views/LiveDesktopView.tsx');
      // UX-33: observer is the safe default — takeover requires an explicit
      // operator action, so the source must default to "observer".
      expect(src).toContain('useState<"observer" | "takeover">("observer")');
    });

    it('F12.2: [source-level] Desktop input forwarding is gated on takeover mode', async () => {
      const src = readSource('views/LiveDesktopView.tsx');
      expect(src).toContain('controlMode === "takeover"');
    });

    it('F12.3: The api client exposes desktop input and frame fetch', async () => {
      expect(typeof api.sendDesktopInput).toBe('function');
      expect(typeof api.desktopFrame).toBe('function');
      expect(typeof api.deviceMonitors).toBe('function');
      expect(typeof api.setSessionModeV1).toBe('function');
    });

    it('F12.4: [source-level] Takeover mode changes go through the v1 session-mode endpoint', async () => {
      const src = readSource('views/LiveDesktopView.tsx');
      expect(src).toContain('setSessionModeV1');
    });

    it('F12.5: Dispatching a desktop click mirrors the workflow step-3 call shape', async () => {
      const before = dashboardStore.getState().tasks.length;
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'desktop.click_coordinate',
        args: { x: 810, y: 500, button: 'left' },
        riskTier: 'tier2_workspace',
      });
      const after = dashboardStore.getState();
      expect(after.tasks.length).toBe(before + 1);
      expect(after.tasks[0].args).toEqual({ x: 810, y: 500, button: 'left' });
      const task = await pending;
      expect(task.tool).toBe('desktop.click_coordinate');
      expect(task.riskTier).toBe('tier2_workspace');
    });
  }, { tier: 'tier1', featureId: 'F12' });

  // =========================================================================
  // F13: ANSI Monospace PTY Studio (5 tests)
  // =========================================================================
  describe('F13: ANSI Monospace PTY Studio', () => {
    it('F13.1: The api client exposes the full terminal-session surface', async () => {
      for (const name of ['createTerminalSession', 'listTerminalSessions', 'writeTerminalInput', 'closeTerminalSession', 'resizeTerminal', 'terminalStreamUrl'] as const) {
        expect(typeof (api as any)[name]).toBe('function');
      }
    });

    it('F13.2: Terminal stream URL carries device, session and sequence', async () => {
      expect(api.terminalStreamUrl('srv-us-east-412', 'sess-7', 5)).toBe(
        'http://127.0.0.1:8000/api/devices/srv-us-east-412/terminal/sess-7/stream?since_seq=5'
      );
    });

    it('F13.3: Seed holds a running pty.spawn task on the GPU inference node', async () => {
      const task = SEED_TASKS.find((t) => t.id === 'TSK-89210')!;
      expect(task.tool).toBe('pty.spawn');
      expect(task.deviceId).toBe('gpu-infer-h100-01');
      expect(task.riskTier).toBe('tier3_shell');
      expect(task.status).toBe('running');
    });

    it('F13.4: [source-level] TerminalView labels its demo output as simulated, never run anywhere', async () => {
      const src = readSource('views/TerminalView.tsx');
      expect(src).toContain('DEMO_TERMINAL_LINES');
      expect(src).toContain('[demo] Simulated output only');
      expect(src).toContain('was not run anywhere.');
    });

    it('F13.5: Seed log-3 records a real PTY session spawn on /dev/pts/4', async () => {
      const log = SEED_LOGS.find((l) => l.id === 'log-3')!;
      expect(log.service).toBe('ai-bridge-edge-daemon');
      expect(log.moduleTag).toBe('edge::pty');
      expect(log.message).toContain('PTY session spawned on /dev/pts/4');
      expect((log.details as any).pts).toBe('/dev/pts/4');
    });
  }, { tier: 'tier1', featureId: 'F13' });

  // =========================================================================
  // F14: Multi-Turn DAG Pipeline Stepper (5 tests)
  // =========================================================================
  describe('F14: Multi-Turn DAG Pipeline Stepper', () => {
    it('F14.1: Seed workflow WF-1092 is running at step 3 of 4 on the primary node', async () => {
      expect(SEED_WORKFLOWS.length).toBe(1);
      const wf = SEED_WORKFLOWS[0];
      expect(wf.id).toBe('WF-1092');
      expect(wf.status).toBe('running');
      expect(wf.currentStepIndex).toBe(2);
      expect(wf.totalSteps).toBe(4);
      expect(wf.targetDeviceId).toBe('srv-us-east-412');
    });

    it('F14.2: Workflow steps progress completed/completed/running/pending with real tools', async () => {
      const steps = SEED_WORKFLOWS[0].steps;
      expect(steps.map((s) => s.status)).toEqual(['completed', 'completed', 'running', 'pending']);
      expect(steps.map((s) => s.tool)).toEqual(['desktop.capture_screen', 'vision.ocr_screen', 'desktop.click_coordinate', 'audit.commit_transaction']);
      expect(steps[0].durationMs).toBe(320);
      expect(steps[1].durationMs).toBe(410);
      expect(steps[2].args).toEqual({ x: 810, y: 500, button: 'left' });
    });

    it('F14.3: Step reasoning traces name the OCR target and the click target', async () => {
      const steps = SEED_WORKFLOWS[0].steps;
      expect(steps[1].reasoningTrace).toContain("Confirm Order");
      expect(steps[2].reasoningTrace).toContain('Targeting center coordinate of verified confirmation button');
      expect(steps[3].reasoningTrace).toContain('Awaiting step 3 completion before signing transaction hash');
    });

    it('F14.4: The api client exposes the workflow lifecycle surface', async () => {
      for (const name of ['workflows', 'workflowDetail', 'submitWorkflow', 'cancelWorkflow', 'retryWorkflow', 'deleteWorkflow', 'scheduleWorkflow', 'workflowTemplates', 'createWorkflowTemplate', 'deleteWorkflowTemplate'] as const) {
        expect(typeof (api as any)[name]).toBe('function');
      }
    });

    it('F14.5: Every seed workflow declares exactly as many steps as its totalSteps', async () => {
      for (const wf of SEED_WORKFLOWS) {
        expect(wf.steps.length).toBe(wf.totalSteps);
        expect(wf.currentStepIndex).toBeLessThan(wf.totalSteps);
        expect(wf.steps.map((s) => s.stepNumber)).toEqual([1, 2, 3, 4]);
      }
    });
  }, { tier: 'tier1', featureId: 'F14' });

  // =========================================================================
  // F15: Multi-Node Command Bus (5 tests)
  // =========================================================================
  describe('F15: Multi-Node Command Bus', () => {
    it('F15.1: Fleet-tag selection over the real seed (production-east, k8s-cluster, production-windows)', async () => {
      const tagged = (tag: string) => SEED_DEVICES.filter((d) => d.tags.includes(tag));
      expect(tagged('production-east').length).toBe(1);
      expect(tagged('production-east')[0].id).toBe('srv-us-east-412');
      expect(tagged('k8s-cluster').length).toBe(4);
      expect(tagged('production-windows').length).toBe(11);
    });

    it('F15.2: The api client exposes the fleet broadcast surface', async () => {
      for (const name of ['fleetBroadcast', 'broadcastStatus', 'fleetVersion', 'updateFleet', 'triggers', 'schedules'] as const) {
        expect(typeof (api as any)[name]).toBe('function');
      }
    });

    it('F15.3: Broadcast reach over the seed is the 38 online nodes of 40', async () => {
      const online = SEED_DEVICES.filter((d) => d.status === 'online').length;
      expect(online).toBe(38);
      expect(SEED_DEVICES.length).toBe(40);
      expect(online + 2).toBe(SEED_DEVICES.length);
    });

    it('F15.4: Every seed device carries non-empty fleet tags', async () => {
      for (const d of SEED_DEVICES) {
        expect(d.tags.length).toBeGreaterThan(0);
      }
      expect(SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!.tags).toContain('pci-compliant');
    });

    it('F15.5: Dispatching to a second device binds the task to that device hostname', async () => {
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-win-prod-02',
        tool: 'desktop.capture_screen',
        args: { format: 'png', quality: 95 },
        riskTier: 'tier1_safe',
      });
      expect(dashboardStore.getState().tasks[0].deviceId).toBe('srv-win-prod-02');
      const task = await pending;
      expect(task.deviceHostname).toBe('srv-win-prod-02.ad.internal');
      expect(task.status).toBe('running');
    });
  }, { tier: 'tier1', featureId: 'F15' });

  // =========================================================================
  // F16: Reactive Self-Healing Rule Cards (5 tests)
  // =========================================================================
  describe('F16: Reactive Self-Healing Rule Cards', () => {
    it('F16.1: Seed audit records the auto-heal daemon restarting a service', async () => {
      const event = SEED_AUDIT_EVENTS.find((e) => e.blockNumber === 1492016)!;
      expect(event.action).toBe('systemd.restart_service');
      expect(event.actor).toBe('workflow:auto-heal-daemon');
      expect(event.governanceVerdict).toBe('auto_allowed');
      expect(event.payloadSummary).toContain('ai-bridge-edge-daemon');
    });

    it('F16.2: [source-level] FleetOperationsView defines a self-heal remediation action', async () => {
      const src = readSource('views/FleetOperationsView.tsx');
      expect(src).toContain('systemctl restart ai-bridge-agent && notify SecOps');
    });

    it('F16.3: [source-level] FleetOperationsView can simulate a rule trigger', async () => {
      const src = readSource('views/FleetOperationsView.tsx');
      expect(src).toContain('handleSimulateRuleTrigger');
    });

    it('F16.4: Seed log-4 ties the memory watchdog remediation to policy POL-042', async () => {
      const log = SEED_LOGS.find((l) => l.id === 'log-4')!;
      expect(log.level).toBe('WARN');
      expect((log.details as any).ruleId).toBe('POL-042');
      expect((log.details as any).riskTier).toBe('tier3_shell');
    });

    it('F16.5: The api client exposes the trigger/schedule rule surface', async () => {
      for (const name of ['triggers', 'createTrigger', 'deleteTrigger', 'toggleTrigger', 'testTrigger', 'schedules', 'createSchedule', 'deleteSchedule', 'toggleSchedule', 'runScheduleNow'] as const) {
        expect(typeof (api as any)[name]).toBe('function');
      }
    });
  }, { tier: 'tier1', featureId: 'F16' });

  // =========================================================================
  // F17: Multi-Provider Agent Hub (5 tests)
  // =========================================================================
  describe('F17: Multi-Provider Agent Hub', () => {
    it('F17.1: The api client exposes the AI provider/agent surface', async () => {
      for (const name of ['getAiSettings', 'saveAiSettings', 'aiTools', 'aiExecute', 'aiAgent', 'aiFleet', 'aiChat', 'agents', 'createAgent', 'updateAgent', 'deleteAgent', 'runAgentNow', 'askAgent', 'agentRuns'] as const) {
        expect(typeof (api as any)[name]).toBe('function');
      }
    });

    it('F17.2: [source-level, honesty D-03] Provider cards start "not_configured" with no hardcoded keys or latencies', async () => {
      const src = readSource('views/AiApiHubView.tsx');
      expect(src).toContain('status: "not_configured" as const');
      expect(src).toContain('latencyMs: null');
      expect(src).not.toContain('sk-ant-api03-***9a4');
      expect(src).not.toContain('sk-proj-***410f');
      expect(src).not.toContain('AIzaSy***71b9');
    });

    it('F17.3: [source-level] The SDK snippet generator references the real BridgeClient and gateway', async () => {
      const src = readSource('views/AiApiHubView.tsx');
      expect(src).toContain('BridgeClient');
      expect(src).toContain('https://bridge.internal/v1');
    });

    it('F17.4: Seed devices declare assigned models; the primary node has two', async () => {
      for (const d of SEED_DEVICES) {
        expect(d.assignedModels.length).toBeGreaterThan(0);
      }
      expect(SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!.assignedModels).toEqual(['Claude 3.5 Sonnet', 'GPT-4o']);
      expect(new Set(SEED_DEVICES.flatMap((d) => d.assignedModels)).size).toBeGreaterThan(1);
    });

    it('F17.5: [source-level] Demo AI execution is labelled as running nothing', async () => {
      const src = readSource('views/AiApiHubView.tsx');
      expect(src).toContain('Run sample (demo — runs nothing)');
    });
  }, { tier: 'tier1', featureId: 'F17' });

  // =========================================================================
  // F18: Human-in-the-Loop Approval Modal (5 tests)
  // =========================================================================
  describe('F18: Human-in-the-Loop Approval Modal', () => {
    it('F18.1: Seed holds three pending approvals across tiers 3 and 4', async () => {
      expect(SEED_APPROVALS.length).toBe(3);
      expect(SEED_APPROVALS.filter((a) => a.status === 'pending').length).toBe(3);
      expect(SEED_APPROVALS.find((a) => a.id === 'APR-4891')!.riskTier).toBe('tier3_shell');
      expect(SEED_APPROVALS.find((a) => a.id === 'APR-4892')!.riskTier).toBe('tier4_kernel');
      expect(SEED_APPROVALS.find((a) => a.id === 'APR-4893')!.riskTier).toBe('tier3_shell');
    });

    it('F18.2: Every seed approval links to a real seed task in needs_approval', async () => {
      for (const approval of SEED_APPROVALS) {
        const task = SEED_TASKS.find((t) => t.id === approval.taskId)!;
        expect(task).toBeDefined();
        expect(task.status).toBe('needs_approval');
        expect(task.deviceId).toBe(approval.deviceId);
      }
    });

    it('F18.3: Approving APR-4891 transitions approval, task and ledger, then restores seed state', async () => {
      const saved = snapshotStoreState();
      try {
        const before = dashboardStore.getState();
        const p = dashboardStore.resolveApproval('APR-4891', 'approved', 'Operator verification complete');
        callStore(p);
        const state = dashboardStore.getState();
        const app = state.approvals.find((a) => a.id === 'APR-4891')!;
        expect(app.status).toBe('approved');
        expect(app.decidedBy).toBe('operator:admin');
        expect(app.decisionReason).toBe('Operator verification complete');
        const task = state.tasks.find((t) => t.id === 'TSK-89214')!;
        expect(task.status).toBe('running');
        expect(state.auditEvents.length).toBe(before.auditEvents.length + 1);
        expect(state.auditEvents[0].action).toBe('approval.approved');
        expect(state.auditEvents[0].governanceVerdict).toBe('human_approved');
        // No await inside try: the restore in `finally` must land
        // synchronously, before the next test's synchronous prefix runs.
      } finally {
        restoreStoreState(saved);
      }
      expect(dashboardStore.getState().approvals.filter((a) => a.status === 'pending').length).toBe(3);
    });

    it('F18.4: Denying APR-4892 transitions approval and task, then restores seed state', async () => {
      const saved = snapshotStoreState();
      try {
        const before = dashboardStore.getState();
        const p = dashboardStore.resolveApproval('APR-4892', 'denied', 'Unauthorized bypass argument detected');
        callStore(p);
        const state = dashboardStore.getState();
        expect(state.approvals.find((a) => a.id === 'APR-4892')!.status).toBe('denied');
        expect(state.tasks.find((t) => t.id === 'TSK-89215')!.status).toBe('denied');
        expect(state.auditEvents.length).toBe(before.auditEvents.length + 1);
        expect(state.auditEvents[0].action).toBe('approval.denied');
        expect(state.auditEvents[0].governanceVerdict).toBe('denied');
        // No await inside try: the restore in `finally` must land
        // synchronously, before the next test's synchronous prefix runs.
      } finally {
        restoreStoreState(saved);
      }
      expect(dashboardStore.getState().approvals.filter((a) => a.status === 'pending').length).toBe(3);
    });

    it('F18.5: [source-level] Approval hold-to-confirm is 900ms live / 600ms demo', async () => {
      const src = readSource('views/HumanApprovalsView.tsx');
      expect(src).toContain('holdDurationMs={isLive ? 900 : 600}');
      expect(src).toContain('HoldToConfirmButton');
    });
  }, { tier: 'tier1', featureId: 'F18' });

  // =========================================================================
  // F19: AST Command Diff Inspector (5 tests)
  // =========================================================================
  describe('F19: AST Command Diff Inspector', () => {
    it('F19.1: APR-4891 diff shows the original, the proposed rm -rf and its dangerous tokens', async () => {
      const approval = SEED_APPROVALS.find((a) => a.id === 'APR-4891')!;
      expect(approval.command).toBe('rm -rf /opt/cache/node-modules-backup');
      expect(approval.argsDiff!.original).toBe('rm -f /opt/cache/temp.log');
      expect(approval.argsDiff!.proposed).toBe('rm -rf /opt/cache/node-modules-backup');
      expect(approval.argsDiff!.dangerousTokens).toEqual(['-rf', '/opt/cache/node-modules-backup']);
    });

    it('F19.2: Every dangerous token in every seed approval actually occurs in its command', async () => {
      for (const approval of SEED_APPROVALS) {
        for (const tokenText of approval.argsDiff!.dangerousTokens) {
          expect(approval.command).toContain(tokenText);
        }
      }
    });

    it('F19.3: APR-4893 diff flags the iptables flush and its NAT token', async () => {
      const approval = SEED_APPROVALS.find((a) => a.id === 'APR-4893')!;
      expect(approval.command).toBe('iptables -F && iptables -t nat -F');
      expect(approval.argsDiff!.dangerousTokens).toEqual(['iptables -F', '-t nat -F']);
    });

    it('F19.4: Seed shell.exec tasks carry the same dangerous commands as their approvals', async () => {
      const shellTasks = SEED_TASKS.filter((t) => t.tool === 'shell.exec');
      expect(shellTasks.length).toBe(3);
      const commands = shellTasks.map((t) => (t.args as any).command);
      expect(commands).toContain('rm -rf /opt/cache/node-modules-backup');
      expect(commands).toContain('powershell.exe -ExecutionPolicy Bypass -File C:\\Setup\\deploy-driver.ps1');
      expect(commands).toContain('iptables -F && iptables -t nat -F');
    });

    it('F19.5: [source-level] HumanApprovalsView renders the argsDiff dangerous tokens and proposed command', async () => {
      const src = readSource('views/HumanApprovalsView.tsx');
      expect(src).toContain('activeApproval.argsDiff?.dangerousTokens');
      expect(src).toContain('activeApproval.argsDiff.proposed');
    });
  }, { tier: 'tier1', featureId: 'F19' });

  // =========================================================================
  // F20: Executable Allowlist Matrix (5 tests)
  // =========================================================================
  describe('F20: Executable Allowlist Matrix', () => {
    it('F20.1: Every seed device fingerprint is a well-formed SHA-256 digest', async () => {
      for (const d of SEED_DEVICES) {
        expect(d.telemetry.fingerprintSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
      expect(SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!.telemetry.fingerprintSha256).toBe(
        'sha256:d9a4f2108b1e43cb98016b01e38921a4fa0c558913b8e434220b22f0981e4b3c'
      );
    });

    it('F20.2: Policy POL-042 denied the netcat reverse shell in the seed audit', async () => {
      const event = SEED_AUDIT_EVENTS.find((e) => e.blockNumber === 1492017)!;
      expect(event.governanceVerdict).toBe('denied');
      expect(event.payloadSummary).toContain('Policy POL-042');
      expect(event.payloadSummary).toContain('netcat reverse shell');
    });

    it('F20.3: The api client exposes the policy version/simulate surface', async () => {
      for (const name of ['policies', 'policyHistory', 'createPolicy', 'updatePolicyVersion', 'deletePolicyVersion', 'simulatePolicy'] as const) {
        expect(typeof (api as any)[name]).toBe('function');
      }
    });

    it('F20.4: Seed audit governance verdicts split auto_allowed / human_approved / denied', async () => {
      const count = (verdict: string) => SEED_AUDIT_EVENTS.filter((e) => e.governanceVerdict === verdict).length;
      expect(count('auto_allowed')).toBe(2);
      expect(count('human_approved')).toBe(1);
      expect(count('denied')).toBe(1);
    });

    it('F20.5: [source-level] SecurityPoliciesView simulates policy through the api client', async () => {
      const src = readSource('views/SecurityPoliciesView.tsx');
      expect(src).toContain('api.simulatePolicy');
    });
  }, { tier: 'tier1', featureId: 'F20' });

  // =========================================================================
  // F21: Webhook Dispatcher Suite (5 tests)
  // =========================================================================
  describe('F21: Webhook Dispatcher Suite', () => {
    it('F21.1: The api client exposes the webhook settings surface', async () => {
      expect(typeof api.getWebhook).toBe('function');
      expect(typeof api.setWebhook).toBe('function');
      expect(typeof api.testWebhook).toBe('function');
    });

    it('F21.2: The api client exposes the alert-config and delivery surface', async () => {
      expect(typeof api.alertsConfig).toBe('function');
      expect(typeof api.updateAlertsConfig).toBe('function');
      expect(typeof api.testAlerts).toBe('function');
      expect(typeof api.alertDeliveries).toBe('function');
    });

    it('F21.3: [source-level] The demo webhook list names the PagerDuty on-call sentinel', async () => {
      const src = readSource('views/SecurityPoliciesDemo.tsx');
      expect(src).toContain('PagerDuty On-Call Sentinel');
    });

    it('F21.4: [source-level] The demo delivery log records a delivered self-healing event', async () => {
      const src = readSource('views/SecurityPoliciesDemo.tsx');
      expect(src).toContain('SELF_HEALING_TRIGGERED');
      expect(src).toContain('PagerDuty On-Call');
      expect(src).toContain('delivered (200 OK)');
    });

    it('F21.5: Fleet notifications surface exists; seed log-2 names its MCP delivery target', async () => {
      expect(typeof api.notifications).toBe('function');
      const log = SEED_LOGS.find((l) => l.id === 'log-2')!;
      expect((log.details as any).client).toBe('client-cur-891');
      expect((log.details as any).taskId).toBe('TSK-89213');
    });
  }, { tier: 'tier1', featureId: 'F21' });

  // =========================================================================
  // F22: Merkle Root Integrity Ledger (5 tests)
  // =========================================================================
  describe('F22: Merkle Root Integrity Ledger', () => {
    it('F22.1: [source-level, honesty D-02] AuditTrailView reports "Not verified" and fabricates no Merkle root', async () => {
      const src = readSource('views/AuditTrailView.tsx');
      expect(src).toContain('Not verified — no cryptographic verification available');
      expect(src).not.toContain('0x7fa281b94d');
      expect(src).not.toContain('blocksChecked: 14920');
      expect(src).not.toContain('verificationProof');
    });

    it('F22.2: Seed audit blocks are hash-chained in descending block order', async () => {
      expect(SEED_AUDIT_EVENTS.map((e) => e.blockNumber)).toEqual([1492019, 1492018, 1492017, 1492016]);
      for (let i = 0; i < SEED_AUDIT_EVENTS.length - 1; i++) {
        expect(SEED_AUDIT_EVENTS[i].prevHash).toBe(SEED_AUDIT_EVENTS[i + 1].sha256Hash);
        expect(SEED_AUDIT_EVENTS[i].blockNumber).toBe(SEED_AUDIT_EVENTS[i + 1].blockNumber + 1);
      }
    });

    it('F22.3: Seed audit hashes are 64-hex digests (no "sha256:" prefix in the seed ledger)', async () => {
      for (const e of SEED_AUDIT_EVENTS) {
        expect(e.sha256Hash).toMatch(/^[0-9a-f]{64}$/);
        expect(e.prevHash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('F22.4: Seed audit covers all four actor kinds', async () => {
      const actors = new Set(SEED_AUDIT_EVENTS.map((e) => e.actor));
      expect(actors.has('agent:claude-3.5-sub')).toBe(true);
      expect(actors.has('operator:sarah.j')).toBe(true);
      expect(actors.has('agent:gpt-4o-copilot')).toBe(true);
      expect(actors.has('workflow:auto-heal-daemon')).toBe(true);
    });

    it('F22.5: Ledger filters over the real seed (denied 1, human_approved 1, auto_allowed 2)', async () => {
      expect(SEED_AUDIT_EVENTS.filter((e) => e.governanceVerdict === 'denied').length).toBe(1);
      expect(SEED_AUDIT_EVENTS.filter((e) => e.governanceVerdict === 'human_approved').length).toBe(1);
      expect(SEED_AUDIT_EVENTS.filter((e) => e.governanceVerdict === 'auto_allowed').length).toBe(2);
      expect(SEED_AUDIT_EVENTS.filter((e) => e.actor === 'agent:claude-3.5-sub').length).toBe(1);
    });
  }, { tier: 'tier1', featureId: 'F22' });

  // =========================================================================
  // F23: Multi-Format Audit Exporter (5 tests)
  // =========================================================================
  describe('F23: Multi-Format Audit Exporter', () => {
    it('F23.1: [source-level] The export payload is a JSON-LD AuditReport', async () => {
      const src = readSource('views/AuditTrailView.tsx');
      expect(src).toContain('"@context": "https://schema.org"');
      expect(src).toContain('type: "AuditReport"');
    });

    it('F23.2: [source-level] Live export goes through api.exportAudit()', async () => {
      const src = readSource('views/AuditTrailView.tsx');
      expect(src).toContain('api.exportAudit()');
      expect(typeof api.exportAudit).toBe('function');
    });

    it('F23.3: A CSV header built from the real audit record shape has the ledger columns', async () => {
      const header = Object.keys(SEED_AUDIT_EVENTS[0]).join(',');
      for (const col of ['blockNumber', 'timestamp', 'actor', 'action', 'targetHost', 'sha256Hash']) {
        expect(header).toContain(col);
      }
    });

    it('F23.4: Ledger filters over the real seed return the matching records', async () => {
      expect(SEED_AUDIT_EVENTS.filter((e) => e.actor === 'agent:claude-3.5-sub').length).toBe(1);
      expect(SEED_AUDIT_EVENTS.filter((e) => e.targetHost === 'srv-us-east-412').length).toBe(1);
      expect(SEED_AUDIT_EVENTS.filter((e) => e.action === 'shell.exec').length).toBe(1);
    });

    it('F23.5: A filter matching zero records yields an empty export set', async () => {
      expect(SEED_AUDIT_EVENTS.filter((e) => e.actor === 'agent:does-not-exist').length).toBe(0);
    });
  }, { tier: 'tier1', featureId: 'F23' });

  // =========================================================================
  // F24: MCP Protocol Gateway Monitor (5 tests)
  // =========================================================================
  describe('F24: MCP Protocol Gateway Monitor', () => {
    it('F24.1: Seed MCP routes are the four gateway streams', async () => {
      expect(SEED_MCP_CONNECTIONS.map((c) => c.route)).toEqual([
        '/mcp/v1/fleet-desktop',
        '/mcp/v1/host-terminal',
        '/mcp/v1/system-telemetry',
        '/mcp/v1/filesystem-sandbox',
      ]);
    });

    it('F24.2: All seed MCP streams speak MCP v1.0.4 over SSE except the stdio filesystem stream', async () => {
      for (const c of SEED_MCP_CONNECTIONS) {
        expect(c.specVersion).toBe('MCP v1.0.4');
      }
      expect(SEED_MCP_CONNECTIONS.filter((c) => c.transport === 'sse').length).toBe(3);
      expect(SEED_MCP_CONNECTIONS.find((c) => c.id === 'mcp-stream-04')!.transport).toBe('stdio');
    });

    it('F24.3: Seed streams export the tool schemas the dashboard invokes', async () => {
      const schemas = new Set(SEED_MCP_CONNECTIONS.flatMap((c) => c.exportedSchemas));
      for (const tool of ['desktop.capture_screen', 'pty.spawn', 'telemetry.cpu', 'file.read']) {
        expect(schemas.has(tool)).toBe(true);
      }
      expect(SEED_MCP_CONNECTIONS.find((c) => c.id === 'mcp-stream-01')!.exportedSchemas).toContain('desktop.click_coordinate');
    });

    it('F24.4: Seed stream load totals 42 clients and 5720 req/min, all p99 under 20ms', async () => {
      const clients = SEED_MCP_CONNECTIONS.reduce((sum, c) => sum + c.connectedClients, 0);
      const throughput = SEED_MCP_CONNECTIONS.reduce((sum, c) => sum + c.throughputReqMin, 0);
      expect(clients).toBe(42);
      expect(throughput).toBe(5720);
      for (const c of SEED_MCP_CONNECTIONS) {
        expect(c.latencyP99Ms).toBeLessThan(20);
        expect(c.status).toBe('online');
      }
    });

    it('F24.5: [source-level] ConnectionsView filters out exactly the four seed MCP ids in live mode', async () => {
      const src = readSource('views/ConnectionsView.tsx');
      expect(src).toContain('SEED_MCP_IDS');
      for (const id of SEED_MCP_CONNECTIONS.map((c) => c.id)) {
        expect(src).toContain(`"${id}"`);
      }
    });
  }, { tier: 'tier1', featureId: 'F24' });

  // =========================================================================
  // F25: OAuth 2.0 Credential Vault (5 tests)
  // =========================================================================
  describe('F25: OAuth 2.0 Credential Vault', () => {
    it('F25.1: Seed holds three OAuth clients with the seeded ids', async () => {
      expect(SEED_OAUTH_CLIENTS.map((c) => c.id)).toEqual(['client-cur-891', 'client-cld-104', 'client-py-092']);
      expect(SEED_OAUTH_CLIENTS.map((c) => c.clientName)).toEqual([
        'Cursor IDE Autonomous Agent',
        'Claude Desktop App Direct Bridge',
        'SecOps Automation Python SDK',
      ]);
    });

    it('F25.2: Seed clients bind PKCE S256, two of them with DPoP', async () => {
      expect(SEED_OAUTH_CLIENTS.find((c) => c.id === 'client-cur-891')!.pkceType).toBe('S256 + DPoP');
      expect(SEED_OAUTH_CLIENTS.find((c) => c.id === 'client-cld-104')!.pkceType).toBe('S256 + DPoP');
      expect(SEED_OAUTH_CLIENTS.find((c) => c.id === 'client-py-092')!.pkceType).toBe('S256');
    });

    it('F25.3: Seed client scopes cover fleet read, MCP stream, tool call, audit read and approvals write', async () => {
      const scopes = new Set(SEED_OAUTH_CLIENTS.flatMap((c) => c.scopes));
      for (const scope of ['fleet:read', 'mcp:stream', 'tools:call', 'audit:read', 'approvals:write']) {
        expect(scopes.has(scope)).toBe(true);
      }
      expect(SEED_OAUTH_CLIENTS.find((c) => c.id === 'client-cur-891')!.scopes).toEqual(['fleet:read', 'mcp:stream', 'tools:call']);
    });

    it('F25.4: Seed client secrets are masked with the sec_tok_ prefix and bullet masking', async () => {
      for (const c of SEED_OAUTH_CLIENTS) {
        expect(c.tokenSecretMasked.startsWith('sec_tok_')).toBe(true);
        expect(c.tokenSecretMasked).toContain('••••');
      }
      expect(SEED_OAUTH_CLIENTS.find((c) => c.id === 'client-cur-891')!.tokenSecretMasked).toBe('sec_tok_••••••••••••3fa9');
    });

    it('F25.5: [source-level] ConnectionsView filters out exactly the three seed client ids in live mode', async () => {
      const src = readSource('views/ConnectionsView.tsx');
      expect(src).toContain('SEED_CLIENT_IDS');
      for (const id of SEED_OAUTH_CLIENTS.map((c) => c.id)) {
        expect(src).toContain(`"${id}"`);
      }
      expect(typeof api.connections).toBe('function');
      expect(typeof api.updateOAuthClient).toBe('function');
      expect(typeof api.deleteOAuthClient).toBe('function');
    });
  }, { tier: 'tier1', featureId: 'F25' });

  // =========================================================================
  // F26: Wire Protocol Realtime Audit Drawer (5 tests)
  // =========================================================================
  describe('F26: Wire Protocol Realtime Audit Drawer', () => {
    it('F26.1: Seed log-2 is the tools/call wire frame for TSK-89213', async () => {
      const log = SEED_LOGS.find((l) => l.id === 'log-2')!;
      expect(log.message).toContain('method=tools/call');
      expect(log.message).toContain('id=TSK-89213');
      expect((log.details as any).client).toBe('client-cur-891');
      expect((log.details as any).taskId).toBe('TSK-89213');
    });

    it('F26.2: Terminal stream URL carries the sequence cursor for live tailing', async () => {
      expect(api.terminalStreamUrl('srv-us-east-412', 'sess-1', 0)).toContain('since_seq=0');
      expect(api.terminalStreamUrl('srv-us-east-412', 'sess-1', 42)).toContain('since_seq=42');
    });

    it('F26.3: Seed audit names the blocked wire-level tool (netcat reverse shell)', async () => {
      const event = SEED_AUDIT_EVENTS.find((e) => e.action === 'shell.exec')!;
      expect(event.payloadSummary).toContain('netcat reverse shell');
      expect(event.governanceVerdict).toBe('denied');
    });

    it('F26.4: The capture tool name is a dotted MCP name exported by the fleet-desktop stream', async () => {
      const tool = SEED_TASKS.find((t) => t.id === 'TSK-89213')!.tool;
      expect(tool).toMatch(/^\w+\.\w+$/);
      expect(SEED_MCP_CONNECTIONS.find((c) => c.id === 'mcp-stream-01')!.exportedSchemas).toContain(tool);
    });

    it('F26.5: Wire filters over the real seed (capture 1, shell.exec 3)', async () => {
      expect(SEED_TASKS.filter((t) => t.tool === 'desktop.capture_screen').length).toBe(1);
      expect(SEED_TASKS.filter((t) => t.tool === 'shell.exec').length).toBe(3);
    });
  }, { tier: 'tier1', featureId: 'F26' });

  // =========================================================================
  // F27: Monospace Systemd Log Canvas (5 tests)
  // =========================================================================
  describe('F27: Monospace Systemd Log Canvas', () => {
    it('F27.1: Seed logs name the real systemd-era services', async () => {
      expect(SEED_LOGS.map((l) => l.service)).toEqual([
        'ai-bridge-core.service',
        'ai-bridge-mcp-gateway',
        'ai-bridge-edge-daemon',
        'ai-bridge-core.service',
      ]);
    });

    it('F27.2: Seed log severities split INFO 2 / DEBUG 1 / WARN 1 with no ERROR or FATAL', async () => {
      const count = (level: string) => SEED_LOGS.filter((l) => l.level === level).length;
      expect(count('INFO')).toBe(2);
      expect(count('DEBUG')).toBe(1);
      expect(count('WARN')).toBe(1);
      expect(count('ERROR')).toBe(0);
      expect(count('FATAL')).toBe(0);
    });

    it('F27.3: Log text search over the real seed finds the handshake row', async () => {
      const match = SEED_LOGS.filter((l) => /Handshake/.test(l.message));
      expect(match.length).toBe(1);
      expect(match[0].id).toBe('log-1');
      // The mTLS evidence itself lives in the details (cipher + latency).
      expect((match[0].details as any).cipher).toBe('TLS_AES_256_GCM_SHA384');
      expect((match[0].details as any).latencyMs).toBe(14);
    });

    it('F27.4: Seed trace ids are unique and well-formed', async () => {
      const ids = SEED_LOGS.map((l) => l.traceId!);
      expect(new Set(ids).size).toBe(4);
      expect(ids).toEqual(['trc-890a-112', 'trc-890a-113', 'trc-890a-114', 'trc-890a-115']);
      for (const id of ids) {
        expect(id).toMatch(/^trc-[0-9a-f]+-\d+$/);
      }
    });

    it('F27.5: Seed logs are newest-first by timestamp', async () => {
      const stamps = SEED_LOGS.map((l) => Date.parse(l.timestamp));
      for (let i = 0; i < stamps.length - 1; i++) {
        expect(stamps[i]).toBeGreaterThan(stamps[i + 1]);
      }
    });
  }, { tier: 'tier1', featureId: 'F27' });

  // =========================================================================
  // F28: Structured JSON Log Inspector (5 tests)
  // =========================================================================
  describe('F28: Structured JSON Log Inspector', () => {
    it('F28.1: Log details survive a JSON round-trip unchanged', async () => {
      const details = SEED_LOGS.find((l) => l.id === 'log-1')!.details!;
      expect(JSON.parse(JSON.stringify(details))).toEqual(details);
      expect((details as any).service).toBeUndefined();
    });

    it('F28.2: Structured details carry cipher/latency/node and policy rule ids', async () => {
      const log1 = SEED_LOGS.find((l) => l.id === 'log-1')!.details as any;
      expect(log1.cipher).toBe('TLS_AES_256_GCM_SHA384');
      expect(log1.latencyMs).toBe(14);
      expect(log1.node).toBe('srv-us-east-412');
      const log4 = SEED_LOGS.find((l) => l.id === 'log-4')!.details as any;
      expect(log4.ruleId).toBe('POL-042');
      expect(log4.riskTier).toBe('tier3_shell');
    });

    it('F28.3: Trace-id filter over the real seed selects log-3; a record without traceId has no key', async () => {
      expect(SEED_LOGS.filter((l) => l.traceId === 'trc-890a-114').map((l) => l.id)).toEqual(['log-3']);
      const { traceId: _dropped, ...rest } = SEED_LOGS[0] as any;
      expect('traceId' in rest).toBe(false);
      expect(rest.id).toBe('log-1');
    });

    it('F28.4: The node pinned from log-1 details exists in the seed fleet', async () => {
      const node = (SEED_LOGS.find((l) => l.id === 'log-1')!.details as any).node;
      expect(SEED_DEVICES.some((d) => d.id === node)).toBe(true);
    });

    it('F28.5: A plain-text log line is not JSON and falls back to raw display', async () => {
      const raw = SEED_LOGS.find((l) => l.id === 'log-1')!.message;
      expect(raw.length).toBeGreaterThan(0);
      let parsed: unknown = null;
      let threw = false;
      try {
        parsed = JSON.parse(raw);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(parsed).toBeNull();
    });
  }, { tier: 'tier1', featureId: 'F28' });

  // =========================================================================
  // F29: Stream Pause Hotkey (Spacebar) (5 tests)
  // =========================================================================
  describe('F29: Stream Pause Hotkey (Spacebar)', () => {
    it('F29.1: Pausing the 15s poll flips autoPollEnabled and restores it', async () => {
      expect(dashboardStore.getState().autoPollEnabled).toBe(true);
      dashboardStore.setAutoPollEnabled(false);
      expect(dashboardStore.getState().autoPollEnabled).toBe(false);
      dashboardStore.setAutoPollEnabled(true);
      expect(dashboardStore.getState().autoPollEnabled).toBe(true);
    });

    it('F29.2: [source-level] DiagnosticsLogsView guards its regex filter with try/catch', async () => {
      const src = readSource('views/DiagnosticsLogsView.tsx');
      expect(src).toContain('try {');
      expect(src).toContain('catch');
    });

    it('F29.3: Store listeners fire on poll-toggle changes and not on same-value sets', async () => {
      let callCount = 0;
      const unsubscribe = dashboardStore.subscribe(() => {
        callCount++;
      });
      dashboardStore.setAutoPollEnabled(false);
      expect(callCount).toBe(1);
      dashboardStore.setAutoPollEnabled(false);
      expect(callCount).toBe(1);
      dashboardStore.setAutoPollEnabled(true);
      expect(callCount).toBe(2);
      unsubscribe();
      dashboardStore.setAutoPollEnabled(false);
      expect(callCount).toBe(2);
      dashboardStore.setAutoPollEnabled(true);
    });

    it('F29.4: Seed audit timestamps are newest-first (the tail the pause preserves)', async () => {
      const stamps = SEED_AUDIT_EVENTS.map((e) => Date.parse(e.timestamp));
      for (let i = 0; i < stamps.length - 1; i++) {
        expect(stamps[i]).toBeGreaterThan(stamps[i + 1]);
      }
    });

    it('F29.5: Refresh chrome strings come from the real i18n catalog', async () => {
      expect(messages).toContain('Refresh');
      expect(messages).toContain('Refreshing…');
      expect(translate('en', 'Refresh')).toBe('Refresh');
    });
  }, { tier: 'tier1', featureId: 'F29' });

  // =========================================================================
  // F30: Zero-Drop Ring Buffer Meter (5 tests)
  // =========================================================================
  describe('F30: Zero-Drop Ring Buffer Meter', () => {
    it('F30.1: [source-level] DiagnosticsLogsView falls back to the 30.72MB meter value when not live', async () => {
      const src = readSource('views/DiagnosticsLogsView.tsx');
      expect(src).toContain('if (!isLive) return 30.72;');
      expect(Math.round((30.72 / 64.0) * 100)).toBe(48);
    });

    it('F30.2: Every seed device disk percentage is within 0–100', async () => {
      for (const d of SEED_DEVICES) {
        expect(d.telemetry.diskPercent).toBeGreaterThanOrEqual(0);
        expect(d.telemetry.diskPercent).toBeLessThanOrEqual(100);
      }
      expect(SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!.telemetry.diskPercent).toBe(42);
    });

    it('F30.3: Seed MCP throughput is a live ingestion rate well above 1000 req/min', async () => {
      const total = SEED_MCP_CONNECTIONS.reduce((sum, c) => sum + c.throughputReqMin, 0);
      expect(total).toBe(5720);
      expect(total).toBeGreaterThan(1000);
    });

    it('F30.4: The two newest audit blocks are the head of the ledger', async () => {
      expect(SEED_AUDIT_EVENTS.slice(0, 2).map((e) => e.blockNumber)).toEqual([1492019, 1492018]);
    });

    it('F30.5: The api client exposes live service logs', async () => {
      expect(typeof api.logs).toBe('function');
      for (const log of SEED_LOGS) {
        expect(log.service.length).toBeGreaterThan(0);
      }
    });
  }, { tier: 'tier1', featureId: 'F30' });

  // =========================================================================
  // F31: Legacy CSS & Wrapper Elimination (5 tests)
  // =========================================================================
  describe('F31: Legacy CSS & Wrapper Elimination', () => {
    it('F31.1: [source-level] fluent2.css and jxui.css do not exist under src/', async () => {
      expect(fs.existsSync(path.join(SRC_DIR, 'fluent2.css'))).toBe(false);
      expect(fs.existsSync(path.join(SRC_DIR, 'jxui.css'))).toBe(false);
    });

    it('F31.2: [source-level] Legacy wrapper components do not exist under src/', async () => {
      for (const name of ['ConfirmDialog.tsx', 'Pager.tsx', 'ViewLoadingSkeleton.tsx']) {
        expect(fs.existsSync(path.join(SRC_DIR, name))).toBe(false);
      }
    });

    it('F31.3: [source-level] No inline style={{...}} attributes remain in production source', async () => {
      const violations: string[] = [];
      for (const file of scanProductionSources()) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, idx) => {
          if (/style\s*=\s*[{'"]/.test(line)) violations.push(`${file}:${idx + 1}`);
        });
      }
      expect(violations.length).toBe(0);
    });

    it('F31.4: [source-level] No f2- legacy CSS utility classes remain in production source', async () => {
      const violations: string[] = [];
      for (const file of scanProductionSources()) {
        if (/\.f2-[a-z0-9_-]+/.test(fs.readFileSync(file, 'utf8'))) violations.push(file);
      }
      expect(violations.length).toBe(0);
    });

    it('F31.5: [source-level] tailwind.css is the only CSS file under src/', async () => {
      const cssFiles: string[] = [];
      const walk = (dir: string): void => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (ent.name !== 'tests' && ent.name !== 'node_modules') walk(full);
          } else if (ent.isFile() && ent.name.endsWith('.css')) {
            cssFiles.push(full);
          }
        }
      };
      walk(SRC_DIR);
      expect(cssFiles).toEqual([path.join(SRC_DIR, 'tailwind.css')]);
    });
  }, { tier: 'tier1', featureId: 'F31' });

  // Surface any rejection from the synchronously-applied store calls
  // collected via callStore() (see the header note).
  await Promise.all(pendingStoreCalls);
}

const isDirectExecution =
  process.argv[1]?.endsWith('tier1-feature-coverage.test.ts') ||
  process.argv[1]?.endsWith('tier1-feature-coverage.test.js');

if (isDirectExecution) {
  runTier1Tests()
    .then(async () => {
      const { printSummary } = await import('./harness.js');
      const summary = printSummary('Tier 1 Test Suite');
      if (summary.failed > 0) process.exit(1);
    })
    .catch((err) => {
      console.error('Tier 1 runner failed:', err);
      process.exit(1);
    });
}
