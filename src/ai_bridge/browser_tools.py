"""Web browser automation via Playwright for MCP tool integration.

Provides structured web browser control: navigation, element interaction,
screenshots, and JavaScript execution. The browser instance is kept alive
across tool calls for session persistence (cookies, localStorage, page state).

All tools enforce the same policy/approval model as desktop automation.
"""
from __future__ import annotations

import base64
import functools
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .config import get_settings
from .policy import Policy
from .security import ensure_workspace
from .tools import _check, default_policy

# Singleton Playwright browser state — see F-04-13 note below.
_pw = None
_browser = None
_context = None
_page = None
_device_profile: dict[str, Any] = {
    "name": "desktop",
    "viewport": {"width": 1280, "height": 720},
    "is_mobile": False,
    "has_touch": False,
    "user_agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
}
_console_logs: list[dict[str, Any]] = []
_failed_requests: list[dict[str, Any]] = []

DEVICE_PRESETS: dict[str, dict[str, Any]] = {
    "desktop": {
        "name": "desktop",
        "viewport": {"width": 1280, "height": 720},
        "is_mobile": False,
        "has_touch": False,
        "user_agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
        ),
    },
    "desktop_1080": {
        "name": "desktop_1080",
        "viewport": {"width": 1920, "height": 1080},
        "is_mobile": False,
        "has_touch": False,
        "user_agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
        ),
    },
    "iphone": {
        "name": "iphone",
        "viewport": {"width": 390, "height": 844},
        "is_mobile": True,
        "has_touch": True,
        "user_agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        ),
    },
    "pixel": {
        "name": "pixel",
        "viewport": {"width": 412, "height": 915},
        "is_mobile": True,
        "has_touch": True,
        "user_agent": (
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
        ),
    },
    "tablet": {
        "name": "tablet",
        "viewport": {"width": 820, "height": 1180},
        "is_mobile": True,
        "has_touch": True,
        "user_agent": (
            "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
            "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        ),
    },
}


# ---------------------------------------------------------------------------
# F-04-13 — one locked browser context per session/device.
#
# The module-level globals above always describe the ACTIVE session only.
# Every other session's Playwright objects (pw/browser/context/page,
# profile, console/failed-request logs) live in _BROWSER_SESSIONS, keyed
# by session id or device id. _browser_session_scoped() swaps the active
# session in (under _BROWSER_LOCK, so browser ops are serialised) before
# a public function runs and swaps back afterwards. Two sessions therefore
# never share a context, page, cookies or localStorage, while callers
# that pass no session keep the historical "default" session behaviour.
# ---------------------------------------------------------------------------

_BROWSER_LOCK = threading.RLock()
_BROWSER_SESSIONS: dict[str, dict[str, Any]] = {}
_ACTIVE_SESSION_KEY = "default"


def _session_key(session_id: str | None = None, device_id: str | None = None) -> str:
    if session_id:
        return f"session:{session_id}"
    if device_id:
        return f"device:{device_id}"
    return "default"


def _fresh_session_state() -> dict[str, Any]:
    return {
        "pw": None, "browser": None, "context": None, "page": None,
        "profile": dict(DEVICE_PRESETS["desktop"]),
        "console_logs": [], "failed_requests": [],
    }


def _save_active_state() -> None:
    _BROWSER_SESSIONS[_ACTIVE_SESSION_KEY] = {
        "pw": _pw, "browser": _browser, "context": _context, "page": _page,
        "profile": _device_profile,
        "console_logs": _console_logs, "failed_requests": _failed_requests,
    }


def _activate_session(key: str, *, save: bool = True) -> None:
    """Swap the module globals to another session's stored state."""
    global _ACTIVE_SESSION_KEY, _pw, _browser, _context, _page
    global _device_profile, _console_logs, _failed_requests
    if key == _ACTIVE_SESSION_KEY:
        return
    if save:
        _save_active_state()
    state = _BROWSER_SESSIONS.get(key) or _fresh_session_state()
    _pw, _browser, _context, _page = state["pw"], state["browser"], state["context"], state["page"]
    _device_profile = state["profile"]
    _console_logs, _failed_requests = state["console_logs"], state["failed_requests"]
    _ACTIVE_SESSION_KEY = key


def _browser_session_scoped(fn):
    """Decorator: run a browser function inside one locked session.

    ``session_id`` / ``device_id`` kwargs select the session; when
    neither is given the call runs in whatever session is currently
    active (historical default). The lock is held for the whole call so
    two sessions' Playwright objects can never interleave.
    """
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        session_id = kwargs.pop("session_id", None)
        device_id = kwargs.pop("device_id", None)
        with _BROWSER_LOCK:
            prev_key = _ACTIVE_SESSION_KEY
            key = _session_key(session_id, device_id)
            if session_id is not None or device_id is not None:
                _activate_session(key)
            try:
                return fn(*args, **kwargs)
            finally:
                if _ACTIVE_SESSION_KEY != prev_key:
                    _activate_session(prev_key)
    return wrapper


