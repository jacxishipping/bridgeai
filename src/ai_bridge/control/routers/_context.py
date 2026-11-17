"""Shared control-plane state for the domain routers (Wave 3B Track A).

``create_app()`` in ``ai_bridge.control.app`` builds one ``ControlContext``
from its locals (the DB connection, the resolved admin token, and the
helper closures the route handlers used to capture directly) and passes it
to each router factory. Router modules must not import ``control.app`` at
module top level for state — they receive everything through this object —
except for the module-level names (Pydantic models, ``make_quick_sig``,
``send_webhook_notification``) imported explicitly in each router file.

Fields mirror the ``create_app()`` locals by name so a moved handler body
can keep referring to ``conn``, ``require_role`` etc. after the factory
binds ``conn = ctx.conn`` and friends.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from fastapi import FastAPI


@dataclass
class ControlContext:
    """Everything a domain router needs from ``create_app()``."""

    app: FastAPI
    conn: Any  # control-plane DB connection (ai_bridge.control.db wrapper)
    token: str | None  # resolved admin token (feeds quick-approval HMAC)
    admin_token: str | None  # create_app() admin_token argument, as passed
    db_path: Any
    device_ttl_days: int
    backup_dir: Any
    notify_tasks: Callable[..., Any]
    get_webhook_url: Callable[[], str]
    get_public_base_url: Callable[..., str]
    _auth_context_full: Callable[..., Any]
    auth_context: Callable[..., Any]
    session_tenant_for_request: Callable[..., Any]
    resolve_request_tenant: Callable[..., Any]
    _row_tenant: Callable[..., Any]
    _require_row_tenant: Callable[..., Any]
    _require_device_tenant: Callable[..., Any]
    require_role: Callable[..., Any]
    require_admin: Callable[..., Any]
    get_current_policy: Callable[[], dict]
    get_effective_device_policy: Callable[..., dict]
    reject_policy_widening: Callable[..., Any]
    device_row: Callable[..., Any]
    _require_agent_mtls: Callable[..., Any]
    audit: Callable[..., Any]
    _install_asset: Callable[..., Any]
    _get_device_live_meta: Callable[..., dict]
    _get_devices_live_meta: Callable[..., dict]
    expire_pending_approvals: Callable[[], None]
    approval_detail: Callable[..., dict]
    _execute_workflow_step_sync: Callable[..., dict]
    _run_workflow_worker: Callable[..., Any]
    _evaluate_device_triggers: Callable[..., Any]
    _fetch_desktop_frame: Callable[..., dict]
    _webrtc_sessions: Callable[[], dict]
    _load_sess: Callable[..., Any]
    _save_sess: Callable[..., Any]
    _get_webrtc_session: Callable[..., dict]
    _queue_webrtc_task: Callable[..., Any]
    _remote_terminal_exec: Callable[..., dict]
    _load_alert_settings: Callable[[], dict]
    _record_alert_delivery: Callable[..., Any]
