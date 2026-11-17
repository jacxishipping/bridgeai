"""Deploy a PINNED commit to AI Bridge on a remote server (Docker stack) over SSH.

Supports DigitalOcean Droplets, AWS EC2, and any Linux server with Docker + Docker Compose.

Shared logic (remote runner, pinned checkout, health gate) lives in
deployment/deploy_common.py (P-08, Wave 7) — this script is a thin
wrapper holding only the droplet-specific defaults.

Usage:
    # DigitalOcean Droplet
    set AI_BRIDGE_SSH_KEY=C:\\path\\to\\do-key.pem
    set AI_BRIDGE_SSH_HOST=ubuntu@your-droplet-ip
    python deploy_to_droplet.py --commit <40-hex SHA>

    # AWS EC2
    set AI_BRIDGE_SSH_KEY=C:\\path\\to\\aws-key.pem
    set AI_BRIDGE_SSH_HOST=ubuntu@ec2-instance
    python deploy_to_droplet.py --commit <40-hex SHA>

    # AWS SSM Session Manager (no public IP needed)
    set AI_BRIDGE_SSM_INSTANCE_ID=i-1234567890abcdef0
    python deploy_to_droplet.py --commit <40-hex SHA>

Pinned deploys (P-08): a deploy NEVER floats ``origin/main``. The
commit comes from (1) a verified signed release manifest
(AI_BRIDGE_UPDATE_MANIFEST_PATH / AI_BRIDGE_UPDATE_SIGNATURE_PATH /
AI_BRIDGE_UPDATE_PUBLIC_KEY — Ed25519 signature verified locally by
ai_bridge.updates BEFORE any fetch), or (2) an explicit
``--commit <40-hex SHA>`` / AI_BRIDGE_COMMIT. With neither, the
script refuses to deploy. The remote checks out exactly that SHA
and verifies HEAD afterwards.

Post-deploy health gate (P-08): after restart the script polls
/health/ready (AI_BRIDGE_HEALTH_URL, else https://<AI_BRIDGE_DOMAIN>,
else https://<SSH host>) until healthy or --health-timeout (default
300 s) and exits non-zero if the plane never becomes healthy.

Environment:
    AI_BRIDGE_SSH_KEY           Path to the SSH private key (required for SSH)
    AI_BRIDGE_SSH_HOST          SSH user@host (default ubuntu@jxiptvplayer.app)
    AI_BRIDGE_SSM_INSTANCE_ID   EC2 instance ID for AWS SSM (alternative to SSH)
    AI_BRIDGE_APP_DIR           Target directory (default /opt/ai-bridge)
    AI_BRIDGE_AWS_REGION        AWS region for SSM (default us-east-2)
    AI_BRIDGE_DOMAIN            Public domain for nginx/cert config and the
                                health gate (default: derived from SSH host)
    AI_BRIDGE_COMMIT            Pinned 40-hex commit SHA (alternative to --commit)
    AI_BRIDGE_HEALTH_URL        Explicit health-gate URL (default: derived)
    AI_BRIDGE_HEALTH_TIMEOUT_S  Health-gate timeout in seconds (default 300)
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from deployment.deploy_common import (  # noqa: E402
    COMPOSE,
    DEFAULT_APP_DIR,
    DEFAULT_AWS_REGION,
    DEFAULT_HEALTH_TIMEOUT_S,
    deploy_service_steps,
    health_gate_or_exit,
    health_url_for,
    pinned_checkout_command,
    resolve_pinned_commit,
    run_remote,
)

KEY = os.environ.get("AI_BRIDGE_SSH_KEY", "")
HOST = os.environ.get("AI_BRIDGE_SSH_HOST", "ubuntu@jxiptvplayer.app")
SSM_INSTANCE_ID = os.environ.get("AI_BRIDGE_SSM_INSTANCE_ID", "")
APP_DIR = os.environ.get("AI_BRIDGE_APP_DIR", DEFAULT_APP_DIR)
AWS_REGION = os.environ.get("AI_BRIDGE_AWS_REGION", DEFAULT_AWS_REGION)
DOMAIN = os.environ.get("AI_BRIDGE_DOMAIN", "")


def _remote(step: str, cmd: str) -> None:
    run_remote(step, cmd, key=KEY, host=HOST, ssm_instance_id=SSM_INSTANCE_ID,
               app_dir=APP_DIR, aws_region=AWS_REGION)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Deploy a pinned AI Bridge commit to a remote server.")
    parser.add_argument("--commit", default=os.environ.get("AI_BRIDGE_COMMIT", ""),
                        help="Pinned 40-hex commit SHA to deploy (or set AI_BRIDGE_COMMIT; "
                             "not needed when a signed release manifest is configured).")
    parser.add_argument("--health-url", default=os.environ.get("AI_BRIDGE_HEALTH_URL", ""),
                        help="Explicit /health/ready URL for the post-deploy gate.")
    parser.add_argument("--health-timeout", type=float,
                        default=float(os.environ.get("AI_BRIDGE_HEALTH_TIMEOUT_S",
                                                     DEFAULT_HEALTH_TIMEOUT_S)),
                        help="Seconds to wait for the plane to become healthy (default 300).")
    args = parser.parse_args(argv)

    if not KEY and not SSM_INSTANCE_ID:
        sys.exit("Set AI_BRIDGE_SSH_KEY or AI_BRIDGE_SSM_INSTANCE_ID.")

    try:
        pinned = resolve_pinned_commit(explicit_commit=args.commit or None)
    except (ValueError, PermissionError, FileNotFoundError) as exc:
        sys.exit(f"Refusing unpinned deploy: {exc}")
    print(f"Pinned deploy: commit {pinned}")

    _remote("Check out pinned commit", pinned_checkout_command(pinned))
    for step, cmd in deploy_service_steps(COMPOSE, force_recreate=True):
        _remote(step, cmd)
    health_gate_or_exit(
        health_url_for(explicit=args.health_url or None, domain=DOMAIN, host=HOST),
        timeout_s=args.health_timeout,
    )
    print("\nDeployment finished.")


if __name__ == "__main__":
    main()
