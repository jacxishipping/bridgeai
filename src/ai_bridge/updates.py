"""Signed release verification and optional apply (Ed25519).

Workflow:
  1. Maintainer:  python -m ai_bridge.updates keygen --out-dir keys/
                  python -m ai_bridge.updates sign --private-key keys/private.pem
                         --manifest release.json   # signs {name, version, files[]}
  2. Agent:       python agents/windows/agent_main.py --check-update
                         --manifest-url https://example.com/release.json
                         --signature-url https://example.com/release.json.sig
                         --public-key keys/public.pem
     The agent verifies the signature BEFORE downloading any file, and
     refuses (non-zero exit) on a bad signature or a file-hash mismatch.
  3. Optional silent apply (Windows fleets): set AI_BRIDGE_ALLOW_AUTO_UPDATE=1 and
     pass --apply-update. Files download into a staging dir, hashes are re-checked,
     then staged into the install root. The agent does not restart itself.

Requires the `cryptography` package (a declared dependency).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


def _ed25519():
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
    except ImportError as exc:
        raise RuntimeError("Signed updates require the 'cryptography' package.") from exc
    return Ed25519PrivateKey, Ed25519PublicKey, serialization

def generate_keypair(out_dir: Path) -> tuple[Path, Path]:
    Ed25519PrivateKey, _, serialization = _ed25519()
    private = Ed25519PrivateKey.generate()
    out_dir.mkdir(parents=True, exist_ok=True)
    priv_path = out_dir / "private.pem"; pub_path = out_dir / "public.pem"
    priv_path.write_bytes(private.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    priv_path.chmod(0o600)
    pub_path.write_bytes(private.public_key().public_bytes(serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo))
    return priv_path, pub_path

def manifest_bytes(manifest: dict) -> bytes:
    return json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()

def sign_manifest(manifest: dict, private_key_path: Path) -> str:
    _, _, serialization = _ed25519()
    private = serialization.load_pem_private_key(Path(private_key_path).read_bytes(), password=None)
    return base64.b64encode(private.sign(manifest_bytes(manifest))).decode()

def verify_manifest(manifest: dict, signature_b64: str, public_key_path: Path) -> bool:
    _, _, serialization = _ed25519()
    public = serialization.load_pem_public_key(Path(public_key_path).read_bytes())
    try:
        public.verify(base64.b64decode(signature_b64), manifest_bytes(manifest))
        return True
    except Exception:
        return False

def hash_file(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def verify_file_hashes(manifest: dict, base_dir: Path) -> list[str]:
    """Return the list of files whose hash does NOT match the manifest."""
    bad = []
    for entry in manifest.get("files", []):
        p = base_dir / entry["path"]
        if not p.is_file() or hash_file(p) != entry.get("sha256"):
            bad.append(entry["path"])
    return bad


def auto_update_allowed() -> bool:
    return os.environ.get("AI_BRIDGE_ALLOW_AUTO_UPDATE", "").strip().lower() in ("1", "true", "yes")


# ---------------------------------------------------------------------------
# Signed fleet updates (R-P0-16 / P-13): pinned-git apply.
#
# The fleet path must never `git checkout origin/main`. A release is a
# manifest (JSON, must contain a full 40-hex ``commit`` SHA) signed with
# Ed25519; the signature is verified BEFORE any fetch/checkout, the pinned
# commit is checked out exactly, HEAD is verified against the pin, and the
# previous HEAD is recorded so a failed update can roll back.
# Configuration is three env vars (all required):
#   AI_BRIDGE_UPDATE_MANIFEST_PATH   - signed release manifest (JSON)
#   AI_BRIDGE_UPDATE_SIGNATURE_PATH  - base64 Ed25519 signature of the manifest
#   AI_BRIDGE_UPDATE_PUBLIC_KEY      - PEM public key that signed the manifest
# ---------------------------------------------------------------------------

UPDATE_MANIFEST_ENV = "AI_BRIDGE_UPDATE_MANIFEST_PATH"
UPDATE_SIGNATURE_ENV = "AI_BRIDGE_UPDATE_SIGNATURE_PATH"
UPDATE_PUBLIC_KEY_ENV = "AI_BRIDGE_UPDATE_PUBLIC_KEY"

_COMMIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def _rollback_path() -> Path:
    return Path.home() / ".ai-bridge" / "update-rollback.json"


def _resolve_update_paths(
    manifest_path: Path | str | None = None,
    signature_path: Path | str | None = None,
    public_key_path: Path | str | None = None,
) -> tuple[Path | None, Path | None, Path | None]:
    manifest = Path(manifest_path) if manifest_path else (
        Path(os.environ[UPDATE_MANIFEST_ENV]) if os.environ.get(UPDATE_MANIFEST_ENV) else None)
    signature = Path(signature_path) if signature_path else (
        Path(os.environ[UPDATE_SIGNATURE_ENV]) if os.environ.get(UPDATE_SIGNATURE_ENV) else None)
    public_key = Path(public_key_path) if public_key_path else (
        Path(os.environ[UPDATE_PUBLIC_KEY_ENV]) if os.environ.get(UPDATE_PUBLIC_KEY_ENV) else None)
    return manifest, signature, public_key


def signed_update_configured(
    manifest_path: Path | str | None = None,
    signature_path: Path | str | None = None,
    public_key_path: Path | str | None = None,
) -> bool:
    """True only if manifest + signature + public key are all set and exist."""
    manifest, signature, public_key = _resolve_update_paths(manifest_path, signature_path, public_key_path)
    return bool(
        manifest and signature and public_key
        and manifest.is_file() and signature.is_file() and public_key.is_file()
    )


def load_signed_manifest(
    manifest_path: Path | str | None = None,
    signature_path: Path | str | None = None,
    public_key_path: Path | str | None = None,
) -> tuple[dict, str]:
    """Read the manifest + signature and verify the Ed25519 signature.

    Verification happens here, BEFORE any fetch/download/checkout.
    Raises PermissionError if the update is not configured or the signature
    does not verify; FileNotFoundError if a configured file is missing.
    Returns ``(manifest, signature_b64)``.
    """
    manifest_p, signature_p, public_key_p = _resolve_update_paths(manifest_path, signature_path, public_key_path)
    if not manifest_p or not signature_p or not public_key_p:
        raise PermissionError(
            "Signed fleet update is not configured: set "
            f"{UPDATE_MANIFEST_ENV}, {UPDATE_SIGNATURE_ENV} and {UPDATE_PUBLIC_KEY_ENV}."
        )
    for label, p in (("manifest", manifest_p), ("signature", signature_p), ("public key", public_key_p)):
        if not p.is_file():
            raise FileNotFoundError(f"Signed update {label} file not found: {p}")
    manifest = json.loads(manifest_p.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError(f"Signed update manifest is not a JSON object: {manifest_p}")
    signature_b64 = signature_p.read_text(encoding="utf-8").strip()
    if not verify_manifest(manifest, signature_b64, public_key_p):
        raise PermissionError(
            f"Signed update manifest signature verification failed ({manifest_p}); update refused."
        )
    return manifest, signature_b64


def _git(repo_dir: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo_dir), *args],
        shell=False, capture_output=True, text=True, timeout=120,
    )


def apply_pinned_git_update(
    repo_dir: Path | str,
    manifest: dict,
    signature_b64: str,
    public_key_path: Path | str,
) -> dict:
    """Verify a signed manifest and check out exactly its pinned commit.

    Steps: (1) verify the manifest signature (refuse on tamper, before any
    git network/fetch); (2) require ``manifest["commit"]`` to be a full
    40-hex SHA; (3) record the current HEAD (commit + branch) as a rollback
    snapshot at ``~/.ai-bridge/update-rollback.json``; (4) fetch only if the
    pinned commit is not already present locally, then
    ``git checkout -f <pinned>`` (never ``origin/main``); (5) verify
    ``HEAD == pinned``. On any failure, check out the previous HEAD/branch
    (rollback) and re-raise the original error.
    """
    repo = Path(repo_dir)
    if not repo.is_dir():
        raise ValueError(f"Update repo directory does not exist: {repo}")
    public_key = Path(public_key_path)
    if not verify_manifest(manifest, signature_b64, public_key):
        raise PermissionError("Signed update manifest signature verification failed; update refused.")
    pinned = str(manifest.get("commit") or "").strip().lower()
    if not _COMMIT_SHA_RE.match(pinned):
        raise ValueError(
            "Signed update manifest has no valid pinned commit: "
            'manifest["commit"] must be a full 40-hex SHA.'
        )

    head = _git(repo, "rev-parse", "HEAD")
    if head.returncode != 0:
        raise ValueError(f"Cannot determine current HEAD in {repo}: {head.stderr.strip()}")
    previous_commit = head.stdout.strip()
    branch = _git(repo, "branch", "--show-current")
    previous_branch = branch.stdout.strip() if branch.returncode == 0 else ""
    rollback_file = _rollback_path()
    rollback_file.parent.mkdir(parents=True, exist_ok=True)
    rollback_file.write_text(json.dumps({
        "previous_commit": previous_commit,
        "previous_branch": previous_branch or None,
        "pinned_commit": pinned,
        "repo_dir": str(repo),
        "timestamp": time.time(),
    }, indent=2), encoding="utf-8")

    try:
        present = _git(repo, "cat-file", "-e", f"{pinned}^{{commit}}")
        if present.returncode != 0:
            fetched = _git(repo, "fetch", "origin")
            if fetched.returncode != 0:
                raise RuntimeError(f"git fetch origin failed: {fetched.stderr.strip()}")
            present = _git(repo, "cat-file", "-e", f"{pinned}^{{commit}}")
            if present.returncode != 0:
                raise ValueError(f"Pinned commit {pinned} is not available after fetching origin.")
        checked = _git(repo, "checkout", "-f", pinned)
        if checked.returncode != 0:
            raise RuntimeError(f"git checkout of pinned commit {pinned} failed: {checked.stderr.strip()}")
        new_head = _git(repo, "rev-parse", "HEAD")
        if new_head.returncode != 0 or new_head.stdout.strip() != pinned:
            raise RuntimeError(
                f"HEAD verification failed after checkout: HEAD={new_head.stdout.strip()!r}, pinned={pinned!r}."
            )
    except Exception:
        # Roll back to the recorded HEAD; never leave a half-applied update.
        try:
            target = previous_branch or previous_commit
            rolled = _git(repo, "checkout", "-f", target)
            if rolled.returncode != 0:
                raise RuntimeError(f"Rollback checkout of {target} failed: {rolled.stderr.strip()}")
        except Exception as rollback_exc:  # noqa: BLE001 - report both failures
            raise RuntimeError(
                f"Signed update to {pinned} failed and rollback to {previous_commit} also failed: {rollback_exc}"
            ) from rollback_exc
        raise
    return {
        "ok": True,
        "commit": pinned,
        "previous_commit": previous_commit,
        "previous_branch": previous_branch or None,
        "rollback_file": str(rollback_file),
    }


def _safe_manifest_path(root: Path, rel: str) -> Path:
    rel_clean = (rel or "").strip().replace("\\", "/")
    if not rel_clean or rel_clean.startswith("/") or ":" in rel_clean.split("/")[0]:
        raise ValueError(f"Unsafe manifest path: {rel!r}")
    root_res = root.resolve()
    target = (root_res / rel_clean).resolve()
    if not target.is_relative_to(root_res) or target == root_res:
        raise ValueError(f"Manifest path escapes target directory: {rel!r}")
    return target


def download_and_stage_update(
    manifest: dict,
    *,
    staging_dir: Path,
    install_dir: Path | None = None,
    apply: bool = False,
) -> dict:
    """Download manifest files into staging, verify hashes, optionally apply into install_dir.

    Each manifest file entry must include ``path``, ``sha256``, and ``url``.
    """
    staging_dir.mkdir(parents=True, exist_ok=True)
    downloaded: list[str] = []
    for entry in manifest.get("files", []):
        rel = entry.get("path")
        url = entry.get("url")
        expected = entry.get("sha256")
        if not rel or not url or not expected:
            raise ValueError(f"manifest file entry missing path/url/sha256: {entry}")
        dest = _safe_manifest_path(staging_dir, rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=60) as resp:
            dest.write_bytes(resp.read())
        if hash_file(dest) != expected:
            dest.unlink(missing_ok=True)
            raise ValueError(f"hash mismatch after download: {rel}")
        downloaded.append(rel)

    bad = verify_file_hashes(manifest, staging_dir)
    if bad:
        raise ValueError(f"staging hash verification failed: {bad}")

    applied: list[str] = []
    if apply:
        if not auto_update_allowed():
            raise PermissionError(
                "Silent apply refused: set AI_BRIDGE_ALLOW_AUTO_UPDATE=1 to enable."
            )
        if install_dir is None:
            raise ValueError("install_dir is required when apply=True")
        install_dir.mkdir(parents=True, exist_ok=True)
        for rel in downloaded:
            src = _safe_manifest_path(staging_dir, rel)
            dst = _safe_manifest_path(install_dir, rel)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            applied.append(rel)

    return {
        "ok": True,
        "version": manifest.get("version"),
        "downloaded": downloaded,
        "applied": applied,
        "staging_dir": str(staging_dir),
        "install_dir": str(install_dir) if install_dir else "",
    }

def main(argv: list[str] | None = None) -> int:
    import argparse
    parser = argparse.ArgumentParser(prog="ai-bridge-updates")
    sub = parser.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("keygen"); k.add_argument("--out-dir", required=True)
    s = sub.add_parser("sign"); s.add_argument("--private-key", required=True); s.add_argument("--manifest", required=True)
    v = sub.add_parser("verify"); v.add_argument("--public-key", required=True); v.add_argument("--manifest", required=True); v.add_argument("--signature", required=True)
    args = parser.parse_args(argv)
    if args.cmd == "keygen":
        priv, pub = generate_keypair(Path(args.out_dir)); print(f"private: {priv}\npublic: {pub}")
    elif args.cmd == "sign":
        manifest = json.loads(Path(args.manifest).read_text())
        print(sign_manifest(manifest, Path(args.private_key)))
    elif args.cmd == "verify":
        manifest = json.loads(Path(args.manifest).read_text())
        ok = verify_manifest(manifest, Path(args.signature).read_text().strip(), Path(args.public_key))
        print("verified" if ok else "SIGNATURE INVALID"); return 0 if ok else 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
