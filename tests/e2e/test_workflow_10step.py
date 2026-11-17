"""End-to-end: the 10-step device/task lifecycle against a local plane
(TST-09).

One test function, one separately asserted step each:

 1. enroll a device
 2. device heartbeat (device visible as online)
 3. admin creates a task for the device
 4. agent claims the task (atomic claim, leaves queued state)
 5. agent executes the tool for real (dispatch)
 6. agent posts the result (task completed)
 7. admin reads the completed task + result
 8. approval gate: a Tier-3 task cannot be claimed before approval,
    then is claimable after a real admin approval
 9. cancel: a queued task is cancelled and never claimed
10. audit + revoke: audit covers the lifecycle; a revoked token is 401

Runs against a local plane only (FastAPI TestClient, fresh temp SQLite
DB, admin token). No sleeps against wall-clock, no network.
"""
import json
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from ai_bridge.control.app import create_app
from ai_bridge.control.dispatch import dispatch

ADMIN = "e2e-admin-10step"


def test_ten_step_workflow():
    db = Path(tempfile.mkdtemp()) / "c.db"
    c = TestClient(create_app(admin_token=ADMIN, db_path=db))
    admin = {"X-Admin-Token": ADMIN}

    # -- Step 1: enroll a device -------------------------------------
    r = c.post("/api/devices/enroll", json={"name": "e2e-10step", "os": "Linux"}, headers=admin)
    assert r.status_code == 200, f"step 1 (enroll): expected 200, got {r.status_code}: {r.text}"
    dev = r.json()
    assert dev.get("device_id"), f"step 1 (enroll): no device_id in {dev}"
    assert dev.get("device_token"), f"step 1 (enroll): no device_token in {dev}"
    device_id, device_token = dev["device_id"], dev["device_token"]
    agent = {"X-Device-Token": device_token}

    # -- Step 2: device heartbeat; device visible as online ----------
    r = c.post("/api/agent/heartbeat", json={}, headers=agent)
    assert r.status_code == 200, f"step 2 (heartbeat): expected 200, got {r.status_code}: {r.text}"
    devices = c.get("/api/devices", headers=admin).json()
    mine = [d for d in devices if d["id"] == device_id]
    assert len(mine) == 1, f"step 2 (heartbeat): device {device_id} not in device list"
    assert mine[0]["status"] == "online", (
        f"step 2 (heartbeat): device status is {mine[0]['status']!r}, expected 'online'"
    )

    # -- Step 3: admin creates a task for the device ------------------
    r = c.post(
        "/api/tasks",
        json={"device_id": device_id, "tool": "get_resource_usage", "args": {}},
        headers=admin,
    )
    assert r.status_code == 200, f"step 3 (create task): expected 200, got {r.status_code}: {r.text}"
    created = r.json()
    assert created.get("task_id"), f"step 3 (create task): no task_id in {created}"
    assert created["status"] == "queued", (
        f"step 3 (create task): status is {created['status']!r}, expected 'queued'"
    )
    task_id = created["task_id"]

    # -- Step 4: agent claims the task (atomic claim) -----------------
    r = c.get("/api/agent/tasks/next", headers=agent)
    assert r.status_code == 200, f"step 4 (claim): expected 200, got {r.status_code}: {r.text}"
    claimed = r.json().get("task")
    assert claimed is not None, "step 4 (claim): agent got no task although one is queued"
    assert claimed["id"] == task_id, (
        f"step 4 (claim): claimed task {claimed['id']!r} != created task {task_id!r}"
    )
    after_claim = c.get(f"/api/tasks/{task_id}", headers=admin).json()
    assert after_claim["status"] == "running", (
        f"step 4 (claim): task status is {after_claim['status']!r} after claim, expected 'running'"
    )
    # A second claim must not return the same task again (atomic claim).
    again = c.get("/api/agent/tasks/next", headers=agent).json().get("task")
    assert again is None, f"step 4 (claim): second claim re-returned task {again}"

    # -- Step 5: agent executes the tool for real ---------------------
    result = dispatch(claimed["tool"], json.loads(claimed["args_json"]))
    assert isinstance(result, dict), f"step 5 (dispatch): unexpected result type {type(result)}"
    assert result, "step 5 (dispatch): get_resource_usage returned an empty result"

    # -- Step 6: agent posts the result -------------------------------
    r = c.post(
        f"/api/agent/tasks/{task_id}/result",
        json={"status": "completed", "result": json.dumps(result)},
        headers=agent,
    )
    assert r.status_code == 200, f"step 6 (result): expected 200, got {r.status_code}: {r.text}"
    assert r.json().get("status") == "completed", f"step 6 (result): unexpected body {r.json()}"

    # -- Step 7: admin reads the completed task + result --------------
    final = c.get(f"/api/tasks/{task_id}", headers=admin).json()
    assert final["status"] == "completed", (
        f"step 7 (read result): status is {final['status']!r}, expected 'completed'"
    )
    assert final.get("result"), "step 7 (read result): completed task has no stored result"
    stored = json.loads(final["result"])
    assert stored == result, "step 7 (read result): stored result differs from the dispatched result"

    # -- Step 8: approval gate ----------------------------------------
    # run_shell is Tier 3 (SENSITIVE); the default policy has
    # allow_tier3=False and max_tier_unattended=2, so creating it must
    # produce a needs_approval task + approval row, never a queued task.
    r = c.post(
        "/api/tasks",
        json={"device_id": device_id, "tool": "run_shell", "args": {"command": "echo approval-ok"}},
        headers=admin,
    )
    assert r.status_code == 200, f"step 8 (approval gate): create expected 200, got {r.status_code}: {r.text}"
    gated = r.json()
    assert gated["status"] == "needs_approval", (
        f"step 8 (approval gate): status is {gated['status']!r}, expected 'needs_approval'"
    )
    assert gated.get("approval_id"), f"step 8 (approval gate): no approval_id in {gated}"
    gated_id, approval_id = gated["task_id"], gated["approval_id"]
    # The agent must NOT be able to claim it before approval.
    pre = c.get("/api/agent/tasks/next", headers=agent).json().get("task")
    assert pre is None, f"step 8 (approval gate): agent claimed task {gated_id} before approval"
    still = c.get(f"/api/tasks/{gated_id}", headers=admin).json()
    assert still["status"] == "needs_approval", (
        f"step 8 (approval gate): task left 'needs_approval' before approval: {still['status']!r}"
    )
    # A real admin approval releases it.
    r = c.post(
        f"/api/approvals/{approval_id}/decide",
        json={"decision": "approved"},
        headers=admin,
    )
    assert r.status_code == 200, f"step 8 (approval gate): decide expected 200, got {r.status_code}: {r.text}"
    assert r.json().get("status") == "approved", f"step 8 (approval gate): decide body {r.json()}"
    released = c.get(f"/api/tasks/{gated_id}", headers=admin).json()
    assert released["status"] == "queued", (
        f"step 8 (approval gate): status after approval is {released['status']!r}, expected 'queued'"
    )
    # Now the agent CAN claim it, and the approved tool executes for real.
    claimed2 = c.get("/api/agent/tasks/next", headers=agent).json().get("task")
    assert claimed2 is not None and claimed2["id"] == gated_id, (
        f"step 8 (approval gate): agent could not claim the approved task (got {claimed2})"
    )
    assert claimed2.get("approval_granted") is True, (
        "step 8 (approval gate): claimed task does not carry approval_granted=True"
    )
    shell_result = dispatch(
        claimed2["tool"], json.loads(claimed2["args_json"]), approval_granted=True
    )
    assert "approval-ok" in json.dumps(shell_result), (
        f"step 8 (approval gate): approved run_shell did not run: {shell_result}"
    )
    r = c.post(
        f"/api/agent/tasks/{gated_id}/result",
        json={"status": "completed", "result": json.dumps(shell_result)},
        headers=agent,
    )
    assert r.status_code == 200, f"step 8 (approval gate): result post got {r.status_code}: {r.text}"

    # -- Step 9: cancel a queued task ---------------------------------
    r = c.post(
        "/api/tasks",
        json={"device_id": device_id, "tool": "get_resource_usage", "args": {}},
        headers=admin,
    )
    assert r.status_code == 200, f"step 9 (cancel): create expected 200, got {r.status_code}: {r.text}"
    doomed_id = r.json()["task_id"]
    r = c.post(f"/api/tasks/{doomed_id}/cancel", headers=admin)
    assert r.status_code == 200, f"step 9 (cancel): cancel expected 200, got {r.status_code}: {r.text}"
    assert r.json().get("status") == "cancelled", f"step 9 (cancel): cancel body {r.json()}"
    nxt = c.get("/api/agent/tasks/next", headers=agent).json().get("task")
    assert nxt is None, f"step 9 (cancel): agent claimed cancelled task {doomed_id}"
    cancelled = c.get(f"/api/tasks/{doomed_id}", headers=admin).json()
    assert cancelled["status"] == "cancelled", (
        f"step 9 (cancel): status is {cancelled['status']!r}, expected 'cancelled'"
    )

    # -- Step 10: audit + revoke --------------------------------------
    audit = c.get("/api/audit", headers=admin).json()
    tools_seen = {(a.get("tool"), a.get("decision")) for a in audit}
    assert ("enroll_device", "allowed") in tools_seen, (
        "step 10 (audit): no enroll_device entry in the audit log"
    )
    assert ("get_resource_usage", "queued") in tools_seen, (
        "step 10 (audit): no task-creation entry for get_resource_usage in the audit log"
    )
    assert ("get_resource_usage", "completed") in tools_seen, (
        "step 10 (audit): no completed-result entry for get_resource_usage in the audit log"
    )
    assert ("decide_approval", "allowed") in tools_seen, (
        "step 10 (audit): no decide_approval entry in the audit log"
    )
    assert ("cancel_task", "allowed") in tools_seen, (
        "step 10 (audit): no cancel_task entry in the audit log"
    )
    # The claim itself is recorded as a task event (the audit log records
    # decisions, not polls): the claimed task must have a "running" event.
    events = c.get(f"/api/tasks/{task_id}/events", headers=admin).json()["events"]
    assert any(e.get("event") == "running" for e in events), (
        f"step 10 (audit): no 'running' task event for the claimed task {task_id}"
    )
    r = c.post(f"/api/devices/{device_id}/revoke", headers=admin)
    assert r.status_code == 200, f"step 10 (revoke): expected 200, got {r.status_code}: {r.text}"
    r = c.post("/api/agent/heartbeat", json={}, headers=agent)
    assert r.status_code == 401, (
        f"step 10 (revoke): heartbeat with revoked token got {r.status_code}, expected 401"
    )
    r = c.get("/api/agent/tasks/next", headers=agent)
    assert r.status_code == 401, (
        f"step 10 (revoke): task claim with revoked token got {r.status_code}, expected 401"
    )
    audit = c.get("/api/audit", headers=admin).json()
    assert any(a.get("tool") == "revoke_device" for a in audit), (
        "step 10 (audit): no revoke_device entry in the audit log"
    )
