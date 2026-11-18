"""P1-3 — admin device-token rotation + mTLS fingerprint clearing
(DASHBOARD_AUDIT.md §7, P1-3).

Fixture pattern follows tests/unit/test_phase3_fleet_ops.py: create_app
with a tmp DB, TestClient, legacy admin-token header. Session-token
POSTs also send the X-CSRF-Token minted from GET /api/auth/csrf-token
(CSRF is on by default; see control/csrf.py).

NOTE (scope change, 18 Nov 2026): P1-4 (user deletion, password
change/reset) was done by James himself and is deliberately NOT covered
here — this module is P1-3 only.
"""
from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from ai_bridge.control.app import create_app

ADMIN = "p1-device-identity-admin-token"


def make_client(tmp_path):
    app = create_app(admin_token=ADMIN, db_path=tmp_path / "control.db")
    return TestClient(app, raise_server_exceptions=False)


def admin_headers():
    return {"X-Admin-Token": ADMIN}


def create_user(client, username, password="Password123", role="viewer"):
    r = client.post(
        "/api/auth/users",
        json={"username": username, "password": password, "role": role},
        headers=admin_headers(),
    )
    assert r.status_code == 200, r.text
    return r.json()


def login(client, username, password):
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["session_token"]


def csrf_headers(client, token):
    r = client.get("/api/auth/csrf-token", headers={"X-Session-Token": token})
    assert r.status_code == 200, r.text
    return {"X-Session-Token": token, "X-CSRF-Token": r.json()["csrf_token"]}


def enroll(client, name="node-1"):
    r = client.post(
        "/api/devices/enroll",
        json={"name": name, "os": "Linux Ubuntu 24.04"},
        headers=admin_headers(),
    )
    assert r.status_code == 200, r.text
    return r.json()


def heartbeat(client, device_token):
    return client.post(
        "/api/agent/heartbeat",
        json={"hostname": "h1", "os": "Linux Ubuntu 24.04", "metrics": {}},
        headers={"X-Device-Token": device_token},
    )


def db_fingerprint(tmp_path, device_id):
    con = sqlite3.connect(tmp_path / "control.db")
    try:
        row = con.execute(
            "SELECT mtls_fingerprint FROM devices WHERE id=?", (device_id,)
        ).fetchone()
        return row[0] if row else None
    finally:
        con.close()


# --- 1. POST /api/devices/{device_id}/rotate-token -------------------------


def test_rotate_token_success_old_token_dies_new_token_works(tmp_path):
    client = make_client(tmp_path)
    dev = enroll(client)
    old_token = dev["device_token"]
    assert heartbeat(client, old_token).status_code == 200

    r = client.post(
        f"/api/devices/{dev['device_id']}/rotate-token", headers=admin_headers()
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["device_id"] == dev["device_id"]
    assert body["device_token"] != old_token
    assert body["token_expires_at"] > dev["token_expires_at"] - 86400 * 7
    assert body["token_ttl_days"] == 7
    assert body["note"].startswith("Old token is invalid immediately.")

    # Old token is dead immediately (not just at the 5 s cache TTL).
    assert heartbeat(client, old_token).status_code == 401
    # New token works.
    assert heartbeat(client, body["device_token"]).status_code == 200


def test_rotate_token_auth_and_404(tmp_path):
    client = make_client(tmp_path)
    dev = enroll(client)
    url = f"/api/devices/{dev['device_id']}/rotate-token"

    assert client.post(url).status_code == 401
    assert client.post("/api/devices/doesnotexist/rotate-token", headers=admin_headers()).status_code == 404

    create_user(client, "viewer1", role="viewer")
    create_user(client, "op1", role="operator")
    viewer_tok = login(client, "viewer1", "Password123")
    op_tok = login(client, "op1", "Password123")
    assert client.post(url, headers=csrf_headers(client, viewer_tok)).status_code == 403
    assert client.post(url, headers=csrf_headers(client, op_tok)).status_code == 403

    # Revoked device -> 404 with the refresh endpoint's wording.
    r = client.post(f"/api/devices/{dev['device_id']}/revoke", headers=admin_headers())
    assert r.status_code == 200, r.text
    r = client.post(url, headers=admin_headers())
    assert r.status_code == 404
    assert r.json()["detail"] == "Device not found or revoked."


# --- 2. POST /api/devices/{device_id}/mtls-fingerprint (clear) -------------


def test_mtls_fingerprint_set_and_clear(tmp_path):
    client = make_client(tmp_path)
    dev = enroll(client)
    url = f"/api/devices/{dev['device_id']}/mtls-fingerprint"
    fp = "aa" * 32

    r = client.post(url, json={"fingerprint": fp}, headers=admin_headers())
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "device_id": dev["device_id"], "mtls_fingerprint": fp}
    assert db_fingerprint(tmp_path, dev["device_id"]) == fp

    # Present but normalizes to empty -> CLEAR (column NULL).
    r = client.post(url, json={"fingerprint": "::: "}, headers=admin_headers())
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "device_id": dev["device_id"], "mtls_fingerprint": None}
    assert db_fingerprint(tmp_path, dev["device_id"]) is None

    # Empty-string value via the alternate key also clears.
    client.post(url, json={"fingerprint": fp}, headers=admin_headers())
    r = client.post(url, json={"mtls_fingerprint": ""}, headers=admin_headers())
    assert r.status_code == 200, r.text
    assert r.json()["mtls_fingerprint"] is None
    assert db_fingerprint(tmp_path, dev["device_id"]) is None


def test_mtls_fingerprint_missing_keys_400_unknown_404(tmp_path):
    client = make_client(tmp_path)
    dev = enroll(client)
    url = f"/api/devices/{dev['device_id']}/mtls-fingerprint"

    assert client.post(url, json={}, headers=admin_headers()).status_code == 400
    assert client.post(url, json={"other": "x"}, headers=admin_headers()).status_code == 400
    assert client.post(
        "/api/devices/doesnotexist/mtls-fingerprint",
        json={"fingerprint": "aa" * 32},
        headers=admin_headers(),
    ).status_code == 404
    assert client.post(url, json={"fingerprint": "aa" * 32}).status_code == 401
