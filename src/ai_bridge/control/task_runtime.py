"""Cooperative cancellation hooks for in-flight agent task execution.

Per-task execution contexts (Wave 2A / F-05-07). The previous single
global context (one ``_current_task_id`` / ``_cancel_check``) meant two
concurrent local executions overwrote each other's cancel predicate.
Each task now owns a :class:`TaskContext` in a registry keyed by task id,
and the "current" context — the one :func:`is_cancelled`,
:func:`raise_if_cancelled` and :func:`cooperative_sleep` consult — lives
in a :class:`contextvars.ContextVar`, so concurrent tasks running in
different threads (or asyncio tasks) keep separate cancel predicates.

The original public API is unchanged: ``set_execution_context`` /
``clear_execution_context`` / ``current_task_id`` / ``current_device_id``
/ ``is_cancelled`` / ``raise_if_cancelled`` / ``cooperative_sleep`` all
still work, now backed by the current contextvar instead of globals.
"""
from __future__ import annotations

import contextvars
import threading
from dataclasses import dataclass
from typing import Callable


@dataclass
class TaskContext:
    """One task's execution context: cancel predicate + owning device."""

    task_id: str
    cancel_check: Callable[[], bool] | None = None
    device_id: str | None = None
    # Wave 3A (DIST-08): monotonic timestamp of the last progress report
    # for this locally-executed task, so a long local task can prove it
    # is still alive (mirrors orchestration.record_task_progress for
    # remote agents, which bumps tasks.updated_at in the DB).
    last_progress_at: float | None = None

    def is_cancelled(self) -> bool:
        if self.cancel_check is None:
            return False
        try:
            return bool(self.cancel_check())
        except Exception:
            return False

    def record_progress(self) -> None:
        """Mark this task as progressing right now (DIST-08 heartbeat)."""
        import time

        self.last_progress_at = time.monotonic()


class TaskCancelled(RuntimeError):
    """Raised when the control plane marks the active task cancelled or timed out."""


_registry: dict[str, TaskContext] = {}
_registry_lock = threading.Lock()
_current: contextvars.ContextVar[TaskContext | None] = contextvars.ContextVar(
    "ai_bridge_current_task_context", default=None
)


def register_task_context(
    task_id: str,
    cancel_check: Callable[[], bool] | None,
    device_id: str | None = None,
) -> TaskContext:
    """Register (or replace) the execution context for ``task_id``.

    Registration alone does not make the task "current" — use
    :func:`set_execution_context` (or set the contextvar) for that. A
    context registered here can be queried from any thread via
    :func:`is_task_cancelled` / :func:`task_context`.
    """
    ctx = TaskContext(task_id=task_id, cancel_check=cancel_check, device_id=device_id)
    with _registry_lock:
        _registry[task_id] = ctx
    return ctx


def unregister_task_context(task_id: str) -> None:
    """Drop the execution context for ``task_id`` (task finished)."""
    with _registry_lock:
        _registry.pop(task_id, None)
    current = _current.get()
    if current is not None and current.task_id == task_id:
        _current.set(None)


def task_context(task_id: str) -> TaskContext | None:
    """Return the registered context for ``task_id``, or None."""
    with _registry_lock:
        return _registry.get(task_id)


def set_execution_context(
    task_id: str | None,
    cancel_check: Callable[[], bool] | None,
    *,
    device_id: str | None = None,
) -> None:
    """Bind the active fleet task and optional cancel predicate (called from the poller).

    Registers the task's context and makes it the *current* context for
    this thread/asyncio task. Passing ``task_id=None`` clears the current
    context (equivalent to :func:`clear_execution_context`).
    """
    if task_id is None:
        _current.set(None)
        return
    _current.set(register_task_context(task_id, cancel_check, device_id=device_id))


def clear_execution_context() -> None:
    """Clear the current execution context and unregister its task."""
    current = _current.get()
    _current.set(None)
    if current is not None:
        with _registry_lock:
            _registry.pop(current.task_id, None)


def current_device_id() -> str | None:
    ctx = _current.get()
    return ctx.device_id if ctx is not None else None


def current_task_id() -> str | None:
    ctx = _current.get()
    return ctx.task_id if ctx is not None else None


def is_cancelled() -> bool:
    """True when the *current* task's cancel predicate says so."""
    ctx = _current.get()
    return ctx.is_cancelled() if ctx is not None else False


def is_task_cancelled(task_id: str) -> bool:
    """True when the registered context for ``task_id`` says cancelled.

    Works from any thread, including threads other than the one executing
    the task. Unknown task ids are not cancelled.
    """
    ctx = task_context(task_id)
    return ctx.is_cancelled() if ctx is not None else False


def record_task_progress(task_id: str) -> bool:
    """Record a progress heartbeat for a locally-executed task (DIST-08).

    Stamps ``last_progress_at`` on the task's registered context.
    Returns False when the task has no registered context (unknown or
    finished — the caller should stop work); True otherwise. Remote
    agents use :func:`orchestration.record_task_progress` instead, which
    bumps ``tasks.updated_at`` in the shared DB.
    """
    ctx = task_context(task_id)
    if ctx is None:
        return False
    ctx.record_progress()
    return True


def last_progress_at(task_id: str) -> float | None:
    """Monotonic timestamp of the last progress heartbeat, or None."""
    ctx = task_context(task_id)
    return ctx.last_progress_at if ctx is not None else None


def raise_if_cancelled() -> None:
    if is_cancelled():
        raise TaskCancelled("Task was cancelled or timed out by the control plane.")


def cooperative_sleep(seconds: float, *, interval: float = 0.25) -> None:
    """Sleep in small slices so cancellation can interrupt long waits."""
    import time

    deadline = time.time() + max(0.0, float(seconds))
    while time.time() < deadline:
        raise_if_cancelled()
        time.sleep(min(interval, max(0.0, deadline - time.time())))
