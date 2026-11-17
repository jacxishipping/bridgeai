"""Compatibility shim over :mod:`.limiter` (INV-12 / TD-D05, Wave 3B).

The single rate-limit entry point is now :mod:`.limiter`, which
delegates backend selection to :mod:`.durable_ratelimit`. This module
only re-exports the same names so existing imports
(``from .ratelimit import rate_limit, make_rate_limiter, ...``) keep
working unchanged. New code must import from :mod:`.limiter`.

Behaviour is unchanged: the sync callable from :func:`rate_limit`
still warns once per process (DIST-07) when called inside a running
event loop, :func:`rate_limit_async` is still the async-native entry
point, and the default limit is still 120 requests per minute.
"""
from __future__ import annotations

import logging

from .limiter import (
    DEFAULT_LIMIT,
    DEFAULT_WINDOW,
    allow,
    allow_async,
    backend_name,
    make_async_rate_limiter,
    make_rate_limiter,
    rate_limit,
    rate_limit_async,
    redis_required,
    reset_for_tests,
)

# Kept for callers that reference this module's logger (the DIST-07
# warning is still emitted under this name by limiter.py).
log = logging.getLogger("ai_bridge.ratelimit")

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