def use_browser_session(session_id: str | None = None, device_id: str | None = None) -> str:
    """Persistently switch the active browser session; returns its key."""
    with _BROWSER_LOCK:
        key = _session_key(session_id, device_id)
        _activate_session(key)
        return key


def list_browser_sessions() -> list[dict[str, Any]]:
    """List known browser session keys and whether each has a live page."""
    with _BROWSER_LOCK:
        # Snapshot the active session only if it actually holds objects;
        # do not register an empty "default" entry just by listing.
        if _pw is not None or _browser is not None or _page is not None:
            _save_active_state()
        out = []
        for key, state in _BROWSER_SESSIONS.items():
            page = state.get("page")
            alive = False
            try:
                alive = page is not None and not page.is_closed()
            except Exception:
                alive = False
            out.append({
                "session_key": key,
                "active": key == _ACTIVE_SESSION_KEY,
                "has_page": alive,
                "has_browser": state.get("browser") is not None,
            })
        return out


def close_browser_session(session_id: str | None = None, device_id: str | None = None) -> bool:
    """Close and drop one browser session (its context/page/cookies)."""
    with _BROWSER_LOCK:
        key = _session_key(session_id, device_id)
        prev_key = _ACTIVE_SESSION_KEY
        _activate_session(key)
        try:
            had = _browser is not None or _page is not None
            _close_browser()
            _BROWSER_SESSIONS.pop(key, None)
            return had
        finally:
            if _ACTIVE_SESSION_KEY != prev_key and prev_key in _BROWSER_SESSIONS:
                # save=False: the popped key must not be re-registered.
                _activate_session(prev_key, save=False)
            elif _ACTIVE_SESSION_KEY != prev_key:
                # Previous session was dropped; fall back to default.
                _activate_session("default", save=False)


def close_all_browser_sessions() -> None:
    """Close every browser session (used on shutdown / in tests)."""
    global _ACTIVE_SESSION_KEY, _pw, _browser, _context, _page
    global _device_profile, _console_logs, _failed_requests
    with _BROWSER_LOCK:
        _save_active_state()  # make sure the active session is in the dict
        for key in list(_BROWSER_SESSIONS.keys()):
            _activate_session(key, save=False)
            _close_browser()
            _BROWSER_SESSIONS.pop(key, None)
        # Reset to a fresh default session without re-saving popped keys.
        _pw, _browser, _context, _page = None, None, None, None
        _device_profile = dict(DEVICE_PRESETS["desktop"])
        _console_logs, _failed_requests = [], []
        _ACTIVE_SESSION_KEY = "default"


# ---------------------------------------------------------------------------
# F-04-13 — URL allowlist for browser_evaluate.
# ---------------------------------------------------------------------------

def _evaluate_allowlist() -> list[str] | None:
    """Parsed AI_BRIDGE_BROWSER_EVALUATE_ALLOWLIST, or None if unconfigured.

    Entries are hostnames (``example.com``) or suffix patterns
    (``.example.com`` matches subdomains). When the env var is unset the
    allowlist is NOT configured and evaluate keeps its historical
    allow-all behaviour — reported as such by browser_session_info().
    """
    raw = os.environ.get("AI_BRIDGE_BROWSER_EVALUATE_ALLOWLIST", "").strip()
    if not raw:
        return None
    return [h.strip().lower().lstrip("*").lstrip(".") for h in raw.split(",") if h.strip()]


def _evaluate_url_allowed(url: str) -> bool:
    """True when ``url``'s host is on the evaluate allowlist (or no list)."""
    allowlist = _evaluate_allowlist()
    if allowlist is None:
        return True
    try:
        from urllib.parse import urlparse

        host = (urlparse(url or "").hostname or "").lower()
    except Exception:
        return False
    for entry in allowlist:
        if host == entry or host.endswith("." + entry):
            return True
    return False


def _require_evaluate_url_allowed(url: str) -> None:
    if not _evaluate_url_allowed(url):
        raise ValueError(
            f"browser_evaluate refused: current page URL {url!r} is not on "
            "the AI_BRIDGE_BROWSER_EVALUATE_ALLOWLIST. Refusing to run "
            "arbitrary JavaScript on a non-allowlisted page."
        )


def _validate_http_url(url: str) -> None:
    from urllib.parse import urlparse

    parsed = urlparse(url or "")
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"URL must be http(s) with a host: {url!r}")


class BrowserToolError(RuntimeError):
    """Playwright/browser failures with an operator-friendly message."""


