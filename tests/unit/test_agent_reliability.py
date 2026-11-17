"""Wave 3C Track A — agent reliability tests (F07-08, F07-09, F07-10, F07-12, DIST-08).

Covers: spool cap/TTL/DLQ, graceful drain (stop claiming, in-flight
completes), heartbeat independence (heartbeat fires while a task is hung),
401 revocation vs transient distinction, and the task-progress heartbeat
payload + 404 tolerance.
"""
from __future__ import annotations

import io
import random
import threading
import time
import urllib.error
from pathlib import Path

import pytest

from agents.common.poller import (
    ControlPlaneHTTPError,
    DeviceRevokedError,
    DeviceTokenExpiredError,
    Poller,
    backoff_delay,
    classify_auth_failure,
)
from agents.common.spool import TaskSpooler


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _poller(tmp_path: Path, **kwargs) -> Poller:
    kwargs.setdefault("heartbeat_interval", 10.0)
    kwargs.setdefault("drain_timeout", 5.0)
    kwargs.setdefault("progress_interval", 60.0)
    return Poller(
        "http://127.0.0.1:9",
        "test-token",
        token_file=tmp_path / "device.token",
        **kwargs,
    )


class FakePlane:
    """Minimal fake control plane answering Poller._req calls.

    ``task`` is returned once by tasks/next, then no task. ``dispatch`` is
    stubbed separately (see _block_dispatch). Every call is recorded.
    """

    def __init__(self, task: dict | None = None):
        self.task = task
        self.claims = 0
        self.heartbeats: list[float] = []
        self.progress_calls: list[dict] = []
        self.results: list[tuple[str, str, str]] = []
        self.calls: list[tuple[str, str]] = []

    def __call__(self, method: str, path: str, payload=None, timeout: int = 15):
        self.calls.append((method, path))
        if method == "POST" and path == "/api/agent/heartbeat":
            self.heartbeats.append(time.time())
            return {"emergency_stop": False, "token_expires_at": time.time() + 10 * 86400}
        if method == "GET" and path.startswith("/api/agent/tasks/next"):
            self.claims += 1
            if self.task is not None and self.claims == 1:
                return {"task": self.task, "emergency_stop": False}
            return {"task": None, "emergency_stop": False}
        if method == "GET" and path.endswith("/execution-state"):
            return {"status": "running", "emergency_stop": False}
        if method == "POST" and path.endswith("/result"):
            task_id = path.split("/")[4]  # /api/agent/tasks/{id}/result
            self.results.append((task_id, payload.get("status"), payload.get("result")))
            return {}
        if method == "POST" and path.endswith("/progress"):
            self.progress_calls.append(dict(payload or {}))
            return {}
        if method == "POST" and path == "/api/agent/rotate":
            return {"device_token": "rotated-token"}
        raise AssertionError(f"unexpected fake-plane call: {method} {path}")


def _task(task_id: str = "task-1", tool: str = "get_system_info") -> dict:
    return {
        "id": task_id,
        "tool": tool,
        "args_json": "{}",
        "device_id": "dev-1",
        "approval_granted": False,
        "policy": None,
        "epoch": 7,
    }


# --------------------------------------------------------------------------
# F07-08 — spool cap / TTL / DLQ
# --------------------------------------------------------------------------

def test_spool_cap_evicts_oldest_to_dlq(tmp_path: Path):
    spooler = TaskSpooler(db_path=tmp_path / "spool.db", max_items=3)
    for i in range(5):
        spooler.spool(f"task-{i}", "completed", "ok")
    pending = spooler.get_pending()
    assert [p["task_id"] for p in pending] == ["task-2", "task-3", "task-4"]
    assert spooler.pending_count() == 3
    assert spooler.dead_letter_count() == 2
    dlq = spooler.get_dead_letter()
    assert [d["task_id"] for d in dlq] == ["task-0", "task-1"]
    assert all(d["reason"] == "spool_capacity_exceeded" for d in dlq)
    # DLQ preserves the payload.
    assert dlq[0]["result"] == "ok" and dlq[0]["status"] == "completed"


