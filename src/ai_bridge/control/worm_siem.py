"""External WORM / SIEM audit sink (append-only export hook).

Set ``AI_BRIDGE_WORM_SIEM_URL`` to a collector that accepts POST JSON.
Optional HMAC with ``AI_BRIDGE_WORM_SIEM_HMAC_SECRET``. Failures are logged and
surfaced on the production checklist as warnings (or critical when
``AI_BRIDGE_WORM_SIEM_REQUIRED=1``).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.parse
from typing import Any

from ..security import validate_outbound_url


def worm_siem_url() -> str:
    return (os.environ.get("AI_BRIDGE_WORM_SIEM_URL") or "").strip()


def worm_siem_required() -> bool:
    return os.environ.get("AI_BRIDGE_WORM_SIEM_REQUIRED", "").strip().lower() in ("1", "true", "yes")


def describe_worm_siem() -> dict[str, Any]:
    return {
        "configured": bool(worm_siem_url()),
        "required": worm_siem_required(),
        "url_set": bool(worm_siem_url()),
    }


def _sign(body: bytes) -> str | None:
    secret = (os.environ.get("AI_BRIDGE_WORM_SIEM_HMAC_SECRET") or "").encode("utf-8")
    if not secret:
        return None
    return hmac.new(secret, body, hashlib.sha256).hexdigest()


def emit_audit_event(event: dict[str, Any], *, timeout: float = 5.0) -> dict[str, Any]:
    """POST one audit event to the WORM/SIEM endpoint. Returns transport result.

    F-05-17 / SEC-11 (SSRF): the URL is validated (DNS resolution +
    rejection of private/loopback/link-local/reserved/metadata IPs)
    BEFORE connecting. Redirects are never followed automatically;
    each redirect target is re-validated the same way, max 3 hops.
    """
    url = worm_siem_url()
    if not url:
        return {"ok": False, "skipped": True, "reason": "AI_BRIDGE_WORM_SIEM_URL unset"}
    try:
        target = validate_outbound_url(url)
    except ValueError as exc:
        if worm_siem_required():
            raise
        return {"ok": False, "skipped": False, "error": f"SSRF validation failed: {exc}"}
    payload = {
        "schema": "ai-bridge.audit.v1",
        "ts": time.time(),
        "event": event,
    }
    body = json.dumps(payload, default=str, separators=(",", ":")).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    sig = _sign(body)
    if sig:
        headers["X-AI-Bridge-Signature"] = sig
    try:
        import httpx

        res = httpx.post(target, content=body, headers=headers, timeout=timeout, follow_redirects=False)
        hops = 0
        while res.status_code in (301, 302, 303, 307, 308) and hops < 3:
            hdrs = getattr(res, "headers", None) or {}
            location = hdrs.get("location") if hasattr(hdrs, "get") else None
            if not location:
                break
            next_url = urllib.parse.urljoin(target, location)
            try:
                target = validate_outbound_url(next_url)
            except ValueError as exc:
                if worm_siem_required():
                    raise
                return {"ok": False, "skipped": False, "error": f"SSRF validation failed on redirect: {exc}"}
            hops += 1
            res = httpx.post(target, content=body, headers=headers, timeout=timeout, follow_redirects=False)
        if hops >= 3 and res.status_code in (301, 302, 303, 307, 308):
            err = "SIEM endpoint exceeded max redirects (3)"
            if worm_siem_required():
                raise ValueError(err)
            return {"ok": False, "skipped": False, "error": err}
        ok = res.status_code < 300
        return {"ok": ok, "status_code": res.status_code, "skipped": False}
    except Exception as exc:
        if worm_siem_required():
            raise
        return {"ok": False, "skipped": False, "error": str(exc)}
