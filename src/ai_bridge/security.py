"""Workspace confinement, secret redaction, output limits.

Hardened vs the starter:
- workspace_root() no longer creates directories as a side effect of a
  read-only check; callers that need the directory use ensure_workspace().
- confined_path() rejects NUL bytes, Windows drive/UNC forms, and
  symlink escapes, and resolves against a *resolved* root.
- Secret-named files are never readable through workspace tools.
- All tool output passes through redact() / truncate_output().
"""
from __future__ import annotations

import base64
import ipaddress
import re
import socket
import urllib.parse
from pathlib import Path
from typing import Any

from .config import get_settings

MAX_READ_BYTES = 128_000
MAX_OUTPUT_BYTES = 64_000
# Names/patterns that look like credentials. Blocked from workspace reads.
_SECRET_NAME_RE = re.compile(
    r"(^|\.)env(\..+)?$|(^|\.)(pem|key|pfx|p12|kdbx|npmrc|netrc)$|"
    r"id_(rsa|ed25519|ecdsa|dsa)|agent_gui\.json$|"
    r"credentials|secret|private[_-]?key|token",
    re.IGNORECASE,
)
_BEARER_RE = re.compile(
    r"(?i)(authorization[\"']?\s*[:=]\s*[\"']?bearer\s+)([^\s\"',;}{]+)"
)
_REDACT_RE = re.compile(
    r"(?i)(api[_-]?key|password|passwd|token|secret|client_secret|authorization)"
    r"([\"']?\s*[:=]\s*[\"']?)([^\s\"',;}{]{4,})"
)
_SECRET_KEY_RE = re.compile(
    r"(?i)^(api[_-]?key|password|passwd|.*token|.*secret|authorization|credential.*)$"
)
_DEVICE_TOKEN_INLINE_RE = re.compile(
    r"(?i)(device[_-]?token)([\"']?\s*[:=]\s*[\"']?)([A-Za-z0-9_\-]{16,})"
)
_TURN_INLINE_RE = re.compile(
    r"(?i)(turn[_-]?secret|ai_bridge_turn_secret)([\"']?\s*[:=]\s*[\"']?)([^\s\"',;}{]{4,})"
)
_PRESERVE_KEYS = frozenset({"mime_type"})

# A JWT is three base64url segments; the header is base64url('{"...') so
# it always starts with "eyJ". Anchoring on that avoids redacting
# version numbers ("1.2.3") or dotted filenames.
_JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")

# Standard base64 alphabet (padding allowed only at the end).
_B64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")
# Magic bytes of the image formats tools produce (JPEG, PNG, GIF, WEBP, BMP).
_IMAGE_MAGIC = (b"\xff\xd8\xff", b"\x89PNG", b"GIF8", b"RIFF", b"BM")


def _is_plausible_image_base64(value: Any) -> bool:
    """True only when ``value`` is actually base64-encoded image data.

    A short or malformed value under an ``image_base64`` key is treated
    as a possible secret and redacted; real screenshots are kilobytes
    of valid base64 whose decoded prefix carries an image magic.
    """
    if not isinstance(value, str):
        return False
    text = "".join(value.split())
    if len(text) < 256 or len(text) % 4 != 0 or not _B64_RE.match(text):
        return False
    try:
        # Decode only the first 48 chars (36 bytes): enough for the
        # magic. 48 is a multiple of 4 and padding only ever appears at
        # the very end of a base64 string, so no padding is needed here.
        head = base64.b64decode(text[:48], validate=True)
    except Exception:
        return False
    if head.startswith(b"RIFF"):
        return len(head) >= 12 and head[8:12] == b"WEBP"
    return any(head.startswith(magic) for magic in _IMAGE_MAGIC)


def workspace_root() -> Path:
    return get_settings().workspace.resolve()


def ensure_workspace() -> Path:
    root = workspace_root()
    root.mkdir(parents=True, exist_ok=True)
    return root


def confined_path(relative_path: str, root: Path | None = None) -> Path:
    """Resolve a relative path, rejecting traversal and symlink escape."""
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("A non-empty relative path is required.")
    if "\x00" in relative_path:
        raise ValueError("Path contains a NUL byte.")
    candidate = Path(relative_path)
    if candidate.is_absolute() or candidate.drive:
        raise ValueError("Absolute paths are not allowed.")
    # Reject Windows UNC / drive-like prefixes even on Linux hosts.
    if relative_path.startswith(("\\\\", "//")) or re.match(r"^[A-Za-z]:", relative_path):
        raise ValueError("Absolute paths are not allowed.")
    base = (root or workspace_root()).resolve()
    resolved = (base / candidate).resolve()
    if resolved != base and base not in resolved.parents:
        raise ValueError("Path escapes the configured workspace.")
    return resolved


def is_secret_name(path: Path | str) -> bool:
    """True if any component of the path looks like it holds secrets.

    F-04-09: every component is inspected, not just the filename, so
    ``secrets/mykey.txt``, a ``secrets/`` directory, a ``.env`` file at
    any depth, and private-key filenames are all refused.

    Components are inspected relative to the workspace root when the
    path lies inside it: callers pass resolved absolute paths, and the
    prefix above the workspace (a pytest tmp dir, a home directory) is
    not part of the workspace path — e.g. a tmp dir named after a test
    containing "secret" must not make every file in it unreadable.
    Paths outside the workspace fall back to checking all components
    (fail closed).
    """
    parts = Path(path).parts
    try:
        rel = Path(path).resolve().relative_to(workspace_root().resolve())
        parts = rel.parts
    except Exception:
        pass
    return any(bool(_SECRET_NAME_RE.search(part)) for part in parts)


