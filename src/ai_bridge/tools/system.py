"""System information and diagnostics tools (F-04-06 split of tools.py)."""
# Code in this module was moved verbatim from src/ai_bridge/tools.py
# (F-04-06 package split). Behaviour is unchanged; only the module
# location changed. Import through `ai_bridge.tools` for compatibility.

from __future__ import annotations

from .. import diagnostics
from ..policy import Policy
from ..security import workspace_root

from ._common import _check, default_policy
def get_system_info() -> dict:
    _check("get_system_info")
    info = diagnostics.system_info(); info["workspace"] = str(workspace_root())
    return info

def get_resource_usage() -> dict:
    _check("get_resource_usage"); return diagnostics.resource_usage()


def get_network_info() -> dict:
    _check("get_network_info"); return diagnostics.network_info()


def get_service_status(service: str, *, policy: Policy | None = None) -> dict:
    eff_policy = policy or default_policy()
    _check("get_service_status", policy=eff_policy)
    allowed_svc = None if eff_policy.unrestricted or "*" in eff_policy.allowed_services else eff_policy.allowed_services
    return diagnostics.service_status(service, allowed_services=allowed_svc)


def get_system_monitors() -> list[dict]:
    """Enumerate all physical and virtual displays on the host machine."""
    try:
        from ai_bridge.screen_capture import get_monitors
        return get_monitors()
    except Exception:
        return [{"index": 0, "name": "Display 1 (Default)", "width": 1920, "height": 1080, "is_primary": True}]
