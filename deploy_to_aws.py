"""Deploy a PINNED commit to AI Bridge on AWS EC2.

Supports EC2 instances running Ubuntu with Docker and Docker Compose.
Uses AWS SSM or direct SSH for connectivity.

Shared logic (remote runner, pinned checkout, health gate) lives in
deployment/deploy_common.py (P-08, Wave 7) — this script is a thin
wrapper holding only the AWS-specific defaults and bootstrap.

Usage:
    # Direct SSH (key-based)
    set AI_BRIDGE_SSH_KEY=C:\\path\\to\\aws-key.pem
    set AI_BRIDGE_SSH_HOST=ubuntu@ec2-instance
    set AI_BRIDGE_DOMAIN=app.mydomain.com
    python deploy_to_aws.py --commit <40-hex SHA>

    # ... or with a signed release manifest configured (see below),
    # the pinned commit comes from the manifest instead:
    python deploy_to_aws.py

    # AWS SSM Session Manager (no public IP needed)
    set AI_BRIDGE_SSM_INSTANCE_ID=i-1234567890abcdef0
    set AI_BRIDGE_DOMAIN=app.mydomain.com
    python deploy_to_aws.py --commit <40-hex SHA>

    # One-time EC2 bootstrap (first-time setup)
    set AI_BRIDGE_BOOTSTRAP=1
    python deploy_to_aws.py

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
    AI_BRIDGE_SSH_KEY           Path to the EC2 private key (.pem) for SSH
    AI_BRIDGE_SSH_HOST          SSH user@host (default ubuntu@ec2-instance)
    AI_BRIDGE_SSM_INSTANCE_ID   EC2 instance ID for AWS SSM (alternative to SSH)
    AI_BRIDGE_APP_DIR           Target directory (default /opt/ai-bridge)
    AI_BRIDGE_AWS_REGION        AWS region (default us-east-2)
    AI_BRIDGE_DOMAIN            Public domain (e.g. app.mydomain.com)
    AI_BRIDGE_ACM_ARN           ACM certificate ARN for ALB (optional)
    AI_BRIDGE_BOOTSTRAP         Set to 1 for first-time EC2 setup
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
HOST = os.environ.get("AI_BRIDGE_SSH_HOST", "ubuntu@ec2-instance")
SSM_INSTANCE_ID = os.environ.get("AI_BRIDGE_SSM_INSTANCE_ID", "")
APP_DIR = os.environ.get("AI_BRIDGE_APP_DIR", DEFAULT_APP_DIR)
AWS_REGION = os.environ.get("AI_BRIDGE_AWS_REGION", DEFAULT_AWS_REGION)
DOMAIN = os.environ.get("AI_BRIDGE_DOMAIN", "")
BOOTSTRAP = os.environ.get("AI_BRIDGE_BOOTSTRAP", "")


def _remote(step: str, cmd: str) -> None:
    run_remote(step, cmd, key=KEY, host=HOST, ssm_instance_id=SSM_INSTANCE_ID,
               app_dir=APP_DIR, aws_region=AWS_REGION)


def bootstrap_ec2() -> None:
    """First-time setup for a fresh EC2 instance."""
    steps = [
        ("Update system", "sudo apt-get update -qq && sudo apt-get upgrade -y -qq"),
        ("Install Docker", "curl -fsSL https://get.docker.com | sudo bash"),
        ("Install Docker Compose plugin",
         "sudo mkdir -p /usr/local/lib/docker/cli-plugins && "
         "sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m) "
         "-o /usr/local/lib/docker/cli-plugins/docker-compose && sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose"),
        ("Add ubuntu to docker group", "sudo usermod -aG docker ubuntu"),
        ("Clone repo", f"sudo git clone https://github.com/jacxishipping/ai-bridge.git {APP_DIR} && sudo chown -R ubuntu:ubuntu {APP_DIR}"),
        ("Create data dirs",
         f"sudo mkdir -p {APP_DIR}/data {{APP_DIR}}/workspace && sudo chown -R ubuntu:ubuntu {APP_DIR}/data {APP_DIR}/workspace"),
    ]
    for step, cmd in steps:
        _remote(step, cmd)
    print("\n✅ EC2 bootstrap complete. Set up your .env.production and deploy.")
    print("NOTE: bootstrap clones floating main for first-time setup only —")
    print("run a pinned deploy (this script, --commit or signed manifest)")
    print("before serving traffic from it.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Deploy a pinned AI Bridge commit to AWS EC2.")
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

    if BOOTSTRAP:
        bootstrap_ec2()
        return

    try:
        pinned = resolve_pinned_commit(explicit_commit=args.commit or None)
    except (ValueError, PermissionError, FileNotFoundError) as exc:
        sys.exit(f"Refusing unpinned deploy: {exc}")
    print(f"Pinned deploy: commit {pinned}")

    _remote("Check out pinned commit", pinned_checkout_command(pinned))
    for step, cmd in deploy_service_steps(COMPOSE):
        _remote(step, cmd)
    health_gate_or_exit(
        health_url_for(explicit=args.health_url or None, domain=DOMAIN, host=HOST),
        timeout_s=args.health_timeout,
    )
    print("\n✅ AWS EC2 deployment finished.")


if __name__ == "__main__":
    main()