def read_workspace_text(relative_path: str, max_bytes: int | None = None) -> str:
    path = confined_path(relative_path)
    if is_secret_name(path):
        raise ValueError("Refusing to read a file whose name suggests it holds secrets.")
    if not path.is_file():
        raise ValueError("Path is not a regular file.")
    limit = max_bytes if max_bytes is not None else get_settings().max_read_bytes
    if path.stat().st_size > limit:
        raise ValueError(f"File exceeds the {limit}-byte read limit.")
    return path.read_text(encoding="utf-8", errors="replace")


def redact(text: str) -> str:
    """Replace secret-looking values; never leak tokens into logs/results."""
    if not isinstance(text, str):
        text = str(text)
    out = _BEARER_RE.sub(lambda m: f"{m.group(1)}***REDACTED***", text)
    out = _REDACT_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}***REDACTED***", out)
    out = _DEVICE_TOKEN_INLINE_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}***REDACTED***", out)
    out = _TURN_INLINE_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}***REDACTED***", out)
    # JWT-shaped tokens in free text (eyJ... header; three segments).
    out = _JWT_RE.sub("***REDACTED***", out)
    return out


def refuse_device_token_log(text: str) -> str:
    """Strip device tokens from log lines; always redact other secrets too."""
    return redact(text)


def redact_obj(value: Any) -> Any:
    """Recursively redact secret keys and inline secret patterns in JSON-like structures."""
    if isinstance(value, dict):
        cleaned: dict[Any, Any] = {}
        for k, v in value.items():
            key_str = str(k)
            if key_str == "image_base64":
                # F-04-09: the old blanket exemption let any value under
                # this key through unredacted. Preserve it only when it
                # is actually base64 image data; otherwise redact it.
                # Empty/missing values stay as they are.
                cleaned[k] = v if v in (None, "") or _is_plausible_image_base64(v) else "***REDACTED***"
            elif key_str in _PRESERVE_KEYS:
                cleaned[k] = v
            elif _SECRET_KEY_RE.match(key_str):
                cleaned[k] = "***REDACTED***" if v not in (None, "") else v
            else:
                cleaned[k] = redact_obj(v)
        return cleaned
    if isinstance(value, list):
        return [redact_obj(item) for item in value]
    if isinstance(value, tuple):
        return [redact_obj(item) for item in value]
    if isinstance(value, str):
        return redact(value)
    return value


def truncate_output(text: str, limit: int | None = None) -> str:
    lim = limit if limit is not None else get_settings().max_output_bytes
    text = redact(text)
    encoded = text.encode("utf-8", "replace")
    if len(encoded) > lim:
        clipped = encoded[:lim].decode("utf-8", "ignore")
        return clipped + f"\n[output truncated at {lim} bytes]"
    return text


# --- Outbound webhook SSRF validation (F-05-17 / SEC-11) ----------------
# Networks that must never be the target of an outbound webhook POST:
# RFC1918 private space, CGNAT, IETF protocol assignments, documentation
# ranges, multicast, and (via the ipaddress flags below) loopback,
# link-local, unspecified, and reserved addresses — including the
# 169.254.169.254 cloud-metadata address, which is link-local.
_BLOCKED_NETWORKS = (
    [ipaddress.ip_network(n) for n in (
        "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",  # RFC1918
        "100.64.0.0/10",  # CGNAT, RFC 6598
        "0.0.0.0/8", "192.0.0.0/24",  # "this network" / IETF assignments
        "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24",  # documentation
        "224.0.0.0/4", "240.0.0.0/4",  # multicast / reserved
        "::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8",  # IPv6
        "2001:db8::/32",  # IPv6 documentation
    )]
)


def _ip_is_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
        return True
    return any(ip in net for net in _BLOCKED_NETWORKS)


def validate_outbound_url(url: str) -> str:
    """SSRF validation for an outbound webhook URL. Returns ``url`` unchanged.

    Raises ValueError (before any connection is made) when the URL is
    not http(s), has no hostname, embeds credentials, or resolves to a
    blocked address. Every resolved A/AAAA address is checked, so a
    hostname with one public and one private answer is still rejected.

    Known limitation, documented deliberately: 198.18.0.0/15 (benchmark
    range) is NOT in the blocklist. It is non-routable on the public
    internet, but this environment's DNS wildcard resolves every
    hostname into it, so blocking it would break all webhook delivery
    here (including the existing worm_siem test host). The primary SSRF
    targets — RFC1918, loopback, link-local/metadata, CGNAT — are all
    blocked. Revisit if webhooks ever run where 198.18/15 is routed.
    """
    if not isinstance(url, str) or not url.strip():
        raise ValueError("Outbound webhook URL is empty.")
    parsed = urllib.parse.urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Outbound webhook URL must be http(s), got scheme {parsed.scheme!r}.")
    host = parsed.hostname
    if not host:
        raise ValueError("Outbound webhook URL has no hostname.")
    if parsed.username or parsed.password:
        raise ValueError("Outbound webhook URL must not embed credentials.")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addrinfos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, OSError) as exc:
        raise ValueError(f"Outbound webhook host {host!r} does not resolve: {exc}") from exc
    if not addrinfos:
        raise ValueError(f"Outbound webhook host {host!r} does not resolve.")
    for info in addrinfos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        try:
            ip = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            raise ValueError(f"Outbound webhook host {host!r} resolved to an unparsable address.")
        if _ip_is_blocked(ip):
            raise ValueError(f"Outbound webhook host {host!r} resolves to blocked address {ip}.")
    return url
