"""Durable MCP approval store (F-04-01, Wave 5A).

Local approvals (created by ``request_approval``, granted by
``approve_task``) used to live only in ``server._APPROVALS``, a plain
in-process dict: they were lost on restart, invisible to other
processes, and — before Wave 1C — unscoped. Wave 1C added session
scoping + a TTL; this module adds durability on top of the same
record shape.

Storage follows the existing durable pattern used by ``plane_state``
and the OIDC exchange-code store: one row per approval in the
control-plane ``settings`` table, key ``approval.<id>``, JSON value::

    {"tool": ..., "reason": ..., "status": "pending|approved|used",
     "session": <session key or None>, "created_at": <epoch seconds>}

The same ``settings`` upsert the rest of the control plane uses keeps
this working on both SQLite and Postgres (``?`` placeholders are
translated by the connection wrapper, as in ``plane_state``).

Callers pass a control-plane connection (see ``control.db.connect``);
this module never opens one itself.
"""
from __future__ import annotations

import json
import time
from typing import Any

KEY_PREFIX = "approval."

_STATUSES = ("pending", "approved", "used", "denied")


def _key(approval_id: str) -> str:
    return f"{KEY_PREFIX}{approval_id}"


def _upsert(conn: Any, approval_id: str, rec: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (_key(approval_id), json.dumps(rec)),
    )
    conn.commit()


def _row_value(conn: Any, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    if row is None:
        return None
    return row["value"] if hasattr(row, "keys") else row[0]


def create_approval(
    conn: Any,
    approval_id: str,
    tool: str,
    reason: str,
    session: str | None,
    created_at: float | None = None,
) -> dict[str, Any]:
    """Insert a new pending approval; returns the stored record."""
    rec = {
        "tool": tool,
        "reason": reason,
        "status": "pending",
        "session": session,
        "created_at": created_at if created_at is not None else time.time(),
    }
    _upsert(conn, approval_id, rec)
    return rec


def get_approval(conn: Any, approval_id: str) -> dict[str, Any] | None:
    """Return the stored record for ``approval_id``, or None."""
    raw = _row_value(conn, _key(approval_id))
    if not raw:
        return None
    try:
        rec = json.loads(str(raw))
    except (json.JSONDecodeError, TypeError):
        return None
    return rec if isinstance(rec, dict) else None


def set_approval_status(conn: Any, approval_id: str, status: str) -> bool:
    """Set ``status`` on a stored approval; False when it does not exist."""
    if status not in _STATUSES:
        raise ValueError(f"unknown approval status: {status!r}")
    rec = get_approval(conn, approval_id)
    if rec is None:
        return False
    rec["status"] = status
    _upsert(conn, approval_id, rec)
    return True


def _is_live(rec: dict[str, Any], session: str, ttl_s: float, now: float) -> bool:
    if rec.get("status") != "approved":
        return False
    if rec.get("session") is not None and rec["session"] != session:
        return False
    if now - float(rec.get("created_at", now)) > ttl_s:
        return False
    return True


def list_approvals(conn: Any) -> dict[str, dict[str, Any]]:
    """All stored approvals, ``{approval_id: record}`` (expired kept)."""
    out: dict[str, dict[str, Any]] = {}
    rows = conn.execute(
        "SELECT key, value FROM settings WHERE key LIKE 'approval.%'"
    ).fetchall()
    for row in rows:
        key = row["key"] if hasattr(row, "keys") else row[0]
        raw = row["value"] if hasattr(row, "keys") else row[1]
        try:
            rec = json.loads(str(raw))
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(rec, dict):
            out[str(key)[len(KEY_PREFIX):]] = rec
    return out


def find_approved(
    conn: Any, tool: str, session: str, ttl_s: float, now: float | None = None
) -> str | None:
    """Approval id of a live (approved, same-session, unexpired) record
    for ``tool``, or None. Peeks without consuming."""
    now = time.time() if now is None else now
    for approval_id, rec in list_approvals(conn).items():
        if rec.get("tool") != tool:
            continue
        if _is_live(rec, session, ttl_s, now):
            return approval_id
    return None


def consume_approved(
    conn: Any, tool: str, session: str, ttl_s: float, now: float | None = None
) -> bool:
    """Consume one live approval for ``tool`` (mark it ``used``)."""
    approval_id = find_approved(conn, tool, session, ttl_s, now)
    if approval_id is None:
        return False
    return set_approval_status(conn, approval_id, "used")


def prune_expired(conn: Any, ttl_s: float, now: float | None = None) -> int:
    """Delete stored approvals older than ``ttl_s``; returns the count."""
    now = time.time() if now is None else now
    removed = 0
    for approval_id, rec in list_approvals(conn).items():
        if now - float(rec.get("created_at", now)) > ttl_s:
            conn.execute("DELETE FROM settings WHERE key=?", (_key(approval_id),))
            removed += 1
    if removed:
        conn.commit()
    return removed
