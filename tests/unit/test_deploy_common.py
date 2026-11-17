"""Wave 7 (P-08) tests: shared deploy helpers — pinned deploys + health gate.

Covers deployment/deploy_common.py: SHA validation, pinned-commit
resolution (signed manifest vs explicit --commit vs refusal), the
pinned checkout command, health-URL derivation, the health gate
against a local fake HTTP endpoint, and static checks that both deploy
scripts now use the shared module with no floating `git pull`.

No real deployment is ever performed: the health gate is exercised
against a local HTTP server, the checkout command is asserted as a
string (never executed), and the SSH/SSM runner is not invoked.
"""
from __future__ import annotations

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from ai_bridge.updates import generate_keypair, sign_manifest
from deployment.deploy_common import (
    COMPOSE,
    deploy_service_steps,
    health_url_for,
    is_valid_commit_sha,
    normalize_commit_sha,
    pinned_checkout_command,
    resolve_pinned_commit,
    wait_for_health,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_AWS = REPO_ROOT / "deploy_to_aws.py"
DEPLOY_DROPLET = REPO_ROOT / "deploy_to_droplet.py"

GOOD_SHA = "a" * 40
GOOD_SHA_UPPER = "A" * 39 + "F"
BAD_SHAS = ["", "main", "abc123", "a" * 39, "a" * 41, "g" * 40, None, 12345]


# ---------------------------------------------------------------------------
# SHA validation
# ---------------------------------------------------------------------------

class TestCommitShaValidation:
    def test_valid_40_hex(self):
        assert is_valid_commit_sha(GOOD_SHA)
        assert is_valid_commit_sha(GOOD_SHA_UPPER)
        assert is_valid_commit_sha("0123456789abcdef" * 2 + "01234567")

    @pytest.mark.parametrize("bad", BAD_SHAS)
    def test_invalid_shas_rejected(self, bad):
        assert not is_valid_commit_sha(bad)
        with pytest.raises(ValueError):
            normalize_commit_sha(bad)

    def test_normalize_lowercases(self):
        assert normalize_commit_sha(GOOD_SHA_UPPER) == GOOD_SHA_UPPER.lower()


# ---------------------------------------------------------------------------
# Pinned-commit resolution
# ---------------------------------------------------------------------------

def _clear_update_env(monkeypatch):
    for var in (
        "AI_BRIDGE_UPDATE_MANIFEST_PATH",
        "AI_BRIDGE_UPDATE_SIGNATURE_PATH",
        "AI_BRIDGE_UPDATE_PUBLIC_KEY",
    ):
        monkeypatch.delenv(var, raising=False)


def _write_signed_manifest(tmp_path, commit, *, tamper_after_sign=False):
    priv, pub = generate_keypair(tmp_path / "keys")
    manifest = {"name": "ai-bridge", "version": "0.3.0", "commit": commit, "files": []}
    sig = sign_manifest(manifest, priv)
    if tamper_after_sign:
        manifest = dict(manifest, commit="b" * 40)
    manifest_p = tmp_path / "release.json"
    sig_p = tmp_path / "release.json.sig"
    manifest_p.write_text(json.dumps(manifest), encoding="utf-8")
    sig_p.write_text(sig, encoding="utf-8")
    return manifest_p, sig_p, pub


class TestResolvePinnedCommit:
    def test_explicit_commit_accepted(self, monkeypatch):
        _clear_update_env(monkeypatch)
        assert resolve_pinned_commit(explicit_commit=GOOD_SHA_UPPER) == GOOD_SHA_UPPER.lower()

    def test_explicit_commit_invalid_refused(self, monkeypatch):
        _clear_update_env(monkeypatch)
        with pytest.raises(ValueError):
            resolve_pinned_commit(explicit_commit="main")

    def test_neither_manifest_nor_commit_refuses(self, monkeypatch):
        _clear_update_env(monkeypatch)
        with pytest.raises(ValueError, match="unpinned"):
            resolve_pinned_commit()

    def test_signed_manifest_wins_and_verifies(self, tmp_path, monkeypatch):
        manifest_p, sig_p, pub = _write_signed_manifest(tmp_path, GOOD_SHA)
        monkeypatch.setenv("AI_BRIDGE_UPDATE_MANIFEST_PATH", str(manifest_p))
        monkeypatch.setenv("AI_BRIDGE_UPDATE_SIGNATURE_PATH", str(sig_p))
        monkeypatch.setenv("AI_BRIDGE_UPDATE_PUBLIC_KEY", str(pub))
        assert resolve_pinned_commit() == GOOD_SHA

    def test_tampered_manifest_refused(self, tmp_path, monkeypatch):
        manifest_p, sig_p, pub = _write_signed_manifest(
            tmp_path, GOOD_SHA, tamper_after_sign=True
        )
        monkeypatch.setenv("AI_BRIDGE_UPDATE_MANIFEST_PATH", str(manifest_p))
        monkeypatch.setenv("AI_BRIDGE_UPDATE_SIGNATURE_PATH", str(sig_p))
        monkeypatch.setenv("AI_BRIDGE_UPDATE_PUBLIC_KEY", str(pub))
        with pytest.raises(PermissionError):
            resolve_pinned_commit()

    def test_manifest_without_commit_refused(self, tmp_path, monkeypatch):
        priv, pub = generate_keypair(tmp_path / "keys")
        manifest = {"name": "ai-bridge", "version": "0.3.0", "files": []}
        sig = sign_manifest(manifest, priv)
        manifest_p = tmp_path / "release.json"
        sig_p = tmp_path / "release.json.sig"
        manifest_p.write_text(json.dumps(manifest), encoding="utf-8")
        sig_p.write_text(sig, encoding="utf-8")
        monkeypatch.setenv("AI_BRIDGE_UPDATE_MANIFEST_PATH", str(manifest_p))
        monkeypatch.setenv("AI_BRIDGE_UPDATE_SIGNATURE_PATH", str(sig_p))
        monkeypatch.setenv("AI_BRIDGE_UPDATE_PUBLIC_KEY", str(pub))
        with pytest.raises(ValueError):
            resolve_pinned_commit()

    def test_partially_configured_manifest_falls_back_to_explicit(self, tmp_path, monkeypatch):
        # Manifest path set but signature file missing: not "configured",
        # so an explicit --commit still works (and without one it refuses).
        manifest_p = tmp_path / "release.json"
        manifest_p.write_text(json.dumps({"commit": GOOD_SHA}), encoding="utf-8")
        monkeypatch.setenv("AI_BRIDGE_UPDATE_MANIFEST_PATH", str(manifest_p))
        monkeypatch.delenv("AI_BRIDGE_UPDATE_SIGNATURE_PATH", raising=False)
        monkeypatch.delenv("AI_BRIDGE_UPDATE_PUBLIC_KEY", raising=False)
        assert resolve_pinned_commit(explicit_commit=GOOD_SHA) == GOOD_SHA
        with pytest.raises(ValueError):
            resolve_pinned_commit()


# ---------------------------------------------------------------------------
# Pinned checkout command (string only — never executed)
# ---------------------------------------------------------------------------

class TestPinnedCheckoutCommand:
    def test_checks_out_exact_sha_and_verifies_head(self):
        cmd = pinned_checkout_command(GOOD_SHA)
        assert f"git checkout -f {GOOD_SHA}" in cmd
        assert f'test "$(git rev-parse HEAD)" = "{GOOD_SHA}"' in cmd
        assert "git fetch origin" in cmd

    def test_never_floats_origin_main_or_pulls(self):
        cmd = pinned_checkout_command(GOOD_SHA)
        assert "origin main" not in cmd
        assert "git pull" not in cmd

    def test_invalid_sha_refused_before_any_command(self):
        with pytest.raises(ValueError):
            pinned_checkout_command("main")


# ---------------------------------------------------------------------------
# Service steps
# ---------------------------------------------------------------------------

class TestDeployServiceSteps:
    def test_shared_steps_cover_build_restart_nginx_status(self):
        steps = deploy_service_steps(COMPOSE)
        names = [name for name, _ in steps]
        assert names == [
            "Build image",
            "Restart app services",
            "Recreate nginx (reload config)",
            "Status",
        ]
        assert all(COMPOSE.split()[0] in cmd or "docker ps" in cmd for _, cmd in steps)

    def test_force_recreate_only_on_restart_step(self):
        plain = dict(deploy_service_steps(COMPOSE))
        forced = dict(deploy_service_steps(COMPOSE, force_recreate=True))
        assert "--force-recreate" not in plain["Restart app services"]
        assert "--force-recreate" in forced["Restart app services"]
        assert plain["Build image"] == forced["Build image"]


# ---------------------------------------------------------------------------
# Health-URL derivation
# ---------------------------------------------------------------------------

class TestHealthUrlFor:
    def test_explicit_url_wins(self):
        assert health_url_for(explicit="https://example.com/health/ready") == (
            "https://example.com/health/ready"
        )
        assert health_url_for(explicit="https://example.com") == (
            "https://example.com/health/ready"
        )

    def test_domain_beats_host(self):
        assert health_url_for(domain="jxiptvplayer.app", host="ubuntu@other.example") == (
            "https://jxiptvplayer.app/health/ready"
        )

    def test_host_fallback(self):
        assert health_url_for(host="ubuntu@jxiptvplayer.app") == (
            "https://jxiptvplayer.app/health/ready"
        )

    def test_placeholder_host_fails_closed(self):
        with pytest.raises(ValueError, match="AI_BRIDGE_DOMAIN"):
            health_url_for(host="ubuntu@ec2-instance")
        with pytest.raises(ValueError, match="AI_BRIDGE_DOMAIN"):
            health_url_for(host="")


# ---------------------------------------------------------------------------
# Health gate against a fake local HTTP endpoint
# ---------------------------------------------------------------------------

class _ScriptedHandler(BaseHTTPRequestHandler):
    statuses: list[int] = [200]

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler naming
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[-1]
        self.send_response(status)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):  # noqa: D102 - silence test server logs
        pass


