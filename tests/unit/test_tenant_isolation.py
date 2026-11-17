"""Wave 2A — tenant isolation regression tests (R-P0-12).

Session users are scoped to their own tenant server-side: caller-supplied
tenant parameters that differ from the session tenant are rejected (403),
single-resource reads of another tenant's rows return 404, and the legacy
admin token (explicit opt-in) may address any tenant.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from ai_bridge.control.app import create_app

ADMIN = "test-admin-token-12345"


def make_client(monkeypatch, tmp_path):
    for key in ("AI_BRIDGE_ENABLE_LEGACY_ADMIN_TOKEN", "AI_BRIDGE_ADMIN_TOKEN",
                "AI_BRIDGE_ALLOW_LOCAL_EXECUTION", "AI_BRIDGE_CSRF_DISABLED"):
        monkeypatch.delenv(key, raising=False)
    db_path = str(tmp_path / "test.db")
    app = create_app(admin_token=ADMIN, db_path=db_path)
    return TestClient(app, raise_server_exceptions=False), app


def admin_headers():
    return {"X-Admin-Token": ADMIN}


def create_user(client, username, password, role="operator", tenant=None):
    body = {"username": username, "password": password, "role": role}
    if tenant is not None:
        body["tenant"] = tenant
    r = client.post("/api/auth/users", json=body, headers=admin_headers())
    assert r.status_code == 200, r.text
    return r.json()


def login(client, username, password):
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["session_token"]


def session_headers(token):
    return {"X-Session-Token": token}


def csrf_headers(client, token):
    """Session-token POSTs require a CSRF token (F-05-02, on by default)."""
    r = client.get("/api/auth/csrf-token", headers=session_headers(token))
    assert r.status_code == 200, r.text
    return {"X-Session-Token": token, "X-CSRF-Token": r.json()["csrf_token"]}


def enroll(client, name, tenant=None):
    body = {"name": name, "hostname": "h1", "os": "linux"}
    if tenant is not None:
        body["tenant"] = tenant
    r = client.post("/api/devices/enroll", json=body, headers=admin_headers())
    assert r.status_code == 200, r.text
    return r.json()["device_id"]


def test_cross_tenant_list_rejected_and_default_scoped(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    enroll(client, "default-device")  # tenant "default"
    create_user(client, "alice", "pw123456", tenant="acme")
    token = login(client, "alice", "pw123456")
    # Explicit foreign tenant -> 403.
    r = client.get("/api/devices?tenant=default", headers=session_headers(token))
    assert r.status_code == 403, r.text
    # No tenant param -> scoped to the session tenant (empty, not default's).
    r = client.get("/api/devices", headers=session_headers(token))
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_cross_tenant_single_resource_read_404(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    dev_id = enroll(client, "default-device")
    r = client.post(
        "/api/tasks",
        json={"device_id": dev_id, "tool": "get_system_info", "args": {}},
        headers=admin_headers(),
    )
    task_id = r.json()["task_id"]
    create_user(client, "alice", "pw123456", tenant="acme")
    token = login(client, "alice", "pw123456")
    assert client.get(f"/api/devices/{dev_id}/overview", headers=session_headers(token)).status_code == 404
    assert client.get(f"/api/tasks/{task_id}", headers=session_headers(token)).status_code == 404
    assert client.get(f"/api/devices/{dev_id}/telemetry", headers=session_headers(token)).status_code == 404


def test_cross_tenant_write_rejected(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    dev_id = enroll(client, "default-device")
    create_user(client, "alice", "pw123456", tenant="acme")
    token = login(client, "alice", "pw123456")
    # Submitting against the default tenant explicitly -> 403.
    r = client.post(
        "/api/tasks",
        json={"device_id": dev_id, "tool": "get_system_info", "args": {}, "tenant": "default"},
        headers=csrf_headers(client, token),
    )
    assert r.status_code == 403, r.text
    assert "does not match" in r.text
    # Submitting with no tenant -> session tenant; device is not in it -> 404.
    r = client.post(
        "/api/tasks",
        json={"device_id": dev_id, "tool": "get_system_info", "args": {}},
        headers=csrf_headers(client, token),
    )
    assert r.status_code == 404, r.text
    # Enrolling a device into the foreign tenant -> 403.
    r = client.post(
        "/api/devices/enroll",
        json={"name": "x", "hostname": "h", "os": "linux", "tenant": "default"},
        headers=csrf_headers(client, token),
    )
    assert r.status_code == 403, r.text


def test_session_tenant_visible_in_login_and_me(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    create_user(client, "alice", "pw123456", tenant="acme")
    r = client.post("/api/auth/login", json={"username": "alice", "password": "pw123456"})
    assert r.status_code == 200, r.text
    assert r.json()["tenant"] == "acme"
    token = r.json()["session_token"]
    r = client.get("/api/auth/me", headers=session_headers(token))
    assert r.status_code == 200, r.text
    assert r.json()["tenant"] == "acme"


def test_legacy_admin_may_address_any_tenant(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    enroll(client, "acme-device", tenant="acme")
    r = client.get("/api/devices?tenant=acme", headers=admin_headers())
    assert r.status_code == 200, r.text
    assert len(r.json()) == 1
    r = client.get("/api/devices?tenant=default", headers=admin_headers())
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_user_creation_tenant_scoped(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    create_user(client, "acme-admin", "pw123456", role="admin", tenant="acme")
    token = login(client, "acme-admin", "pw123456")
    # Admin in acme cannot create users in another tenant.
    r = client.post(
        "/api/auth/users",
        json={"username": "bob", "password": "pw123456", "role": "operator", "tenant": "default"},
        headers=csrf_headers(client, token),
    )
    assert r.status_code == 403, r.text
    # Creating in their own tenant works.
    r = client.post(
        "/api/auth/users",
        json={"username": "bob", "password": "pw123456", "role": "operator", "tenant": "acme"},
        headers=csrf_headers(client, token),
    )
    assert r.status_code == 200, r.text
    # And a session admin only lists their own tenant's users.
    r = client.get("/api/auth/users", headers=session_headers(token))
    assert r.status_code == 200, r.text
    assert {u["username"] for u in r.json()} == {"acme-admin", "bob"}


def test_v1_cross_tenant(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    dev_id = enroll(client, "default-device")
    r = client.post(
        "/api/v1/tasks",
        json={"device_id": dev_id, "tool": "get_system_info", "args": {}},
        headers=admin_headers(),
    )
    task_id = r.json()["task_id"]
    create_user(client, "alice", "pw123456", tenant="acme")
    token = login(client, "alice", "pw123456")
    # v1 list is scoped: the default task is invisible.
    r = client.get("/api/v1/tasks", headers=session_headers(token))
    assert r.status_code == 200, r.text
    assert r.json()["tasks"] == []
    # v1 single read of another tenant's task -> 404.
    r = client.get(f"/api/v1/tasks/{task_id}", headers=session_headers(token))
    assert r.status_code == 404, r.text
    # v1 device read of another tenant's device -> 404.
    r = client.get(f"/api/v1/devices/{dev_id}", headers=session_headers(token))
    assert r.status_code == 404, r.text


def test_list_tenants_session_user_sees_only_own(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    create_user(client, "alice", "pw123456", tenant="acme")
    token = login(client, "alice", "pw123456")
    r = client.get("/api/tenants", headers=session_headers(token))
    assert r.status_code == 200, r.text
    assert r.json()["tenants"] == ["acme"]


def test_cross_tenant_desktop_and_terminal_404(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    default_dev = enroll(client, "default-device")
    acme_dev = enroll(client, "acme-device", tenant="acme")
    create_user(client, "alice", "pw123456", tenant="acme")
    alice = login(client, "alice", "pw123456")
    # Cross-tenant desktop read -> 404 (no existence oracle).
    r = client.get(f"/api/devices/{default_dev}/desktop/monitors", headers=session_headers(alice))
    assert r.status_code == 404, r.text
    # Own-tenant desktop read works.
    r = client.get(f"/api/devices/{acme_dev}/desktop/monitors", headers=session_headers(alice))
    assert r.status_code == 200, r.text
    # Cross-tenant terminal create -> 404 even for a session admin.
    create_user(client, "acme-admin", "pw123456", role="admin", tenant="acme")
    admin_tok = login(client, "acme-admin", "pw123456")
    r = client.post(
        f"/api/devices/{default_dev}/terminal/sessions",
        json={},
        headers=csrf_headers(client, admin_tok),
    )
    assert r.status_code == 404, r.text
