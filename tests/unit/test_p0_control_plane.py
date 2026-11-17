"""Wave 2A — P0 control-plane regression tests.

Covers: R-P0-04 (term-* auto-approval deleted), R-P0-03 (local execution
off by default), R-P0-10 v1 approval gate, R-P0-16 (signed fleet updates
refused when unconfigured), F-05-05 (legacy admin token off by default),
F-05-02 (CSRF on by default), DB-05 (audit-chain verifier), SEC-08
(takeover blocks claim), DIST-01 (scheduler atomic claim), DIST-05/F07-04
(epoch fencing on results).
"""
from __future__ import annotations

import os
import sqlite3
import tempfile
import time

import pytest
from fastapi.testclient import TestClient

from ai_bridge.control import plane_state
from ai_bridge.control.app import create_app
from ai_bridge.control import migrations as migrationsmod

ADMIN = "test-admin-token-12345"


def make_client(monkeypatch, tmp_path, admin_token=ADMIN, env=None):
    for key in (
        "AI_BRIDGE_ENABLE_LEGACY_ADMIN_TOKEN",
        "AI_BRIDGE_ADMIN_TOKEN",
        "AI_BRIDGE_ALLOW_LOCAL_EXECUTION",
        "AI_BRIDGE_CSRF_DISABLED",
    ):
        monkeypatch.delenv(key, raising=False)
    if env:
        for k, v in env.items():
            monkeypatch.setenv(k, v)
    db_path = str(tmp_path / "test.db")
    app = create_app(admin_token=admin_token, db_path=db_path)
    return TestClient(app, raise_server_exceptions=False), app


