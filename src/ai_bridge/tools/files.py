"""Workspace-confined file reads and writes (F-04-06 split of tools.py)."""
# Code in this module was moved verbatim from src/ai_bridge/tools.py
# (F-04-06 package split). Behaviour is unchanged; only the module
# location changed. Import through `ai_bridge.tools` for compatibility.

from __future__ import annotations

import os
from pathlib import Path

from ..policy import Policy
from ..security import is_secret_name, redact, workspace_root
from ._common import _check


def _host_file_access_allowed(is_admin: bool, policy: Policy | None) -> bool:
    if is_admin or (policy and policy.unrestricted):
        return True
    return os.environ.get("AI_BRIDGE_DISABLE_HOST_TOOLS", "1") == "0"


def _confine_file_path(path: str, *, is_admin: bool = False, policy: Policy | None = None) -> Path:
    """Workspace paths are always allowed; anything else needs explicit host access."""
    target = Path(path).expanduser()
    try:
        resolved = target.resolve()
    except OSError:
        resolved = target.absolute()
    root = workspace_root()
    if resolved == root or root in resolved.parents:
        return target
    if _host_file_access_allowed(is_admin, policy):
        return target
    raise PermissionError(
        "Path is outside the configured workspace and host file access is disabled "
        "(set AI_BRIDGE_DISABLE_HOST_TOOLS=0 or use an unrestricted policy)."
    )


def read_file(path: str, max_chars: int = 100000, *, is_admin: bool = False, policy: Policy | None = None) -> str:
    """Read a UTF-8 text file, confined to the workspace unless host access is enabled."""

    _check("read_file", policy=policy)
    target = _confine_file_path(path, is_admin=is_admin, policy=policy)
    if is_secret_name(target):
        raise ValueError("Refusing to read a file whose name suggests it holds secrets.")
    try:
        text = target.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("not a UTF-8 text file")
    text = redact(text)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n[truncated]"
    return text


def write_file(path: str, content: str, overwrite: bool = False, *, approval_granted: bool = False, is_admin: bool = False, policy: Policy | None = None) -> dict:
    """Write content to an absolute path."""

    _check("write_file", approval_granted=approval_granted, is_admin=is_admin, policy=policy)
    target = _confine_file_path(path, is_admin=is_admin, policy=policy)
    if is_secret_name(target):
        raise ValueError("Refusing to write a file whose name suggests it holds secrets.")
    if target.exists() and not overwrite:
        raise ValueError("file exists; pass overwrite=true to replace it")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {"path": str(target), "bytes": len(content.encode("utf-8"))}