def _start_server(statuses):
    handler = type("H", (_ScriptedHandler,), {"statuses": list(statuses)})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/health/ready"


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class TestWaitForHealth:
    def test_healthy_immediately(self):
        server, url = _start_server([200])
        try:
            assert wait_for_health(url, timeout_s=5, interval_s=0.05) is True
        finally:
            server.shutdown()

    def test_retries_until_healthy(self):
        server, url = _start_server([500, 500, 200])
        try:
            assert wait_for_health(url, timeout_s=5, interval_s=0.05) is True
        finally:
            server.shutdown()

    def test_redirect_counts_as_healthy_like_deploy_production_sh(self):
        server, url = _start_server([301])
        try:
            assert wait_for_health(url, timeout_s=5, interval_s=0.05) is True
        finally:
            server.shutdown()

    def test_never_healthy_times_out(self):
        server, url = _start_server([500])
        try:
            assert wait_for_health(url, timeout_s=0.3, interval_s=0.05) is False
        finally:
            server.shutdown()

    def test_connection_refused_times_out(self):
        url = f"http://127.0.0.1:{_free_port()}/health/ready"
        assert wait_for_health(url, timeout_s=0.3, interval_s=0.05) is False


# ---------------------------------------------------------------------------
# Both deploy scripts use the shared module (static checks)
# ---------------------------------------------------------------------------

class TestDeployScriptsUseSharedModule:
    @pytest.mark.parametrize("script", [DEPLOY_AWS, DEPLOY_DROPLET])
    def test_no_floating_git_pull(self, script):
        text = script.read_text(encoding="utf-8")
        assert "git pull" not in text, f"{script.name} still floats origin/main"
        assert "origin main" not in text

    @pytest.mark.parametrize("script", [DEPLOY_AWS, DEPLOY_DROPLET])
    def test_uses_shared_module_and_pinned_flow(self, script):
        text = script.read_text(encoding="utf-8")
        assert "from deployment.deploy_common import" in text
        assert "resolve_pinned_commit" in text
        assert "pinned_checkout_command" in text
        assert "--commit" in text
        assert "health_gate_or_exit" in text

    def test_aws_keeps_bootstrap(self):
        assert "bootstrap_ec2" in DEPLOY_AWS.read_text(encoding="utf-8")

    def test_droplet_keeps_force_recreate_restart(self):
        text = DEPLOY_DROPLET.read_text(encoding="utf-8")
        assert "force_recreate=True" in text