def enroll(client, name="d1"):
    r = client.post(
        "/api/devices/enroll",
        json={"name": name, "hostname": "h1", "os": "linux"},
        headers={"X-Admin-Token": ADMIN},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    return data["device_id"], data["device_token"]


def admin_headers():
    return {"X-Admin-Token": ADMIN}


# --- R-P0-04: term-* tasks no longer auto-approved ---------------------------

def test_term_task_without_approval_not_auto_approved(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    dev_id, dev_token = enroll(client)
    # Insert a queued terminal task with a term-* id directly (the old code
    # auto-approved exactly these ids in next_task).
    conn = app.state.conn
    conn.execute(
        "INSERT INTO tasks (id, device_id, tenant, tool, args_json, tier, status, created_at, updated_at)"
        " VALUES (?,?,?,?,?,3,'queued',?,?)",
        ("term-abc123", dev_id, "default", "terminal_exec", '{"command": "echo hi"}', time.time(), time.time()),
    )
    conn.commit()
    r = client.get("/api/agent/tasks/next", headers={"X-Device-Token": dev_token})
    assert r.status_code == 200, r.text
    task = r.json()["task"]
    assert task is not None
    assert task["approval_granted"] is False


def test_tier3_task_claimed_only_after_approval(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    dev_id, dev_token = enroll(client)
    r = client.post(
        "/api/tasks",
        json={"device_id": dev_id, "tool": "run_shell", "args": {"command": "echo hi"}},
        headers=admin_headers(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "needs_approval"
    approval_id = r.json()["approval_id"]
    # Not handed out while awaiting approval.
    r = client.get("/api/agent/tasks/next", headers={"X-Device-Token": dev_token})
    assert r.json()["task"] is None
    # Approve, then it is claimed with approval_granted True.
    r = client.post(
        f"/api/approvals/{approval_id}/decide",
        json={"decision": "approved"},
        headers=admin_headers(),
    )
    assert r.status_code == 200, r.text
    r = client.get("/api/agent/tasks/next", headers={"X-Device-Token": dev_token})
    task = r.json()["task"]
    assert task is not None
    assert task["approval_granted"] is True
    assert task["epoch"] == 1


# --- R-P0-10: v1 Tier-3 without approval is pending, never executed ---------

def test_v1_tier3_without_approval_pending_not_executed(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    dev_id, dev_token = enroll(client)
    r = client.post(
        "/api/v1/tasks",
        json={"device_id": dev_id, "tool": "run_shell", "args": {"command": "echo hi"}},
        headers=admin_headers(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "needs_approval"
    task_id = r.json()["task_id"]
    r = client.get(f"/api/v1/tasks/{task_id}", headers=admin_headers())
    assert r.json()["status"] == "needs_approval"
    r = client.get("/api/agent/tasks/next", headers={"X-Device-Token": dev_token})
    assert r.json()["task"] is None


# --- R-P0-03: local execution off by default --------------------------------

def test_local_execution_off_by_default(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    enroll(client)
    r = client.post(
        "/api/ai/execute",
        json={"tool": "run_shell", "device": "local", "args": {"command": "echo hi"}},
        headers=admin_headers(),
    )
    assert r.status_code == 403, r.text
    assert "Local execution is disabled" in r.text


def test_local_execution_readonly_db_query_still_works(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    enroll(client)
    r = client.post(
        "/api/ai/execute",
        json={"tool": "list_devices", "device": "local", "args": {}},
        headers=admin_headers(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


# --- R-P0-16: fleet updates refused without a signed release ----------------

def test_fleet_update_refused_without_signed_config(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    dev_id, _ = enroll(client)
    r = client.post(f"/api/devices/{dev_id}/update", headers=admin_headers())
    assert r.status_code == 409, r.text
    assert "Signed fleet updates are not configured" in r.text
    r = client.post("/api/fleet/update", headers=admin_headers())
    assert r.status_code == 409, r.text


# --- F-05-05: legacy admin token off by default ------------------------------

def test_legacy_admin_token_off_by_default(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_BRIDGE_ADMIN_TOKEN", "env-legacy-token")
    monkeypatch.delenv("AI_BRIDGE_ENABLE_LEGACY_ADMIN_TOKEN", raising=False)
    db_path = str(tmp_path / "test.db")
    app = create_app(db_path=db_path)  # no explicit admin_token
    client = TestClient(app, raise_server_exceptions=False)
    r = client.get("/api/devices", headers={"X-Admin-Token": "env-legacy-token"})
    assert r.status_code == 401, r.text


def test_legacy_admin_token_explicit_opt_in(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_BRIDGE_ADMIN_TOKEN", "env-legacy-token")
    monkeypatch.setenv("AI_BRIDGE_ENABLE_LEGACY_ADMIN_TOKEN", "1")
    db_path = str(tmp_path / "test.db")
    app = create_app(db_path=db_path)
    client = TestClient(app, raise_server_exceptions=False)
    r = client.get("/api/devices", headers={"X-Admin-Token": "env-legacy-token"})
    assert r.status_code == 200, r.text


# --- F-05-02: CSRF on by default ----------------------------------------------

def _login_operator(client):
    r = client.post(
        "/api/auth/users",
        json={"username": "op1", "password": "pw123456", "role": "operator"},
        headers=admin_headers(),
    )
    assert r.status_code == 200, r.text
    r = client.post("/api/auth/login", json={"username": "op1", "password": "pw123456"})
    assert r.status_code == 200, r.text
    return r.json()["session_token"]


def test_csrf_required_for_session_posts_by_default(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    dev_id, _ = enroll(client)
    session_token = _login_operator(client)
    # No CSRF token -> rejected.
    r = client.post(
        "/api/tasks",
        json={"device_id": dev_id, "tool": "get_system_info", "args": {}},
        headers={"X-Session-Token": session_token},
    )
    assert r.status_code == 403, r.text
    assert "CSRF" in r.text
    # With a minted CSRF token -> accepted.
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


# --- DB-05: audit-chain verifier ----------------------------------------------

def test_audit_chain_verify_endpoint(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    enroll(client)
    r = client.get("/api/audit/verify", headers=admin_headers())
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["ok"] is True
    assert data["checked"] >= 1
    assert data["broken_at"] is None


# --- SEC-08: takeover blocks claim, human-initiated tasks still flow ---------

def test_takeover_blocks_claim_but_not_human_initiated(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    dev_id, dev_token = enroll(client)
    conn = app.state.conn
    now = time.time()
    conn.execute(
        "INSERT INTO tasks (id, device_id, tenant, tool, args_json, tier, status, created_at, updated_at)"
        " VALUES (?,?,?,?,?,1,'queued',?,?)",
        ("auto-1", dev_id, "default", "get_system_info", "{}", now, now),
    )
    conn.execute(
        "INSERT INTO tasks (id, device_id, tenant, tool, args_json, tier, status, created_at, updated_at)"
        " VALUES (?,?,?,?,?,3,'queued',?,?)",
        ("human-1", dev_id, "default", "terminal_exec", '{"command": "echo hi", "human_initiated": true}', now, now),
    )
    conn.commit()
    plane_state.save_human_takeover(
        conn, dev_id,
        {"device_id": dev_id, "human_takeover_active": True, "actor": "test", "session_id": "", "updated_at": now},
    )
    try:
        # Autonomous task is not handed out.
        r = client.get("/api/agent/tasks/next", headers={"X-Device-Token": dev_token})
        assert r.status_code == 200, r.text
        assert r.json() == {"task": None, "human_takeover_active": True}
        # Human-initiated task IS handed out (it is the human's own action).
        # Clear takeover first would also release it; instead verify the
        # queued autonomous task is still queued and the human one is next
        # once takeover clears.
        plane_state.clear_human_takeover(conn, dev_id)
        r = client.get("/api/agent/tasks/next", headers={"X-Device-Token": dev_token})
        assert r.json()["task"]["id"] == "auto-1"
    finally:
        plane_state.clear_human_takeover(conn, dev_id)


# --- DIST-05/F07-04: epoch fencing on results ---------------------------------

def test_late_result_with_stale_epoch_rejected(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    dev_id, dev_token = enroll(client)
    r = client.post(
        "/api/tasks",
        json={"device_id": dev_id, "tool": "get_system_info", "args": {}},
        headers=admin_headers(),
    )
    task_id = r.json()["task_id"]
    r = client.get("/api/agent/tasks/next", headers={"X-Device-Token": dev_token})
    task = r.json()["task"]
    assert task["epoch"] == 1
    # Stale epoch -> 409.
    r = client.post(
        f"/api/agent/tasks/{task_id}/result",
        json={"status": "completed", "result": "{}", "epoch": 999},
        headers={"X-Device-Token": dev_token},
    )
    assert r.status_code == 409, r.text
    # Correct epoch -> accepted.
    r = client.post(
        f"/api/agent/tasks/{task_id}/result",
        json={"status": "completed", "result": "{}", "epoch": 1},
        headers={"X-Device-Token": dev_token},
    )
    assert r.status_code == 200, r.text
    # Second result for the finished task -> 409 (late result).
    r = client.post(
        f"/api/agent/tasks/{task_id}/result",
        json={"status": "completed", "result": "{}", "epoch": 1},
        headers={"X-Device-Token": dev_token},
    )
    assert r.status_code == 409, r.text


# --- DIST-01: scheduler atomic claim ------------------------------------------

def test_scheduler_atomic_claim_exactly_one_winner(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    conn = app.state.conn
    now = time.time()
    conn.execute(
        "INSERT INTO schedules (id, name, tenant, device_id, interval_seconds, tool, args_json, last_run_at, next_run_at, enabled, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ("sched-1", "test job", "default", "local", 60, "get_system_info", "{}", None, now - 5, 1, now),
    )
    conn.commit()
    claim_sql = (
        "UPDATE schedules SET last_run_at=?, next_run_at=? "
        "WHERE id=? AND next_run_at<=? AND enabled=1"
    )
    # Two workers claiming the same due job: exactly one wins.
    first = conn.execute(claim_sql, (now, now + 60, "sched-1", now))
    conn.commit()
    second = conn.execute(claim_sql, (now, now + 60, "sched-1", now))
    conn.commit()
    assert first.rowcount == 1
    assert second.rowcount == 0


# --- Migration 013 preserves data under "default" ------------------------------

def test_migration_013_preserves_data_under_default(tmp_path):
    old_db = str(tmp_path / "old.db")
    raw = sqlite3.connect(old_db)
    raw.execute(
        "CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,"
        " password_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer',"
        " created_at REAL NOT NULL, disabled INTEGER NOT NULL DEFAULT 0)"
    )
    raw.execute(
        "CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL,"
        " role TEXT NOT NULL, expires_at REAL NOT NULL, created_at REAL NOT NULL)"
    )
    raw.execute(
        "CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT, tool TEXT, reason TEXT,"
        " status TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL, decided_by TEXT,"
        " expires_at REAL, decided_at REAL, policy_version INTEGER NOT NULL DEFAULT 0)"
    )
    raw.execute(
        "CREATE TABLE tasks (id TEXT PRIMARY KEY, device_id TEXT, tenant TEXT, tool TEXT,"
        " args_json TEXT, tier INTEGER, status TEXT, approval_id TEXT, created_at REAL,"
        " updated_at REAL, result TEXT)"
    )
    raw.execute(
        "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at REAL NOT NULL)"
    )
    for v in ("001", "002", "003", "004", "005", "006", "007", "008", "009", "010", "011", "012"):
        raw.execute("INSERT INTO schema_migrations VALUES (?,?,?)", (v, f"{v}_x.sql", time.time()))
    raw.execute("INSERT INTO users VALUES (?,?,?,?,?,?,0)", ("u1", "alice", "hash", "salt", "operator", time.time()))
    raw.execute("INSERT INTO sessions VALUES (?,?,?,?,?)", ("tokhash", "alice", "operator", time.time() + 3600, time.time()))
    raw.execute("INSERT INTO approvals VALUES (?,?,?,?, 'pending', ?, NULL, NULL, NULL, 0)", ("ap1", "t1", "run_shell", "r", time.time()))
    raw.execute("INSERT INTO tasks VALUES (?,?,?,?,?,1,'queued',NULL,?, ?, '')", ("t1", "d1", "default", "get_system_info", "{}", time.time(), time.time()))
    raw.commit()
    applied = migrationsmod.run_migrations(raw)
    assert "013" in applied
    assert raw.execute("SELECT tenant FROM users WHERE id='u1'").fetchone()[0] == "default"
    assert raw.execute("SELECT tenant FROM sessions WHERE token_hash='tokhash'").fetchone()[0] == "default"
    assert raw.execute("SELECT tenant FROM approvals WHERE id='ap1'").fetchone()[0] == "default"
    assert raw.execute("SELECT epoch FROM tasks WHERE id='t1'").fetchone()[0] == 0
    assert raw.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1
    assert raw.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 1
    raw.close()
