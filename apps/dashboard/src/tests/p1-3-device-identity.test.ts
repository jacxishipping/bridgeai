/**
 * P1-3 Test Suite: device-token rotation + mTLS fingerprint (dashboard).
 *
 * Covers, per the P1-3 contract:
 * - the rotate-token and mtls-fingerprint api wrappers hit the right
 *   paths with the right methods/bodies (real calls against a stubbed
 *   fetch — no live backend);
 * - the 72-hour expiry-badge logic at its boundaries (real helper);
 * - the DevicesView / Device360View wiring at source level (these views
 *   need a browser/DOM + live control plane to render, so — following
 *   the established "[source-level]" convention — the assertions read
 *   the real view source as text).
 *
 * P1-4 (user deletion / password change/reset) is deliberately NOT
 * covered here: James implemented P1-4 himself and this wave is P1-3
 * only. No P1-4 wrapper, view, or test exists in this tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, setSuite } from './harness.js';
import { api, ApiError } from '../api.js';
import {
  tokenExpiryStatus,
  tokenExpiryLabel,
  TOKEN_EXPIRY_WARNING_HOURS,
  TOKEN_EXPIRY_WARNING_MS,
} from '../state/tokenExpiry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..');
const readSource = (rel: string): string => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');

export async function runP13DeviceIdentityTests() {
  setSuite('P1-3: Device-token rotation + mTLS fingerprint', 'tier1', 'P1-3');

  describe('P1-3 api wrappers (stubbed fetch, no live backend)', () => {
    // NOTE: the two fetch-stub scenarios live in ONE `it` callback on
    // purpose — the harness starts `it` callbacks without awaiting each
    // in turn, so two separate stub-fetch tests would interleave and
    // steal each other's stub (see tier1 header note (b)).
    it('P1-3.1: rotateDeviceToken POSTs /api/devices/{id}/rotate-token; setDeviceMtlsFingerprint POSTs the fingerprint body; empty fingerprint sends "" (clear); a 404 surfaces as an ApiError with status + server detail', async () => {
      const calls: Array<{ url: string; method: string; body: unknown }> = [];
      const originalFetch = (globalThis as any).fetch;
      (globalThis as any).fetch = async (url: string, opts: any) => {
        calls.push({ url: String(url), method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : undefined });
        return { ok: true, status: 200, json: async () => ({ ok: true, device_id: 'dev-1', device_token: 'tok-new', token_expires_at: 1793000000, token_ttl_days: 7, mtls_fingerprint: 'aabbcc' }) };
      };
      try {
        const rotated = await api.rotateDeviceToken('dev-1');
        expect(rotated.device_token).toBe('tok-new');
        expect(calls[0].url).toBe('http://127.0.0.1:8000/api/devices/dev-1/rotate-token');
        expect(calls[0].method).toBe('POST');

        const set = await api.setDeviceMtlsFingerprint('dev-1', 'aa:bb:cc');
        expect(calls[1].url).toBe('http://127.0.0.1:8000/api/devices/dev-1/mtls-fingerprint');
        expect(calls[1].method).toBe('POST');
        expect(calls[1].body).toEqual({ fingerprint: 'aa:bb:cc' });
        expect(set.mtls_fingerprint).toBe('aabbcc');

        await api.setDeviceMtlsFingerprint('dev-1', '');
        expect(calls[2].body).toEqual({ fingerprint: '' });

        // Device ids are URL-encoded in the path.
        await api.rotateDeviceToken('dev/1');
        expect(calls[3].url).toBe('http://127.0.0.1:8000/api/devices/dev%2F1/rotate-token');
      } finally {
        (globalThis as any).fetch = originalFetch;
      }

      // 404 path, same callback: a missing device surfaces as an ApiError
      // carrying the status and the server's detail string.
      (globalThis as any).fetch = async () => ({
        ok: false, status: 404, json: async () => ({ detail: 'Device not found.' }),
      });
      try {
        let caught: unknown;
        try {
          await api.rotateDeviceToken('missing-device');
        } catch (err) {
          caught = err;
        }
        expect(caught instanceof ApiError).toBe(true);
        expect((caught as ApiError).status).toBe(404);
        expect((caught as Error).message).toContain('404');
        expect((caught as Error).message).toContain('Device not found.');
      } finally {
        (globalThis as any).fetch = originalFetch;
      }
    });

    it('P1-3.2: [source-level] api.ts defines both P1-3 wrappers on the contract paths', async () => {
      const src = readSource('api.ts');
      expect(src).toContain('rotateDeviceToken');
      expect(src).toContain('/rotate-token');
      expect(src).toContain('setDeviceMtlsFingerprint');
      expect(src).toContain('/mtls-fingerprint');
      expect(typeof api.rotateDeviceToken).toBe('function');
      expect(typeof api.setDeviceMtlsFingerprint).toBe('function');
    });
  });

  describe('P1-3 token-expiry badge logic (72 h boundary)', () => {
    const nowMs = Date.parse('2026-11-18T01:00:00.000Z');
    const secs = (ms: number) => Math.floor(ms / 1000);

    it('P1-3.3: the warning window is 72 hours', async () => {
      expect(TOKEN_EXPIRY_WARNING_HOURS).toBe(72);
      expect(TOKEN_EXPIRY_WARNING_MS).toBe(72 * 3600 * 1000);
    });

    it('P1-3.4: past expiry is "expired"; expiry exactly now is "expired"', async () => {
      expect(tokenExpiryStatus(secs(nowMs - 1000), nowMs)).toBe('expired');
      expect(tokenExpiryStatus(secs(nowMs), nowMs)).toBe('expired');
    });

    it('P1-3.5: expiry 1 s inside the 72 h window is "expiring"; exactly 72 h out is "expiring" (inclusive boundary)', async () => {
      expect(tokenExpiryStatus(secs(nowMs + TOKEN_EXPIRY_WARNING_MS - 1000), nowMs)).toBe('expiring');
      expect(tokenExpiryStatus(secs(nowMs + TOKEN_EXPIRY_WARNING_MS), nowMs)).toBe('expiring');
    });

    it('P1-3.6: expiry 1 s beyond the 72 h window is "valid"; 7 days out is "valid"', async () => {
      expect(tokenExpiryStatus(secs(nowMs + TOKEN_EXPIRY_WARNING_MS + 1000), nowMs)).toBe('valid');
      expect(tokenExpiryStatus(secs(nowMs + 7 * 24 * 3600 * 1000), nowMs)).toBe('valid');
    });

    it('P1-3.7: missing / zero / non-finite expiry is "none" (no badge)', async () => {
      expect(tokenExpiryStatus(undefined, nowMs)).toBe('none');
      expect(tokenExpiryStatus(null, nowMs)).toBe('none');
      expect(tokenExpiryStatus(0, nowMs)).toBe('none');
      expect(tokenExpiryStatus(NaN, nowMs)).toBe('none');
    });

    it('P1-3.8: epoch-millisecond values are tolerated; labels match the status', async () => {
      expect(tokenExpiryStatus(nowMs - 1000, nowMs)).toBe('expired');
      expect(tokenExpiryStatus(nowMs + TOKEN_EXPIRY_WARNING_MS, nowMs)).toBe('expiring');
      expect(tokenExpiryLabel(secs(nowMs - 1000), nowMs)).toBe('Token expired');
      expect(tokenExpiryLabel(secs(nowMs + 3600 * 1000), nowMs)).toBe('Token expiring soon');
      expect(tokenExpiryLabel(secs(nowMs + 7 * 24 * 3600 * 1000), nowMs)).toBe('');
      expect(tokenExpiryLabel(undefined, nowMs)).toBe('');
    });
  });

  describe('P1-3 view wiring [source-level]', () => {
    it('P1-3.9: DevicesView has a hold-to-confirm "Rotate token" action per row and a show-once token modal that clears its state on dismiss', async () => {
      const src = readSource('views/DevicesView.tsx');
      expect(src).toContain('Rotate token');
      expect(src).toContain('rotateDeviceToken');
      expect(src).toContain('setRotateConfirm');
      expect(src).toContain('requireHold');
      expect(src).toContain('Shown once');
      expect(src).toContain('setRotatedToken(null)');
      // The rotated token is never persisted: no localStorage write of it.
      expect(src).not.toContain('localStorage.setItem');
      expect(src).toContain('Rotate: invalidates the device');
    });

    it('P1-3.10: DevicesView badges expired / expiring-soon tokens and sorts by token expiry', async () => {
      const src = readSource('views/DevicesView.tsx');
      expect(src).toContain('Token expired');
      expect(src).toContain('Token expiring soon');
      expect(src).toContain('tokenExpiresAt');
      expect(src).toContain('tokenExpiryStatus');
      expect(src).toContain('value="tokenExpiry"');
      expect(src).toContain('72 h');
    });

    it('P1-3.11: Device360View shows the REAL mtls_fingerprint from the overview device row, never the seeded telemetry fingerprint', async () => {
      const src = readSource('views/Device360View.tsx');
      expect(src).toContain('overviewDevice?.mtls_fingerprint');
      expect(src).toContain('data?.device');
      // The old display expression (seeded demo value) must be gone.
      expect(src).not.toContain('telemetry.fingerprintSha256 && telemetry.fingerprintSha256 !== "unknown" ? telemetry.fingerprintSha256');
      expect(src).toContain('Rotate token');
      expect(src).toContain('Token expired');
      expect(src).toContain('Token expiring soon');
    });

    it('P1-3.12: Device360View wires Set fingerprint (input + save) and Clear fingerprint (confirm) to the endpoint', async () => {
      const src = readSource('views/Device360View.tsx');
      expect(src).toContain('Set mTLS fingerprint');
      expect(src).toContain('setDeviceMtlsFingerprint');
      expect(src).toContain('Save fingerprint');
      expect(src).toContain('Clear fingerprint');
      expect(src).toContain('setClearFingerprintConfirm');
      expect(src).toContain('Hex, with optional colons or spaces');
      expect(src).toContain('Shown once');
      expect(src).toContain('setRotatedToken(null)');
    });

    it('P1-3.13: the store maps list_devices token_expires_at onto the device type, and neither view uses window.confirm', async () => {
      const store = readSource('state/dashboardStore.ts');
      const types = readSource('types/dashboard.ts');
      expect(store).toContain('tokenExpiresAt');
      expect(store).toContain('token_expires_at');
      expect(types).toContain('tokenExpiresAt?: number');
      expect(readSource('views/DevicesView.tsx')).not.toContain('window.confirm');
      expect(readSource('views/Device360View.tsx')).not.toContain('window.confirm');
      expect(readSource('views/DevicesView.tsx')).not.toContain('window.prompt');
      expect(readSource('views/Device360View.tsx')).not.toContain('window.prompt');
    });

    it('P1-3.14: no P1-4 surface exists in this tree (P1-4 was done by James; this wave is P1-3 only)', async () => {
      const apiSrc = readSource('api.ts');
      expect(apiSrc).not.toContain('deleteUser');
      expect(apiSrc).not.toContain('changeMyPassword');
      expect(apiSrc).not.toContain('resetUserPassword');
      expect(apiSrc).not.toContain('/api/auth/me/password');
      expect(apiSrc).not.toContain('/reset-password');
    });
  });
}
