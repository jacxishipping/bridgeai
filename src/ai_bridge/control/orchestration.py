"""Task lifecycle maintenance: stale running recovery and concurrency helpers."""
from __future__ import annotations

import json
import os
from typing import Any

from . import db as dbmod
from .plane_state import is_emergency_stop


DEFAULT_RUNNING_LEASE_SEC = int(os.environ.get("AI_BRIDGE_TASK_RUNNING_LEASE_SEC", "900"))
DEFAULT_SWEEP_INTERVAL_SEC = int(os.environ.get("AI_BRIDGE_TASK_SWEEP_INTERVAL_SEC", "30"))


def device_has_active_lease(conn: Any, device_id: str, *, lease_sec: int | None = None) -> bool:
    """True when a fresh 'running' task still holds the per-device execution lease."""
    lease = lease_sec if lease_sec is not None else DEFAULT_RUNNING_LEASE_SEC
    cutoff = dbmod.now() - lease
    row = conn.execute(
        "SELECT id FROM tasks WHERE device_id=? AND status='running' AND updated_at >= ? LIMIT 1",
        (device_id, cutoff),
    ).fetchone()
    return row is not None


def record_task_progress(conn: Any, task_id: str, *, device_id: str | None = None) -> bool:
    """Record that the agent owning ``task_id`` is still making progress.

    Bumps ``tasks.updated_at`` to now (and appends a ``"progress"`` row to
    ``task_events``) iff the task is still ``status='running'``; returns
    True in that case, False when the task is no longer running (already
    terminal / re-queued / unknown) — a False return tells the agent its
    task is gone and it should stop work.

    ``device_id`` (Wave 3A) scopes the heartbeat to the task's owning
    device: a progress report for a task another device owns returns
    False, so one agent cannot keep another device's task alive. Callers
    that cannot prove ownership pass None (previous behaviour).

    Why this matters: :func:`sweep_stale_running_tasks` re-queues
    ``running`` tasks whose ``updated_at`` is older than the lease
    (default 900s, unchanged). Without a progress heartbeat a
    legitimately long task is re-queued while still running and then
    executes twice. With it, a task whose agent reports progress is not
    re-queued while running; only a task whose agent has gone silent for
    a full lease is reclaimed. The change is committed immediately so
    the heartbeat is durable across workers. Callers should throttle
    reports (e.g. at most once per 60s per task) to bound task_events
    growth.
    """
    from .task_events import append_task_event

    now = dbmod.now()
    if device_id:
        cur = conn.execute(
            "UPDATE tasks SET updated_at=? WHERE id=? AND status='running' AND device_id=?",
            (now, task_id, device_id),
        )
    else:
        cur = conn.execute(
            "UPDATE tasks SET updated_at=? WHERE id=? AND status='running'",
            (now, task_id),
        )
    if cur.rowcount != 1:
        return False
    append_task_event(conn, task_id, "progress", {"at": now}, commit=False)
    conn.commit()
    return True


def sweep_stale_running_tasks(
    conn: Any,
    *,
    lease_sec: int | None = None,
    requeue: bool | None = None,
) -> dict[str, int]:
    """Reclaim tasks stuck in 'running' longer than the lease (agent crash / network loss)."""
    lease = lease_sec if lease_sec is not None else DEFAULT_RUNNING_LEASE_SEC
    if requeue is None:
        requeue = os.environ.get("AI_BRIDGE_STALE_TASK_REQUEUE", "1").strip().lower() in (
            "1",
            "true",
            "yes",
        )
    cutoff = dbmod.now() - lease
    rows = conn.execute(
        "SELECT id, device_id, tool, args_json FROM tasks WHERE status='running' AND updated_at < ?",
        (cutoff,),
    ).fetchall()
    timed_out = 0
    requeued = 0
    for row in rows:
        tid = row["id"] if hasattr(row, "keys") else row[0]
        if requeue and not is_emergency_stop(conn):
            conn.execute(
                "UPDATE tasks SET status='queued', result=?, updated_at=? WHERE id=? AND status='running'",
                (
                    json.dumps({"note": "Requeued after stale running lease expired."})[:2000],
                    dbmod.now(),
                    tid,
                ),
            )
            requeued += 1
        else:
            conn.execute(
                "UPDATE tasks SET status='timed_out', result=?, updated_at=? WHERE id=? AND status='running'",
                (
                    json.dumps({"error": "Task exceeded running lease without completion."})[:2000],
                    dbmod.now(),
                    tid,
                ),
            )
            timed_out += 1
    if timed_out or requeued:
        conn.commit()
    return {"timed_out": timed_out, "requeued": requeued, "scanned": len(rows)}