def test_spool_bytes_cap_evicts_oldest_to_dlq(tmp_path: Path):
    spooler = TaskSpooler(db_path=tmp_path / "spool.db", max_total_bytes=10)
    spooler.spool("task-a", "completed", "0123456789")  # exactly 10 bytes
    spooler.spool("task-b", "completed", "x")  # 10 + 1 > 10 -> evict task-a
    assert [p["task_id"] for p in spooler.get_pending()] == ["task-b"]
    dlq = spooler.get_dead_letter()
    assert len(dlq) == 1 and dlq[0]["task_id"] == "task-a"
    assert dlq[0]["reason"] == "spool_capacity_exceeded"


def test_spool_ttl_moves_expired_to_dlq(tmp_path: Path):
    spooler = TaskSpooler(db_path=tmp_path / "spool.db", ttl_seconds=0)
    spooler.spool("task-old", "completed", "ok")
    assert spooler.get_pending() == []
    assert spooler.dead_letter_count() == 1
    dlq = spooler.get_dead_letter()
    assert dlq[0]["task_id"] == "task-old"
    assert dlq[0]["reason"] == "ttl_expired"
    assert dlq[0]["dead_at"] > 0


def test_spool_prune_expired_returns_count(tmp_path: Path):
    spooler = TaskSpooler(db_path=tmp_path / "spool.db", ttl_seconds=0)
    spooler.spool("task-a", "completed", "ok")
    spooler.spool("task-b", "completed", "ok")
    # spool("task-b") already pruned task-a (ttl 0); task-b is expired too.
    assert spooler.prune_expired() == 1
    assert spooler.dead_letter_count() == 2
    assert spooler.pending_count() == 0
    # Pruning again is a no-op.
    assert spooler.prune_expired() == 0


def test_spool_max_attempts_dead_letters_poison_result(tmp_path: Path):
    spooler = TaskSpooler(db_path=tmp_path / "spool.db", max_attempts=3)
    spooler.spool("task-poison", "completed", "ok")
    assert spooler.flush(lambda tid, st, res: False) == 0
    assert spooler.pending_count() == 1
    assert spooler.flush(lambda tid, st, res: False) == 0
    assert spooler.pending_count() == 1
    assert spooler.flush(lambda tid, st, res: False) == 0
    assert spooler.pending_count() == 0
    assert spooler.dead_letter_count() == 1
    dlq = spooler.get_dead_letter()
    assert dlq[0]["task_id"] == "task-poison"
    assert dlq[0]["reason"] == "max_attempts_exceeded"
    assert dlq[0]["attempts"] == 3


def test_spool_flush_skips_failed_item_no_head_of_line_blocking(tmp_path: Path):
    spooler = TaskSpooler(db_path=tmp_path / "spool.db")
    for tid in ("task-a", "task-b", "task-c"):
        spooler.spool(tid, "completed", "ok")
    delivered = []

    def sender(tid, st, res):
        if tid == "task-a":
            return False
        delivered.append(tid)
        return True

    assert spooler.flush(sender) == 2
    assert delivered == ["task-b", "task-c"]
    pending = spooler.get_pending()
    assert len(pending) == 1 and pending[0]["task_id"] == "task-a"
    assert pending[0]["attempts"] == 1


def test_spool_respool_resets_attempts_and_ttl(tmp_path: Path):
    spooler = TaskSpooler(db_path=tmp_path / "spool.db", max_attempts=2)
    spooler.spool("task-1", "completed", "first")
    assert spooler.flush(lambda tid, st, res: False) == 0
    assert spooler.get_pending()[0]["attempts"] == 1
    # Re-execution produces a fresh result: fresh delivery budget.
    spooler.spool("task-1", "failed", "second")
    pending = spooler.get_pending()
    assert len(pending) == 1
    assert pending[0]["attempts"] == 0
    assert pending[0]["result"] == "second"
    assert pending[0]["status"] == "failed"
    assert spooler.flush(lambda tid, st, res: False) == 0
    assert spooler.pending_count() == 1  # 1 attempt < max_attempts=2
    assert spooler.flush(lambda tid, st, res: False) == 0
    assert spooler.pending_count() == 0
    assert spooler.get_dead_letter()[0]["reason"] == "max_attempts_exceeded"


