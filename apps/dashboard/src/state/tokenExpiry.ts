/**
 * Device-token expiry status (P1-3).
 *
 * `list_devices` returns `token_expires_at` as epoch SECONDS (the
 * control plane stores `issued + ttl_days * 86400`). The default token
 * TTL is 7 days, so a 72-hour warning window gives an operator time to
 * rotate before the token dies; that threshold is the single constant
 * below so both device views and the tests agree on it.
 *
 * Status values:
 * - "none"     — no expiry reported (e.g. seed/demo devices, or the
 *                backend did not return one); render no badge.
 * - "valid"    — expires more than TOKEN_EXPIRY_WARNING_HOURS from now.
 * - "expiring" — expires within the warning window (inclusive of the
 *                exact boundary) but has not expired yet.
 * - "expired"  — expiry is in the past.
 *
 * Epoch milliseconds are tolerated defensively (values > 1e12 are
 * treated as ms) because callers mix the two; the backend contract is
 * seconds.
 */

/** Warn when a device token expires within this many hours (72 h = 3 days). */
export const TOKEN_EXPIRY_WARNING_HOURS = 72;
export const TOKEN_EXPIRY_WARNING_MS = TOKEN_EXPIRY_WARNING_HOURS * 3600 * 1000;

export type TokenExpiryStatus = "none" | "valid" | "expiring" | "expired";

function toExpiryMs(expiresAt: number | null | undefined): number | null {
  if (expiresAt === null || expiresAt === undefined) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  // Epoch seconds (contract) vs milliseconds (defensive): ms values are > 1e12.
  return expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
}

export function tokenExpiryStatus(
  expiresAt: number | null | undefined,
  nowMs: number = Date.now()
): TokenExpiryStatus {
  const expiryMs = toExpiryMs(expiresAt);
  if (expiryMs === null) return "none";
  if (expiryMs <= nowMs) return "expired";
  if (expiryMs - nowMs <= TOKEN_EXPIRY_WARNING_MS) return "expiring";
  return "valid";
}

/** Human label for a badge; empty string when there is nothing to show. */
export function tokenExpiryLabel(
  expiresAt: number | null | undefined,
  nowMs: number = Date.now()
): string {
  const status = tokenExpiryStatus(expiresAt, nowMs);
  if (status === "expired") return "Token expired";
  if (status === "expiring") return "Token expiring soon";
  return "";
}
