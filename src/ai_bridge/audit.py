"""Structured, append-only audit logging. Secrets are redacted before write."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from .security import redact, redact_obj


def audit_event(log_path: Path, *, actor: str, device_id: str, tool: str,
                arguments: dict, decision: str, result: str = "", tenant: str = "default") -> dict:
    safe_args = redact_obj(json.loads(json.dumps(arguments, default=str)))
    event = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tenant": tenant, "actor": actor, "device_id": device_id,
        "tool": tool, "arguments": safe_args,
        "decision": decision, "result": redact(result)[:2000],
    }
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(event) + "\n")
        fh.flush()
        # Wave 1C (F-04-21): fsync so an audit record is durable once
        # written; a crash must not silently lose the most recent events.
        os.fsync(fh.fileno())
    return event
