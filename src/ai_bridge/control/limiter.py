"""Single rate-limit entry point (INV-12 / TD-D05, Wave 3B Track B).

This module is the ONE interface for rate limiting. It delegates all
backend selection to :mod:`.durable_ratelimit` (the implementation
layer — do not call it directly from new code):

* Redis URL configured and reachable -> Redis sliding window.
* Redis URL configured but unreachable -> in-memory limiter (PERF-02:
  the DB path is never used on this path, so a Redis outage cannot
  turn into a per-request DB write).
* No Redis URL configured -> DB limiter when a connection is supplied,
  else in-memory.

Documented limit (one limit, matching the enforced default): **120
requests per minute** — every entry point below defaults to
``limit=120, window=60`` (seconds). Callers that need a different
limit pass it explicitly; the control-plane HTTP middleware
(``control/app.py``) does so today (1200/min for authenticated tokens,
300/min for anonymous IPs) — those overrides live with that caller,
not here.

The old :mod:`.ratelimit` module is now a thin compatibility shim that
re-exports everything from here; :mod:`.durable_ratelimit` keeps its
public functions as the implementation layer.

NOTE (DIST-07, fixed in Wave 3A, preserved here): the sync callable
returned by :func:`rate_limit` cannot await Redis from inside a running
event loop, so when it is called from async code it warns once per
process and falls back to the in-memory limiter for that request
instead of silently under-enforcing under multiple workers. Async
callers must use :func:`rate_limit_async` (or :func:`allow_async`)
instead.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

from fastapi import HTTPException

from . import durable_ratelimit as _durable

# The DIST-07 sync-in-loop warning is captured by tests under this
# logger name; keep it even though this module is now `limiter`.
log = logging.getLogger("ai_bridge.ratelimit")

DEFAULT_LIMIT = 120
DEFAULT_WINDOW = 60

_SYNC_IN_LOOP_WARNED = False


def redis_required() -> bool:
    """True when a Redis URL is configured (Redis is the required backend)."""
    return _durable.redis_required()


def backend_name(conn: Any | None = None) -> str:
    """Name of the backend :func:`allow` would actually use.

    ``"redis"`` when Redis is configured and reachable, ``"memory"``
    when Redis is configured but unreachable, ``"database"`` when no
    Redis URL is configured and a connection is supplied, else
    ``"memory"``.
    """
    return _durable.backend_name(conn)


def allow(key: str, limit: int = DEFAULT_LIMIT, window: float = DEFAULT_WINDOW,
          conn: Any | None = None) -> bool:
    """Return True if the request is within the rate limit.

    Delegates to :func:`durable_ratelimit.allow` (same backend
    selection, same defaults: 120 requests per 60-second window).
    """
    return _durable.allow(key, limit, window, conn=conn)


async def allow_async(key: str, limit: int = DEFAULT_LIMIT,
                      window: float = DEFAULT_WINDOW,
                      conn: Any | None = None) -> bool:
    """Async-native version of :func:`allow` (DIST-07).

    Same backend selection as :func:`allow`; async callers must use
    this (or :func:`rate_limit_async`) so the shared Redis limiter is
    enforced instead of the per-worker memory fallback.
    """
    return await _durable.allow_async(key, limit, window, conn=conn)


def _note_sync_in_async_context() -> None:
    """Warn once that a sync limiter ran inside a running loop (DIST-07).

    The sync wrapper cannot await Redis from a running loop, so it falls
    back to the per-worker in-memory limiter for that request. That
    fallback used to be silent — under 4 workers it meant the effective
    limit was 4x the configured one with no signal. Callers in async
    code must use :func:`rate_limit_async` instead.
    """
    global _SYNC_IN_LOOP_WARNED
    if not _SYNC_IN_LOOP_WARNED:
        _SYNC_IN_LOOP_WARNED = True
        log.warning(
            "ratelimit: sync rate_limit() called inside a running event "
            "loop; falling back to per-worker in-memory limiting for this "
            "process — use rate_limit_async() from async code so the "
            "shared Redis limiter is enforced"
        )


def rate_limit(key: str, limit: int = DEFAULT_LIMIT,
               window: int = DEFAULT_WINDOW) -> Callable[[], None]:
    """Return a synchronous rate-limit callable (raises 429 when exceeded).

    Outside a running event loop the callable enforces the shared limit
    through :func:`allow` (Redis when configured and reachable, else
    the in-memory/DB fallback). Inside a running loop it warns once
    (DIST-07) and enforces the per-worker in-memory limit for that
    request instead of blocking the loop on synchronous Redis I/O.
    """
    def _sync_check() -> None:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            # No running loop — safe to enforce the shared limit.
            if not allow(key, limit, window):
                raise HTTPException(status_code=429, detail="Rate limit exceeded.")
            return
        # Already inside an async context: cannot await Redis from sync
        # code. Fall back to memory for this request, but warn once
        # (DIST-07) instead of silently under-enforcing.
        _note_sync_in_async_context()
        # Private import, same package: durable_ratelimit's memory bucket
        # is the single in-memory implementation; reusing it (rather than
        # a second bucket here) keeps reset_for_tests() coherent.
        if not _durable._memory_allow(key, limit, window):
            raise HTTPException(status_code=429, detail="Rate limit exceeded.")

    return _sync_check


async def rate_limit_async(key: str, limit: int = DEFAULT_LIMIT,
                           window: int = DEFAULT_WINDOW) -> None:
    """Async-native rate limit (DIST-07).

    Awaits the shared limiter directly, so async middleware enforces
    the shared limit instead of the per-worker memory fallback. Falls
    back to the in-memory limiter only when Redis is unconfigured or
    unreachable (PERF-02: never a per-request DB write). Raises
    HTTPException 429 when the limit is exceeded.
    """
    if not await allow_async(key, limit, window):
        raise HTTPException(status_code=429, detail="Rate limit exceeded.")


def make_rate_limiter(limit: int = DEFAULT_LIMIT,
                      window: int = DEFAULT_WINDOW) -> Callable[[str], None]:
    """Factory: returns a sync per-key rate-limit checker."""
    def checker(key: str) -> None:
        rate_limit(key, limit, window)()

    return checker


def make_async_rate_limiter(limit: int = DEFAULT_LIMIT,
                            window: int = DEFAULT_WINDOW) -> Callable[[str], None]:
    """Factory: returns an async per-key rate-limit checker."""
    async def checker(key: str) -> None:
        await rate_limit_async(key, limit, window)

    return checker


def reset_for_tests() -> None:
    """Clear cached clients, once-per-process warnings, and buckets."""
    global _SYNC_IN_LOOP_WARNED
    _SYNC_IN_LOOP_WARNED = False
    _durable.reset_for_tests()


__all__ = [
    "DEFAULT_LIMIT",
    "DEFAULT_WINDOW",
    "allow",
    "allow_async",
    "rate_limit",
    "rate_limit_async",
    "make_rate_limiter",
    "make_async_rate_limiter",
    "backend_name",
    "redis_required",
    "reset_for_tests",
]
