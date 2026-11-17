"""Deployment-config regression tests (Wave 1A: R-P0-14, R-P0-15, P-03,
P-04, P-05, P-06, P-09, R-P1-53).

Stdlib only — no `ai_bridge` imports and no third-party dependency — so
these tests run even when the full package cannot be installed (the CI
`deployment-config` job runs them with plain `python3`).

Compose YAML is parsed with PyYAML when available; otherwise a regex
fallback scans the raw text for the same `VAR=value` entries. nginx and
the installer scripts are plain-text assertions.

Run either way:
    pytest -q tests/unit/test_deployment_config.py
    python3 tests/unit/test_deployment_config.py -v
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

PROD_COMPOSE = REPO_ROOT / "docker-compose.prod.yml"
BASE_COMPOSE = REPO_ROOT / "docker-compose.yml"
DEV_COMPOSE = REPO_ROOT / "docker-compose.dev.yml"
RENDER = REPO_ROOT / "render.yaml"
CFN = REPO_ROOT / "deployment/aws/cloudformation.yml"
NGINX = REPO_ROOT / "deployment/docker/nginx.conf"
DEPLOY_PROD = REPO_ROOT / "deployment/linux/deploy-production.sh"
MAGIC_SH = REPO_ROOT / "magic-install.sh"
MAGIC_SH_LINUX = REPO_ROOT / "deployment/linux/magic-install.sh"
MAGIC_PS1 = REPO_ROOT / "magic-install.ps1"
ENV_EXAMPLE = REPO_ROOT / ".env.example"

# Known default / placeholder secrets that must never appear in a shipped
# deployment file (R-P0-15). These literals appear here only as the
# denylist for the scan; the scanned files must not contain them.
KNOWN_DEFAULT_SECRETS = (
    "aibridge-dev-password",
    "change-me-in-production",
    "aibridge_turn_shared_secret_2026",
    "dev-admin-token",
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _compose_env(path: Path) -> dict[str, str]:
    """Return {VAR: raw value} for every `VAR=...` in a compose file.

    Prefers a real YAML parse; falls back to a regex scan of the raw
    text when PyYAML is not installed.
    """
    text = _read(path)
    try:
        import yaml  # type: ignore[import]

        data = yaml.safe_load(text) or {}
        env: dict[str, str] = {}
        for service in (data.get("services") or {}).values():
            raw = (service or {}).get("environment") or []
            items = raw.items() if isinstance(raw, dict) else raw
            for item in items:
                if isinstance(item, str) and "=" in item:
                    key, value = item.split("=", 1)
                    env.setdefault(key.strip(), value.strip())
        if env:
            return env
    except ImportError:
        pass
    env = {}
    for match in re.finditer(r"^\s*-\s*([A-Z][A-Z0-9_]*)=(.*)$", text, re.M):
        env.setdefault(match.group(1), match.group(2).strip())
    return env


def _nginx_block(text: str, header_re: str) -> str:
    """Return the text of the first nginx block starting at `header_re`.

    Brace-counts from the opening `{` so nested locations are included.
    """
    match = re.search(header_re, text)
    assert match is not None, f"nginx block not found: {header_re}"
    start = text.index("{", match.start())
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    raise AssertionError(f"unbalanced braces in nginx block: {header_re}")


class TestTier3Default(unittest.TestCase):
    def test_prod_compose_tier3_defaults_to_0(self):
        env = _compose_env(PROD_COMPOSE)
        self.assertIn("AI_BRIDGE_ALLOW_TIER3", env)
        self.assertEqual(env["AI_BRIDGE_ALLOW_TIER3"], "${AI_BRIDGE_ALLOW_TIER3:-0}")

    def test_no_tier3_enabled_by_default_anywhere(self):
        # Strip full-line comments first: prose may mention the opt-in
        # value ("set it to 1") without enabling anything.
        for path in (PROD_COMPOSE, BASE_COMPOSE, DEV_COMPOSE, CFN):
            code = "\n".join(
                line for line in _read(path).splitlines()
                if not line.strip().startswith("#")
            )
            self.assertNotIn(
                "AI_BRIDGE_ALLOW_TIER3=1",
                code,
                f"{path.name} still enables Tier 3 by default",
            )
            self.assertNotRegex(
                code, r"AI_BRIDGE_ALLOW_TIER3=\$\{[^}]*:-1\}",
            )

    def test_render_tier3_explicitly_0(self):
        text = _read(RENDER)
        self.assertRegex(text, r"key: AI_BRIDGE_ALLOW_TIER3\s*\n\s*value: \"0\"")


class TestNoDefaultSecrets(unittest.TestCase):
    def test_no_known_default_secrets_in_compose_files(self):
        for path in (PROD_COMPOSE, BASE_COMPOSE, DEV_COMPOSE):
            text = _read(path)
            for secret in KNOWN_DEFAULT_SECRETS:
                self.assertNotIn(secret, text, f"{path.name} contains {secret!r}")

    def test_no_known_default_secrets_in_env_example(self):
        text = _read(ENV_EXAMPLE)
        for secret in KNOWN_DEFAULT_SECRETS:
            self.assertNotIn(secret, text, f".env.example contains {secret!r}")

    def test_postgres_password_fails_fast(self):
        for path in (PROD_COMPOSE, BASE_COMPOSE):
            env = _compose_env(path)
            self.assertIn("POSTGRES_PASSWORD", env, path.name)
            self.assertIn(
                ":?",
                env["POSTGRES_PASSWORD"],
                f"{path.name}: POSTGRES_PASSWORD must use ${{VAR:?message}}",
            )

    def test_turn_secret_fails_fast(self):
        # The TURN secret lives in the coturn `command:` list, not in an
        # `environment:` block, so check the raw text in both files.
        for path in (PROD_COMPOSE, BASE_COMPOSE):
            self.assertRegex(
                _read(path),
                r"--static-auth-secret=\$\{AI_BRIDGE_TURN_SECRET:\?[^}]+\}",
                f"{path.name}: TURN secret must use ${{VAR:?message}}",
            )

    def test_deploy_script_generates_turn_secret(self):
        text = _read(DEPLOY_PROD)
        self.assertIn("AI_BRIDGE_TURN_SECRET=${TURN_SECRET}", text)
        self.assertIn("TURN_SECRET=$(openssl rand -hex 32)", text)
        self.assertIn('chmod 600 "$ENV_FILE"', text)


class TestNginx(unittest.TestCase):
    def setUp(self):
        self.text = _read(NGINX)

    def test_http_redirects_to_https(self):
        # P-03: :80 serves the ACME challenge and redirects everything else.
        http_block = _nginx_block(self.text, r"server\s*\{\s*\n\s*listen 80;")
        self.assertIn("/.well-known/acme-challenge/", http_block)
        self.assertIn("return 301 https://$host$request_uri;", http_block)
        self.assertNotIn("proxy_pass", http_block)

    def test_metrics_is_protected(self):
        metrics = _nginx_block(self.text, r"location /metrics\s*\{")
        self.assertIn("auth_request /internal/verify;", metrics)
        self.assertIn("limit_req", metrics)

    def test_mcp_uses_oauth_auth_request(self):
        mcp = _nginx_block(self.text, r"location = /mcp\s*\{")
        self.assertIn("auth_request /internal/verify;", mcp)
        # The MCP DNS-rebinding guard requires a local Host value.
        self.assertIn("proxy_set_header Host 127.0.0.1:8001;", mcp)

    def test_internal_verify_location_shipped(self):
        verify = _nginx_block(self.text, r"location = /internal/verify\s*\{")
        self.assertIn("internal;", verify)
        self.assertIn("proxy_pass http://oauth_gateway/internal/verify;", verify)
        self.assertIn("proxy_set_header Authorization $http_authorization;", verify)


class TestInstallerTls(unittest.TestCase):
    def test_no_insecure_curl_in_magic_install_sh(self):
        for path in (MAGIC_SH, MAGIC_SH_LINUX):
            text = _read(path)
            self.assertNotRegex(text, r"curl\s+[^\n]*?(?:\s-k\b|--insecure\b)",
                                f"{path} still disables TLS verification")
            self.assertNotIn("curl -k", text)

    def test_enrollment_verifies_tls_with_explicit_ca_option(self):
        # P-09: enrollment must verify TLS; a private CA is supplied
        # explicitly via --cacert, never by skipping verification.
        for path in (MAGIC_SH, MAGIC_SH_LINUX):
            text = _read(path)
            self.assertIn("--fail", text)
            self.assertIn('AI_BRIDGE_CA_BUNDLE', text)
            self.assertIn('--cacert "$AI_BRIDGE_CA_BUNDLE"', text)

    def test_no_cert_bypass_in_magic_install_ps1(self):
        text = _read(MAGIC_PS1)
        self.assertNotIn("SkipCertificateCheck", text)
        self.assertNotIn("ServerCertificateValidationCallback", text)

    def test_deploy_script_health_probe_has_no_insecure_flag(self):
        text = _read(DEPLOY_PROD)
        self.assertNotRegex(text, r"curl\s+[^\n]*-k\b")


class TestEnvExample(unittest.TestCase):
    def test_all_required_vars_documented(self):
        text = _read(ENV_EXAMPLE)
        for var in (
            "AI_BRIDGE_ADMIN_TOKEN",
            "SECRET_KEY",
            "DATABASE_URL",
            "REDIS_URL",
            "POSTGRES_PASSWORD",
            "AI_BRIDGE_PUBLIC_URL",
            "AI_BRIDGE_DOMAIN",
            "AI_BRIDGE_TURN_SECRET",
            "AI_BRIDGE_CORS_ORIGINS",
            "AI_BRIDGE_EMBED_MCP",
            "AI_BRIDGE_MCP_HOST",
            "AI_BRIDGE_OAUTH_HOST",
            "AI_BRIDGE_ALLOW_TIER3",
        ):
            self.assertRegex(text, rf"(?m)^{var}=", f".env.example omits {var}")

    def test_env_example_has_no_secret_defaults(self):
        # Non-secret operational defaults (port, db name, TTL) are fine;
        # anything that is or contains a credential must be empty.
        secret_vars = {
            "AI_BRIDGE_ADMIN_TOKEN",
            "SECRET_KEY",
            "DATABASE_URL",
            "POSTGRES_PASSWORD",
            "REDIS_PASSWORD",
            "AI_BRIDGE_TURN_SECRET",
            "AI_BRIDGE_TURN_CREDENTIAL",
            "AI_BRIDGE_OIDC_CLIENT_SECRET",
            "AI_BRIDGE_M365_CLIENT_SECRET",
            "AI_BRIDGE_DEVICE_TOKEN",
        }
        for line in _read(ENV_EXAMPLE).splitlines():
            if line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key in secret_vars:
                self.assertEqual(
                    value.strip(), "",
                    f".env.example ships a default for secret {key}",
                )
        self.assertIn("AI_BRIDGE_ALLOW_TIER3=0", _read(ENV_EXAMPLE))


if __name__ == "__main__":
    unittest.main()
