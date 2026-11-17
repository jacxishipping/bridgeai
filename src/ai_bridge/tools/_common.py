"""Shared tool implementations used by the MCP server, the agent, and
the control plane. Each function enforces policy before doing work.
No function here trusts its caller: device_revoked / approval flags are
inputs the *server* supplies, never values an AI tool argument can set
for itself (see policy.decide and server wrappers)."""
from __future__ import annotations

import os
import platform
import threading
from typing import Any

from ..config import get_settings
from ..policy import Policy, decide


def _ensure_dpi_aware() -> None:
    """Make this process per-monitor DPI aware on Windows.

    Without this, GetSystemMetrics/ImageGrab report logical (scaled) pixels
    while SetCursorPos expects physical pixels. On displays scaled above 100%
    that mismatch makes every click land away from the pixel the model saw.
    """
    if platform.system() != "Windows":
        return
    try:
        import ctypes

        # PROCESS_PER_MONITOR_DPI_AWARE = 2 (Windows 8.1+); fall back to Vista API.
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


_ensure_dpi_aware()


# Scale of the most recent frame returned to a model (1.0 = native pixels).
# interact_and_view_screen uses it to map coordinates from a scaled frame back
# to physical screen pixels.
LAST_FRAME_SCALE: float = 1.0

# Cached Set-of-Marks from the most recent set_of_marks_screenshot (mark_id -> entry).
_LAST_SOM_MARKS: dict[str, dict[str, Any]] = {}
_LAST_SOM_LOCK = threading.Lock()


def get_last_som_marks() -> dict[str, dict[str, Any]]:
    with _LAST_SOM_LOCK:
        return dict(_LAST_SOM_MARKS)


def clear_som_marks_cache() -> None:
    with _LAST_SOM_LOCK:
        _LAST_SOM_MARKS.clear()


def default_policy() -> Policy:
    s = get_settings()
    allowed_apps = frozenset(a.strip() for a in os.environ.get("AI_BRIDGE_ALLOWED_APPS", "").split(",") if a.strip())
    allowed_services = frozenset(a.strip() for a in os.environ.get("AI_BRIDGE_ALLOWED_SERVICES", "").split(",") if a.strip())
    return Policy(allow_writes=True, allow_tier3=s.allow_tier3,
                  allowed_services=allowed_services, allowed_apps=allowed_apps,
                  desktop_enabled=s.desktop_enabled)

def _check(tool: str, *, approval_granted: bool = False, is_admin: bool = False, policy: Policy | None = None):
    d = decide(policy or default_policy(), tool, approval_granted=approval_granted, is_admin=is_admin)
    if not d.allowed:
        raise PermissionError(d.reason)
    return d


_VETOED_INTENTS: set[str] = set()


def _require_no_human_takeover(device_id: str = "local") -> None:
    """Enforce Section 12 & 13: Human takeover immediately revokes AI input until handed back."""
    from ..control.v1_routes import is_device_human_takeover_active

    if is_device_human_takeover_active(device_id):
        raise PermissionError(
            "Human takeover is active on this desktop session; AI input and execution are suppressed until control is explicitly handed back."
        )


def desktop_veto_action(intent_id: str, reason: str = "Operator override") -> dict:
    """Cancels a pending anticipated agent action."""
    _VETOED_INTENTS.add(intent_id)
    return {"ok": True, "intent_id": intent_id, "vetoed": True, "reason": reason}


def desktop_is_action_vetoed(intent_id: str) -> bool:
    """Check whether a pending agent action was vetoed by human operator."""
    return intent_id in _VETOED_INTENTS
