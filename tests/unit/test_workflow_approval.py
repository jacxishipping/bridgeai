"""Wave 2A — workflow approval regression tests (R-P0-11).

Workflow/scheduler steps execute with the WORKFLOW OWNER's policy, never
admin. Tier >= 3 steps require per-step approval by default; a workflow
approved as a whole by an admin (recorded approval covering the workflow)
may run its steps. Local steps are used so no agent is needed: the
supervisor-enqueue step is a Tier-3 local tool, list_devices is Tier 1,
and delete_workspace_file is Tier 4.
"""
from __future__ import annotations

import time

import pytest
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


def submit_workflow(client, steps, workflow_approval_id=None, max_retries=0):
    body = {"name": "test workflow", "steps": steps, "max_retries": max_retries}
    if workflow_approval_id:
        body["workflow_approval_id"] = workflow_approval_id
    r = client.post("/api/workflows", json=body, headers=admin_headers())
    assert r.status_code == 200, r.text
    return r.json()["workflow_id"]


def wait_workflow_status(client, workflow_id, statuses, timeout=25.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        r = client.get(f"/api/workflows/{workflow_id}", headers=admin_headers())
        assert r.status_code == 200, r.text
        last = r.json()["status"]
        if last in statuses:
            return last
        time.sleep(0.25)
    raise AssertionError(f"workflow {workflow_id} never reached {statuses}; last={last}")


def pending_approval_for(client, tool):
    r = client.get("/api/approvals", headers=admin_headers())
    assert r.status_code == 200, r.text
    for row in r.json():
        if row["tool"] == tool and row["status"] == "pending":
            return row["id"]
    return None


def deny_approval(client, approval_id):
    r = client.post(
        f"/api/approvals/{approval_id}/decide",
        json={"decision": "denied"},
        headers=admin_headers(),
    )
    assert r.status_code == 200, r.text


def task_count(app):
    """Handoff steps enqueue plane tasks; count them to prove a step ran."""
    row = app.state.conn.execute("SELECT COUNT(*) FROM tasks").fetchone()
    return row[0]


def test_workflow_tier3_step_without_approval_does_not_execute(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    before = task_count(app)
    wf_id = submit_workflow(client, [
        {"action": "supervisor_enqueue_handoff",
         "args": {"role": "tester", "prompt": "hi", "device_id": "local", "goal": "write a hello-world test"}},
    ])
    # The worker must park in waiting_approval instead of executing as admin.
    assert wait_workflow_status(client, wf_id, {"waiting_approval"}) == "waiting_approval"
    approval_id = pending_approval_for(client, "supervisor_enqueue_handoff")
    assert approval_id is not None
    deny_approval(client, approval_id)
    assert wait_workflow_status(client, wf_id, {"failed"}) == "failed"
    # The step never ran: no agent run was enqueued.
    assert task_count(app) == before


def test_workflow_tier1_step_executes_without_approval(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    wf_id = submit_workflow(client, [{"action": "list_devices", "args": {}}])
    assert wait_workflow_status(client, wf_id, {"completed"}) == "completed"


def test_workflow_approved_as_whole_runs_tier3_steps(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    conn = app.state.conn
    now = time.time()
    conn.execute(
        "INSERT INTO approvals (id, task_id, tool, reason, status, created_at, decided_by, expires_at, decided_at, policy_version, tenant)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ("wf-appr-1", None, "execute_workflow", "admin approved whole workflow",
         "approved", now, "admin", now + 3600, now, 0, "default"),
    )
    conn.commit()
    before = task_count(app)
    wf_id = submit_workflow(
        client,
        [{"action": "supervisor_enqueue_handoff",
          "args": {"role": "tester", "prompt": "hi", "device_id": "local", "goal": "write a hello-world test"}}],
        workflow_approval_id="wf-appr-1",
    )
    assert wait_workflow_status(client, wf_id, {"completed"}) == "completed"
    # The step actually executed under the whole-workflow approval.
    assert task_count(app) == before + 1


def test_workflow_approval_id_invalid_rejected(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    r = client.post(
        "/api/workflows",
        json={"name": "bad", "steps": [{"action": "list_devices", "args": {}}],
              "workflow_approval_id": "does-not-exist"},
        headers=admin_headers(),
    )
    assert r.status_code == 400, r.text


def test_workflow_tier4_step_without_approval_does_not_execute(monkeypatch, tmp_path):
    client, app = make_client(monkeypatch, tmp_path)
    wf_id = submit_workflow(client, [
        {"action": "delete_workspace_file",
         "args": {"path": "/tmp/wave2a-nonexistent-test-file.txt"}},
    ])
    assert wait_workflow_status(client, wf_id, {"waiting_approval"}) == "waiting_approval"
    approval_id = pending_approval_for(client, "delete_workspace_file")
    assert approval_id is not None
    deny_approval(client, approval_id)
    assert wait_workflow_status(client, wf_id, {"failed"}) == "failed"