# --------------------------------------------------------------------------
# F07-12 — 401 revocation vs transient
# --------------------------------------------------------------------------

def test_classify_auth_failure():
    assert classify_auth_failure("Unknown or revoked device token.") == "revoked"
    assert classify_auth_failure("Device token expired; rotate it via /api/agent/rotate before it expires, or re-enroll.") == "expired"
    assert classify_auth_failure("Device token required.") == "transient"
    assert classify_auth_failure("") == "transient"
    assert classify_auth_failure(None) == "transient"
    assert classify_auth_failure("DEVICE REVOKED") == "revoked"


def test_req_raises_structured_auth_errors(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path)

    def _raise_http_error(status, body):
        def _fake_urlopen(req, timeout=None):
            raise urllib.error.HTTPError(
                req.full_url, status, "error", {}, io.BytesIO(body.encode())
            )
        return _fake_urlopen

    monkeypatch.setattr(
        "urllib.request.urlopen",
        _raise_http_error(401, '{"detail": "Unknown or revoked device token."}'),
    )
    with pytest.raises(DeviceRevokedError) as excinfo:
        poller._req("GET", "/api/agent/tasks/next")
    assert excinfo.value.status_code == 401

    monkeypatch.setattr(
        "urllib.request.urlopen",
        _raise_http_error(401, '{"detail": "Device token expired; rotate it via /api/agent/rotate before it expires, or re-enroll."}'),
    )
    with pytest.raises(DeviceTokenExpiredError) as excinfo:
        poller._req("GET", "/api/agent/tasks/next")
    assert excinfo.value.status_code == 401

    monkeypatch.setattr(
        "urllib.request.urlopen",
        _raise_http_error(500, "boom"),
    )
    with pytest.raises(ControlPlaneHTTPError) as excinfo:
        poller._req("GET", "/api/agent/tasks/next")
    assert excinfo.value.status_code == 500
    assert not isinstance(excinfo.value, DeviceRevokedError)


def test_heartbeat_revoked_stops_and_flags(tmp_path: Path, monkeypatch, capsys):
    poller = _poller(tmp_path)
    monkeypatch.setattr(
        poller, "_req",
        lambda method, path, payload=None, timeout=15: (_ for _ in ()).throw(
            DeviceRevokedError(401, path, "Unknown or revoked device token.")
        ),
    )
    with pytest.raises(DeviceRevokedError):
        poller.heartbeat()
    assert poller.revoked is True
    assert poller.revoked_reason is not None and "revoked" in poller.revoked_reason
    assert "re-enroll" in capsys.readouterr().err.lower()


def test_heartbeat_expired_is_terminal_too(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path)
    monkeypatch.setattr(
        poller, "_req",
        lambda method, path, payload=None, timeout=15: (_ for _ in ()).throw(
            DeviceTokenExpiredError(401, path, "Device token expired; rotate it via /api/agent/rotate before it expires, or re-enroll.")
        ),
    )
    with pytest.raises(DeviceTokenExpiredError):
        poller.heartbeat()
    assert poller.revoked is True
    assert "expired" in (poller.revoked_reason or "")


def test_heartbeat_transient_401_is_not_revocation(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path)
    monkeypatch.setattr(
        poller, "_req",
        lambda method, path, payload=None, timeout=15: (_ for _ in ()).throw(
            ControlPlaneHTTPError(401, path, "Device token required.")
        ),
    )
    with pytest.raises(ControlPlaneHTTPError):
        poller.heartbeat()
    assert poller.revoked is False


def test_heartbeat_rotation_race_recovers_via_saved_token(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path)
    (tmp_path / "device.token").write_text("saved-token-xyz", encoding="utf-8")
    calls = {"n": 0}

    def fake_req(method, path, payload=None, timeout=15):
        calls["n"] += 1
        if calls["n"] == 1:
            # In-memory token is stale (rotated elsewhere): plane 401s.
            raise ControlPlaneHTTPError(401, path, "Unknown or revoked device token.")
        return {"emergency_stop": False, "token_expires_at": time.time() + 10 * 86400}

    monkeypatch.setattr(poller, "_req", fake_req)
    assert poller.heartbeat()["emergency_stop"] is False
    assert poller.revoked is False
    assert poller.device_token == "saved-token-xyz"
    assert calls["n"] == 2


