"""Failure/recovery tests against a local plane (TST-10).

Every case below was verified against the control-plane source before
being asserted (see the notes on each test); nothing here asserts
behaviour the code does not have:

- restart recovery: state lives in SQLite, so a second app instance on
  the same DB file sees the same devices and queued tasks
  (``dbmod.connect`` runs migrations on open).
- duplicate result: results are only accepted while a task is
  ``running`` (routers/agent.py ``task_result``); a second post is a
  409 and the stored result is unchanged.
- cancel of a claimed task: ``POST /api/tasks/{id}/cancel`` cancels a
  ``running`` task too (only completed/failed/cancelled are no-ops); a
  late result post is then a 409, and the agent execution-state
  endpoint reports ``cancelled``.
- emergency stop: ``POST /api/emergency-stop`` is durable
  (``plane_state`` settings table); while active, task creation is 403
  (``task_service.create_task``) and the claim path returns
  ``{"task": None, "emergency_stop": true}``; clearing it resumes
  normal operation.
- malformed input: an unknown tool is a 400 from ``create_task``; a
  non-object ``args`` is a 422 from the ``TaskIn`` model.
- revoked/unknown device token: ``device_row`` raises 401, which gates
  heartbeat, claim, and result post alike.

Local plane only (FastAPI TestClient, fresh temp SQLite DBs). No sleeps
against wall-clock, no network.
"""
import json
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from ai_bridge.control.app import create_app

ADMIN = "e2e-admin-recovery"


def _plane(db_path: Path) -> TestClient:
    return TestClient(create_app(admin_token=ADMIN, db_path=db_path))


def _enroll(c: TestClient, name: str = "recovery-box"):
    r = c.post(
        "/api/devices/enroll",
        json={"name": name, "os": "Linux"},
        headers={"X-Admin-Token": ADMIN},
    )
    assert r.status_code == 200, f"setup enroll failed: {r.status_code}: {r.text}"
    dev = r.json()
    return dev["device_id"], dev["device_token"]


def _create_task(c: TestClient, device_id: str, tool: str = "get_resource_usage"):
    r = c.post(
        "/api/tasks",
        json={"device_id": device_id, "tool": tool, "args": {}},
        headers={"X-Admin-Token": ADMIN},
    )
    assert r.status_code == 200, f"setup create task failed: {r.status_code}: {r.text}"
    return r.json()["task_id"]


def test_plane_restart_recovers_devices_and_queued_tasks():
    """A second app instance on the SAME db file sees the enrolled device
    and the queued task (durable state survives a plane restart)."""
    db = Path(tempfile.mkdtemp()) / "c.db"
    c1 = _plane(db)
    device_id, device_token = _enroll(c1)
    task_id = _create_task(c1, device_id)

    # "Restart": a brand-new app instance on the same DB file.
    c2 = _plane(db)
    devices = c2.get("/api/devices", headers={"X-Admin-Token": ADMIN}).json()
    assert any(d["id"] == device_id for d in devices), (
        "restart recovery: enrolled device missing after plane restart"
    )
    task = c2.get(f"/api/tasks/{task_id}", headers={"X-Admin-Token": ADMIN}).json()
    assert task["status"] == "queued", (
        f"restart recovery: queued task status after restart is {task['status']!r}, expected 'queued'"
    )
    # The recovered plane can serve the recovered work: the device claims it.
    claimed = c2.get("/api/agent/tasks/next", headers={"X-Device-Token": device_token}).json().get("task")
    assert claimed is not None and claimed["id"] == task_id, (
        "restart recovery: device could not claim its queued task on the restarted plane"
    )


