"""Wave 3A Phase 2 — distributed reliability tests.

Covers: DIST-03 Redis fan-out (cross-worker cancel via an injected fake
pub/sub shim — no live Redis in this environment; fakeredis is not
installed and must NOT be pip-installed), Redis-down fallback with a
logged warning, PERF-06 wake events, DIST-08 progress heartbeats +
lease sweep, DIST-07 async rate limiter, DIST-06 stuck-handoff sweeper,
and create_task idempotency (DIST-09 TTL is covered by
test_db_phase2.py::test_retention_jobs).

The fake Redis below is deliberately small: it implements exactly the
calls the production code makes (sync publish/ping, async ping/pubsub,
pipeline zremrangebyscore/zadd/zcard/expire), backed by one shared
in-process broker so two "workers" (two _WORKER_ID values sharing the
module) can talk to each other.
"""
from __future__ import annotations

import asyncio
import collections
import contextlib
import json
import sys
import time
import types

import pytest
from fastapi import HTTPException

from ai_bridge.control import agent_channel, durable_ratelimit, orchestration, ratelimit, supervisor, task_runtime, task_service
from ai_bridge.control import db as dbmod


# ------------------------------------------------------------- fake Redis
class FakeBroker:
    """Shared in-process stand-in for one Redis server."""

    def __init__(self):
        self.published: list[tuple[str, str]] = []
        self.subscribers: list["FakePubSub"] = []
        self.zsets: dict[str, dict[str, float]] = {}
        self.fail = False

    def publish(self, channel: str, message: str) -> int:
        if self.fail:
            raise ConnectionError("redis down (fake)")
        self.published.append((channel, message))
        for sub in list(self.subscribers):
            sub._deliver(channel, message)
        return len(self.subscribers)


class FakePubSub:
    def __init__(self, broker: FakeBroker):
        self._broker = broker
        self._queue: collections.deque = collections.deque()
        self.patterns: list[str] = []
        broker.subscribers.append(self)

    def _deliver(self, channel: str, message: str) -> None:
        self._queue.append(
            {"type": "pmessage", "pattern": "aibridge:agent:*", "channel": channel, "data": message}
        )

    async def psubscribe(self, pattern: str) -> None:
        self.patterns.append(pattern)

    async def listen(self):
        while True:
            while self._queue:
                yield self._queue.popleft()
            await asyncio.sleep(0.005)

    async def close(self) -> None:
        pass


class FakeSyncRedis:
    def __init__(self, broker: FakeBroker):
        self._broker = broker

    def ping(self) -> bool:
        if self._broker.fail:
            raise ConnectionError("redis down (fake)")
        return True

    def publish(self, channel: str, message: str) -> int:
        return self._broker.publish(channel, message)


class FakePipeline:
    def __init__(self, broker: FakeBroker):
        self._broker = broker
        self._ops: list[tuple] = []

    def zremrangebyscore(self, key, mn, mx):
        self._ops.append(("zrem", key, mn, mx))
        return self

    def zadd(self, key, mapping):
        self._ops.append(("zadd", key, mapping))
        return self

    def zcard(self, key):
        self._ops.append(("zcard", key))
        return self

    def expire(self, key, ttl):
        self._ops.append(("expire", key, ttl))
        return self

    async def execute(self):
        if self._broker.fail:
            raise ConnectionError("redis down (fake)")
        results = []
        for op in self._ops:
            if op[0] == "zrem":
                _, key, mn, mx = op
                z = self._broker.zsets.setdefault(key, {})
                lo = float("-inf") if mn == "-inf" else float(mn)
                hi = float("inf") if mx == "+inf" else float(mx)
                for m in [m for m, s in z.items() if lo <= s <= hi]:
                    del z[m]
                results.append(0)
            elif op[0] == "zadd":
                _, key, mapping = op
                z = self._broker.zsets.setdefault(key, {})
                for m, s in mapping.items():
                    z[m] = float(s)
                results.append(len(mapping))
            elif op[0] == "zcard":
                results.append(len(self._broker.zsets.get(op[1], {})))
            else:
                results.append(True)
        self._ops.clear()
        return results


