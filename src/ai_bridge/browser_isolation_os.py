"""Linux netns / gVisor-oriented browser egress isolation helpers.

Playwright Chromium still runs as a child process. When
``AI_BRIDGE_BROWSER_NETNS=1`` on Linux, launch wrappers prefer ``unshare`` /
``bwrap`` if present. gVisor ``runsc`` is detected but not auto-invoked unless
``AI_BRIDGE_BROWSER_GVISOR=1`` and ``runsc`` is on PATH.

F-04-14 (Wave 3C) — this module used to be detection-only: it reported
which tools exist and silently returned the unwrapped Chromium argv when
a requested sandbox was unavailable, so callers could believe they were
isolated when they were not. That is fixed here:

- :func:`chromium_launch_wrapper_argv` FAILS CLOSED: when a sandbox is
  explicitly requested (netns / gVisor) but the tooling is missing, it
  raises :class:`BrowserIsolationError` instead of returning the bare
  argv. The only escape is the explicit, documented opt-out
  ``AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX=1``.
- :func:`require_browser_sandbox` fails closed when
  ``AI_BRIDGE_BROWSER_REQUIRE_SANDBOX=1`` and no real sandbox can be
  established. ``browser_tools._ensure_browser`` calls it before launch.
- :func:`describe_os_browser_isolation` now reports ``enforced`` (True
  only when a wrapper will actually be applied) and is explicit that no
  seccomp filter is shipped: the bwrap argv drops all capabilities and
  read-only-binds system directories, but there is NO seccomp-BPF filter
  in this tree — ``seccomp`` is reported as ``"none"`` and must not be
  claimed elsewhere. Detection is not presented as isolation anywhere.
"""
from __future__ import annotations

import os
import shutil
import sys
from typing import Any


class BrowserIsolationError(RuntimeError):
    """Raised when a requested browser sandbox cannot be established."""


def browser_netns_requested() -> bool:
    return os.environ.get("AI_BRIDGE_BROWSER_NETNS", "").strip().lower() in ("1", "true", "yes")


def browser_gvisor_requested() -> bool:
    return os.environ.get("AI_BRIDGE_BROWSER_GVISOR", "").strip().lower() in ("1", "true", "yes")


def browser_no_sandbox_opt_out() -> bool:
    """Explicit, documented opt-out (F-04-14).

    ``AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX=1`` is the operator's deliberate
    statement that this host cannot run the Chromium sandbox. It is the
    ONLY bypass for the fail-closed checks in this module.
    """
    return os.environ.get("AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX", "").strip().lower() in (
        "1", "true", "yes",
    )


def browser_sandbox_required() -> bool:
    return os.environ.get("AI_BRIDGE_BROWSER_REQUIRE_SANDBOX", "").strip().lower() in (
        "1", "true", "yes",
    )


def describe_os_browser_isolation() -> dict[str, Any]:
    is_linux = sys.platform.startswith("linux")
    has_unshare = bool(shutil.which("unshare"))
    has_bwrap = bool(shutil.which("bwrap"))
    has_runsc = bool(shutil.which("runsc"))
    mode = "none"
    if browser_gvisor_requested() and has_runsc:
        mode = "gvisor_runsc"
    elif browser_netns_requested() and is_linux and (has_bwrap or has_unshare):
        mode = "linux_netns_wrapper"
    elif browser_netns_requested() and not is_linux:
        mode = "unsupported_platform"
    # `enforced` is True ONLY when a wrapper argv will actually be applied.
    # Mere detection of bwrap/unshare/runsc on PATH is not isolation.
    enforced = mode in ("gvisor_runsc", "linux_netns_wrapper")
    return {
        "platform": sys.platform,
        "netns_requested": browser_netns_requested(),
        "gvisor_requested": browser_gvisor_requested(),
        "has_unshare": has_unshare,
        "has_bwrap": has_bwrap,
        "has_runsc": has_runsc,
        "mode": mode,
        "enforced": enforced,
        "sandbox_required": browser_sandbox_required(),
        "no_sandbox_opt_out": browser_no_sandbox_opt_out(),
        # Honest: no seccomp-BPF filter is shipped in this tree. bwrap
        # drops capabilities and read-only-binds system dirs, but that
        # is not a syscall filter. Do not claim seccomp anywhere.
        "seccomp": "none",
        "limitations": [
            "Isolation wraps the Chromium process; it is not a separate agent worker VM.",
            "gVisor requires runsc on PATH and AI_BRIDGE_BROWSER_GVISOR=1.",
            "Non-Linux hosts cannot enable netns; Playwright sandbox still applies.",
            "No seccomp-BPF filter is shipped; bwrap drops capabilities but does not filter syscalls.",
            "When a sandbox is requested but its tooling is missing, launch is refused (fail closed) unless AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX=1.",
        ],
    }


