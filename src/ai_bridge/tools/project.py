"""Workspace project tools: backups, staging deploys, tests, lint (F-04-06 split of tools.py)."""
# Code in this module was moved verbatim from src/ai_bridge/tools.py
# (F-04-06 package split). Behaviour is unchanged; only the module
# location changed. Import through `ai_bridge.tools` for compatibility.

from __future__ import annotations

import shutil
import time
import uuid
import zipfile

from ..execution import RUNNER
from ..policy import Policy
from ..security import confined_path, is_secret_name, workspace_root
from ._common import _check, default_policy


def _is_safe_workspace_file(p, root) -> bool:
    if ".ai-bridge-backups" in p.parts or p.is_symlink() or not p.is_file() or is_secret_name(p):
        return False
    try:
        resolved = p.resolve()
    except OSError:
        return False
    return resolved == root or root in resolved.parents


def create_backup(relative_directory: str = ".", *, approval_granted: bool = False, policy: Policy | None = None) -> dict:
    _check("create_backup", approval_granted=approval_granted, policy=policy)
    src = confined_path(relative_directory)
    if not src.is_dir():
        raise ValueError("Directory does not exist inside the workspace.")
    root = workspace_root()
    out_dir = root / ".ai-bridge-backups"; out_dir.mkdir(parents=True, exist_ok=True)
    name = f"backup-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.zip"
    dest = out_dir / name
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(src.rglob("*")):
            if not _is_safe_workspace_file(p, root):
                continue
            try:
                zf.write(p, p.relative_to(src))
            except OSError:
                continue
    return {"backup": str(dest.relative_to(root)), "size_bytes": dest.stat().st_size}

def deploy_application(project_directory: str = ".", target_directory: str = "deploy-staging", *, approval_granted: bool = False, policy: Policy | None = None) -> dict:
    """Staging-only deploy inside the workspace: backup, then copy.
    Production deploys are Tier 4 and must go through the control-plane
    approval queue (docs/security.md); this tool never deploys to prod."""
    _check("deploy_application", approval_granted=approval_granted, policy=policy)
    backup = create_backup(project_directory, approval_granted=approval_granted, policy=policy)
    src = confined_path(project_directory); dst = confined_path(target_directory)
    if dst.resolve() == src.resolve():
        raise ValueError("Target must differ from the project directory.")
    root = workspace_root()
    dst.mkdir(parents=True, exist_ok=True)
    copied = 0
    for p in sorted(src.rglob("*")):
        if not _is_safe_workspace_file(p, root):
            continue
        if dst == p or dst in p.parents:
            continue
        rel = p.relative_to(src); out = dst / rel
        out.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(p, out); copied += 1
    return {"backup": backup["backup"], "target": target_directory, "files_copied": copied,
            "note": "Staging deploy inside the workspace only."}

def run_project_tests(test_command: str = "pytest", timeout: int = 120, *, policy: Policy | None = None) -> dict:
    eff_policy = policy or default_policy()
    _check("run_project_tests", policy=eff_policy)
    result = RUNNER.submit("run_project_tests", timeout=timeout, test_command=test_command,
                           allowed_test_commands=eff_policy.allowed_test_commands)
    deadline = time.time() + min(timeout, 300) + 5
    while time.time() < deadline and result.status in {"pending", "running"}:
        time.sleep(0.2)
    return {"task_id": result.task_id, "status": result.status, "output": result.output[:8000]}

def run_linter(timeout: int = 60) -> dict:
    _check("run_linter")
    result = RUNNER.submit("run_linter", timeout=timeout)
    deadline = time.time() + timeout + 5
    while time.time() < deadline and result.status in {"pending", "running"}:
        time.sleep(0.2)
    return {"task_id": result.task_id, "status": result.status, "output": result.output[:8000]}
