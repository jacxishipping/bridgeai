"""F-05-02 (Wave 6): shared CSRF secret across workers.

Wave 5E observed live that a per-process random CSRF secret breaks
session CSRF on the 4-worker staging plane (~80% of session writes
failed: a token minted on one worker does not validate on the others).
The fix: deployment configs declare one shared secret, and the plane
fails fast at boot when it runs with >1 worker and no shared secret
is configured.

These tests cover the resolver, the boot fail-fast, and the failure
mode itself (a token minted under one secret does not validate under
another).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from ai_bridge.control import csrf as csrfmod
from ai_bridge.control.app import create_app


@pytest.fixture(autouse=True)
def _reset_csrf_secret(monkeypatch):
    """Isolate the module-level secret cache (and env) per test."""
    csrfmod._CSRF_SECRET = None
    monkeypatch.delenv("AI_BRIDGE_CSRF_SECRET", raising=False)
    monkeypatch.delenv("AI_BRIDGE_WORKERS", raising=False)
    monkeypatch.delenv("AI_BRIDGE_CSRF_DISABLED", raising=False)
    yield
    csrfmod._CSRF_SECRET = None


def _make_client(monkeypatch, tmp_path, env=None):
    for key in (
        "AI_BRIDGE_ENABLE_LEGACY_ADMIN_TOKEN",
        "AI_BRIDGE_ADMIN_TOKEN",
        "AI_BRIDGE_ALLOW_LOCAL_EXECUTION",
        "AI_BRIDGE_CSRF_DISABLED",
        "AI_BRIDGE_CSRF_SECRET",
        "AI_BRIDGE_WORKERS",
    ):
        monkeypatch.delenv(key, raising=False)
    if env:
        for k, v in env.items():
            monkeypatch.setenv(k, v)
    app = create_app(admin_token="test", db_path=str(tmp_path / "test.db"))
    return TestClient(app, raise_server_exceptions=False), app


def _admin_headers():
    return {"X-Admin-Token": "test"}


def _login_operator(client):
    r = client.post(
        "/api/auth/users",
        json={"username": "op1", "password": "pw123456", "role": "operator"},
        headers=_admin_headers(),
    )
    assert r.status_code == 200, r.text
    r = client.post("/api/auth/login", json={"username": "op1", "password": "pw123456"})
    assert r.status_code == 200, r.text
    return r.json()["session_token"]


def _enroll(client, name="d1"):
    r = client.post("/api/devices/enroll", json={"name": name}, headers=_admin_headers())
    assert r.status_code == 200, r.text
    return r.json()["device_id"]


# --- resolver ---------------------------------------------------------------

def test_single_worker_falls_back_to_random_with_warning(monkeypatch, caplog):
    with caplog.at_level("WARNING", logger="ai_bridge.csrf"):
        secret = csrfmod.get_csrf_secret()
    assert len(secret) == 64 and all(c in "0123456789abcdef" for c in secret)
    assert "per-process random" in caplog.text
    # Cached: a second call returns the same secret.
    assert csrfmod.get_csrf_secret() == secret


def test_multi_worker_without_secret_raises(monkeypatch):
    monkeypatch.setenv("AI_BRIDGE_WORKERS", "4")
    with pytest.raises(RuntimeError, match="AI_BRIDGE_CSRF_SECRET"):
        csrfmod.resolve_csrf_secret()
    with pytest.raises(RuntimeError, match="AI_BRIDGE_CSRF_SECRET"):
        csrfmod.get_csrf_secret()


def test_multi_worker_with_shared_secret_uses_it(monkeypatch):
    monkeypatch.setenv("AI_BRIDGE_WORKERS", "4")
    monkeypatch.setenv("AI_BRIDGE_CSRF_SECRET", "s3cret-shared-value")
    assert csrfmod.resolve_csrf_secret() == "s3cret-shared-value"
    token = csrfmod.generate_csrf_token("sess-1")
    assert csrfmod.validate_csrf_token("sess-1", token) is True


def test_workers_env_non_integer_fails_closed(monkeypatch):
    monkeypatch.setenv("AI_BRIDGE_WORKERS", "four")
    with pytest.raises(RuntimeError, match="AI_BRIDGE_WORKERS"):
        csrfmod.resolve_csrf_secret()


def test_token_minted_under_one_secret_fails_under_another(monkeypatch):
    """The cross-worker failure mode itself: secrets must match."""
    monkeypatch.setenv("AI_BRIDGE_CSRF_SECRET", "worker-A-secret")
    token = csrfmod.generate_csrf_token("sess-1")
    assert csrfmod.validate_csrf_token("sess-1", token) is True
    csrfmod._CSRF_SECRET = None
    monkeypatch.setenv("AI_BRIDGE_CSRF_SECRET", "worker-B-secret")
    assert csrfmod.validate_csrf_token("sess-1", token) is False


# --- boot fail-fast ---------------------------------------------------------

def test_create_app_fails_fast_multi_worker_no_secret(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_BRIDGE_WORKERS", "4")
    with pytest.raises(RuntimeError, match="AI_BRIDGE_CSRF_SECRET"):
        create_app(admin_token="test", db_path=str(tmp_path / "test.db"))


def test_create_app_boots_multi_worker_with_shared_secret(monkeypatch, tmp_path):
    client, _app = _make_client(
        monkeypatch, tmp_path,
        env={"AI_BRIDGE_WORKERS": "4", "AI_BRIDGE_CSRF_SECRET": "shared-secret-123"},
    )
    dev_id = _enroll(client)
    session_token = _login_operator(client)
    r = client.get("/api/auth/csrf-token", headers={"X-Session-Token": session_token})
    assert r.status_code == 200, r.text
    csrf = r.json()["csrf_token"]
    r = client.post(
        "/api/tasks",
        json={"device_id": dev_id, "tool": "get_system_info", "args": {}},
        headers={"X-Session-Token": session_token, "X-CSRF-Token": csrf},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "queued"


def test_csrf_disabled_skips_boot_check(monkeypatch, tmp_path):
    # With CSRF off, the secret is irrelevant: no fail-fast.
    client, _app = _make_client(
        monkeypatch, tmp_path,
        env={"AI_BRIDGE_WORKERS": "4", "AI_BRIDGE_CSRF_DISABLED": "1"},
    )
    r = client.get("/health")
    assert r.status_code == 200
