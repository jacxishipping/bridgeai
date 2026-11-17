/**
 * k6 cluster soak, one credential set per VU (Wave 5E re-soak).
 *
 * Why this variant exists: the original claim_cancel_soak.js enrolls ONE
 * device and uses ONE shared admin token for every VU. The plane rate-limits
 * at 1200/min per token hash, so 20 VUs through one token measured the
 * limiter (91% 429s), not the plane. This variant gives every VU its own
 * admin-role session token (POST /api/auth/users + POST /api/auth/login)
 * and its own enrolled device, so each VU has its own 1200/min bucket for
 * both the session-token calls (task create/cancel) and the device-token
 * calls (claim/result).
 *
 * Setup paces its auth-path calls (~2.5s apart) to stay under the
 * 30/min-per-IP auth-path bucket.
 *
 * CSRF: session-token requests to mutating endpoints must carry
 * X-CSRF-Token (control/csrf.py middleware; admin/device tokens are
 * exempt). The token is minted per session via GET /api/auth/csrf-token
 * and is valid 24h, so one fetch per VU in setup() is enough.
 *
 * Usage:
 *   k6 run -e BASE_URL=https://control.example -e ADMIN_TOKEN=... -e VUS=20 -e DURATION=5m \
 *     scripts/k6/claim_cancel_soak_per_vu.js
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

const BASE = (__ENV.BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const ADMIN = __ENV.ADMIN_TOKEN || "";
const VUS = Number(__ENV.VUS || 20);
const claimLatency = new Trend("claim_latency_ms");

export const options = {
  vus: VUS,
  duration: __ENV.DURATION || "5m",
  setupTimeout: "5m",
  thresholds: {
    claim_latency_ms: ["p(95)<5000"],
    http_req_failed: ["rate<0.05"],
  },
};

function adminHeaders() {
  return { "X-Admin-Token": ADMIN, "Content-Type": "application/json" };
}

export function setup() {
  if (!ADMIN) {
    throw new Error("ADMIN_TOKEN required");
  }
  const runId = Date.now() % 100000000;
  const password = `k6soak-${runId}-pw`;
  const vusers = [];
  for (let i = 0; i < VUS; i++) {
    const username = `k6soak5e-${runId}-${i}`;
    const created = http.post(
      `${BASE}/api/auth/users`,
      JSON.stringify({ username: username, password: password, role: "admin" }),
      { headers: adminHeaders() }
    );
    check(created, { "user created": (r) => r.status === 200 || r.status === 201 });
    sleep(2.5);
    const login = http.post(
      `${BASE}/api/auth/login`,
      JSON.stringify({ username: username, password: password }),
      { headers: { "Content-Type": "application/json" } }
    );
    check(login, { "login 200": (r) => r.status === 200 });
    const sessionToken = login.json("session_token");
    const csrf = http.get(`${BASE}/api/auth/csrf-token`, {
      headers: { "X-Session-Token": sessionToken },
    });
    check(csrf, { "csrf 200": (r) => r.status === 200 });
    const csrfToken = csrf.json("csrf_token");
    sleep(2.5);
    const enroll = http.post(
      `${BASE}/api/devices/enroll`,
      JSON.stringify({ name: `k6soak5e-${runId}-${i}`, os: "Linux" }),
      { headers: adminHeaders() }
    );
    check(enroll, { "enroll 200": (r) => r.status === 200 });
    const body = enroll.json();
    vusers.push({
      session_token: sessionToken,
      csrf_token: csrfToken,
      device_id: body.device_id,
      device_token: body.device_token,
    });
  }
  return { vusers: vusers };
}

export default function (data) {
  const me = data.vusers[(__VU - 1) % data.vusers.length];
  const sessionHeaders = {
    "X-Session-Token": me.session_token,
    "X-CSRF-Token": me.csrf_token,
    "Content-Type": "application/json",
  };
  const create = http.post(
    `${BASE}/api/tasks`,
    JSON.stringify({
      device_id: me.device_id,
      tool: "get_system_info",
      args: {},
    }),
    { headers: sessionHeaders }
  );
  check(create, { "task created": (r) => r.status === 200 || r.status === 201 });

  const t0 = Date.now();
  const next = http.get(`${BASE}/api/agent/tasks/next?wait=0`, {
    headers: { "X-Device-Token": me.device_token },
  });
  claimLatency.add(Date.now() - t0);
  const task = next.json("task");
  if (task && task.id) {
    if (__ITER % 3 === 0) {
      http.post(`${BASE}/api/tasks/${task.id}/cancel`, null, { headers: sessionHeaders });
    } else {
      http.post(
        `${BASE}/api/agent/tasks/${task.id}/result`,
        JSON.stringify({ status: "completed", result: "{}" }),
        { headers: { "X-Device-Token": me.device_token, "Content-Type": "application/json" } }
      );
    }
  }
  sleep(0.2);
}
