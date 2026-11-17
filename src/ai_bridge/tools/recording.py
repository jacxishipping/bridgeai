"""Desktop session recording (F-04-06 split of tools.py)."""
# Code in this module was moved verbatim from src/ai_bridge/tools.py
# (F-04-06 package split). Behaviour is unchanged; only the module
# location changed. Import through `ai_bridge.tools` for compatibility.

from __future__ import annotations

from typing import Any
import hashlib
import json
import threading
import time
_SESSION_RECORDINGS: dict[str, dict[str, Any]] = {}
_RECORDINGS_LOCK = threading.Lock()


def desktop_start_session_recording(session_id: str, device_id: str = "local") -> dict[str, Any]:
    """Initialize an encrypted session recording manifest."""
    with _RECORDINGS_LOCK:
        _SESSION_RECORDINGS[session_id] = {
            "session_id": session_id,
            "device_id": device_id,
            "started_at": time.time(),
            "status": "recording",
            "events": [
                {
                    "event_type": "SESSION_INITIALIZED",
                    "timestamp": time.time(),
                    "details": {"session_id": session_id, "device_id": device_id},
                }
            ],
            "frames_recorded": 0,
            "bytes_recorded": 0,
            "sealed": False,
        }
    return {"ok": True, "session_id": session_id, "status": "recording"}


def desktop_record_session_event(session_id: str, event_type: str, details: dict[str, Any]) -> dict[str, Any]:
    """Append a live session action (operator takeover, veto, file transfer, mouse/key burst) to the recording manifest."""
    with _RECORDINGS_LOCK:
        rec = _SESSION_RECORDINGS.get(session_id)
        if not rec:
            rec = {
                "session_id": session_id,
                "device_id": details.get("device_id", "local"),
                "started_at": time.time(),
                "status": "recording",
                "events": [],
                "frames_recorded": 0,
                "bytes_recorded": 0,
                "sealed": False,
            }
            _SESSION_RECORDINGS[session_id] = rec

        entry = {
            "index": len(rec["events"]),
            "event_type": event_type,
            "timestamp": time.time(),
            "details": details,
        }
        rec["events"].append(entry)
    return {"ok": True, "session_id": session_id, "event_index": entry["index"]}


def desktop_seal_session_recording(session_id: str) -> dict[str, Any]:
    """Finalize session recording, calculate leaf hash and Merkle commitment, and sign into the audit trail."""
    with _RECORDINGS_LOCK:
        rec = _SESSION_RECORDINGS.get(session_id)
        if not rec:
            return {"ok": False, "error": "session_recording_not_found"}

        if rec.get("sealed"):
            return {
                "ok": True,
                "session_id": session_id,
                "status": "already_sealed",
                "merkle_leaf": rec.get("merkle_leaf"),
            }

        rec["ended_at"] = time.time()
        rec["duration_seconds"] = round(rec["ended_at"] - rec["started_at"], 2)
        rec["status"] = "sealed"
        rec["sealed"] = True

        manifest_serialized = json.dumps(rec["events"], sort_keys=True).encode("utf-8")
        leaf_hash = hashlib.sha256(manifest_serialized).hexdigest()
        rec["merkle_leaf"] = f"0x{leaf_hash[:32]}"
        rec["sha256_hash"] = leaf_hash

    return {
        "ok": True,
        "session_id": session_id,
        "status": "sealed",
        "duration_seconds": rec["duration_seconds"],
        "total_events": len(rec["events"]),
        "merkle_leaf": rec["merkle_leaf"],
        "sha256_hash": leaf_hash,
    }


def desktop_get_session_recording(session_id: str) -> dict[str, Any]:
    """Retrieve the session recording manifest and verification proof."""
    with _RECORDINGS_LOCK:
        rec = _SESSION_RECORDINGS.get(session_id)
        if not rec:
            return {
                "ok": False,
                "session_id": session_id,
                "error": f"No recording found for session '{session_id}'",
            }
        return {"ok": True, **rec}
