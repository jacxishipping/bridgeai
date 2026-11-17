"""Chunked file transfers to/from desktops (F-04-06 split of tools.py)."""
# Code in this module was moved verbatim from src/ai_bridge/tools.py
# (F-04-06 package split). Behaviour is unchanged; only the module
# location changed. Import through `ai_bridge.tools` for compatibility.

from __future__ import annotations

from pathlib import Path
from typing import Any
import base64
import hashlib
import os
import shutil
import threading
import time

from ..security import workspace_root
_ACTIVE_TRANSFERS: dict[str, dict[str, Any]] = {}
_TRANSFERS_LOCK = threading.Lock()


def get_transfer_storage_dir() -> Path:
    """Ensure safe root directory for incoming and outgoing file transfers."""
    base = Path(os.environ.get("AI_BRIDGE_TRANSFERS_DIR", workspace_root() / "transfers"))
    base.mkdir(parents=True, exist_ok=True)
    return base


def get_transfer_quarantine_dir() -> Path:
    """Quarantine root for completed inbound transfers pending operator review."""
    q = get_transfer_storage_dir() / "quarantine"
    q.mkdir(parents=True, exist_ok=True)
    return q


def max_transfer_bytes() -> int:
    """Hard cap for inbound transfers (default 512 MiB)."""
    raw = os.environ.get("AI_BRIDGE_MAX_TRANSFER_BYTES", str(512 * 1024 * 1024)).strip()
    try:
        return max(1024, int(raw))
    except ValueError:
        return 512 * 1024 * 1024


def desktop_handle_file_start(
    transfer_id: str,
    name: str,
    size: int,
    total_chunks: int,
    target_dir: str = "",
) -> dict[str, Any]:
    """Initialize an incoming chunked file transfer over WebRTC or REST."""
    clean_name = Path(name).name
    if not clean_name:
        clean_name = f"transfer_{int(time.time())}.bin"

    limit = max_transfer_bytes()
    if size and int(size) > limit:
        return {
            "ok": False,
            "error": "file_too_large",
            "max_bytes": limit,
            "requested_bytes": int(size),
        }

    storage_root = get_transfer_storage_dir()
    # Default inbound path is quarantine; explicit downloads/workspace still allowed.
    if target_dir and target_dir.lower() in ("downloads", "workspace"):
        target_path = storage_root / target_dir.lower()
        target_path.mkdir(parents=True, exist_ok=True)
    else:
        target_path = get_transfer_quarantine_dir()

    final_path = target_path / clean_name
    temp_path = storage_root / f".{transfer_id}.part"

    with _TRANSFERS_LOCK:
        # Resume: keep existing part file + chunk map when the same transfer_id returns.
        existing = _ACTIVE_TRANSFERS.get(transfer_id)
        if existing and existing.get("status") == "in_progress" and Path(existing["temp_path"]).exists():
            return {
                "ok": True,
                "transfer_id": transfer_id,
                "filename": existing["filename"],
                "target_path": existing["final_path"],
                "status": "resume",
                "received_chunks": existing.get("received_chunks", 0),
                "received_indexes": sorted(int(k) for k in existing.get("chunks_map", {}).keys()),
            }
        _ACTIVE_TRANSFERS[transfer_id] = {
            "transfer_id": transfer_id,
            "filename": clean_name,
            "expected_size": size,
            "total_chunks": total_chunks,
            "received_chunks": 0,
            "chunks_map": {},
            "temp_path": str(temp_path),
            "final_path": str(final_path),
            "started_at": time.time(),
            "status": "in_progress",
            "quarantined": target_path == get_transfer_quarantine_dir(),
            "max_bytes": limit,
        }

    # Truncate / create empty temp part file
    try:
        temp_path.write_bytes(b"")
    except Exception as exc:
        return {"ok": False, "error": f"Failed to initialize transfer file: {exc}"}

    return {
        "ok": True,
        "transfer_id": transfer_id,
        "filename": clean_name,
        "target_path": str(final_path),
        "status": "ready_for_chunks",
        "quarantined": target_path == get_transfer_quarantine_dir(),
        "max_bytes": limit,
    }


def desktop_handle_file_chunk(
    transfer_id: str,
    chunk_index: int,
    chunk_b64: str,
) -> dict[str, Any]:
    """Append a decoded binary chunk to the in-progress transfer file."""
    with _TRANSFERS_LOCK:
        info = _ACTIVE_TRANSFERS.get(transfer_id)
        if not info:
            return {"ok": False, "error": f"Unknown transfer_id: {transfer_id}"}
        temp_path = Path(info["temp_path"])

    try:
        raw_bytes = base64.b64decode(chunk_b64)
    except Exception as exc:
        return {"ok": False, "error": f"Base64 decode failed for chunk {chunk_index}: {exc}"}

    with _TRANSFERS_LOCK:
        # Idempotent resume: skip duplicate chunk indexes already stored.
        if chunk_index in info.get("chunks_map", {}):
            curr_bytes = temp_path.stat().st_size if temp_path.exists() else 0
            return {
                "ok": True,
                "transfer_id": transfer_id,
                "chunk_index": chunk_index,
                "received_chunks": info["received_chunks"],
                "total_chunks": info["total_chunks"],
                "received_bytes": curr_bytes,
                "expected_bytes": info["expected_size"],
                "percent": round((info["received_chunks"] / max(1, info["total_chunks"])) * 100, 1),
                "resumed_skip": True,
            }
        total_chunks = int(info.get("total_chunks") or 0)
        if chunk_index < 0 or (total_chunks > 0 and chunk_index >= total_chunks):
            return {"ok": False, "error": "invalid_chunk_index", "chunk_index": chunk_index, "total_chunks": total_chunks}
        expected_idx = int(info.get("received_chunks") or 0)
        if chunk_index != expected_idx:
            return {"ok": False, "error": "out_of_order_chunk", "chunk_index": chunk_index, "expected_chunk_index": expected_idx}
        limit = int(info.get("max_bytes") or max_transfer_bytes())
        curr = temp_path.stat().st_size if temp_path.exists() else 0
        if curr + len(raw_bytes) > limit:
            return {"ok": False, "error": "file_too_large", "max_bytes": limit}

        try:
            with open(temp_path, "ab") as f:
                f.write(raw_bytes)
        except Exception as exc:
            return {"ok": False, "error": f"Failed writing chunk {chunk_index}: {exc}"}

        info["received_chunks"] += 1
        info["chunks_map"][chunk_index] = len(raw_bytes)
        rec_chunks = info["received_chunks"]
        total = info["total_chunks"]
        exp_size = info["expected_size"]
        curr_bytes = temp_path.stat().st_size if temp_path.exists() else 0

    pct = round((rec_chunks / max(1, total)) * 100, 1)
    return {
        "ok": True,
        "transfer_id": transfer_id,
        "chunk_index": chunk_index,
        "received_chunks": rec_chunks,
        "total_chunks": total,
        "received_bytes": curr_bytes,
        "expected_bytes": exp_size,
        "percent": pct,
    }