def resolve_device_profile(
    device: str | None = None,
    *,
    width: int | None = None,
    height: int | None = None,
    is_mobile: bool | None = None,
    has_touch: bool | None = None,
) -> dict[str, Any]:
    """Resolve a named preset plus optional viewport overrides."""
    key = (device or "desktop").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {"mobile": "iphone", "phone": "iphone", "android": "pixel"}
    key = aliases.get(key, key)
    base = dict(DEVICE_PRESETS.get(key) or DEVICE_PRESETS["desktop"])
    vp = dict(base.get("viewport") or {"width": 1280, "height": 720})
    if width is not None:
        vp["width"] = max(200, min(int(width), 3840))
    if height is not None:
        vp["height"] = max(200, min(int(height), 2160))
    base["viewport"] = vp
    if is_mobile is not None:
        base["is_mobile"] = bool(is_mobile)
    if has_touch is not None:
        base["has_touch"] = bool(has_touch)
    if key not in DEVICE_PRESETS and device:
        base["name"] = str(device)
    return base


def _default_timeout_sec(fallback: int = 30) -> int:
    raw = os.environ.get("AI_BRIDGE_BROWSER_NAV_TIMEOUT_SEC", str(fallback)).strip()
    try:
        return max(5, min(int(raw), 180))
    except ValueError:
        return fallback


def _allow_browser_no_sandbox() -> bool:
    return os.environ.get("AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX", "0").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def _hard_browser_isolation() -> bool:
    return os.environ.get("AI_BRIDGE_BROWSER_HARD_ISOLATION", "0").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def _browser_network_lockdown() -> bool:
    return os.environ.get("AI_BRIDGE_BROWSER_NETWORK_LOCKDOWN", "0").strip().lower() in (
        "1",
        "true",
        "yes",
    )


@_browser_session_scoped
def browser_isolation_report() -> dict[str, Any]:
    """Operator-facing honesty for Playwright isolation (+ optional OS netns/gVisor)."""
    try:
        from ai_bridge import browser_isolation_os

        os_iso = browser_isolation_os.describe_os_browser_isolation()
    except Exception as exc:
        os_iso = {"error": str(exc), "mode": "none"}
    return {
        "hard_isolation": _hard_browser_isolation(),
        "network_lockdown": _browser_network_lockdown(),
        "chromium_subprocess": True,
        "secondary_os_process": False,
        "os_isolation": os_iso,
        # F-04-14: enforced is True only when a real sandbox wrapper will
        # be applied; mere detection of bwrap/unshare is not isolation.
        "isolation_enforced": bool((os_iso or {}).get("enforced", False)),
        "seccomp": (os_iso or {}).get("seccomp", "none"),
        "limitations": [
            "Playwright runs Chromium in a child process; this is not a separate agent worker.",
            "Network lockdown uses Chromium host-resolver rules only — not full egress firewalling.",
            "Linux netns/gVisor wrappers activate only with AI_BRIDGE_BROWSER_NETNS / AI_BRIDGE_BROWSER_GVISOR and host tools.",
        ],
    }


def playwright_launch_options(*, headless: bool = True, create_dir: bool = True) -> dict[str, Any]:
    """Pure launch config for tests — Chromium sandbox on unless explicitly opted out."""
    launch_args: list[str] = []
    if _allow_browser_no_sandbox():
        launch_args.extend(["--no-sandbox", "--disable-setuid-sandbox"])
    if _hard_browser_isolation():
        launch_args.extend(
            [
                "--incognito",
                "--disable-extensions",
                "--disable-sync",
                "--no-first-run",
                "--disable-default-apps",
                "--disable-features=Translate,MediaRouter",
            ]
        )
    if _browser_network_lockdown():
        launch_args.append("--host-resolver-rules=MAP * 127.0.0.1")
    profile_parent = ensure_workspace() / ".ai-bridge" / "browser-profiles"
    if create_dir:
        profile_parent.mkdir(parents=True, exist_ok=True)
        user_data_dir = profile_parent / uuid.uuid4().hex[:12]
    else:
        user_data_dir = profile_parent / "default"
    isolation = browser_isolation_report()
    return {
        "headless": headless,
        "args": launch_args or None,
        "user_data_dir": str(user_data_dir),
        "chromium_sandbox": not _allow_browser_no_sandbox(),
        "isolation_level": "hard" if _hard_browser_isolation() else "standard",
        "isolation": isolation,
    }


@_browser_session_scoped
def browser_session_info() -> dict:
    """Return whether a reusable Playwright session is active (fleet diagnostics)."""
    alive = _page is not None and not _page.is_closed()
    opts = playwright_launch_options(create_dir=False)
    allowlist = _evaluate_allowlist()
    return {
        "active": alive,
        "has_browser": _browser is not None,
        "session_key": _ACTIVE_SESSION_KEY,
        "default_timeout_sec": _default_timeout_sec(),
        "chromium_sandbox": opts["chromium_sandbox"],
        "user_data_dir": opts["user_data_dir"],
        "isolation_level": opts.get("isolation_level", "standard"),
        "isolation": opts.get("isolation") or browser_isolation_report(),
        "isolation_enforced": bool((opts.get("isolation") or {}).get("os_isolation", {}).get("enforced", False)),
        "evaluate_allowlist_configured": allowlist is not None,
        "evaluate_allowlist": allowlist,
        "device": dict(_device_profile),
        "console_errors": len([c for c in _console_logs if c.get("type") == "error"]),
        "failed_requests": len(_failed_requests),
    }


