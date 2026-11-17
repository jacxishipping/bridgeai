"""Policy simulation, demo-mode flag, and signed-update gate (Wave 3C).

FR-01 — Policy simulation ("what would this call do?").
    A dry-run over :func:`ai_bridge.policy.decide` for a hypothetical
    tool + policy + actor. It NEVER executes anything: it calls ``decide()``
    directly and never touches ``dispatch()``, the task queue, or any tool
    implementation. There is deliberately NO control-plane endpoint here;
    wiring an HTTP endpoint is a Wave 4 follow-up (see
    ``analysis/wave3c-mcp-progress.md``).

FR-05 — Explicit demo-mode backend flag. The dashboard is out of scope
for this track, but the backend can now state explicitly whether it is
running in demo mode instead of letting callers infer it from seeded
data. ``is_demo_mode()`` reads only the explicit opt-in env vars
``AI_BRIDGE_DEMO_MODE`` / ``AI_BRIDGE_DEMO`` (``1``/``true``/``yes``);
anything else is live mode. Demo mode is never the default.

F-04-20 — Signed-update gate. No file in this track's scope contains an
update path (verified by grep: no ``git checkout``/fetch, no
download-and-apply, no ``update_fleet_agent`` in ``client.py``,
``terminal_manager.py``, ``browser_tools.py``, ``browser_isolation_os.py``,
``control/mcp_client.py``, ``vision.py`` or this module). Any future
update path in these files MUST call :func:`require_signed_update`
first: it verifies the Ed25519 manifest signature via
``ai_bridge.updates.load_signed_manifest`` BEFORE any fetch/download/
checkout, and raises (refuses) when the update is unconfigured or the
signature does not verify. Unsigned updates are refused, never applied.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .policy import Policy, RiskTier, decide


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# FR-05 — explicit demo-mode flag
# ---------------------------------------------------------------------------

def is_demo_mode() -> dict[str, Any]:
    """Report demo mode explicitly.

    Returns ``{"demo_mode": bool, "source": str, "explicit": bool}``.
    ``source`` names the env var that enabled it, or ``"default"`` when
    demo mode is off (demo is never the default).
    """
    for var in ("AI_BRIDGE_DEMO_MODE", "AI_BRIDGE_DEMO"):
        if _truthy(os.environ.get(var)):
            return {"demo_mode": True, "source": var, "explicit": True}
    return {"demo_mode": False, "source": "default", "explicit": False}


def demo_mode_enabled() -> bool:
    """Boolean form of :func:`is_demo_mode`."""
    return bool(is_demo_mode()["demo_mode"])


# ---------------------------------------------------------------------------
# FR-01 — policy simulation (dry-run only, never executes)
# ---------------------------------------------------------------------------

def _rule_fired(policy: Policy, tool: str, tier: RiskTier | None,
                allowed: bool, needs_approval: bool, reason: str) -> str:
    """Name the rule that decided the outcome, for operator readability."""
    if tier is None:
        return "unknown_tool_deny"
    if tool in policy.denied_tools:
        return "denied_tools"
    if policy.allowed_tools is not None and tool not in policy.allowed_tools:
        return "allowed_tools"
    if tier == RiskTier.HIGH_RISK:
        return "tier4_requires_approval_and_admin" if not allowed else "tier4_approved"
    if getattr(policy, "unrestricted", False) and getattr(policy, "unrestricted_granted_by", None):
        return "unrestricted_granted_bypass"
    if tier == RiskTier.SENSITIVE and not allowed:
        return "tier3_requires_allow_tier3_or_approval"
    if tier == RiskTier.LOW_RISK and not allowed:
        return "tier2_requires_allow_writes"
    if allowed and needs_approval:
        return "approval_required"
    return "allowed"


def simulate_policy_decision(
    tool: str,
    policy: Policy | None = None,
    *,
    actor: str | None = None,
    device_id: str | None = None,
    approval_granted: bool = False,
    is_admin: bool = False,
    device_revoked: bool = False,
) -> dict[str, Any]:
    """Dry-run ``decide()`` for a hypothetical call. Executes NOTHING.

    Args:
        tool: tool name as the caller would pass it (e.g. ``"run_shell"``).
        policy: the hypothetical policy to test; defaults to ``Policy()``.
        actor: opaque actor label recorded in the simulation output only.
        device_id: opaque device label recorded in the output only.
        approval_granted / is_admin / device_revoked: inputs to ``decide()``.

    Returns a plain dict: tool, tier (int or None), allowed, needs_approval,
    reason, rule, actor, device_id. The ``rule`` names the policy rule that
    fired so an operator can see *why* without reading policy.py.
    """
    eff_policy = policy if policy is not None else Policy()
    decision = decide(
        eff_policy, tool,
        approval_granted=approval_granted,
        is_admin=is_admin,
        device_revoked=device_revoked,
    )
    tier = eff_policy.tier_of(tool)
    return {
        "tool": tool,
        "tier": int(tier) if tier is not None else None,
        "tier_name": tier.name if tier is not None else None,
        "allowed": bool(decision.allowed),
        "needs_approval": bool(decision.needs_approval),
        "reason": decision.reason,
        "rule": _rule_fired(eff_policy, tool, tier, bool(decision.allowed),
                            bool(decision.needs_approval), decision.reason),
        "actor": actor,
        "device_id": device_id,
        "approval_granted": bool(approval_granted),
        "is_admin": bool(is_admin),
        "executed": False,  # simulation never executes
    }


def simulate_tool_call(
    tool: str,
    policy: Policy | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Alias of :func:`simulate_policy_decision` for call-site readability."""
    return simulate_policy_decision(tool, policy, **kwargs)


