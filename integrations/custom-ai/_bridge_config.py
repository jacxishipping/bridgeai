"""Shared configuration helpers for the AI Bridge example agents.

Single source of truth for two honesty rules that every example agent
in ``integrations/custom-ai/`` must follow:

1. The control-plane URL is a REQUIRED parameter. There is no default
   host: a copy-pasted example must never silently phone home to the
   operator's production server (former default ``https://jxiptvplayer.app``,
   finding I-01). Set ``AI_BRIDGE_URL`` (or ``AI_BRIDGE_CONTROL_URL``) to
   your own control plane, e.g. ``https://your-control-plane.example``.
2. Tool results must be reported honestly (finding I-04): a result whose
   ``status`` is ``needs_approval`` means the operation was QUEUED for
   human approval and has NOT run — it must never be summarised as done.
"""

from __future__ import annotations

import json
import os
import sys

# Statuses that mean "the operation did not run (yet)".
PENDING_STATUSES = frozenset({"needs_approval", "queued", "awaiting_approval", "pending_approval"})


def require_bridge_url() -> str:
    """Return the control-plane URL from the environment, or fail loudly.

    No default is provided on purpose. Exits with status 2 and a clear
    error message instead of silently contacting a default host.
    """
    url = (
        os.environ.get("AI_BRIDGE_URL")
        or os.environ.get("AI_BRIDGE_CONTROL_URL")
        or ""
    ).strip()
    if not url:
        print(
            "[!] AI_BRIDGE_URL is not set.\n"
            "    The control-plane URL is a required parameter — there is no default.\n"
            "    Set it to your own AI Bridge control plane, for example:\n"
            "        export AI_BRIDGE_URL=\"https://your-control-plane.example\"",
            file=sys.stderr,
        )
        sys.exit(2)
    return url.rstrip("/")


def describe_result(result) -> str:
    """Render a tool-execution result as an honest, model-readable string.

    Approval-gated results are labelled PENDING APPROVAL (not executed);
    denied/failed results are labelled as such. Returns a JSON string so
    it can be fed back into an LLM tool loop unchanged.
    """
    if not isinstance(result, dict):
        return json.dumps({"result": result})
    status = str(result.get("status") or "").lower()
    if status in PENDING_STATUSES:
        return json.dumps({
            **result,
            "honest_status": (
                "PENDING HUMAN APPROVAL — the operation has NOT been executed. "
                "It is queued under approval_id "
                f"{result.get('approval_id')!r}. Do NOT tell the user it succeeded; "
                "tell them it is awaiting approval."
            ),
        })
    if result.get("ok") is False or status in {"denied", "failed", "cancelled", "timed_out"}:
        return json.dumps({
            **result,
            "honest_status": f"NOT EXECUTED SUCCESSFULLY (status={status or 'failed'}).",
        })
    return json.dumps(result)


def is_pending_approval(result) -> bool:
    """True when a tool result means 'queued for approval, not executed'."""
    return isinstance(result, dict) and str(result.get("status") or "").lower() in PENDING_STATUSES