@_browser_session_scoped
def browser_snapshot(
    selector: str = "body",
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict[str, Any]:
    """Capture combined URL, visible text, and interactive DOM elements from the active browser page."""
    url_info = browser_get_url(approval_granted=approval_granted, policy=policy)
    text_info = browser_get_text(selector, approval_granted=approval_granted, policy=policy)
    el_info = browser_get_elements(
        "a,button,input,textarea,select,[role='button']",
        include_text=True,
        approval_granted=approval_granted,
        policy=policy,
    )
    return {"ok": True, "url": url_info, "text": text_info, "elements": el_info}


@_browser_session_scoped
def attach_external_page(pw, browser, context, page, *, device: dict[str, Any] | None = None) -> None:
    """Adopt an externally connected Playwright page (e.g. Browserbase CDP)."""
    global _pw, _browser, _context, _page, _device_profile, _console_logs, _failed_requests
    _close_browser()
    _pw, _browser, _context, _page = pw, browser, context, page
    if device:
        _device_profile = resolve_device_profile(
            device.get("name"),
            width=(device.get("viewport") or {}).get("width"),
            height=(device.get("viewport") or {}).get("height"),
            is_mobile=device.get("is_mobile"),
            has_touch=device.get("has_touch"),
        )
    _console_logs = []
    _failed_requests = []
    _wire_page_diagnostics(page)


def _wire_page_diagnostics(page) -> None:
    try:
        page.on(
            "console",
            lambda msg: _console_logs.append(
                {"type": msg.type, "text": (msg.text or "")[:500], "ts": time.time()}
            ),
        )
        page.on(
            "requestfailed",
            lambda req: _failed_requests.append(
                {
                    "url": req.url,
                    "method": req.method,
                    "failure": (req.failure or "")[:300],
                    "ts": time.time(),
                }
            ),
        )
    except Exception:
        pass


def _playwright_err(action: str, exc: Exception) -> BrowserToolError:
    hint = (
        "Ensure Chromium is installed (playwright install chromium). "
        "Only set AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX=1 on hosts that cannot run the Chromium sandbox."
    )
    return BrowserToolError(f"{action} failed: {exc}. {hint}")


def _ensure_browser(headless: bool = True) -> Any:
    """Lazy-initialize Playwright browser (Chromium). Returns the active page."""
    global _pw, _browser, _context, _page
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "Playwright is required for browser automation. "
            "Install it with: pip install playwright && playwright install chromium"
        ) from exc

    if _page is not None and not _page.is_closed():
        return _page

    # Clean up stale state
    if _browser is not None:
        try:
            _browser.close()
        except Exception:
            pass
    if _pw is not None:
        try:
            _pw.stop()
        except Exception:
            pass

    # F-04-14: refuse to launch when a requested/required sandbox cannot
    # be established (unless the explicit no-sandbox opt-out is set).
    from ai_bridge import browser_isolation_os as _bio

    _bio.require_browser_sandbox()
    opts = playwright_launch_options(headless=headless)
    launch_args = opts.get("args")
    profile_dir = Path(str(opts["user_data_dir"]))
    profile_dir.mkdir(parents=True, exist_ok=True)
    try:
        _pw = sync_playwright().start()
        launch_kwargs: dict[str, Any] = {"headless": headless, "args": launch_args}
        try:
            _browser = _pw.chromium.launch(
                **launch_kwargs,
                chromium_sandbox=bool(opts["chromium_sandbox"]),
            )
        except TypeError:
            _browser = _pw.chromium.launch(**launch_kwargs)
        profile = dict(_device_profile)
        ctx_kwargs: dict[str, Any] = {
            "viewport": dict(profile.get("viewport") or {"width": 1280, "height": 720}),
            "user_agent": profile.get("user_agent"),
            "is_mobile": bool(profile.get("is_mobile")),
            "has_touch": bool(profile.get("has_touch")),
            "storage_state": None,
        }
        _context = _browser.new_context(**ctx_kwargs)
        _page = _context.new_page()
        nav_timeout = _default_timeout_sec() * 1000
        _page.set_default_navigation_timeout(nav_timeout)
        _page.set_default_timeout(nav_timeout)
        global _console_logs, _failed_requests
        _console_logs = []
        _failed_requests = []
        _wire_page_diagnostics(_page)
    except Exception as exc:
        raise _playwright_err("Browser launch", exc) from exc
    return _page