def test_run_forever_stops_on_revocation_no_infinite_retry(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path, heartbeat_interval=0.2)
    plane = FakePlane(task=None)

    def fake_req(method, path, payload=None, timeout=15):
        if path == "/api/agent/heartbeat" or path.startswith("/api/agent/tasks/next"):
            raise DeviceRevokedError(401, path, "Unknown or revoked device token.")
        return plane(method, path, payload, timeout)

    monkeypatch.setattr(poller, "_req", fake_req)
    started = time.time()
    result = poller.run_forever()
    elapsed = time.time() - started
    assert result["revoked"] is True
    assert elapsed < 5.0
    assert plane.claims == 0  # never claimed after revocation
    assert len(plane.heartbeats) == 0


def test_backoff_delay_bounds_and_growth():
    rng = random.Random(0)
    assert backoff_delay(0, jitter=False) == 2.0
    assert backoff_delay(3, jitter=False) == 16.0
    assert backoff_delay(10, jitter=False) == 60.0  # capped
    for attempt in range(8):
        d = backoff_delay(attempt, rng=random.Random(attempt))
        assert 0.0 < d <= 60.0
        assert d <= min(60.0, 2.0 * (2 ** attempt)) * 1.5 + 1e-9
    # Jitter spreads retries: two seeded runs differ.
    assert backoff_delay(2, rng=random.Random(1)) != backoff_delay(2, rng=random.Random(2))


# --------------------------------------------------------------------------
# F07-10 — heartbeat independence (F07-07 worker thread)
# --------------------------------------------------------------------------

def test_heartbeat_fires_while_task_is_hung(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path, heartbeat_interval=0.3, progress_interval=0.5)
    plane = FakePlane(task=_task("task-hang"))
    monkeypatch.setattr(poller, "_req", plane)
    started = threading.Event()
    release = threading.Event()

    def hung_dispatch(tool, args, policy=None, approval_granted=False):
        started.set()
        assert release.wait(timeout=10), "test release never set"
        return {"ok": True}

    monkeypatch.setattr("agents.common.poller.dispatch", hung_dispatch)
    poller.start_heartbeat_loop()
    result_box: dict = {}
    t = threading.Thread(target=lambda: result_box.update(poller.run_once()), daemon=True)
    t.start()
    assert started.wait(timeout=5), "dispatch never started"
    hb_before = len(plane.heartbeats)
    progress_before = len(plane.progress_calls)
    time.sleep(2.0)
    # The task is still hung, but the heartbeat timer kept firing.
    assert len(plane.heartbeats) - hb_before >= 3
    assert len(plane.progress_calls) - progress_before >= 1
    release.set()
    t.join(timeout=10)
    assert not t.is_alive()
    poller.stop_heartbeat_loop()
    assert result_box.get("task") == "task-hang"
    assert result_box.get("status") == "completed"
    assert len(plane.results) == 1
    assert plane.results[0][1] == "completed"


# --------------------------------------------------------------------------
# F07-09 — graceful shutdown / drain
# --------------------------------------------------------------------------

def test_graceful_drain_finishes_inflight_task(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path, drain_timeout=5.0, heartbeat_interval=10.0)
    plane = FakePlane(task=_task("task-drain"))
    monkeypatch.setattr(poller, "_req", plane)
    started = threading.Event()
    release = threading.Event()

    def slow_dispatch(tool, args, policy=None, approval_granted=False):
        started.set()
        assert release.wait(timeout=10), "test release never set"
        return {"ok": True}

    monkeypatch.setattr("agents.common.poller.dispatch", slow_dispatch)
    result_box: dict = {}
    t = threading.Thread(target=lambda: result_box.update(poller.run_forever()), daemon=True)
    t.start()
    assert started.wait(timeout=5), "dispatch never started"
    assert plane.claims == 1
    poller.request_shutdown()
    time.sleep(0.5)
    # Still in-flight, and no second claim was made after shutdown.
    assert plane.claims == 1
    assert t.is_alive()
    release.set()
    t.join(timeout=10)
    assert not t.is_alive()
    assert result_box.get("drained") is True
    assert result_box.get("shutdown_requested") is True
    assert len(plane.results) == 1
    assert plane.results[0] == ("task-drain", "completed", '{"ok": true}')


