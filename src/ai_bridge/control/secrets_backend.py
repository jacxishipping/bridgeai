"""Optional Vault / AWS Secrets Manager / env secret resolution.

Default remains process environment. Enable with::

    AI_BRIDGE_SECRETS_BACKEND=env|vault|aws_sm

Vault uses ``AI_BRIDGE_VAULT_ADDR`` + ``AI_BRIDGE_VAULT_TOKEN`` (+ optional
``AI_BRIDGE_VAULT_SECRET_PATH``). AWS SM uses boto3 ``GetSecretValue`` with
``AI_BRIDGE_AWS_SECRET_ID``. Missing backends fail closed when required.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

logger = logging.getLogger("ai_bridge.secrets_backend")


def _flag_on(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes")


def _allow_env_fallback() -> bool:
    """Explicit opt-in to the old silent env fallback for vault/aws backends."""
    return _flag_on("AI_BRIDGE_SECRETS_ALLOW_ENV_FALLBACK")


def _fail_closed_or_fallback(name: str, default: str | None, message: str) -> str | None:
    """F-05-10: vault/aws misconfiguration or fetch failure fails closed by
    default. Only an explicit ``AI_BRIDGE_SECRETS_ALLOW_ENV_FALLBACK=1``
    permits falling back to the process environment, and then only with a
    logged warning. ``AI_BRIDGE_SECRETS_REQUIRED=1`` keeps its previous
    behaviour (raise) and takes precedence.
    """
    if _flag_on("AI_BRIDGE_SECRETS_REQUIRED") or not _allow_env_fallback():
        raise RuntimeError(message)
    logger.warning(
        "Secrets backend falling back to process environment for %s "
        "(AI_BRIDGE_SECRETS_ALLOW_ENV_FALLBACK=1 is set): %s",
        name,
        message,
    )
    return os.environ.get(name) or default


def secrets_backend_name() -> str:
    return (os.environ.get("AI_BRIDGE_SECRETS_BACKEND") or "env").strip().lower() or "env"


def get_secret(name: str, *, default: str | None = None) -> str | None:
    """Resolve a secret by logical name (e.g. ``AI_BRIDGE_ADMIN_TOKEN``)."""
    backend = secrets_backend_name()
    if backend in ("", "env", "environment"):
        value = os.environ.get(name)
        return value if value not in (None, "") else default
    if backend in ("vault", "hashicorp_vault"):
        return _vault_get(name, default=default)
    if backend in ("aws", "aws_sm", "secretsmanager", "aws_secrets_manager"):
        return _aws_sm_get(name, default=default)
    raise RuntimeError(f"Unknown AI_BRIDGE_SECRETS_BACKEND={backend!r}")


def describe_secrets_backend() -> dict[str, Any]:
    name = secrets_backend_name()
    return {
        "backend": name,
        "vault_configured": bool(os.environ.get("AI_BRIDGE_VAULT_ADDR")),
        "aws_secret_id": bool(os.environ.get("AI_BRIDGE_AWS_SECRET_ID")),
        "note": "env is default; vault/aws_sm are optional production integrations",
    }


def _vault_get(name: str, *, default: str | None) -> str | None:
    addr = (os.environ.get("AI_BRIDGE_VAULT_ADDR") or "").rstrip("/")
    token = os.environ.get("AI_BRIDGE_VAULT_TOKEN") or ""
    path = (os.environ.get("AI_BRIDGE_VAULT_SECRET_PATH") or "secret/data/ai-bridge").strip("/")
    if not addr or not token:
        return _fail_closed_or_fallback(
            name, default,
            "Vault secrets backend requires AI_BRIDGE_VAULT_ADDR and AI_BRIDGE_VAULT_TOKEN",
        )
    try:
        import httpx

        url = f"{addr}/v1/{path}"
        res = httpx.get(url, headers={"X-Vault-Token": token}, timeout=10.0)
        res.raise_for_status()
        payload = res.json()
        data = (payload.get("data") or {}).get("data") or payload.get("data") or {}
        if name in data and data[name] not in (None, ""):
            return str(data[name])
        # Allow nested key without AI_BRIDGE_ prefix
        short = name.replace("AI_BRIDGE_", "")
        if short in data and data[short] not in (None, ""):
            return str(data[short])
    except Exception as exc:
        return _fail_closed_or_fallback(
            name, default, f"Vault secret fetch failed for {name}: {exc}"
        )
    return os.environ.get(name) or default


def _aws_sm_get(name: str, *, default: str | None) -> str | None:
    secret_id = os.environ.get("AI_BRIDGE_AWS_SECRET_ID") or ""
    if not secret_id:
        return _fail_closed_or_fallback(
            name, default,
            "AWS secrets backend requires AI_BRIDGE_AWS_SECRET_ID",
        )
    try:
        import boto3

        client = boto3.client("secretsmanager")
        resp = client.get_secret_value(SecretId=secret_id)
        raw = resp.get("SecretString") or ""
        data = json.loads(raw) if raw.startswith("{") else {name: raw}
        if name in data and data[name] not in (None, ""):
            return str(data[name])
        short = name.replace("AI_BRIDGE_", "")
        if short in data and data[short] not in (None, ""):
            return str(data[short])
    except Exception as exc:
        return _fail_closed_or_fallback(
            name, default, f"AWS Secrets Manager fetch failed for {name}: {exc}"
        )
    return os.environ.get(name) or default