def _close_browser() -> None:
    """Close the browser and clean up resources."""
    global _pw, _browser, _context, _page, _console_logs, _failed_requests
    if _page is not None:
        try:
            _page.close()
        except Exception:
            pass
        _page = None
    if _context is not None:
        try:
            _context.close()
        except Exception:
            pass
        _context = None
    if _browser is not None:
        try:
            _browser.close()
        except Exception:
            pass
        _browser = None
    if _pw is not None:
        try:
            _pw.stop()
        except Exception:
            pass
        _pw = None
    _console_logs = []
    _failed_requests = []


def _page_info(page) -> dict:
    """Extract current page metadata."""
    return {
        "url": page.url,
        "title": page.title(),
        "session_key": _ACTIVE_SESSION_KEY,
        "device": dict(_device_profile),
        "viewport": page.viewport_size or dict((_device_profile.get("viewport") or {})),
    }


def _screenshot_page(page, full_page: bool = False) -> dict:
    """Capture a screenshot of the current page viewport or full page."""
    shot_bytes = page.screenshot(full_page=full_page, type="jpeg", quality=80)
    b64 = base64.b64encode(shot_bytes).decode("ascii")
    viewport = page.viewport_size or {"width": 0, "height": 0}
    return {
        "available": True,
        "image_base64": b64,
        "mime_type": "image/jpeg",
        "width": viewport.get("width", 0),
        "height": viewport.get("height", 0),
        "full_page": full_page,
        "device": dict(_device_profile),
    }


# ---------------------------------------------------------------------------
# Browser MCP Tools
# ---------------------------------------------------------------------------