def desktop_handle_file_end(
    transfer_id: str,
    expected_sha256: str = "",
) -> dict[str, Any]:
    """Finalize file assembly, verify SHA-256 hash, and atomically move into target location."""
    with _TRANSFERS_LOCK:
        info = _ACTIVE_TRANSFERS.get(transfer_id)
        if not info:
            return {"ok": False, "error": f"Unknown transfer_id: {transfer_id}"}

    temp_path = Path(info["temp_path"])
    final_path = Path(info["final_path"])

    if not temp_path.exists():
        return {"ok": False, "error": f"Temp file missing for transfer {transfer_id}"}

    # Verify sha256
    hasher = hashlib.sha256()
    with open(temp_path, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    actual_hash = hasher.hexdigest()

    if expected_sha256 and expected_sha256.lower() != actual_hash.lower():
        try:
            temp_path.unlink()
        except Exception:
            pass
        return {
            "ok": False,
            "error": "sha256_mismatch",
            "expected": expected_sha256,
            "actual": actual_hash,
        }

    # Atomic move
    try:
        if final_path.exists():
            final_path.unlink()
        temp_path.rename(final_path)
    except Exception as exc:
        # Fallback copy
        try:
            shutil.copy2(temp_path, final_path)
            temp_path.unlink()
        except Exception as exc2:
            return {"ok": False, "error": f"Failed moving assembled file: {exc2}"}

    file_size = final_path.stat().st_size
    duration = max(0.001, time.time() - info["started_at"])
    speed_kbps = round((file_size / 1024.0) / duration, 2)

    with _TRANSFERS_LOCK:
        info["status"] = "completed"
        info["actual_sha256"] = actual_hash
        info["file_size"] = file_size
        info["speed_kbps"] = speed_kbps

    return {
        "ok": True,
        "transfer_id": transfer_id,
        "filename": info["filename"],
        "saved_path": str(final_path),
        "file_size": file_size,
        "sha256": actual_hash,
        "duration_seconds": round(duration, 2),
        "speed_kbps": speed_kbps,
        "status": "completed",
    }


def desktop_list_transfers() -> list[dict[str, Any]]:
    """List all transferred files available on host storage."""
    root = get_transfer_storage_dir()
    items = []
    try:
        for p in root.rglob("*"):
            if p.is_file() and not p.name.startswith("."):
                stat = p.stat()
                items.append({
                    "name": p.name,
                    "relative_path": str(p.relative_to(root)).replace("\\", "/"),
                    "full_path": str(p),
                    "size_bytes": stat.st_size,
                    "modified_at": stat.st_mtime,
                })
    except Exception:
        pass
    items.sort(key=lambda x: x["modified_at"], reverse=True)
    return items


def desktop_prepare_file_download(path_or_name: str) -> dict[str, Any]:
    """Read a file on host and compute its chunk metadata for streaming down to client."""
    root = get_transfer_storage_dir()
    clean = Path(path_or_name).name
    target = root / clean
    if not target.exists():
        for candidate in (
            get_transfer_quarantine_dir() / clean,
            root / "downloads" / clean,
            root / "workspace" / clean,
        ):
            if candidate.exists() and candidate.is_file():
                target = candidate
                break
    if not target.exists():
        # Try direct path within workspace
        target = Path(path_or_name)
        if not target.is_absolute():
            target = workspace_root() / path_or_name

    if not target.exists() or not target.is_file():
        return {"ok": False, "error": "file_not_found", "path": str(path_or_name)}

    # Security check: must not escape allowed roots
    try:
        resolved = target.resolve()
        is_safe = False
        for safe_root in (root.resolve(), workspace_root().resolve()):
            try:
                resolved.relative_to(safe_root)
                is_safe = True
                break
            except ValueError:
                continue
        if not is_safe:
            return {"ok": False, "error": "access_denied_path_traversal"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    file_size = target.stat().st_size
    chunk_size = 64 * 1024  # 64 KB
    total_chunks = max(1, (file_size + chunk_size - 1) // chunk_size)

    hasher = hashlib.sha256()
    with open(target, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    sha256 = hasher.hexdigest()

    return {
        "ok": True,
        "name": target.name,
        "path": str(target),
        "size": file_size,
        "chunk_size": chunk_size,
        "total_chunks": total_chunks,
        "sha256": sha256,
    }
