"""Compatibility shim (F-04-12, Wave 3B).

The workspace routes live in :mod:`ai_bridge.control.workspace_routes`
(the canonical name — the old name collided with
``ai_bridge/workspace.py``). This module re-exports the public names so
existing imports (notably ``from .workspace import
install_workspace_routes`` in ``control/app.py``) keep working.
"""
from __future__ import annotations

from .workspace_routes import DeviceMetadata, UserUpdate, device_summary, install_workspace_routes

__all__ = ["DeviceMetadata", "UserUpdate", "device_summary", "install_workspace_routes"]
