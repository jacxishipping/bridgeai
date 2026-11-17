"""Gate 9 (Wave 6): every audit call site routes through the single
audit writer (ai_bridge.audit_writer.write_audit_event).

Previously mcp_oauth._audit_secret_read, task_service.create_task's
else-branch, and the create_app() audit closure called db.audit
directly, bypassing the writer's redaction/truncation/sink policy;
audit.py::audit_event was dead code with no importers.

These tests prove: the task-service live path (no audit_fn) writes
through the writer on the caller's connection with the caller's
tenant; the audit_fn path is unchanged; secret reads are audited
without leaking the secret; the app closure writes through the writer;
a broken connection falls back to JSONL instead of dropping the event.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from ai_bridge import audit_writer
from ai_bridge.control import db as dbmod
from ai_bridge.control import mcp_oauth
from ai_bridge.control.app import create_app
from ai_bridge.control.task_service import create_task


@pytest.fixture(autouse=True)
def _reset_writer_state(monkeypatch, tmp_path):
    monkeypatch.delenv("AI_BRIDGE_MCP_AUDIT_DB", raising=False)
    monkeypatch.delenv("AI_BRIDGE_MCP_AUDIT_FILE", raising=False)
    audit_writer.set_jsonl_path(tmp_path / "fallback.jsonl")
    yield
    audit_writer.set_jsonl_path(None)


def _audit_rows(conn, tool):
    return conn.execute(
        "SELECT tenant, actor, device_id, tool, decision, args_json FROM audit WHERE tool=?",
        (tool,),
    ).fetchall()


def test_create_task_without_audit_fn_audits_via_writer(tmp_path):
    """The live path (4 of 5 call sites pass no audit_fn): the writer
    writes the row on the caller's connection, keeping its tenant."""
    conn = dbmod.connect(db_path=tmp_path / "t.db")
    out = create_task(
        conn, actor="admin", role="admin", tenant="acme",
        device_id="local", tool="get_system_info", args={"x": 1},
    )
    assert out["status"] == "queued"
    rows = _audit_rows(conn, "get_system_info")
    assert len(rows) == 1
    assert rows[0]["tenant"] == "acme"
    assert rows[0]["actor"] == "admin"
    assert rows[0]["decision"] == "queued"
    assert json.loads(rows[0]["args_json"]) == {"x": 1}


def test_create_task_with_audit_fn_still_uses_it(tmp_path):
    """The audit_fn path is unchanged: the supplied function is called
    and the writer is not also invoked (no double audit row)."""
    conn = dbmod.connect(db_path=tmp_path / "t.db")
    calls = []

    def rec(actor, device_id, tool, args, status, tenant=None):
        calls.append((actor, device_id, tool, status, tenant))

    out = create_task(
        conn, actor="admin", role="admin", tenant="acme",
        device_id="local", tool="get_system_info", args={}, audit_fn=rec,
    )
    assert out["status"] == "queued"
    assert calls == [("admin", "local", "get_system_info", "queued", "acme")]
    assert _audit_rows(conn, "get_system_info") == []


def test_mcp_secret_read_audited_via_writer(tmp_path):
    conn = dbmod.connect(db_path=tmp_path / "t.db")
    now = dbmod.now()
    conn.execute(
        "INSERT INTO mcp_servers (id, name, url, auth_token, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?)",
        ("srv-1", "test-server", "https://example.invalid/mcp", "tok-123-plaintext", now, now),
    )
    conn.commit()
    srv = mcp_oauth.get_mcp_server(conn, "srv-1")
    assert srv is not None
    rows = _audit_rows(conn, "mcp_server_secret_read")
    assert len(rows) == 1
    assert rows[0]["actor"] == "system"
    assert rows[0]["device_id"] == "srv-1"
    assert rows[0]["decision"] == "allowed"
    assert "tok-123-plaintext" not in rows[0]["args_json"]


def _make_client(monkeypatch, tmp_path):
    for key in (
        "AI_BRIDGE_ENABLE_LEGACY_ADMIN_TOKEN",
        "AI_BRIDGE_ADMIN_TOKEN",
        "AI_BRIDGE_ALLOW_LOCAL_EXECUTION",
        "AI_BRIDGE_CSRF_DISABLED",
    ):
        monkeypatch.delenv(key, raising=False)
    db_path = str(tmp_path / "test.db")
    app = create_app(admin_token="test", db_path=db_path)
    return TestClient(app, raise_server_exceptions=False), db_path


def test_app_audit_closure_audits_via_writer(monkeypatch, tmp_path):
    """The create_app() audit closure (used by v1 routes, auth, ai_api,
    custom agents, workspace routes, dispatch) writes through the writer."""
    client, db_path = _make_client(monkeypatch, tmp_path)
    r = client.post(
        "/api/auth/users",
        json={"username": "op1", "password": "pw123456", "role": "operator"},
        headers={"X-Admin-Token": "test"},
    )
    assert r.status_code == 200, r.text
    conn = dbmod.connect(db_path=tmp_path / "test.db")
    rows = _audit_rows(conn, "create_user")
    assert len(rows) == 1
    assert rows[0]["decision"] == "allowed"
    assert json.loads(rows[0]["args_json"])["username"] == "op1"


def test_writer_conn_path_falls_back_to_jsonl(tmp_path):
    """A broken caller connection must not drop the event: the writer
    falls back to JSONL (its documented never-drop policy)."""
    conn = dbmod.connect(db_path=tmp_path / "t.db")
    conn.close()
    jsonl_path = tmp_path / "fallback.jsonl"
    event = audit_writer.write_audit_event(
        actor="system", action="test_conn_fallback",
        device_id="d1", details={"k": "v"}, conn=conn, tenant="acme",
    )
    assert event is not None
    assert event["tool"] == "test_conn_fallback"
    lines = jsonl_path.read_text().splitlines()
    assert len(lines) == 1
    saved = json.loads(lines[0])
    assert saved["tool"] == "test_conn_fallback"
    assert saved["tenant"] == "acme"


def test_audit_py_is_gone():
    """audit.py::audit_event was dead code; the module must not exist."""
    import importlib.util

    assert importlib.util.find_spec("ai_bridge.audit") is None