def simulate_batch(
    calls: list[dict[str, Any]],
    policy: Policy | None = None,
) -> list[dict[str, Any]]:
    """Dry-run a list of hypothetical calls against one policy.

    Each entry is ``{"tool": ..., "actor": ..., "device_id": ...,
    "approval_granted": ..., "is_admin": ..., "device_revoked": ...}``.
    Returns one simulation dict per entry, in order. Executes nothing.
    """
    results: list[dict[str, Any]] = []
    for call in calls:
        if not isinstance(call, dict) or not call.get("tool"):
            results.append({"tool": call.get("tool") if isinstance(call, dict) else None,
                            "allowed": False, "needs_approval": False,
                            "reason": "Simulation entry is missing a tool name.",
                            "rule": "invalid_simulation_entry", "executed": False})
            continue
        results.append(simulate_policy_decision(
            str(call["tool"]), policy,
            actor=call.get("actor"),
            device_id=call.get("device_id"),
            approval_granted=bool(call.get("approval_granted", False)),
            is_admin=bool(call.get("is_admin", False)),
            device_revoked=bool(call.get("device_revoked", False)),
        ))
    return results


# ---------------------------------------------------------------------------
# F-04-20 — signed-update gate (refuse unsigned, never proceed)
# ---------------------------------------------------------------------------

def require_signed_update(
    manifest_path: Path | str | None = None,
    signature_path: Path | str | None = None,
    public_key_path: Path | str | None = None,
) -> dict[str, Any]:
    """Verify a signed release manifest BEFORE any update is applied.

    Delegates to ``ai_bridge.updates.load_signed_manifest`` (read-only
    reuse — the helpers live in ``updates.py`` and are not duplicated
    here). Raises :class:`PermissionError` when the update is not
    configured or the Ed25519 signature does not verify, and
    :class:`FileNotFoundError` when a configured file is missing. Any
    update path in this track's files must call this first and refuse
    on any exception; proceeding unsigned is never allowed.

    Returns ``{"ok": True, "manifest": ..., "version": ...}`` on success.
    """
    from .updates import load_signed_manifest

    manifest, _signature_b64 = load_signed_manifest(
        manifest_path, signature_path, public_key_path
    )
    return {"ok": True, "manifest": manifest, "version": manifest.get("version")}
