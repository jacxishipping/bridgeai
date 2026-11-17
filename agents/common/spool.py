"""Local Offline Task Spooler for AI Bridge Agents.

Guarantees zero-data-loss execution when network connectivity is severed.
If an agent executes a task while disconnected from the Control Plane,
the result is persisted locally in SQLite (agent_spool.db) and automatically
flushed with retry as soon as connectivity is restored.

F07-08 (Wave 3C): the spool is BOUNDED and nothing is ever silently
dropped:

* ``max_items`` / ``max_total_bytes`` cap the pending queue. When a new
  result would exceed either cap, the OLDEST pending result is moved to
  the dead-letter queue (DLQ) first — the queue can never grow without
  bound, and the evicted result is preserved with a reason.
* ``ttl_seconds`` gives every spooled result a per-item expiry. Expired
  results are moved to the DLQ (reason ``ttl_expired``) instead of being
  delivered stale or deleted silently.
* ``max_attempts`` bounds delivery retries. A result whose sender keeps
  failing is moved to the DLQ (reason ``max_attempts_exceeded``) after
  that many failed flush attempts instead of being retried forever.
* ``flush()`` no longer stops at the first failure (the old head-of-line
  blocking): a failed item is left pending (or dead-lettered) and the
  flush continues with the remaining items.

The DLQ lives in the same SQLite file, table ``dead_letter_results``,
with the same payload columns plus ``dead_at`` and ``reason``. Operators
can inspect it with :meth:`TaskSpooler.get_dead_letter`; nothing in the
DLQ is ever deleted by the spooler itself.

Re-spooling the same ``task_id`` (a task re-executed) replaces the stored
result with the fresh one and resets its delivery attempts and TTL clock
— a fresh result gets a fresh delivery budget.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Callable

logger = logging.getLogger("ai_bridge.spool")

# F07-08 defaults: a result is up to 512 KiB (MAX_RESULT_CHARS in the
# poller), so 500 items / 64 MiB bounds the spool DB to a known size
# even for an agent that runs screenshot tasks while offline for days.
DEFAULT_MAX_ITEMS = 500
DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024
DEFAULT_TTL_SECONDS = 7 * 24 * 3600  # 7 days
DEFAULT_MAX_ATTEMPTS = 10

DLQ_REASON_CAPACITY = "spool_capacity_exceeded"
DLQ_REASON_TTL = "ttl_expired"
DLQ_REASON_MAX_ATTEMPTS = "max_attempts_exceeded"


class TaskSpooler:
    """Thread-safe persistent task result queue backed by SQLite."""

    def __init__(
        self,
        db_path: Path | None = None,
        *,
        max_items: int = DEFAULT_MAX_ITEMS,
        max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    ) -> None:
        if db_path is None:
            if os.name == "nt":
                base_dir = Path(os.environ.get("ProgramData", "C:\\ProgramData")) / "AIBridge"
            else:
                base_dir = Path("/var/lib/ai-bridge") if os.geteuid() == 0 else (Path.home() / ".ai-bridge")
            db_path = base_dir / "agent_spool.db"

        self.db_path = Path(db_path)
        self.max_items = max(1, int(max_items))
        self.max_total_bytes = max(1, int(max_total_bytes))
        self.ttl_seconds = float(ttl_seconds)
        self.max_attempts = max(1, int(max_attempts))
        self._lock = threading.RLock()
        self._init_db()

    def _init_db(self) -> None:
        """Initialize the local spool + dead-letter tables."""
        try:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(str(self.db_path), timeout=10.0) as conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS spooled_results (
                        task_id TEXT PRIMARY KEY,
                        status TEXT NOT NULL,
                        result TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        attempts INTEGER NOT NULL DEFAULT 0,
                        last_attempt_at REAL NOT NULL DEFAULT 0
                    );
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS dead_letter_results (
                        task_id TEXT PRIMARY KEY,
                        status TEXT NOT NULL,
                        result TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        attempts INTEGER NOT NULL DEFAULT 0,
                        last_attempt_at REAL NOT NULL DEFAULT 0,
                        dead_at REAL NOT NULL,
                        reason TEXT NOT NULL
                    );
                """)
                conn.commit()
        except Exception as exc:
            logger.warning("Could not initialize local task spool at %s: %s", self.db_path, exc)

    # -- internal helpers (all assume the lock is held) --------------------

    def _pending_stats_locked(self, conn: sqlite3.Connection) -> tuple[int, int]:
        row = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(result)), 0) FROM spooled_results"
        ).fetchone()
        return int(row[0]), int(row[1])

    def _move_to_dlq_locked(
        self, conn: sqlite3.Connection, task_id: str, reason: str
    ) -> bool:
        """Move one pending row to the DLQ. Returns True if a row moved."""
        row = conn.execute(
            "SELECT task_id, status, result, created_at, attempts, last_attempt_at"
            " FROM spooled_results WHERE task_id=?",
            (task_id,),
        ).fetchone()
        if row is None:
            return False
        conn.execute(
            """INSERT INTO dead_letter_results
                   (task_id, status, result, created_at, attempts, last_attempt_at, dead_at, reason)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(task_id) DO UPDATE SET
                       status=excluded.status, result=excluded.result,
                       attempts=excluded.attempts, last_attempt_at=excluded.last_attempt_at,
                       dead_at=excluded.dead_at, reason=excluded.reason""",
            (row[0], row[1], row[2], row[3], row[4], row[5], time.time(), reason),
        )
        conn.execute("DELETE FROM spooled_results WHERE task_id=?", (task_id,))
        logger.warning(
            "Spooled result for task %s moved to dead-letter queue (%s)", task_id, reason
        )
        return True

    def _evict_oldest_locked(self, conn: sqlite3.Connection, reason: str) -> bool:
        row = conn.execute(
            "SELECT task_id FROM spooled_results ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
        if row is None:
            return False
        return self._move_to_dlq_locked(conn, row[0], reason)

    # -- public API ---------------------------------------------------------

    def pending_count(self) -> int:
        """Number of results currently waiting for delivery."""
        with self._lock:
            try:
                with sqlite3.connect(str(self.db_path), timeout=5.0) as conn:
                    return int(conn.execute("SELECT COUNT(*) FROM spooled_results").fetchone()[0])
            except Exception as exc:
                logger.warning("Failed to count spooled tasks: %s", exc)
                return 0

    def dead_letter_count(self) -> int:
        """Number of results in the dead-letter queue."""
        with self._lock:
            try:
                with sqlite3.connect(str(self.db_path), timeout=5.0) as conn:
                    return int(
                        conn.execute("SELECT COUNT(*) FROM dead_letter_results").fetchone()[0]
                    )
            except Exception as exc:
                logger.warning("Failed to count dead-lettered tasks: %s", exc)
                return 0

    def prune_expired(self) -> int:
        """Move every TTL-expired pending result to the DLQ.

        Returns the number of results dead-lettered. Expiry is per-item:
        ``created_at + ttl_seconds < now``.
        """
        with self._lock:
            try:
                cutoff = time.time() - self.ttl_seconds
                with sqlite3.connect(str(self.db_path), timeout=5.0) as conn:
                    rows = conn.execute(
                        "SELECT task_id FROM spooled_results WHERE created_at < ?",
                        (cutoff,),
                    ).fetchall()
                    for (task_id,) in rows:
                        self._move_to_dlq_locked(conn, task_id, DLQ_REASON_TTL)
                    conn.commit()
                    return len(rows)
            except Exception as exc:
                logger.warning("Failed to prune expired spooled tasks: %s", exc)
                return 0

    def move_to_dlq(self, task_id: str, reason: str) -> bool:
        """Move one pending result to the DLQ with an explicit reason."""
        with self._lock:
            try:
                with sqlite3.connect(str(self.db_path), timeout=5.0) as conn:
                    moved = self._move_to_dlq_locked(conn, task_id, reason)
                    conn.commit()
                    return moved
            except Exception as exc:
                logger.warning("Failed to dead-letter task %s: %s", task_id, exc)
                return False

    def get_dead_letter(self, max_items: int = 50) -> list[dict]:
        """Retrieve dead-lettered results, oldest first."""
        with self._lock:
            try:
                with sqlite3.connect(str(self.db_path), timeout=5.0) as conn:
                    conn.row_factory = sqlite3.Row
                    rows = conn.execute(
                        "SELECT task_id, status, result, created_at, attempts,"
                        " last_attempt_at, dead_at, reason FROM dead_letter_results"
                        " ORDER BY dead_at ASC LIMIT ?",
                        (max_items,),
                    ).fetchall()
                    return [dict(r) for r in rows]
            except Exception as exc:
                logger.warning("Failed to query dead-lettered tasks: %s", exc)
                return []

    def spool(self, task_id: str, status: str, result: str) -> None:
        """Persist a task result locally to survive network cuts or process restarts.

        Bounded (F07-08): expired pending results are pruned to the DLQ
        first, then — if the new result would exceed ``max_items`` or
        ``max_total_bytes`` — the oldest pending results are evicted to
        the DLQ until it fits. A result is therefore never dropped
        silently and the spool can never grow without bound.
        """
        with self._lock:
            try:
                now_ts = time.time()
                new_size = len(result.encode("utf-8"))
                with sqlite3.connect(str(self.db_path), timeout=5.0) as conn:
                    # Expired items leave first, freeing their budget.
                    cutoff = now_ts - self.ttl_seconds
                    expired = conn.execute(
                        "SELECT task_id FROM spooled_results WHERE created_at < ?",
                        (cutoff,),
                    ).fetchall()
                    for (old_id,) in expired:
                        self._move_to_dlq_locked(conn, old_id, DLQ_REASON_TTL)
                    # Enforce the caps by evicting oldest-first to the DLQ.
                    # A re-spool of an already-pending task_id replaces it
                    # in place and does not consume an extra slot.
                    already_pending = (
                        conn.execute(
                            "SELECT 1 FROM spooled_results WHERE task_id=?", (task_id,)
                        ).fetchone()
                        is not None
                    )
                    if not already_pending:
                        count, total_bytes = self._pending_stats_locked(conn)
                        while count >= self.max_items or (
                            total_bytes + new_size > self.max_total_bytes and count > 0
                        ):
                            if not self._evict_oldest_locked(conn, DLQ_REASON_CAPACITY):
                                break
                            count, total_bytes = self._pending_stats_locked(conn)
                    conn.execute("""
                        INSERT INTO spooled_results (task_id, status, result, created_at, attempts, last_attempt_at)
                        VALUES (?, ?, ?, ?, 0, ?)
                        ON CONFLICT(task_id) DO UPDATE SET
                            status=excluded.status,
                            result=excluded.result,
                            created_at=excluded.created_at,
                            attempts=0,
                            last_attempt_at=excluded.last_attempt_at;
                    """, (task_id, status, result, now_ts, now_ts))
                    conn.commit()
                logger.info("Persisted spooled result for task %s to %s", task_id, self.db_path.name)
            except Exception as exc:
                # The spool DB itself is unwritable: there is nowhere to
                # record a DLQ entry, so log loudly instead of dropping
                # the result silently (F07-08).
                logger.error("Failed to spool task %s locally: %s", task_id, exc)

    def mark_flushed(self, task_id: str) -> bool:
        """Remove a successfully delivered task result from the spool."""
        with self._lock:
            try:
                with sqlite3.connect(str(self.db_path), timeout=5.0) as conn:
                    cur = conn.execute("DELETE FROM spooled_results WHERE task_id=?", (task_id,))
                    conn.commit()
                    return cur.rowcount > 0
            except Exception as exc:
                logger.warning("Failed to remove task %s from spool: %s", task_id, exc)
                return False

    def get_pending(self, max_items: int = 50) -> list[dict]:
        """Retrieve pending unsent task results (TTL-expired ones are
        dead-lettered first, so this never returns a stale result)."""
        self.prune_expired()
        with self._lock:
            try:
                with sqlite3.connect(str(self.db_path), timeout=5.0) as conn:
                    conn.row_factory = sqlite3.Row
                    rows = conn.execute(
                        "SELECT task_id, status, result, created_at, attempts FROM spooled_results ORDER BY created_at ASC LIMIT ?",
                        (max_items,),
                    ).fetchall()
                    return [dict(r) for r in rows]
            except Exception as exc:
                logger.warning("Failed to query spooled tasks: %s", exc)
                return []

    def flush(self, sender_fn: Callable[[str, str, str], bool]) -> int:
        """Attempt to deliver all spooled tasks to the Control Plane.

        sender_fn(task_id, status, result) -> bool
        Returns the count of successfully delivered tasks.

        F07-08: no head-of-line blocking — a failed item is left pending
        (with its attempt count bumped) and the flush continues with the
        next item. An item that reaches ``max_attempts`` failed deliveries
        is moved to the DLQ instead of being retried forever; a
        TTL-expired item is dead-lettered instead of being delivered stale.
        """
        pending = self.get_pending()
        if not pending:
            return 0

        flushed_count = 0
        for item in pending:
            tid = item["task_id"]
            st = item["status"]
            res = item["result"]
            try:
                ok = sender_fn(tid, st, res)
            except Exception as exc:
                logger.debug("Failed to flush spooled task %s: %s", tid, exc)
                ok = False
            if ok:
                self.mark_flushed(tid)
                flushed_count += 1
                logger.info("Successfully flushed spooled task %s to control plane", tid)
            else:
                self._record_failed_attempt(tid)
        return flushed_count

    def _record_failed_attempt(self, task_id: str) -> None:
        """Bump an item's delivery-attempt count; dead-letter it once it
        reaches ``max_attempts``."""
        with self._lock:
            try:
                with sqlite3.connect(str(self.db_path), timeout=5.0) as conn:
                    cur = conn.execute(
                        "UPDATE spooled_results SET attempts=attempts+1, last_attempt_at=?"
                        " WHERE task_id=?",
                        (time.time(), task_id),
                    )
                    if cur.rowcount == 0:
                        return
                    attempts = conn.execute(
                        "SELECT attempts FROM spooled_results WHERE task_id=?", (task_id,)
                    ).fetchone()[0]
                    if attempts >= self.max_attempts:
                        self._move_to_dlq_locked(conn, task_id, DLQ_REASON_MAX_ATTEMPTS)
                    conn.commit()
            except Exception as exc:
                logger.warning("Failed to record flush failure for task %s: %s", task_id, exc)