def browser_sandbox_status() -> dict[str, Any]:
    """Operator-facing summary: what sandboxing is actually in force."""
    info = describe_os_browser_isolation()
    return {
        "mode": info["mode"],
        "enforced": info["enforced"],
        "seccomp": info["seccomp"],
        "sandbox_required": info["sandbox_required"],
        "no_sandbox_opt_out": info["no_sandbox_opt_out"],
    }


def require_browser_sandbox() -> dict[str, Any]:
    """Fail closed when a sandbox is required but cannot be established.

    Raises :class:`BrowserIsolationError` when
    ``AI_BRIDGE_BROWSER_REQUIRE_SANDBOX=1`` and no wrapper mode is
    available, or when netns/gVisor was explicitly requested but its
    tooling is missing. The explicit opt-out
    ``AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX=1`` bypasses the raise (and is
    reported in the returned status). Returns the sandbox status dict
    when launch may proceed.
    """
    info = describe_os_browser_isolation()
    if browser_no_sandbox_opt_out():
        return {**browser_sandbox_status(), "opted_out": True}
    requested = browser_netns_requested() or browser_gvisor_requested()
    if requested and not info["enforced"]:
        raise BrowserIsolationError(
            "Browser sandbox was requested (AI_BRIDGE_BROWSER_NETNS / "
            "AI_BRIDGE_BROWSER_GVISOR) but no usable sandbox tooling is "
            f"available on this host (mode={info['mode']}, platform={info['platform']}). "
            "Refusing to launch the browser unisolated. Set "
            "AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX=1 only if this host genuinely "
            "cannot run the Chromium sandbox."
        )
    if browser_sandbox_required() and not info["enforced"]:
        raise BrowserIsolationError(
            "AI_BRIDGE_BROWSER_REQUIRE_SANDBOX=1 but no browser sandbox can "
            f"be established on this host (mode={info['mode']}). Refusing to "
            "launch the browser. Set AI_BRIDGE_BROWSER_NETNS=1 (Linux with "
            "bwrap/unshare) or AI_BRIDGE_BROWSER_GVISOR=1 (runsc), or opt out "
            "explicitly with AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX=1."
        )
    return {**browser_sandbox_status(), "opted_out": False}


def chromium_launch_wrapper_argv(inner_argv: list[str]) -> list[str]:
    """Return argv that optionally wraps Chromium with bwrap/unshare/runsc.

    Fail-closed (F-04-14): if a sandbox was requested but its tooling is
    unavailable, raises :class:`BrowserIsolationError` instead of
    silently returning the unwrapped argv. The explicit opt-out
    ``AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX=1`` restores the old
    pass-through behaviour.
    """
    info = describe_os_browser_isolation()
    mode = info["mode"]
    if mode == "gvisor_runsc":
        return ["runsc", "do", "--"] + list(inner_argv)
    if mode == "linux_netns_wrapper":
        if info["has_bwrap"]:
            # Minimal network namespace + fresh /tmp; keep /usr and libs
            # visible read-only; drop all capabilities; new session so
            # the sandbox dies with its parent.
            return [
                "bwrap",
                "--unshare-net",
                "--die-with-parent",
                "--new-session",
                "--cap-drop", "ALL",
                "--ro-bind",
                "/usr",
                "/usr",
                "--ro-bind",
                "/lib",
                "/lib",
                "--ro-bind-try",
                "/lib64",
                "/lib64",
                "--ro-bind-try",
                "/etc/resolv.conf",
                "/etc/resolv.conf",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--tmpfs",
                "/tmp",
                "--",
            ] + list(inner_argv)
        if info["has_unshare"]:
            return ["unshare", "--net", "--"] + list(inner_argv)
    # Requested but unavailable -> fail closed (unless explicitly opted out).
    if (browser_netns_requested() or browser_gvisor_requested()) and not browser_no_sandbox_opt_out():
        raise BrowserIsolationError(
            "Browser sandbox requested but unavailable "
            f"(mode={mode}, platform={info['platform']}); refusing to run "
            "Chromium unwrapped. Set AI_BRIDGE_ALLOW_BROWSER_NO_SANDBOX=1 "
            "to opt out explicitly."
        )
    return list(inner_argv)