def test_duplicate_result_submission_rejected_and_stored_result_unchanged():
    """Posting a result twice: the second post is a 409 and the stored
    result still equals the first submission."""
    db = Path(tempfile.mkdtemp()) / "c.db"
    c = _plane(db)
    device_id, device_token = _enroll(c)
    task_id = _create_task(c, device_id)
    agent = {"X-Device-Token": device_token}
    claimed = c.get("/api/agent/tasks/next", headers=agent).json()["task"]
    assert claimed["id"] == task_id, "setup: claim did not return the created task"

    first = json.dumps({"cpu": 12.5})
    r = c.post(f"/api/agent/tasks/{task_id}/result", json={"status": "completed", "result": first}, headers=agent)
    assert r.status_code == 200, f"first result post expected 200, got {r.status_code}: {r.text}"

    r = c.post(
        f"/api/agent/tasks/{task_id}/result",
        json={"status": "completed", "result": json.dumps({"cpu": 99.9})},
        headers=agent,
    )
    assert r.status_code == 409, (
        f"duplicate result: second post got {r.status_code}, expected 409 (late result rejected)"
    )
    final = c.get(f"/api/tasks/{task_id}", headers={"X-Admin-Token": ADMIN}).json()
    assert final["status"] == "completed", (
        f"duplicate result: task status is {final['status']!r}, expected 'completed'"
    )
    assert final["result"] == first, (
        f"duplicate result: stored result changed to {final['result']!r}, expected the first submission"
    )


def test_cancel_in_flight_task_and_late_result_rejected():
    """Claim a task, cancel it while running, verify the agent is told
    (execution-state reports cancelled) and a late result is rejected."""
    db = Path(tempfile.mkdtemp()) / "c.db"
    c = _plane(db)
    device_id, device_token = _enroll(c)
    task_id = _create_task(c, device_id)
    agent = {"X-Device-Token": device_token}
    claimed = c.get("/api/agent/tasks/next", headers=agent).json()["task"]
    assert claimed["id"] == task_id, "setup: claim did not return the created task"
    assert c.get(f"/api/tasks/{task_id}", headers={"X-Admin-Token": ADMIN}).json()["status"] == "running"

    r = c.post(f"/api/tasks/{task_id}/cancel", headers={"X-Admin-Token": ADMIN})
    assert r.status_code == 200, f"cancel in-flight: expected 200, got {r.status_code}: {r.text}"
    assert r.json().get("status") == "cancelled", f"cancel in-flight: unexpected body {r.json()}"

    state = c.get(f"/api/agent/tasks/{task_id}/execution-state", headers=agent).json()
    assert state["status"] == "cancelled", (
        f"cancel in-flight: agent execution-state reports {state['status']!r}, expected 'cancelled'"
    )
    r = c.post(
        f"/api/agent/tasks/{task_id}/result",
        json={"status": "completed", "result": "{}"},
        headers=agent,
    )
    assert r.status_code == 409, (
        f"cancel in-flight: late result post got {r.status_code}, expected 409"
    )
    final = c.get(f"/api/tasks/{task_id}", headers={"X-Admin-Token": ADMIN}).json()
    assert final["status"] == "cancelled", (
        f"cancel in-flight: final status is {final['status']!r}, expected 'cancelled'"
    )


def test_emergency_stop_blocks_new_work_and_clearing_resumes_it():
    """While e-stop is active, task creation is 403 and claims return no
    task with emergency_stop=true; after clearing, normal operation
    resumes (including for the task queued before the stop)."""
    db = Path(tempfile.mkdtemp()) / "c.db"
    c = _plane(db)
    device_id, device_token = _enroll(c)
    queued_id = _create_task(c, device_id)
    agent = {"X-Device-Token": device_token}
    admin = {"X-Admin-Token": ADMIN}

    r = c.post("/api/emergency-stop", headers=admin)
    assert r.status_code == 200, f"e-stop enable: expected 200, got {r.status_code}: {r.text}"
    assert r.json().get("emergency_stop") is True, f"e-stop enable: unexpected body {r.json()}"

    r = c.post(
        "/api/tasks",
        json={"device_id": device_id, "tool": "get_resource_usage", "args": {}},
        headers=admin,
    )
    assert r.status_code == 403, (
        f"e-stop: task creation during e-stop got {r.status_code}, expected 403"
    )
    claim = c.get("/api/agent/tasks/next", headers=agent).json()
    assert claim.get("task") is None, (
        f"e-stop: agent claimed a task during e-stop: {claim.get('task')}"
    )
    assert claim.get("emergency_stop") is True, (
        f"e-stop: claim response during e-stop lacks emergency_stop=true: {claim}"
    )
    # The pre-stop queued task is untouched, not silently dropped.
    assert c.get(f"/api/tasks/{queued_id}", headers=admin).json()["status"] == "queued", (
        "e-stop: the pre-stop queued task did not stay queued during e-stop"
    )

    r = c.post("/api/emergency-stop/clear", headers=admin)
    assert r.status_code == 200, f"e-stop clear: expected 200, got {r.status_code}: {r.text}"
    assert r.json().get("emergency_stop") is False, f"e-stop clear: unexpected body {r.json()}"
    claimed = c.get("/api/agent/tasks/next", headers=agent).json().get("task")
    assert claimed is not None and claimed["id"] == queued_id, (
        "e-stop: after clearing, the agent could not claim the pre-stop queued task"
    )