def test_graceful_drain_timeout_leaves_task_for_lease_sweep(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path, drain_timeout=1.0, heartbeat_interval=10.0)
    plane = FakePlane(task=_task("task-stuck"))
    monkeypatch.setattr(poller, "_req", plane)
    started = threading.Event()

    def stuck_dispatch(tool, args, policy=None, approval_granted=False):
        started.set()
        time.sleep(30)  # never finishes within the test; daemon thread dies with the process
        return {"ok": True}

    monkeypatch.setattr("agents.common.poller.dispatch", stuck_dispatch)
    result_box: dict = {}
    t = threading.Thread(target=lambda: result_box.update(poller.run_forever()), daemon=True)
    t.start()
    assert started.wait(timeout=5), "dispatch never started"
    poller.request_shutdown()
    t.join(timeout=10)
    assert not t.is_alive(), "run_forever did not exit after the drain timeout"
    assert result_box.get("drained") is False
    # No result was reported: the task stays `running` for the lease sweep.
    assert plane.results == []
    assert poller.spooler.pending_count() == 0


def test_request_shutdown_is_idempotent_and_visible(tmp_path: Path):
    poller = _poller(tmp_path)
    assert poller.shutdown_requested is False
    poller.request_shutdown()
    poller.request_shutdown()
    assert poller.shutdown_requested is True


# --------------------------------------------------------------------------
# DIST-08 — task progress heartbeat
# --------------------------------------------------------------------------

def test_report_progress_payload(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path)
    plane = FakePlane(task=None)
    monkeypatch.setattr(poller, "_req", plane)
    assert poller.report_progress("task-9", None, "running: get_system_info (elapsed 12s)") is True
    assert len(plane.progress_calls) == 1
    payload = plane.progress_calls[0]
    assert plane.calls[-1] == ("POST", "/api/tasks/task-9/progress")
    assert payload["task_id"] == "task-9"
    assert payload["progress_pct"] is None
    assert payload["status_message"] == "running: get_system_info (elapsed 12s)"
    assert "epoch" not in payload  # no current task
    # With a current task, the claim epoch is attached.
    poller._current_task_id = "task-9"
    poller._current_task_epoch = 4
    assert poller.report_progress("task-9", None, "running") is True
    assert plane.progress_calls[1]["epoch"] == 4


def test_report_progress_404_tolerated_and_logged_once(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path)
    calls = {"n": 0}

    def fake_req(method, path, payload=None, timeout=15):
        calls["n"] += 1
        raise ControlPlaneHTTPError(404, path, "Not Found")

    monkeypatch.setattr(poller, "_req", fake_req)
    assert poller.report_progress("task-9", None, "running") is False
    assert poller._progress_endpoint_missing is True
    # Second call does not hit the network again.
    assert poller.report_progress("task-9", None, "running") is False
    assert calls["n"] == 1


def test_report_progress_501_tolerated(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path)

    def fake_req(method, path, payload=None, timeout=15):
        raise ControlPlaneHTTPError(501, path, "Not Implemented")

    monkeypatch.setattr(poller, "_req", fake_req)
    assert poller.report_progress("task-9", None, "running") is False
    assert poller._progress_endpoint_missing is True


def test_report_progress_transient_failure_does_not_disable(tmp_path: Path, monkeypatch):
    poller = _poller(tmp_path)
    calls = {"n": 0}

    def fake_req(method, path, payload=None, timeout=15):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ControlPlaneHTTPError(500, path, "boom")
        return {}

    monkeypatch.setattr(poller, "_req", fake_req)
    assert poller.report_progress("task-9", None, "running") is False
    assert poller._progress_endpoint_missing is False
    assert poller.report_progress("task-9", None, "running") is True
    assert calls["n"] == 2