class FakeAsyncRedis:
    def __init__(self, broker: FakeBroker):
        self._broker = broker

    async def ping(self) -> bool:
        if self._broker.fail:
            raise ConnectionError("redis down (fake)")
        return True

    def pubsub(self) -> FakePubSub:
        return FakePubSub(self._broker)

    def pipeline(self) -> FakePipeline:
        return FakePipeline(self._broker)

    async def close(self) -> None:
        pass


class _FakeRedisModule(types.ModuleType):
    def __init__(self, broker: FakeBroker):
        super().__init__("redis")
        self._broker = broker

    def from_url(self, url, **kw):
        return FakeSyncRedis(self._broker)


class _FakeAsyncRedisModule(types.ModuleType):
    def __init__(self, broker: FakeBroker):
        super().__init__("redis.asyncio")
        self._broker = broker

    def from_url(self, url, **kw):
        return FakeAsyncRedis(self._broker)


class FakeSocket:
    """Minimal WebSocket stand-in: records send_json payloads."""

    def __init__(self):
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


@pytest.fixture
def fake_redis(monkeypatch):
    broker = FakeBroker()
    monkeypatch.setitem(sys.modules, "redis", _FakeRedisModule(broker))
    monkeypatch.setitem(sys.modules, "redis.asyncio", _FakeAsyncRedisModule(broker))
    monkeypatch.setenv("REDIS_URL", "redis://fake:6379/0")
    monkeypatch.setenv("AI_BRIDGE_REDIS_URL", "redis://fake:6379/0")
    agent_channel.reset_for_tests()
    ratelimit.reset_for_tests()
    durable_ratelimit.reset_for_tests()
    yield broker
    agent_channel.reset_for_tests()
    ratelimit.reset_for_tests()
    durable_ratelimit.reset_for_tests()
    task = agent_channel._fanout_task
    agent_channel._fanout_task = None
    if task is not None and not task.done():
        task.cancel()


@pytest.fixture
def conn(tmp_path):
    c = dbmod.connect(db_path=tmp_path / "t.db")
    c.execute("PRAGMA foreign_keys=ON")
    yield c
    c.close()


def _seed_task(conn, task_id="t1", device_id="d1", status="running", updated_at=None):
    now = dbmod.now()
    conn.execute(
        "INSERT INTO tasks (id, device_id, tenant, tool, args_json, tier, status,"
        " created_at, updated_at) VALUES (?,?,?,?,?,?,?, ?,?)",
        (task_id, device_id, "default", "run_command", "{}", 1, status,
         now, now if updated_at is None else updated_at),
    )
    conn.commit()
    return now


def _seed_device(conn, device_id="d1"):
    now = dbmod.now()
    conn.execute(
        "INSERT INTO devices (id, name, tenant, token_hash, status, last_seen, created_at)"
        " VALUES (?, ?, 'default', 't', 'online', ?, ?)",
        (device_id, device_id, now, now),
    )
    conn.commit()


# ------------------------------------------------------------- DIST-03
def test_publish_redis_envelope_carries_worker_origin(fake_redis, monkeypatch):
    monkeypatch.setattr(agent_channel, "_WORKER_ID", "worker-a")
    assert agent_channel.publish_redis("dev1", {"type": "cancel", "task_id": "t1"}) is True
    assert len(fake_redis.published) == 1
    channel, raw = fake_redis.published[0]
    assert channel == "aibridge:agent:dev1"
    envelope = json.loads(raw)
    assert envelope["origin"] == "worker-a"
    assert envelope["payload"] == {"type": "cancel", "task_id": "t1"}


def test_fanout_cancel_reaches_agent_on_other_worker(fake_redis, monkeypatch):
    """Worker B's fan-out forwards a message published by worker A."""
    async def scenario():
        monkeypatch.setattr(agent_channel, "_WORKER_ID", "worker-b")
        ws = FakeSocket()
        agent_channel.register("dev1", ws)
        task = agent_channel.start_redis_fanout()
        assert task is not None
        await asyncio.sleep(0.05)  # let the subscriber attach
        fake_redis.publish(
            "aibridge:agent:dev1",
            json.dumps({"origin": "worker-a", "payload": {"type": "cancel", "task_id": "t1"}}),
        )
        await asyncio.sleep(0.2)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        return ws

    ws = asyncio.run(scenario())
    assert {"type": "cancel", "task_id": "t1"} in ws.sent


