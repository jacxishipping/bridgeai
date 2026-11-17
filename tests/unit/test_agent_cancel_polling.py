"""Wave 7 — PERF-08: WS-driven cancellation, throttled HTTP fallback.

The cancel poller used to GET `execution-state` every 0.5 s per running
task (2 req/s/task), and every `_cancelled()` call — invoked by the task
runtime on each cooperative-cancel check — cost a further HTTP round-trip.
Now cancellation is WS-driven when the side-channel is connected (zero
HTTP) and the HTTP fallback is throttled to at most one GET per
`cancel_poll_interval` (default 5 s). Worst-case cancel latency is
~instant on WS and one poll interval with the WS down.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

from agents.common.poller import CANCEL_POLL_INTERVAL_S, Poller
from ai_bridge.control.task_runtime import TaskCancelled, task_context


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


def _task(task_id: str = "task-1") -> dict:
    return {
        "id": task_id,
        "tool": "get_system_info",
        "args_json": "{}",
        "device_id": "dev-1",
        "approval_granted": False,
        "policy": None,
        "epoch": 7,
    }


class FakePlane:
    """Fake control plane; records every `execution-state` GET."""

    def __init__(self, task: dict | None = None, cancel_after: float | None = None):
        self.task = task
        self.claims = 0
        self.state_calls = 0
        self._started = time.monotonic()
        self._cancel_after = cancel_after

    def __call__(self, method: str, path: str, payload=None, timeout: int = 15):
        if method == "POST" and path == "/api/agent/heartbeat":
            return {"emergency_stop": False, "token_expires_at": time.time() + 10 * 86400}
        if method == "GET" and path.startswith("/api/agent/tasks/next"):
            self.claims += 1
            if self.task is not None and self.claims == 1:
                return {"task": self.task, "emergency_stop": False}
            return {"task": None, "emergency_stop": False}
        if method == "GET" and path.endswith("/execution-state"):
            self.state_calls += 1
            if self._cancel_after is not None and time.monotonic() - self._started >= self._cancel_after:
                return {"status": "cancelled", "emergency_stop": False}
            return {"status": "running", "emergency_stop": False}
        if method == "POST" and path.endswith("/result"):
            return {}
        if method == "POST" and path.endswith("/progress"):
            return {}
        if method == "POST" and path == "/api/agent/rotate":
            return {"device_token": "rotated-token"}
        raise AssertionError(f"unexpected fake-plane call: {method} {path}")


def _checking_dispatch(task_id: str, duration: float):
    """Dispatch stub that polls the cancel predicate like a real tool.

    Returns {"ok": True} after `duration` seconds, or raises
    TaskCancelled as soon as the predicate fires.
    """

    def _dispatch(tool, args, policy=None, approval_granted=False):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            ctx = task_context(task_id)
            if ctx is not None and ctx.is_cancelled():
                raise TaskCancelled("cancelled")
            time.sleep(0.02)
        return {"ok": True}

    return _dispatch


def test_cancel_poll_interval_default_is_5s(tmp_path: Path):
    assert CANCEL_POLL_INTERVAL_S == 5.0
    assert _poller(tmp_path).cancel_poll_interval == 5.0


def test_ws_connected_means_zero_execution_state_requests(tmp_path: Path, monkeypatch):
    """With the WS up, neither the poller thread nor the task runtime's
    cancel checks may hit HTTP at all (old behaviour: ~2/s + one per
    check)."""
    poller = _poller(tmp_path)
    plane = FakePlane(task=_task("task-1"))
    monkeypatch.setattr(poller, "_req", plane)
    monkeypatch.setattr("agents.common.poller.dispatch", _checking_dispatch("task-1", 1.2))
    poller._ws_connected.set()
    try:
        out = poller.run_once()
    finally:
        poller._ws_connected.clear()
    assert out["status"] == "completed"
    assert plane.state_calls == 0


def test_ws_down_fallback_is_throttled_not_per_check(tmp_path: Path, monkeypatch):
    """Without a WS, 50+ cancel checks over ~1 s must cost only a handful
    of GETs (one per interval), not one per check."""
    poller = _poller(tmp_path, cancel_poll_interval=0.3)
    plane = FakePlane(task=_task("task-1"))
    monkeypatch.setattr(poller, "_req", plane)
    monkeypatch.setattr("agents.common.poller.dispatch", _checking_dispatch("task-1", 1.0))
    out = poller.run_once()
    assert out["status"] == "completed"
    assert 1 <= plane.state_calls <= 5, f"expected a throttled handful, got {plane.state_calls}"


def test_fallback_still_detects_cancellation(tmp_path: Path, monkeypatch):
    """Throttling must not lose the signal: a plane-side cancel is
    observed within about one poll interval plus a round-trip."""
    poller = _poller(tmp_path, cancel_poll_interval=0.2)
    plane = FakePlane(task=_task("task-1"), cancel_after=0.6)
    monkeypatch.setattr(poller, "_req", plane)
    monkeypatch.setattr("agents.common.poller.dispatch", _checking_dispatch("task-1", 30.0))
    started = time.monotonic()
    out = poller.run_once()
    elapsed = time.monotonic() - started
    assert out["status"] == "cancelled"
    assert elapsed < 5.0, f"cancel took {elapsed:.2f}s, expected < 5s"
    assert plane.state_calls >= 1


def test_ws_cancel_message_wakes_task_instantly_without_http(tmp_path: Path, monkeypatch):
    """A WS `cancel` must abort the running task promptly and with zero
    `execution-state` GETs — the fast path the 0.5 s poll replaced."""
    poller = _poller(tmp_path)
    plane = FakePlane(task=_task("task-ws"))
    monkeypatch.setattr(poller, "_req", plane)
    monkeypatch.setattr("agents.common.poller.dispatch", _checking_dispatch("task-ws", 30.0))
    poller._ws_connected.set()
    result_box: dict = {}
    try:
        t = threading.Thread(target=lambda: result_box.update(poller.run_once()), daemon=True)
        t.start()
        time.sleep(0.5)  # let the task start executing
        poller._handle_ws_message({"type": "cancel", "task_id": "task-ws"})
        t.join(timeout=5.0)
    finally:
        poller._ws_connected.clear()
    assert not t.is_alive(), "run_once did not exit promptly after the WS cancel"
    assert result_box.get("status") == "cancelled"
    assert plane.state_calls == 0


def test_cancel_cache_is_reset_between_tasks(tmp_path: Path, monkeypatch):
    """A cached 'cancelled' from one task must never leak into the next
    task: task-2 (plane says running) completes even though task-1 was
    cancelled."""
    poller = _poller(tmp_path, cancel_poll_interval=60.0)  # huge interval: cache would stick
    tasks = [_task("task-1"), _task("task-2")]
    statuses = {"task-1": "cancelled", "task-2": "running"}

    class _TwoTaskPlane(FakePlane):
        def __call__(self, method: str, path: str, payload=None, timeout: int = 15):
            if method == "GET" and path.startswith("/api/agent/tasks/next"):
                self.claims += 1
                if self.claims <= len(tasks):
                    return {"task": tasks[self.claims - 1], "emergency_stop": False}
                return {"task": None, "emergency_stop": False}
            if method == "GET" and path.endswith("/execution-state"):
                self.state_calls += 1
                tid = path.split("/")[4]
                return {"status": statuses[tid], "emergency_stop": False}
            return super().__call__(method, path, payload, timeout)

    plane = _TwoTaskPlane(task=None)
    monkeypatch.setattr(poller, "_req", plane)
    monkeypatch.setattr(
        "agents.common.poller.dispatch",
        lambda tool, args, policy=None, approval_granted=False: {"ok": True},
    )
    # Task-1: the runtime's cancel check sees "cancelled" via the fallback.
    # run_once's worker never consults the predicate in this stub, so force
    # one check through the registered context right after claim by using a
    # dispatch that consults it once.
    calls = {"n": 0}

    def _consult_once(tool, args, policy=None, approval_granted=False):
        calls["n"] += 1
        tid = "task-1" if calls["n"] == 1 else "task-2"
        ctx = task_context(tid)
        if ctx is not None and ctx.is_cancelled():
            raise TaskCancelled("cancelled")
        return {"ok": True}

    monkeypatch.setattr("agents.common.poller.dispatch", _consult_once)
    out1 = poller.run_once()
    assert out1["status"] == "cancelled"
    out2 = poller.run_once()
    assert out2["status"] == "completed", f"stale cancel cache leaked into task-2: {out2}"
