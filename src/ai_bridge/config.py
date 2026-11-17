"""Configuration from environment only. Secrets are never read from code
or committed config files; they come from env vars / .env (gitignored).

F-04-23 (Wave 3B): ``get_settings()`` is cached — repeated calls with
an unchanged environment return the same ``Settings`` object instead of
rebuilding it (and re-resolving secrets) on every call. The cache is
keyed on the exact environment values ``Settings`` reads, so changing
an env var still yields a fresh object; ``reset_for_tests()`` clears it
explicitly for tests that mutate backend state beyond the environment.
Numeric settings are validated (``ValueError`` with a clear message)
instead of silently falling back to defaults, and ``$VAR`` in paths is
no longer expanded — only ``~`` (``expanduser``) is. If a path needs an
environment value, export the fully-expanded path.
"""
from __future__ import annotations

import functools
import os
from pathlib import Path

# Every environment variable Settings reads. The get_settings() cache key.
_SETTINGS_ENV_KEYS = (
    "AI_BRIDGE_WORKSPACE",
    "AI_BRIDGE_MAX_READ_BYTES",
    "AI_BRIDGE_MAX_OUTPUT_BYTES",
    "AI_BRIDGE_MAX_LIST",
    "AI_BRIDGE_DEFAULT_TIMEOUT",
    "AI_BRIDGE_MAX_TIMEOUT",
    "AI_BRIDGE_MAX_CONCURRENT",
    "AI_BRIDGE_CONTROL_URL",
    "AI_BRIDGE_CONTROL_PORT",
    "AI_BRIDGE_ADMIN_TOKEN",
    "AI_BRIDGE_DEVICE_TOKEN",
    "AI_BRIDGE_TENANT",
    "AI_BRIDGE_DESKTOP_ENABLED",
    "AI_BRIDGE_ALLOW_TIER3",
    "AI_BRIDGE_DATA_DIR",
    "AI_BRIDGE_SECRETS_BACKEND",
    "AI_BRIDGE_SECRETS_ALLOW_ENV_FALLBACK",
    "AI_BRIDGE_VAULT_ADDR",
    "AI_BRIDGE_VAULT_TOKEN",
    "AI_BRIDGE_VAULT_SECRET_PATH",
    "AI_BRIDGE_AWS_SECRET_ID",
)


def _env_fingerprint() -> tuple[str | None, ...]:
    return tuple(os.environ.get(key) for key in _SETTINGS_ENV_KEYS)


def _int(name: str, default: int, *, minimum: int | None = None, maximum: int | None = None) -> int:
    """Parse an int env var; raise ValueError on garbage or out-of-range
    values instead of silently falling back to the default (F-04-23)."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        value = default
    else:
        try:
            value = int(raw.strip(), 10)
        except ValueError:
            raise ValueError(
                f"Invalid integer for {name}: {raw!r} (expected an integer, got {raw!r})."
            ) from None
    if minimum is not None and value < minimum:
        raise ValueError(f"{name}={value} is below the minimum of {minimum}.")
    if maximum is not None and value > maximum:
        raise ValueError(f"{name}={value} is above the maximum of {maximum}.")
    return value


def _bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, "1" if default else "0").strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    workspace: Path
    max_read_bytes: int = 128_000
    max_output_bytes: int = 64_000
    max_list_entries: int = 200
    default_timeout_s: int = 30
    max_timeout_s: int = 300
    max_concurrent_tasks: int = 4
    control_api_url: str
    control_api_port: int
    admin_token: str | None
    device_token: str | None
    tenant_id: str
    desktop_enabled: bool
    allow_tier3: bool
    data_dir: Path

    def __init__(self) -> None:
        # NOTE: expanduser only — $VAR in paths is deliberately NOT
        # expanded (F-04-23). A literal "$HOME/..." stays literal.
        raw = os.environ.get("AI_BRIDGE_WORKSPACE", str(Path.home() / "ai-bridge-workspace"))
        self.workspace = Path(raw).expanduser()
        self.max_read_bytes = _int("AI_BRIDGE_MAX_READ_BYTES", 128_000, minimum=1)
        self.max_output_bytes = _int("AI_BRIDGE_MAX_OUTPUT_BYTES", 64_000, minimum=1)
        self.max_list_entries = _int("AI_BRIDGE_MAX_LIST", 200, minimum=1)
        self.default_timeout_s = _int("AI_BRIDGE_DEFAULT_TIMEOUT", 30, minimum=1, maximum=3600)
        self.max_timeout_s = _int("AI_BRIDGE_MAX_TIMEOUT", 300, minimum=1, maximum=3600)
        self.max_concurrent_tasks = _int("AI_BRIDGE_MAX_CONCURRENT", 4, minimum=1, maximum=64)
        self.control_api_url = os.environ.get("AI_BRIDGE_CONTROL_URL", "http://127.0.0.1:8000")
        self.control_api_port = _int("AI_BRIDGE_CONTROL_PORT", 8000, minimum=1, maximum=65535)
        from .control.secrets_backend import get_secret

        self.admin_token = get_secret("AI_BRIDGE_ADMIN_TOKEN") or os.environ.get("AI_BRIDGE_ADMIN_TOKEN") or None
        self.device_token = get_secret("AI_BRIDGE_DEVICE_TOKEN") or os.environ.get("AI_BRIDGE_DEVICE_TOKEN") or None
        self.tenant_id = os.environ.get("AI_BRIDGE_TENANT", "default")
        self.desktop_enabled = _bool("AI_BRIDGE_DESKTOP_ENABLED", False)
        self.allow_tier3 = _bool("AI_BRIDGE_ALLOW_TIER3", False)
        data = os.environ.get("AI_BRIDGE_DATA_DIR", str(Path.home() / ".ai-bridge"))
        self.data_dir = Path(data).expanduser()


@functools.lru_cache(maxsize=128)
def _build_settings(_fingerprint: tuple[str | None, ...]) -> Settings:
    # The fingerprint is only a cache key: Settings reads os.environ
    # itself, and the fingerprint is computed from the same variables
    # immediately before construction, so the built object always
    # matches its key.
    return Settings()


def get_settings() -> Settings:
    """Return the cached Settings for the current environment."""
    return _build_settings(_env_fingerprint())


def reset_for_tests() -> None:
    """Clear the get_settings() cache (tests that mutate backend state)."""
    _build_settings.cache_clear()


# Compatibility with code that clears the cache directly (see
# tests/unit/test_phases_456_deep.py).
get_settings.cache_clear = _build_settings.cache_clear  # type: ignore[attr-defined]