def test_fanout_skips_messages_from_own_worker(fake_redis, monkeypatch):
    """A worker must not re-push its own publications (it pushed locally)."""
    async def scenario():
        monkeypatch.setattr(agent_channel, "_WORKER_ID", "worker-b")
        ws = FakeSocket()
        agent_channel.register("dev1", ws)
        task = agent_channel.start_redis_fanout()
        await asyncio.sleep(0.05)
        fake_redis.publish(
            "aibridge:agent:dev1",
            json.dumps({"origin": "worker-b", "payload": {"type": "cancel", "task_id": "t1"}}),
        )
        await asyncio.sleep(0.2)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        return ws

    ws = asyncio.run(scenario())
    assert ws.sent == []


def test_redis_down_falls_back_with_warning(fake_redis, caplog, monkeypatch):
    """Redis down: publish returns False, a WARNING is logged once, and
    local in-process push still works (never silently dropped)."""
    import logging

    fake_redis.fail = True
    monkeypatch.setattr(agent_channel, "_WORKER_ID", "worker-a")
    with caplog.at_level(logging.WARNING, logger="ai_bridge.agent_channel"):
        assert agent_channel.publish_redis("dev1", {"type": "cancel", "task_id": "t1"}) is False
        assert agent_channel.publish_redis("dev1", {"type": "cancel", "task_id": "t2"}) is False
    warnings = [r for r in caplog.records if "Redis fan-out unavailable" in r.message]
    assert len(warnings) == 1  # once per process, not once per publish

    async def local_push():
        ws = FakeSocket()
        agent_channel.register("dev1", ws)
        assert await agent_channel.push_to_device("dev1", {"type": "cancel", "task_id": "t9"}) == 1
        return ws

    ws = asyncio.run(local_push())
    assert {"type": "cancel", "task_id": "t9"} in ws.sent


# ------------------------------------------------------------- PERF-06
def test_wait_for_device_notification_wakes_on_notify():
    async def scenario():
        waiter = asyncio.create_task(agent_channel.wait_for_device_notification("dev1", 5.0))
        await asyncio.sleep(0.02)
        t0 = time.perf_counter()
        agent_channel.notify_task_available("dev1")
        ok = await waiter
        elapsed_ms = (time.perf_counter() - t0) * 1000
        assert ok is True
        assert elapsed_ms < 500  # old spin worst case was ~150 ms + DB check
        # Second wait with no notify times out.
        assert await agent_channel.wait_for_device_notification("dev1", 0.05) is False

    asyncio.run(scenario())


# ------------------------------------------------------------- DIST-08
def test_handle_agent_message_progress_flow(conn):
    _seed_task(conn, updated_at=dbmod.now() - 500)
    ack = agent_channel.handle_agent_message(conn, "d1", {"type": "progress", "task_id": "t1"})
    assert ack == {"type": "progress_ack", "task_id": "t1", "ok": True}
    # updated_at was bumped to ~now by the heartbeat.
    updated = conn.execute("SELECT updated_at FROM tasks WHERE id='t1'").fetchone()[0]
    assert dbmod.now() - updated < 5
    assert conn.execute(
        "SELECT COUNT(*) FROM task_events WHERE task_id='t1' AND event='progress'"
    ).fetchone()[0] == 1
    # Immediate repeat is throttled (no second DB write).
    ack2 = agent_channel.handle_agent_message(conn, "d1", {"type": "progress", "task_id": "t1"})
    assert ack2 == {"type": "progress_ack", "task_id": "t1", "ok": True, "throttled": True}
    assert conn.execute(
        "SELECT COUNT(*) FROM task_events WHERE task_id='t1' AND event='progress'"
    ).fetchone()[0] == 1
    # A report for a task another device owns is rejected.
    assert agent_channel.handle_agent_message(
        conn, "d2", {"type": "progress", "task_id": "t1"}
    ) == {"type": "progress_ack", "task_id": "t1", "ok": False}
    # A completed task is rejected even inside the throttle window.
    conn.execute("UPDATE tasks SET status='completed' WHERE id='t1'")
    conn.commit()
    assert agent_channel.handle_agent_message(
        conn, "d1", {"type": "progress", "task_id": "t1"}
    ) == {"type": "progress_ack", "task_id": "t1", "ok": False}
    # Unknown types / malformed messages are ignored.
    assert agent_channel.handle_agent_message(conn, "d1", {"type": "pong"}) is None
    assert agent_channel.handle_agent_message(conn, "d1", {"type": "progress"}) == {
        "type": "progress_ack", "task_id": "", "ok": False,
    }
    assert agent_channel.handle_agent_message(conn, "d1", "not-a-dict") is None


