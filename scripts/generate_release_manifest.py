#!/usr/bin/env python3
"""Generate a signed-release manifest for an AI Bridge checkout.

A release manifest pins one commit and lists the release payload files
with their SHA-256 hashes and download URLs::

    {"name": "ai-bridge", "version": "0.3.0", "commit": "<40-hex SHA>",
     "files": [{"path": "src/ai_bridge/updates.py",
                "sha256": "<hex>", "url": "<base-url>/src/ai_bridge/updates.py"},
               ...]}

Usage:
    python scripts/generate_release_manifest.py \
        --repo . --version 0.3.0 \
        --base-url https://example.com/releases/0.3.0/ \
        --include 'src/**' --include 'agents/**' \
        --out release.json

The manifest itself is UNSIGNED output. It becomes a release only when
signed with the release Ed25519 key::

    python -m ai_bridge.updates sign --private-key keys/private.pem \
        --manifest release.json

``ai_bridge.updates`` verifies that signature BEFORE any fetch or
checkout, and refuses on tamper or on a file-hash mismatch. See
``scripts/release_manifest_dryrun.py`` for the full end-to-end dry run
with a throwaway test keypair (nothing is published or deployed).

``--base-url`` is required: the manifest must say where each file is
downloaded from. For a dry run it may be a ``file://`` URL pointing at
the release checkout; for a real release it is the HTTPS release host.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed in {repo}: {proc.stderr.strip()}")
    return proc.stdout.strip()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _matches(rel_posix: str, patterns: list[str]) -> bool:
    # fnmatch with ** support: pathlib's match handles **, and fnmatch
    # covers plain globs. A pattern without a slash matches any depth.
    for pattern in patterns:
        if "/" not in pattern:
            if fnmatch.fnmatch(rel_posix.split("/")[-1], pattern):
                return True
        if fnmatch.fnmatch(rel_posix, pattern):
            return True
        if Path(rel_posix).match(pattern):
            return True
    return False


def build_manifest(
    repo: Path,
    *,
    name: str,
    version: str,
    base_url: str,
    includes: list[str],
) -> dict:
    """Build the manifest dict for ``repo`` at its current HEAD."""
    if not (repo / ".git").exists():
        raise ValueError(f"not a git checkout: {repo}")
    commit = _git(repo, "rev-parse", "HEAD")
    if len(commit) != 40 or not all(c in "0123456789abcdef" for c in commit.lower()):
        raise ValueError(f"HEAD is not a full 40-hex SHA: {commit!r}")
    tracked = _git(repo, "ls-files").splitlines()
    base = base_url.rstrip("/")
    files = []
    for rel in tracked:
        if includes and not _matches(rel, includes):
            continue
        full = repo / rel
        if not full.is_file():
            continue
        files.append({
            "path": rel,
            "sha256": _sha256_file(full),
            "url": f"{base}/{rel}",
        })
    files.sort(key=lambda entry: entry["path"])
    return {"name": name, "version": version, "commit": commit, "files": files}


def _version_from_pyproject(repo: Path) -> str:
    try:
        import tomllib

        data = tomllib.loads((repo / "pyproject.toml").read_text(encoding="utf-8"))
        return str(data["project"]["version"])
    except Exception as exc:  # noqa: BLE001 - fall back to explicit --version
        raise ValueError(
            "cannot read version from pyproject.toml; pass --version explicitly"
        ) from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="generate_release_manifest")
    parser.add_argument("--repo", default=".", help="release checkout (default: .)")
    parser.add_argument("--name", default="ai-bridge")
    parser.add_argument("--version", default=None, help="default: pyproject.toml version")
    parser.add_argument("--base-url", required=True,
                        help="download base URL, e.g. https://example.com/releases/0.3.0/")
    parser.add_argument("--include", action="append", default=[],
                        help="glob for payload files (repeatable; default: all tracked files)")
    parser.add_argument("--out", required=True, help="manifest JSON to write")
    args = parser.parse_args(argv)

    repo = Path(args.repo).resolve()
    version = args.version or _version_from_pyproject(repo)
    manifest = build_manifest(
        repo, name=args.name, version=version,
        base_url=args.base_url, includes=args.include,
    )
    out = Path(args.out)
    out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"manifest: {out}")
    print(f"name: {manifest['name']}  version: {manifest['version']}  commit: {manifest['commit']}")
    print(f"files: {len(manifest['files'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
