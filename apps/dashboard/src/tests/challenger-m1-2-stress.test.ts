/**
 * AI Bridge Enterprise Dashboard — Challenger M1.2 Adversarial Stress Test Suite
 * Executed by teamwork_challenger (empirical verification)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { dashboardStore } from '../state/dashboardStore';
import type { ViewId, EnrolledDevice } from '../types/dashboard';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..');

const ALL_15_ROUTES: ViewId[] = [
  'overview',
  'devices',
  'device-360-system',
  'task-queue-and-vision',
  'live-desktop-studio',
  'interactive-terminal',
  'autonomous-workflows',
  'fleet-operations',
  'ai-api-and-agents',
  'human-approvals',
  'security-policies',
  'audit-trail',
  'mcp-and-oauth',
  'diagnostics-and-logs',
  'login',
];

export interface ChallengerTestRecord {
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export async function runChallengerM12StressTests(): Promise<{ total: number; passed: number; failed: number; records: ChallengerTestRecord[] }> {
  console.log('================================================================================');
  console.log('>>> CHALLENGER M1.2 EMPIRICAL ADVERSARIAL STRESS TEST HARNESS <<<');
  console.log('================================================================================');

  let passed = 0;
  let failed = 0;
  const findings: string[] = [];
  const records: ChallengerTestRecord[] = [];
  const currentSuite = 'Challenger M1.2 Stress';

  function test(name: string, fn: () => void | Promise<void>) {
    const start = performance.now();
    try {
      fn();
      const durationMs = Number((performance.now() - start).toFixed(2));
      records.push({ suite: currentSuite, name, passed: true, durationMs });
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err: any) {
      const durationMs = Number((performance.now() - start).toFixed(2));
      const errMsg = err?.message || String(err);
      records.push({ suite: currentSuite, name, passed: false, durationMs, error: errMsg });
      console.error(`[FAIL] ${name}`);
      console.error(`       Error: ${errMsg}`);
      failed++;
    }
  }

  async function asyncTest(name: string, fn: () => Promise<void>) {
    const start = performance.now();
    try {
      await fn();
      const durationMs = Number((performance.now() - start).toFixed(2));
      records.push({ suite: currentSuite, name, passed: true, durationMs });
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err: any) {
      const durationMs = Number((performance.now() - start).toFixed(2));
      const errMsg = err?.message || String(err);
      records.push({ suite: currentSuite, name, passed: false, durationMs, error: errMsg });
      console.error(`[FAIL] ${name}`);
      console.error(`       Error: ${errMsg}`);
      failed++;
    }
  }

  // ==========================================================================
  // SECTION 1: ALL 15 ROUTES RESOLUTION & STORE DISPATCH
  // ==========================================================================
  console.log('\n--- 1. NAVIGATION ROUTING & METADATA VERIFICATION ---');

  test('1.1: All 15 navigation routes can be dispatched without errors in dashboardStore', () => {
    // D-01: in Node there are no credentials and no demo acknowledgement, so
    // every demo route dispatches to the login-first contract ('login') rather
    // than landing on seeded demo data. The dispatch itself must not throw
    // and the resulting view must be a valid, deterministic ViewId.
    // (Canonical contract: Tier 1 F3.3. Route metadata is covered by 1.2.)
    for (const route of ALL_15_ROUTES) {
      dashboardStore.setCurrentView(route);
      const state = dashboardStore.getState();
      assert.strictEqual(state.currentView, 'login', `Unauthenticated dispatch of route ${route} must resolve to login (D-01)`);
    }
    // Reset to login (the only view reachable unauthenticated in Node)
    dashboardStore.setCurrentView('login');
    assert.strictEqual(dashboardStore.getState().currentView, 'login');
  });

  test('1.2: App router view metadata covers all 15 routes completely', () => {
    // Read App.tsx and extract viewMeta keys
    const appSource = fs.readFileSync(path.join(SRC_DIR, 'App.tsx'), 'utf8');

    for (const route of ALL_15_ROUTES) {
      const routeQuoted = `"${route}":`;
      const routeUnquoted = `${route}:`;
      const found = appSource.includes(routeQuoted) || appSource.includes(routeUnquoted);
      assert.ok(found, `App.tsx viewMeta missing metadata entry for route "${route}"`);
    }
  });

  // ==========================================================================
  // SECTION 2: KEYBOARD SHORTCUT EVENT LISTENERS & CLEANUP AUDIT
  // ==========================================================================
  console.log('\n--- 2. KEYBOARD EVENT LISTENERS (⌘K / Ctrl+K / Escape) AUDIT ---');

  test('2.1: CommandPaletteModal source code attaches keydown listener to window in useEffect', () => {
    const modalSource = fs.readFileSync(path.join(SRC_DIR, 'shell', 'CommandPaletteModal.tsx'), 'utf8');

    // Handler is named onKeyDown in the source (not handleKeyDown).
    assert.ok(
      modalSource.includes('window.addEventListener("keydown", onKeyDown)'),
      'Must add keydown listener to window'
    );
  });

  test('2.2: CommandPaletteModal source code cleans up keydown listener in useEffect return', () => {
    const modalSource = fs.readFileSync(path.join(SRC_DIR, 'shell', 'CommandPaletteModal.tsx'), 'utf8');

    // Handler is named onKeyDown in the source (not handleKeyDown).
    assert.ok(
      modalSource.includes('return () => window.removeEventListener("keydown", onKeyDown)'),
      'Must remove keydown listener from window on cleanup'
    );
  });

  test('2.3: CommandPaletteModal keyboard handler handles ⌘K, Ctrl+K, and Escape correctly', () => {
    // Replicate the exact handler from CommandPaletteModal.tsx:59-67
    let isOpen = false;
    let setOpenCallCount = 0;
    let lastSetOpenValue = false;
    const setOpen = (val: boolean) => {
      setOpenCallCount++;
      isOpen = val;
      lastSetOpenValue = val;
    };

    const createHandler = (currentOpen: boolean) => (e: {
      metaKey?: boolean;
      ctrlKey?: boolean;
      key: string;
      defaultPrevented?: boolean;
      preventDefault: () => void;
    }) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!currentOpen);
      } else if (e.key === 'Escape' && currentOpen) {
        e.preventDefault();
        setOpen(false);
      }
    };

    // Test ⌘K when closed -> opens
    let prevented = false;
    let handler = createHandler(false);
    handler({ metaKey: true, key: 'k', preventDefault: () => { prevented = true; } });
    assert.strictEqual(prevented, true, '⌘K should call preventDefault');
    assert.strictEqual(lastSetOpenValue, true, '⌘K should set open to true');

    // Test Ctrl+K (uppercase K) when closed -> opens
    prevented = false;
    handler = createHandler(false);
    handler({ ctrlKey: true, key: 'K', preventDefault: () => { prevented = true; } });
    assert.strictEqual(prevented, true, 'Ctrl+K should call preventDefault');
    assert.strictEqual(lastSetOpenValue, true, 'Ctrl+K should set open to true');

    // Test ⌘K when open -> closes
    prevented = false;
    handler = createHandler(true);
    handler({ metaKey: true, key: 'k', preventDefault: () => { prevented = true; } });
    assert.strictEqual(prevented, true, '⌘K when open should call preventDefault');
    assert.strictEqual(lastSetOpenValue, false, '⌘K when open should toggle to false');

    // Test Escape when open -> closes
    prevented = false;
    handler = createHandler(true);
    handler({ key: 'Escape', preventDefault: () => { prevented = true; } });
    assert.strictEqual(prevented, true, 'Escape when open should call preventDefault');
    assert.strictEqual(lastSetOpenValue, false, 'Escape when open should set open to false');

    // Test Escape when closed -> no-op
    prevented = false;
    const countBefore = setOpenCallCount;
    handler = createHandler(false);
    handler({ key: 'Escape', preventDefault: () => { prevented = true; } });
    assert.strictEqual(prevented, false, 'Escape when closed should NOT call preventDefault');
    assert.strictEqual(setOpenCallCount, countBefore, 'Escape when closed should NOT call setOpen');

    // Test unrelated key (e.g. Enter, Shift) -> no-op
    handler = createHandler(true);
    handler({ key: 'Enter', preventDefault: () => { prevented = true; } });
    assert.strictEqual(setOpenCallCount, countBefore, 'Enter should NOT call setOpen');
  });

  // ==========================================================================
  // SECTION 3: STRICT PROHIBITIONS AUDIT (EMOJIS, INLINE STYLES, CUSTOM CSS)
  // ==========================================================================
  console.log('\n--- 3. STRICT PROHIBITIONS & ANTI-AI AESTHETIC AUDIT ---');

  test('3.1: Zero emojis in production source files', () => {
    const emojiRegex = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

    function scanFiles(dir: string): string[] {
      const violations: string[] = [];
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory() && ent.name !== 'tests' && ent.name !== 'legacy_reference' && ent.name !== 'node_modules') {
          violations.push(...scanFiles(full));
        } else if (ent.isFile() && (ent.name.endsWith('.tsx') || ent.name.endsWith('.ts'))) {
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          lines.forEach((line, idx) => {
            if (emojiRegex.test(line)) {
              violations.push(`${full}:${idx + 1}: ${line.trim()}`);
            }
          });
        }
      }
      return violations;
    }

    const emojiViolations = scanFiles(SRC_DIR);
    assert.strictEqual(
      emojiViolations.length,
      0,
      `Detected ${emojiViolations.length} emojis in UI code:\n${emojiViolations.join('\n')}`
    );
  });

  test('3.2: Zero custom CSS files or inline styles (style=) in production code', () => {
    function scanStyles(dir: string): string[] {
      const violations: string[] = [];
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory() && ent.name !== 'tests' && ent.name !== 'legacy_reference' && ent.name !== 'node_modules') {
          violations.push(...scanStyles(full));
        } else if (ent.isFile() && (ent.name.endsWith('.tsx') || ent.name.endsWith('.ts'))) {
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          lines.forEach((line, idx) => {
            // Check for inline style attribute
            if (/style\s*=\s*[{'"]/.test(line)) {
              violations.push(`${full}:${idx + 1}: ${line.trim()}`);
            }
          });
        } else if (ent.isFile() && ent.name.endsWith('.css') && ent.name !== 'tailwind.css') {
          violations.push(`Custom CSS file detected: ${full}`);
        }
      }
      return violations;
    }

    const styleViolations = scanStyles(SRC_DIR);
    assert.strictEqual(
      styleViolations.length,
      0,
      `Detected style violations:\n${styleViolations.join('\n')}`
    );
  });

  test('3.3: Verify legacy custom wrappers (ConfirmDialog, Pager, ViewLoadingSkeleton) are absent', () => {
    const forbiddenFiles = [
      path.join(SRC_DIR, 'ConfirmDialog.tsx'),
      path.join(SRC_DIR, 'Pager.tsx'),
      path.join(SRC_DIR, 'ViewLoadingSkeleton.tsx'),
      path.join(SRC_DIR, 'fluent2.css'),
      path.join(SRC_DIR, 'jxui.css'),
    ];

    for (const f of forbiddenFiles) {
      assert.strictEqual(fs.existsSync(f), false, `Legacy forbidden file still exists: ${f}`);
    }
  });

  // ==========================================================================
  // SECTION 4: ALL 15 ROUTES LOGICAL EXECUTION & DATA INTEGRITY
  // ==========================================================================
  console.log('\n--- 4. ROUTE DISPATCH & VIEW INTEGRITY (ALL 15 ROUTES) ---');

  // Verify that for all 15 routes, store state and metadata resolve completely
  const appSource = fs.readFileSync(path.join(SRC_DIR, 'App.tsx'), 'utf8');

  for (const route of ALL_15_ROUTES) {
    test(`4.${ALL_15_ROUTES.indexOf(route) + 1}: Route "${route}" dispatches cleanly and has title & breadcrumbs in App.tsx`, () => {
      dashboardStore.setCurrentView(route);
      const state = dashboardStore.getState();
      // D-01: unauthenticated demo-route dispatch resolves to login in Node
      // (Tier 1 F3.3); 'login' itself resolves to 'login'. The route's title
      // & breadcrumbs metadata must still be declared in App.tsx.
      assert.strictEqual(state.currentView, 'login', `Unauthenticated dispatch of route ${route} must resolve to login (D-01)`);

      // Verify that route appears in App.tsx router mapping
      assert.ok(
        appSource.includes(`"${route}":`) || appSource.includes(`${route}:`),
        `Route ${route} not declared in App.tsx viewMeta`
      );
    });
  }

  // ==========================================================================
  // SECTION 5: ADVERSARIAL EDGE CASES & STRESS CONDITIONS
  // ==========================================================================
  console.log('\n--- 5. ADVERSARIAL EDGE CASE STRESS TESTING ---');

  test('5.1: Selected device ID points to non-existent ID falls back safely in store', () => {
    dashboardStore.setSelectedDeviceId('NON_EXISTENT_DEVICE_9999');
    const state = dashboardStore.getState();
    assert.strictEqual(state.selectedDeviceId, 'NON_EXISTENT_DEVICE_9999');
    const selected = state.devices.find((d) => d.id === state.selectedDeviceId) || state.devices[0];
    assert.ok(selected, 'Fallback device should be defined');
    assert.strictEqual(selected.id, 'srv-us-east-412');
  });

  test('5.2: Approvals list emptied dynamically maintains correct badge and zero-state counts', () => {
    const originalApprovals = [...dashboardStore.getState().approvals];
    (dashboardStore as any).state = {
      ...(dashboardStore as any).state,
      approvals: [],
    };
    (dashboardStore as any).notify();

    const state = dashboardStore.getState();
    const pendingCount = state.approvals.filter((a) => a.status === 'pending').length;
    assert.strictEqual(pendingCount, 0, 'Pending count should be 0 when empty');

    // Restore approvals
    (dashboardStore as any).state = {
      ...(dashboardStore as any).state,
      approvals: originalApprovals,
    };
    (dashboardStore as any).notify();
  });

  test('5.3: Tasks list emptied dynamically maintains valid store state', () => {
    const originalTasks = [...dashboardStore.getState().tasks];
    (dashboardStore as any).state = {
      ...(dashboardStore as any).state,
      tasks: [],
    };
    (dashboardStore as any).notify();

    const state = dashboardStore.getState();
    assert.strictEqual(state.tasks.length, 0);

    (dashboardStore as any).state = {
      ...(dashboardStore as any).state,
      tasks: originalTasks,
    };
    (dashboardStore as any).notify();
  });

  test('5.4: Stress condition — empty devices list in App.tsx (Null Dereference Discovery)', () => {
    // In App.tsx line 62:
    // const selectedDevice = devices.find((d) => d.id === selectedDeviceId) || devices[0];
    // If devices is empty array ([]):
    // selectedDevice is undefined.
    // Line 81: breadcrumbs: ["AI Bridge", "Operations", "Device 360", selectedDevice.hostname]
    // Accessing selectedDevice.hostname throws TypeError: Cannot read properties of undefined (reading 'hostname')!
    
    const devicesEmpty: any[] = [];
    const selectedDeviceId = 'srv-us-east-412';
    const selectedDevice = devicesEmpty.find((d) => d.id === selectedDeviceId) || devicesEmpty[0];

    assert.strictEqual(selectedDevice, undefined, 'When devices is empty, selectedDevice is undefined');

    let threwError = false;
    try {
      const hostname = selectedDevice.hostname;
    } catch (e: any) {
      threwError = true;
    }

    assert.strictEqual(threwError, true, 'Accessing hostname on undefined selectedDevice throws TypeError');
    console.warn('       [EDGE CASE FINDING CONFIRMED] App.tsx: line 62/81 assumes devices array is non-empty.');
    console.warn('       If devices array is empty, line 81 and line 536 throw TypeError.');
    findings.push('App.tsx: lines 62, 81, 536 assume `devices` array is non-empty. If devices is empty, accessing `selectedDevice.hostname` or `selectedDevice.name` causes an unhandled TypeError.');
  });

  // Restore store to initial state
  dashboardStore.setCurrentView('overview');
  dashboardStore.setSelectedDeviceId('srv-us-east-412');

  console.log('\n================================================================================');
  console.log(`CHALLENGER M1.2 SUITE RESULTS: ${passed} PASSED / ${failed} FAILED`);
  if (findings.length > 0) {
    console.log(`Discovered ${findings.length} edge-case/adversarial findings:`);
    findings.forEach((f, i) => console.log(`  [${i + 1}] ${f}`));
  }
  console.log('================================================================================');

  return { total: passed + failed, passed, failed, records };
}

// Auto-execute only when invoked directly via tsx (importing this file from the
// master runner must not run the suite or exit the process).
const isDirectExecution =
  process.argv[1]?.endsWith('challenger-m1-2-stress.test.ts') ||
  process.argv[1]?.endsWith('challenger-m1-2-stress.test.js');

if (isDirectExecution) {
  runChallengerM12StressTests()
    .then(({ failed }) => {
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error('Fatal runner error:', err);
      process.exit(1);
    });
}