def test_progress_heartbeat_prevents_requeue_while_running(conn):
    """A 1,200 s task that reports progress is NOT re-queued; a silent
    one past its lease IS re-queued (DIST-08 + lease sweep)."""
    old = dbmod.now() - 1000  # past the 900 s default lease
    _seed_task(conn, "t1", updated_at=old)
    _seed_task(conn, "t2", updated_at=old)
    assert orchestration.record_task_progress(conn, "t1") is True
    assert orchestration.record_task_progress(conn, "missing") is False
    # F-05-09: the sweeper default is now requeue OFF; this test
    # exercises the opt-in path explicitly (the heartbeat protection
    # itself is unchanged — t1 stays running, silent t2 is reclaimed).
    result = orchestration.sweep_stale_running_tasks(conn, lease_sec=900, requeue=True)
    assert result == {"timed_out": 0, "requeued": 1, "scanned": 1}
    assert conn.execute("SELECT status FROM tasks WHERE id='t1'").fetchone()[0] == "running"
    assert conn.execute("SELECT status FROM tasks WHERE id='t2'").fetchone()[0] == "queued"
    # Progress on a terminal task is rejected.
    conn.execute("UPDATE tasks SET status='completed' WHERE id='t1'")
    conn.commit()
    assert orchestration.record_task_progress(conn, "t1") is False


def test_task_runtime_progress_heartbeat():
    task_runtime.register_task_context("local-1", None)
    try:
        assert task_runtime.record_task_progress("local-1") is True
        assert task_runtime.last_progress_at("local-1") is not None
        assert task_runtime.record_task_progress("unknown") is False
        assert task_runtime.last_progress_at("unknown") is None
    finally:
        task_runtime.unregister_task_context("local-1")
    assert task_runtime.task_context("local-1") is None  # unregistered


# ------------------------------------------------------------- DIST-07
def test_async_rate_limiter_hits_fake_redis(fake_redis):
    async def scenario():
        for _ in range(3):
            await ratelimit.rate_limit_async("k", limit=3, window=60)
        with pytest.raises(HTTPException) as exc:
            await ratelimit.rate_limit_async("k", limit=3, window=60)
        assert exc.value.status_code == 429
        # A different key has its own bucket.
        await ratelimit.rate_limit_async("other", limit=3, window=60)

    asyncio.run(scenario())


def test_durable_ratelimit_allow_async_uses_fake_redis(fake_redis):
    async def scenario():
        assert await durable_ratelimit.allow_async("k", 3, window=60.0) is True
        assert await durable_ratelimit.allow_async("k", 3, window=60.0) is True
        assert await durable_ratelimit.allow_async("k", 3, window=60.0) is True
        assert await durable_ratelimit.allow_async("k", 3, window=60.0) is False

    asyncio.run(scenario())


def test_sync_rate_limit_in_loop_warns_once(fake_redis, caplog):
    """The old silent memory fallback inside a running loop now warns."""
    import logging

    async def scenario():
        check = ratelimit.rate_limit("k", limit=100, window=60)
        check()  # inside a running loop: memory fallback + warning
        check()  # second call: no second warning
        return True

    with caplog.at_level(logging.WARNING, logger="ai_bridge.ratelimit"):
        assert asyncio.run(scenario()) is True
    warnings = [r for r in caplog.records if "sync rate_limit() called inside" in r.message]
    assert len(warnings) == 1


def test_async_rate_limiter_falls_back_to_memory_when_redis_down(fake_redis):
    """Redis down (PERF-02): async limiter degrades to memory, never DB."""
    fake_redis.fail = True

    async def scenario():
        for _ in range(2):
            await ratelimit.rate_limit_async("k", limit=2, window=60)
        with pytest.raises(HTTPException) as exc:
            await ratelimit.rate_limit_async("k", limit=2, window=60)
        assert exc.value.status_code == 429

    asyncio.run(scenario())


