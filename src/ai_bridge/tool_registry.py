"""Single tool registry (INV-12 / TD-D01, Wave 3B Track B).

The ONE mapping of tool name -> tier / handler / schema metadata that
both the MCP server (``server.py``) and the control-plane MCP routes
(``control/mcp_routes.py``) read. Previously each of those modules kept
its own duplicated tool list; they now read this registry instead
(wiring is Track C's job — this module only defines the registry).

API contract (frozen for Track C — do not change signatures):

* :class:`ToolEntry` — frozen dataclass: ``name``, ``tier``,
  ``handler``, ``description``, ``requires_approval``.
* ``TOOL_REGISTRY: dict[str, ToolEntry]`` — pre-populated at import
  from :data:`ai_bridge.policy.TOOL_TIERS` (every entry, ``handler=None``,
  ``requires_approval=True`` for the ``SENSITIVE`` / ``HIGH_RISK`` tiers).
* ``register_tool(name, tier, handler=None, description="",
  requires_approval=False) -> ToolEntry``
* ``get_tool(name) -> ToolEntry | None`` — normalizes the name exactly
  like :func:`ai_bridge.policy.normalize_tool_name`.
* ``list_tools() -> list[ToolEntry]``
* ``tools_by_tier(tier) -> list[str]``
* ``get_tier(name) -> str | None``

Tier values are the :class:`ai_bridge.policy.RiskTier` member names
(``"READ_ONLY"``, ``"LOW_RISK"``, ``"SENSITIVE"``, ``"HIGH_RISK"``).

This module imports only from :mod:`.policy` so it can never create an
import cycle with the server or control-plane modules.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .policy import TOOL_TIERS, normalize_tool_name

__all__ = [
    "ToolEntry",
    "TOOL_REGISTRY",
    "register_tool",
    "get_tool",
    "list_tools",
    "tools_by_tier",
    "get_tier",
]


@dataclass(frozen=True)
class ToolEntry:
    """One registered tool: its tier, handler, and approval metadata."""

    name: str
    tier: str
    handler: Callable | None
    description: str = ""
    requires_approval: bool = False


def _tier_name(tier) -> str:
    """Normalize a tier (RiskTier member or plain string) to its name."""
    name = getattr(tier, "name", None)
    if isinstance(name, str):
        return name
    return str(tier).strip().upper()


TOOL_REGISTRY: dict[str, ToolEntry] = {
    name: ToolEntry(
        name=name,
        tier=_tier_name(tier),
        handler=None,
        description="",
        requires_approval=_tier_name(tier) in {"SENSITIVE", "HIGH_RISK"},
    )
    for name, tier in TOOL_TIERS.items()
}


def register_tool(
    name: str,
    tier: str,
    handler: Callable | None = None,
    description: str = "",
    requires_approval: bool = False,
) -> ToolEntry:
    """Register (or replace) one tool in the registry.

    The name is normalized the same way :func:`get_tool` normalizes it
    (dotted client aliases resolve to canonical underscore names), so a
    registration under an alias lands on the canonical entry. Returns
    the stored :class:`ToolEntry`.
    """
    canonical = normalize_tool_name(name)
    entry = ToolEntry(
        name=canonical,
        tier=_tier_name(tier),
        handler=handler,
        description=description,
        requires_approval=bool(requires_approval),
    )
    TOOL_REGISTRY[canonical] = entry
    return entry


def get_tool(name: str) -> ToolEntry | None:
    """Return the registry entry for a tool name, or ``None``.

    The name is normalized with :func:`ai_bridge.policy.normalize_tool_name`,
    so dotted client aliases (``"shell.exec"``) resolve to their canonical
    tool (``"run_shell"``).
    """
    return TOOL_REGISTRY.get(normalize_tool_name(name))


def list_tools() -> list[ToolEntry]:
    """All registered tools, in registration order."""
    return list(TOOL_REGISTRY.values())


def tools_by_tier(tier: str) -> list[str]:
    """Names of all registered tools in the given tier.

    ``tier`` may be a tier-name string (``"SENSITIVE"``) or a
    :class:`~ai_bridge.policy.RiskTier` member; matching is by tier name.
    """
    wanted = _tier_name(tier)
    return [entry.name for entry in TOOL_REGISTRY.values() if entry.tier == wanted]


def get_tier(name: str) -> str | None:
    """Tier name (``"READ_ONLY"`` etc.) for a tool, or ``None`` if unlisted."""
    entry = get_tool(name)
    return entry.tier if entry is not None else None