def test_malformed_task_input_rejected():
    """Unknown tool -> 400; non-object args -> 422 (TaskIn validation);
    unknown device -> 404. None of these create a task."""
    db = Path(tempfile.mkdtemp()) / "c.db"
    c = _plane(db)
    device_id, _token = _enroll(c)
    admin = {"X-Admin-Token": ADMIN}

    r = c.post(
        "/api/tasks",
        json={"device_id": device_id, "tool": "not_a_real_tool", "args": {}},
        headers=admin,
    )
    assert r.status_code == 400, (
        f"malformed input: unknown tool got {r.status_code}, expected 400: {r.text}"
    )

    r = c.post(
        "/api/tasks",
        json={"device_id": device_id, "tool": "get_resource_usage", "args": "not-a-dict"},
        headers=admin,
    )
    assert r.status_code == 422, (
        f"malformed input: non-object args got {r.status_code}, expected 422: {r.text}"
    )

    r = c.post(
        "/api/tasks",
        json={"device_id": "no-such-device", "tool": "get_resource_usage", "args": {}},
        headers=admin,
    )
    assert r.status_code == 404, (
        f"malformed input: unknown device got {r.status_code}, expected 404: {r.text}"
    )

    tasks = c.get("/api/tasks", headers=admin).json()
    assert tasks == [], f"malformed input: rejected submissions created tasks: {tasks}"


def test_revoked_and_unknown_device_token_rejected_everywhere():
    """A revoked token — and a token that was never issued — get 401 on
    heartbeat, task claim, and result post."""
    db = Path(tempfile.mkdtemp()) / "c.db"
    c = _plane(db)
    device_id, device_token = _enroll(c)
    task_id = _create_task(c, device_id)
    agent = {"X-Device-Token": device_token}
    assert c.get("/api/agent/tasks/next", headers=agent).json()["task"]["id"] == task_id

    unknown = {"X-Device-Token": "never-issued-token"}
    for name, call in [
        ("heartbeat", lambda h: c.post("/api/agent/heartbeat", json={}, headers=h)),
        ("claim", lambda h: c.get("/api/agent/tasks/next", headers=h)),
        ("result", lambda h: c.post(f"/api/agent/tasks/{task_id}/result",
                                    json={"status": "completed", "result": "{}"}, headers=h)),
    ]:
        r = call(unknown)
        assert r.status_code == 401, (
            f"unknown token: {name} got {r.status_code}, expected 401"
        )

    r = c.post(f"/api/devices/{device_id}/revoke", headers={"X-Admin-Token": ADMIN})
    assert r.status_code == 200, f"setup revoke failed: {r.status_code}: {r.text}"
    for name, call in [
        ("heartbeat", lambda h: c.post("/api/agent/heartbeat", json={}, headers=h)),
        ("claim", lambda h: c.get("/api/agent/tasks/next", headers=h)),
        ("result", lambda h: c.post(f"/api/agent/tasks/{task_id}/result",
                                    json={"status": "completed", "result": "{}"}, headers=h)),
    ]:
        r = call(agent)
        assert r.status_code == 401, (
            f"revoked token: {name} got {r.status_code}, expected 401"
        )
        assert "revok" in r.json().get("detail", "").lower(), (
            f"revoked token: {name} 401 detail does not say revoked: {r.json()}"
        )