# ------------------------------------------------------------- DIST-06
def test_stuck_handoff_sweeper_redrives_crash(conn):
    _seed_device(conn)
    res = supervisor.run_supervisor_handoff_enqueue(
        conn, device_id="d1", tenant="default", goal="test goal", profile="code"
    )
    hid = res["handoff_id"]
    first = conn.execute("SELECT id FROM tasks WHERE handoff_id=?", (hid,)).fetchone()["id"]
    # Simulate a crash: step 0 completed in the DB, advance never ran.
    conn.execute("UPDATE tasks SET status='completed', updated_at=? WHERE id=?", (dbmod.now(), first))
    conn.commit()
    swept = supervisor.sweep_stuck_handoffs(conn)
    assert swept["advanced"] == 1 and swept["errors"] == []
    children = conn.execute(
        "SELECT id, parent_task_id FROM tasks WHERE handoff_id=? ORDER BY created_at", (hid,)
    ).fetchall()
    assert len(children) == 2
    assert children[1]["parent_task_id"] == first
    # Idempotent: a second sweep finds nothing to advance.
    assert supervisor.sweep_stuck_handoffs(conn)["advanced"] == 0
    # Failed step -> the sweeper enqueues the recovery step.
    res2 = supervisor.run_supervisor_handoff_enqueue(
        conn, device_id="d1", tenant="default", goal="g2", profile="code"
    )
    hid2 = res2["handoff_id"]
    failed = conn.execute("SELECT id FROM tasks WHERE handoff_id=?", (hid2,)).fetchone()["id"]
    conn.execute("UPDATE tasks SET status='failed', updated_at=? WHERE id=?", (dbmod.now(), failed))
    conn.commit()
    assert supervisor.sweep_stuck_handoffs(conn)["advanced"] == 1
    rec = conn.execute(
        "SELECT tool FROM tasks WHERE handoff_id=? AND parent_task_id=?", (hid2, failed)
    ).fetchone()
    assert rec is not None and rec["tool"] == "get_service_status"


def test_handoff_status_uses_index(conn):
    _seed_device(conn)
    res = supervisor.run_supervisor_handoff_enqueue(
        conn, device_id="d1", tenant="default", goal="g", profile="code"
    )
    status = supervisor.handoff_status(conn, res["handoff_id"])
    assert status["count"] == 1
    assert status["tasks"][0]["status"] == "queued"


# ------------------------------------------------------------- idempotency
def test_create_task_idempotency_same_key_same_task(conn):
    _seed_device(conn)
    now = dbmod.now()
    conn.execute(
        "INSERT INTO users VALUES (?,?,?,?,?,?,?,0)",
        ("u1", "alice", "h", "s", "operator", "default", now),
    )
    conn.commit()
    kw = dict(actor="alice", role="operator", tenant="default", device_id="d1",
              tool="get_system_info", args={})
    r1 = task_service.create_task(conn, request_key="k1", **kw)
    r2 = task_service.create_task(conn, request_key="k1", **kw)
    assert r1["task_id"] == r2["task_id"]
    assert r1["status"] == "queued"
    with pytest.raises(HTTPException) as exc:
        task_service.create_task(conn, request_key="k1", **{**kw, "args": {"x": 1}})
    assert exc.value.status_code == 409
    assert conn.execute("SELECT COUNT(*) FROM task_submissions").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 1


def test_create_task_tier4_approval_flow_under_fk(conn):
    """Regression (Wave 3A fix): a tier-4 task creates its approval row
    BEFORE the task row; with the deferred approvals FK the whole
    create must succeed and the approval must reference the new task."""
    _seed_device(conn)
    now = dbmod.now()
    conn.execute(
        "INSERT INTO users VALUES (?,?,?,?,?,?,?,0)",
        ("u1", "alice", "h", "s", "operator", "default", now),
    )
    conn.commit()
    r = task_service.create_task(
        conn, actor="alice", role="operator", tenant="default", device_id="d1",
        tool="delete_workspace_file", args={"path": "/tmp/x"},
        request_key="k-tier4",
    )
    assert r["status"] == "needs_approval"
    assert r["approval_id"] is not None
    row = conn.execute(
        "SELECT task_id, status FROM approvals WHERE id=?", (r["approval_id"],)
    ).fetchone()
    assert row is not None and row["task_id"] == r["task_id"] and row["status"] == "pending"
    assert conn.execute(
        "SELECT status FROM tasks WHERE id=?", (r["task_id"],)
    ).fetchone()[0] == "needs_approval"