@_browser_session_scoped
def browser_navigate(
    url: str,
    *,
    wait_until: str = "networkidle",
    timeout: int | None = None,
    screenshot_after_nav: bool = False,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Navigate the browser to a URL.

    url: Target URL (must be http:// or https://).
    wait_until: When to consider navigation complete ('load', 'domcontentloaded', 'networkidle').
    timeout: Maximum seconds to wait for navigation.
    """
    eff_policy = policy or default_policy()
    _check("browser_navigate", approval_granted=approval_granted, policy=eff_policy)
    _validate_http_url(url)
    eff_timeout = timeout if timeout is not None else _default_timeout_sec()
    page = _ensure_browser()
    try:
        page.goto(url, wait_until=wait_until, timeout=eff_timeout * 1000)
    except Exception as exc:
        raise _playwright_err("browser_navigate", exc) from exc
    out: dict = {"ok": True, "action": "browser_navigate", **_page_info(page), "session": browser_session_info()}
    if screenshot_after_nav:
        out["screenshot"] = _screenshot_page(page, full_page=False)
    return out


@_browser_session_scoped
def browser_screenshot(
    full_page: bool = False,
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Capture a screenshot of the current browser page.

    full_page: When True, captures the entire scrollable page instead of just the viewport.
    """
    eff_policy = policy or default_policy()
    _check("browser_screenshot", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    return {"ok": True, "action": "browser_screenshot", **_screenshot_page(page, full_page=full_page)}


@_browser_session_scoped
def browser_click(
    selector: str,
    *,
    button: str = "left",
    clicks: int = 1,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Click an element on the current page matching a CSS selector.

    selector: CSS selector (e.g. 'button#submit', '.nav-link').
    button: 'left', 'right', or 'middle'.
    clicks: Number of clicks (1 for single, 2 for double).
    """
    eff_policy = policy or default_policy()
    _check("browser_click", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    el = page.locator(selector).first
    if clicks == 2:
        el.dblclick(button=button)
    else:
        el.click(button=button, click_count=clicks)
    return {"ok": True, "action": "browser_click", "selector": selector, **_page_info(page)}


@_browser_session_scoped
def browser_type(
    selector: str,
    text: str,
    *,
    clear_first: bool = True,
    submit: bool = False,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Type text into an input element matching a CSS selector.

    selector: CSS selector for the input/textarea element.
    text: Text to type.
    clear_first: Clear existing content before typing.
    submit: Press Enter after typing.
    """
    eff_policy = policy or default_policy()
    _check("browser_type", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    el = page.locator(selector).first
    if clear_first:
        el.fill(text)
    else:
        el.type(text)
    if submit:
        el.press("Enter")
    return {"ok": True, "action": "browser_type", "selector": selector, "text": text, **_page_info(page)}


@_browser_session_scoped
def browser_get_text(
    selector: str = "body",
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Extract visible text content from elements matching a CSS selector.

    selector: CSS selector (default 'body' for full page text).
    """
    eff_policy = policy or default_policy()
    _check("browser_get_text", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    texts = page.locator(selector).all_inner_texts()
    return {
        "ok": True,
        "action": "browser_get_text",
        "selector": selector,
        "count": len(texts),
        "texts": texts,
        **_page_info(page),
    }


@_browser_session_scoped
def browser_evaluate(
    script: str,
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Execute JavaScript in the current page context and return the result.

    script: JavaScript code to execute. Use 'return' to yield a value.
    """
    eff_policy = policy or default_policy()
    _check("browser_evaluate", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    _require_evaluate_url_allowed(page.url)
    result = page.evaluate(script)
    # Serialize safely
    try:
        serialized = result if isinstance(result, (str, int, float, bool, type(None))) else str(result)
    except Exception:
        serialized = str(result)
    return {
        "ok": True,
        "action": "browser_evaluate",
        "result": serialized,
        **_page_info(page),
    }


@_browser_session_scoped
def browser_get_url(
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Return the current page URL and title."""
    eff_policy = policy or default_policy()
    _check("browser_get_url", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    return {"ok": True, "action": "browser_get_url", **_page_info(page)}


@_browser_session_scoped
def browser_go_back(
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Navigate back in browser history."""
    eff_policy = policy or default_policy()
    _check("browser_go_back", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    page.go_back()
    return {"ok": True, "action": "browser_go_back", **_page_info(page)}


@_browser_session_scoped
def browser_go_forward(
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Navigate forward in browser history."""
    eff_policy = policy or default_policy()
    _check("browser_go_forward", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    page.go_forward()
    return {"ok": True, "action": "browser_go_forward", **_page_info(page)}


@_browser_session_scoped
def browser_scroll(
    delta_y: int = 0,
    delta_x: int = 0,
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Scroll the current page by delta pixels.

    delta_y: Vertical scroll amount (positive = down, negative = up).
    delta_x: Horizontal scroll amount (positive = right, negative = left).
    """
    eff_policy = policy or default_policy()
    _check("browser_scroll", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    page.evaluate(f"window.scrollBy({delta_x}, {delta_y})")
    return {"ok": True, "action": "browser_scroll", "delta_x": delta_x, "delta_y": delta_y, **_page_info(page)}


@_browser_session_scoped
def browser_close(
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Close the browser and release all resources."""
    eff_policy = policy or default_policy()
    _check("browser_close", approval_granted=approval_granted, policy=eff_policy)
    _close_browser()
    return {"ok": True, "action": "browser_close", "note": "Browser closed."}


@_browser_session_scoped
def browser_new_page(
    url: str | None = None,
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Open a new browser tab. Optionally navigate to a URL.

    url: Optional URL to navigate the new tab to.
    """
    eff_policy = policy or default_policy()
    _check("browser_new_page", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    if url:
        _validate_http_url(url)
    new_page = page.context.new_page()
    global _page
    _page = new_page
    if url:
        new_page.goto(url)
    return {"ok": True, "action": "browser_new_page", **_page_info(new_page)}


@_browser_session_scoped
def browser_get_elements(
    selector: str,
    *,
    include_text: bool = True,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """List elements matching a CSS selector with tag names, counts, and optional text snippets.

    selector: CSS selector to query.
    include_text: Include visible text for each matched element.
    """
    eff_policy = policy or default_policy()
    _check("browser_get_elements", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    loc = page.locator(selector)
    count = loc.count()
    elements: list[dict] = []
    for i in range(min(count, 50)):
        el = loc.nth(i)
        tag = el.evaluate("el => el.tagName.toLowerCase()")
        info: dict[str, Any] = {"index": i, "tag": tag}
        if include_text:
            try:
                info["text"] = el.inner_text()[:200]
            except Exception:
                info["text"] = ""
        try:
            info["id"] = el.get_attribute("id") or ""
            info["class"] = el.get_attribute("class") or ""
        except Exception:
            pass
        elements.append(info)
    return {
        "ok": True,
        "action": "browser_get_elements",
        "selector": selector,
        "count": count,
        "elements": elements,
        **_page_info(page),
    }


@_browser_session_scoped
def browser_wait_for_selector(
    selector: str,
    timeout: int = 10,
    *,
    state: str = "visible",
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Wait until an element matching the CSS selector appears (or disappears) on the page.

    selector: CSS selector to wait for.
    timeout: Maximum seconds to wait.
    state: 'visible', 'hidden', 'attached', or 'detached'.
    """
    from .control.task_runtime import TaskCancelled, raise_if_cancelled

    eff_policy = policy or default_policy()
    _check("browser_wait_for_selector", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    # Slice Playwright waits so fleet cancel can interrupt long selector polls.
    deadline = time.time() + max(0.5, float(timeout))
    last_exc: Exception | None = None
    while True:
        raise_if_cancelled()
        rem_ms = int(max(0.0, deadline - time.time()) * 1000)
        if rem_ms <= 0:
            if last_exc is not None:
                raise last_exc
            raise TimeoutError(f"Timeout waiting for selector {selector!r} (state={state})")
        slice_ms = min(500, rem_ms)
        try:
            page.locator(selector).first.wait_for(state=state, timeout=slice_ms)
            break
        except TaskCancelled:
            raise
        except Exception as exc:  # noqa: BLE001 — retry until overall deadline
            last_exc = exc
            if time.time() >= deadline:
                raise
    return {
        "ok": True,
        "action": "browser_wait_for_selector",
        "selector": selector,
        "state": state,
        **_page_info(page),
    }


@_browser_session_scoped
def browser_select_option(
    selector: str,
    value: str | None = None,
    label: str | None = None,
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Select an option in a <select> dropdown by value or visible label.

    selector: CSS selector for the <select> element.
    value: Option value attribute to select.
    label: Visible text of the option to select.
    """
    eff_policy = policy or default_policy()
    _check("browser_select_option", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    el = page.locator(selector).first
    if value is not None:
        el.select_option(value=value)
    elif label is not None:
        el.select_option(label=label)
    else:
        raise ValueError("Either 'value' or 'label' must be provided.")
    return {"ok": True, "action": "browser_select_option", "selector": selector, **_page_info(page)}


@_browser_session_scoped
def browser_download_file(
    url: str,
    filename: str | None = None,
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Download a file via the browser context to the workspace data directory.

    url: Direct URL of the file to download.
    filename: Optional filename override (defaults to URL basename).
    """
    eff_policy = policy or default_policy()
    _check("browser_download_file", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"URL must be http(s): {url}")
    fname = filename or (parsed.path.split("/")[-1] or "download")
    out_dir = get_settings().data_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / fname
    # Use browser context to download (respects cookies/session)
    with page.expect_download() as download_info:
        page.evaluate(f"window.location.href = {url!r}")
    download = download_info.value
    download.save_as(str(out_path))
    return {
        "ok": True,
        "action": "browser_download_file",
        "url": url,
        "path": str(out_path),
        "filename": fname,
        **_page_info(page),
    }


@_browser_session_scoped
def browser_set_viewport(
    device: str = "desktop",
    *,
    width: int | None = None,
    height: int | None = None,
    is_mobile: bool | None = None,
    has_touch: bool | None = None,
    recreate_context: bool = True,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Set desktop/mobile device preset (and optional custom size) for the browser session."""
    global _device_profile, _context, _page
    eff_policy = policy or default_policy()
    _check("browser_set_viewport", approval_granted=approval_granted, policy=eff_policy)
    profile = resolve_device_profile(
        device, width=width, height=height, is_mobile=is_mobile, has_touch=has_touch
    )
    _device_profile = profile
    page = None
    if _browser is not None and recreate_context:
        try:
            if _page is not None:
                try:
                    _page.close()
                except Exception:
                    pass
            if _context is not None:
                try:
                    _context.close()
                except Exception:
                    pass
            _context = _browser.new_context(
                viewport=dict(profile["viewport"]),
                user_agent=profile.get("user_agent"),
                is_mobile=bool(profile.get("is_mobile")),
                has_touch=bool(profile.get("has_touch")),
            )
            _page = _context.new_page()
            _wire_page_diagnostics(_page)
            page = _page
        except Exception as exc:
            raise _playwright_err("browser_set_viewport", exc) from exc
    elif _page is not None and not _page.is_closed():
        try:
            _page.set_viewport_size(dict(profile["viewport"]))
            page = _page
        except Exception as exc:
            raise _playwright_err("browser_set_viewport", exc) from exc
    return {
        "ok": True,
        "action": "browser_set_viewport",
        "device": profile,
        "presets": list(DEVICE_PRESETS.keys()),
        **(_page_info(page) if page is not None else {}),
    }


@_browser_session_scoped
def browser_expect(
    *,
    text: str | None = None,
    url_contains: str | None = None,
    title_contains: str | None = None,
    selector: str | None = None,
    visible: bool = True,
    screenshot_on_fail: bool = False,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Structured assert helper for fleet/MCP website tests."""
    eff_policy = policy or default_policy()
    _check("browser_expect", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    checks: list[dict[str, Any]] = []
    ok = True
    if text:
        body = page.locator("body").inner_text()
        found = text.lower() in (body or "").lower()
        checks.append({"kind": "text", "expected": text, "ok": found})
        ok = ok and found
    if url_contains:
        found = url_contains.lower() in (page.url or "").lower()
        checks.append({"kind": "url_contains", "expected": url_contains, "actual": page.url, "ok": found})
        ok = ok and found
    if title_contains:
        title = page.title() or ""
        found = title_contains.lower() in title.lower()
        checks.append({"kind": "title_contains", "expected": title_contains, "actual": title, "ok": found})
        ok = ok and found
    if selector:
        loc = page.locator(selector).first
        count = page.locator(selector).count()
        is_vis = False
        try:
            is_vis = bool(loc.is_visible()) if count else False
        except Exception:
            is_vis = False
        found = (is_vis if visible else count > 0)
        checks.append(
            {
                "kind": "selector",
                "expected": selector,
                "visible": visible,
                "count": count,
                "is_visible": is_vis,
                "ok": found,
            }
        )
        ok = ok and found
    out: dict[str, Any] = {
        "ok": ok,
        "action": "browser_expect",
        "checks": checks,
        **_page_info(page),
    }
    if not ok and screenshot_on_fail:
        out["screenshot"] = _screenshot_page(page, full_page=False)
        out["console_errors"] = [c for c in _console_logs if c.get("type") == "error"][-20:]
        out["failed_requests"] = list(_failed_requests)[-20:]
    return out


@_browser_session_scoped
def browser_wait_for_url(
    url_contains: str,
    timeout: int = 15,
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Wait until the current URL contains the given substring."""
    from .control.task_runtime import raise_if_cancelled

    eff_policy = policy or default_policy()
    _check("browser_wait_for_url", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    needle = (url_contains or "").strip().lower()
    if not needle:
        raise ValueError("url_contains is required.")
    deadline = time.time() + max(0.5, float(timeout))
    while time.time() < deadline:
        raise_if_cancelled()
        if needle in (page.url or "").lower():
            return {"ok": True, "action": "browser_wait_for_url", "matched": True, **_page_info(page)}
        time.sleep(0.2)
    return {
        "ok": False,
        "action": "browser_wait_for_url",
        "matched": False,
        "expected": url_contains,
        **_page_info(page),
    }


@_browser_session_scoped
def browser_diagnostics(
    *,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Return recent console errors and failed network requests for the active page."""
    eff_policy = policy or default_policy()
    _check("browser_diagnostics", approval_granted=approval_granted, policy=eff_policy)
    page = _ensure_browser()
    return {
        "ok": True,
        "action": "browser_diagnostics",
        "console": list(_console_logs)[-50:],
        "failed_requests": list(_failed_requests)[-50:],
        **_page_info(page),
    }


def _baseline_dir() -> Path:
    d = ensure_workspace() / ".ai-bridge" / "visual-baselines"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _image_rmse(a_bytes: bytes, b_bytes: bytes) -> float:
    """Normalized RMSE (0..1) between two images after resize to a common size."""
    try:
        import io

        from PIL import Image

        ia = Image.open(io.BytesIO(a_bytes)).convert("L").resize((64, 64))
        ib = Image.open(io.BytesIO(b_bytes)).convert("L").resize((64, 64))
        pa = list(ia.getdata())
        pb = list(ib.getdata())
        if not pa:
            return 1.0
        acc = 0.0
        for x, y in zip(pa, pb):
            d = (x - y) / 255.0
            acc += d * d
        return (acc / len(pa)) ** 0.5
    except Exception:
        # Fallback: raw byte mismatch ratio
        n = max(len(a_bytes), len(b_bytes), 1)
        mism = sum(1 for i in range(min(len(a_bytes), len(b_bytes))) if a_bytes[i] != b_bytes[i])
        mism += abs(len(a_bytes) - len(b_bytes))
        return min(1.0, mism / n)


@_browser_session_scoped
def browser_compare_screenshot(
    baseline: str,
    *,
    threshold: float = 0.08,
    full_page: bool = False,
    update_baseline: bool = False,
    approval_granted: bool = False,
    policy: Policy | None = None,
) -> dict:
    """Compare current page screenshot to a workspace baseline (visual validation)."""
    eff_policy = policy or default_policy()
    _check("browser_compare_screenshot", approval_granted=approval_granted, policy=eff_policy)
    name = Path(str(baseline)).name
    if not name or name in {".", ".."}:
        raise ValueError("baseline must be a simple filename.")
    path = _baseline_dir() / name
    page = _ensure_browser()
    shot = page.screenshot(full_page=full_page, type="png")
    if update_baseline or not path.exists():
        path.write_bytes(shot)
        return {
            "ok": True,
            "action": "browser_compare_screenshot",
            "matched": True,
            "updated_baseline": True,
            "baseline": str(path),
            "rmse": 0.0,
            "threshold": threshold,
            **_page_info(page),
        }
    base = path.read_bytes()
    rmse = float(_image_rmse(base, shot))
    matched = rmse <= float(threshold)
    out: dict[str, Any] = {
        "ok": matched,
        "action": "browser_compare_screenshot",
        "matched": matched,
        "updated_baseline": False,
        "baseline": str(path),
        "rmse": round(rmse, 5),
        "threshold": float(threshold),
        **_page_info(page),
    }
    if not matched:
        diff_path = _baseline_dir() / f"diff-{name}"
        diff_path.write_bytes(shot)
        out["actual_path"] = str(diff_path)
    return out


def compare_image_bytes(a: bytes, b: bytes, *, threshold: float = 0.08) -> dict[str, Any]:
    """Pure helper for unit tests — RMSE compare without Playwright."""
    rmse = float(_image_rmse(a, b))
    return {"ok": rmse <= threshold, "matched": rmse <= threshold, "rmse": rmse, "threshold": threshold}
