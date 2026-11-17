"""AI Bridge Python SDK Client.

Connect your custom AI agents, scripts, and LLMs directly to your computer fleet
(Windows workstations, Linux servers, WSL) through AI Bridge.

Quickstart:
    from ai_bridge import AIBridgeClient

    client = AIBridgeClient(base_url="http://127.0.0.1:8000", token="your-token")

    # List online devices
    devices = client.list_devices()
    print("Fleet:", [d["name"] for d in devices])

    # Run command on Linux
    result = client.run_shell("uptime", device="ubuntu")
    print("Ubuntu uptime:", result)

    # Capture Windows desktop screenshot
    shot = client.take_screenshot(device="windows-pc")
    print(f"Captured screenshot: {shot.get('width')}x{shot.get('height')}")

    # Control mouse & keyboard
    client.mouse_click(x=100, y=200, device="windows-pc")
    client.keyboard_type("notepad.exe\n", device="windows-pc")

    # Export tools for OpenAI function calling
    openai_tools = client.get_tools(format="openai")
"""
from __future__ import annotations

import json
import os
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from .policy_simulation import is_demo_mode as _is_demo_mode


# ---------------------------------------------------------------------------
# FR-03 — task result projection (list path returns metadata, not full text)
# ---------------------------------------------------------------------------

#: Keys whose full text must never appear in a projected task summary.
_PROJECT_STRIPPED_KEYS = ("result", "output", "stdout", "stderr", "error_detail")


def project_task_summaries(
    tasks: list[dict[str, Any]] | None,
    *,
    preview_chars: int = 200,
) -> list[dict[str, Any]]:
    """Project task rows to summaries WITHOUT the multi-MB result TEXT.

    Keeps only id / status / device / timestamps plus a truncated preview
    of the result. The full ``result``/``output`` text is never copied
    into the output, so a 200-row list stays small. Pure function — it
    does not fetch anything. Server-side wiring (``SELECT`` explicit
    columns in the control plane list endpoint) needs a ``control/app.py``
    change and is documented as a Wave 4 follow-up; this helper is the
    client-side half and is used by :meth:`AIBridgeClient.list_task_summaries`.
    """
    summaries: list[dict[str, Any]] = []
    for task in tasks or []:
        if not isinstance(task, dict):
            continue
        result = task.get("result", task.get("output", ""))
        preview = ""
        if result is not None:
            text = result if isinstance(result, str) else json.dumps(result, default=str)
            preview = text[:max(0, preview_chars)]
            if len(text) > max(0, preview_chars):
                preview += "… [truncated]"
        summaries.append({
            "id": task.get("id") or task.get("task_id"),
            "task_id": task.get("task_id") or task.get("id"),
            "name": task.get("name") or task.get("task_name"),
            "status": task.get("status"),
            "device": task.get("device") or task.get("device_id"),
            "created_at": task.get("created_at"),
            "updated_at": task.get("updated_at"),
            "finished_at": task.get("finished_at"),
            "started_at": task.get("started_at"),
            "returncode": task.get("returncode"),
            "result_preview": preview,
            "result_truncated": bool(result) and len(str(result)) > max(0, preview_chars),
        })
    return summaries


def _redact_token_from_text(text: str, token: str) -> str:
    """Remove the token value (and any bearer form) from log/error text."""
    if not text or not token:
        return text
    out = text.replace(token, "***")
    return out


def _error_code_for_status(status_code: int | None) -> str:
    """Small shared error taxonomy for the SDK (FR-06)."""
    if status_code is None:
        return "transport"
    if status_code in (401, 403):
        return "auth"
    if status_code == 404:
        return "not_found"
    if status_code == 409:
        return "conflict"
    if status_code == 429:
        return "rate_limited"
    if status_code == 422:
        return "validation"
    if status_code >= 500:
        return "server"
    return "request"


class AIBridgeError(RuntimeError):
    """Base exception for AI Bridge client operations."""
    def __init__(self, message: str, status_code: int | None = None, details: Any = None,
                 code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details
        # FR-06: taxonomy code (auth/not_found/rate_limited/server/...).
        self.code = code or _error_code_for_status(status_code)


class AIBridgeClient:
    """Client for the AI Bridge Control Plane and Device Fleet API."""

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        timeout: int = 60,
        max_retries: int = 2,
        retry_backoff_base: float = 0.5,
    ):
        """Initialize AI Bridge client.

        Args:
            base_url: Control plane URL (e.g. 'https://jxiptvplayer.app' or 'http://localhost:8000').
                      Defaults to AI_BRIDGE_URL or AI_BRIDGE_CONTROL_URL or http://127.0.0.1:8000.
            token: Admin token, user session token, or OAuth bearer token.
                   Defaults to AI_BRIDGE_TOKEN_FILE (0600 file, read-only),
                   then AI_BRIDGE_ADMIN_TOKEN or AI_BRIDGE_TOKEN.
                   The token is stored only in memory, sent only as an
                   ``Authorization`` header, and NEVER placed in a URL,
                   query string, log line, repr, or error message (F-04-19).
            timeout: Default HTTP request timeout in seconds.
            max_retries: Bounded retries for retryable failures (FR-07);
                total attempts = max_retries + 1, capped at 4.
            retry_backoff_base: base seconds for exponential backoff + jitter.
        """
        raw_url = (
            base_url
            or os.environ.get("AI_BRIDGE_URL")
            or os.environ.get("AI_BRIDGE_CONTROL_URL")
            or "http://127.0.0.1:8000"
        )
        self.base_url = raw_url.rstrip("/")
        self.token = token or self._load_token_from_env_or_file()
        self.default_timeout = timeout
        self.max_retries = max(0, min(int(max_retries), 3))
        self.retry_backoff_base = max(0.05, float(retry_backoff_base))
        # FR-07: one-shot idempotency key for the next mutating request.
        # execute() sets this instead of adding a new _request() kwarg so
        # existing callers/subclasses that override _request keep working.
        self._pending_idempotency_key: str | None = None

    @staticmethod
    def _load_token_from_env_or_file() -> str:
        """Load a token from secure storage / env only (F-04-19).

        Precedence: AI_BRIDGE_TOKEN_FILE (a file the operator owns, read
        once at construction) > AI_BRIDGE_ADMIN_TOKEN > AI_BRIDGE_TOKEN.
        An unreadable token file fails closed instead of silently
        falling back to an empty token.
        """
        token_file = os.environ.get("AI_BRIDGE_TOKEN_FILE")
        if token_file:
            try:
                return Path(token_file).read_text(encoding="utf-8").strip()
            except OSError as exc:
                raise ValueError(
                    f"AI_BRIDGE_TOKEN_FILE is set but unreadable: {token_file}: {exc}"
                ) from exc
        return (
            os.environ.get("AI_BRIDGE_ADMIN_TOKEN")
            or os.environ.get("AI_BRIDGE_TOKEN")
            or ""
        )

    def __repr__(self) -> str:  # F-04-19: never leak the token in repr
        return (
            f"AIBridgeClient(base_url={self.base_url!r}, "
            f"token={'***' if self.token else None}, "
            f"timeout={self.default_timeout})"
        )

    def is_demo_mode(self) -> dict[str, Any]:
        """FR-05: report explicitly whether the backend is in demo mode."""
        return _is_demo_mode()

    def _redact(self, text: str) -> str:
        return _redact_token_from_text(text, self.token)

    def _request(
        self,
        method: str,
        path: str,
        payload: dict | None = None,
        params: dict | None = None,
        timeout: int | None = None,
        extra_headers: dict[str, str] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        # F-04-19: the token is NEVER a query parameter. Drop anything
        # token-shaped from params even if a caller passes it.
        url = f"{self.base_url}/{path.lstrip('/')}"
        if params:
            clean_params = {
                k: v for k, v in params.items()
                if v is not None and not re.search(r"token|secret|password|api[_-]?key", str(k), re.I)
            }
            if clean_params:
                url += "?" + urllib.parse.urlencode(clean_params)

        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "AI-Bridge-Python-SDK/0.3",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
            headers["X-Admin-Token"] = self.token
        pending_key = idempotency_key or self._pending_idempotency_key
        self._pending_idempotency_key = None
        if pending_key:
            headers["Idempotency-Key"] = str(pending_key)
        if extra_headers:
            headers.update(extra_headers)
        call_timeout = timeout or self.default_timeout
        method_upper = method.upper()
        # FR-07: retries are bounded and only for retryable failures.
        # Non-idempotent writes are retried only when an idempotency key
        # is present, so a retry can never double-execute a submission.
        # The key may arrive as the idempotency_key argument, as the
        # one-shot _pending_idempotency_key (set by execute()), or as an
        # Idempotency-Key header.
        has_idempotency_key = bool(pending_key) or any(
            str(k).lower() == "idempotency-key"
            for k in (extra_headers or {})
        )
        retryable_method = method_upper in ("GET", "HEAD", "OPTIONS") or has_idempotency_key
        attempts = (self.max_retries + 1) if retryable_method else 1

        last_error: AIBridgeError | None = None
        for attempt in range(attempts):
            req = urllib.request.Request(url, data=data, method=method_upper, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=call_timeout) as resp:
                    resp_bytes = resp.read()
                    if not resp_bytes:
                        return None
                    text = resp_bytes.decode("utf-8")
                    try:
                        return json.loads(text)
                    except Exception:
                        return text
            except urllib.error.HTTPError as exc:
                err_body = exc.read().decode("utf-8") if exc.fp else ""
                try:
                    err_json = json.loads(err_body)
                    msg = err_json.get("detail") or err_json.get("error") or err_body
                except Exception:
                    msg = err_body or str(exc)
                # F-04-19: redact the token from any server echo in errors.
                msg = self._redact(str(msg))
                err_body = self._redact(err_body)
                api_err = AIBridgeError(f"HTTP {exc.code}: {msg}", status_code=exc.code, details=err_body)
                if exc.code in (429,) or exc.code >= 500:
                    last_error = api_err
                    if attempt < attempts - 1:
                        self._sleep_backoff(attempt)
                        continue
                raise api_err
            except Exception as exc:
                last_error = AIBridgeError(f"Request failed: {self._redact(str(exc))}")
                if attempt < attempts - 1:
                    self._sleep_backoff(attempt)
                    continue
                raise last_error
        if last_error is not None:  # pragma: no cover - defensive
            raise last_error
        raise AIBridgeError("Request failed: unknown error")

    def _sleep_backoff(self, attempt: int) -> None:
        """Exponential backoff with full jitter (FR-07)."""
        base = self.retry_backoff_base * (2 ** attempt)
        time.sleep(random.uniform(0, base))

    # Fleet & Devices
    def list_devices(self) -> list[dict]:
        """List all devices in the fleet, their OS, online status, and AI capabilities."""
        res = self._request("GET", "/api/ai/devices")
        if isinstance(res, dict) and "devices" in res:
            return res["devices"]
        # Fallback to general devices endpoint
        res2 = self._request("GET", "/api/devices")
        return res2 if isinstance(res2, list) else []

    def get_device(self, device_id_or_name: str) -> dict | None:
        """Get details for a specific device by ID or name."""
        devices = self.list_devices()
        target = device_id_or_name.lower().strip()
        for d in devices:
            target_low = target.lower()
            if d.get("id") == target or (d.get("name") or "").lower() == target_low:
                return d
        return None

    # Tools Catalog
    def get_tools(
        self,
        format: str = "raw",
        device: str | None = None,
        category: str | None = None,
    ) -> list[dict]:
        """Get tool specifications formatted for LLMs.

        Args:
            format: 'raw', 'openai' (function calling), 'anthropic' (tools), or 'gemini'.
            device: Optional target device name to filter compatible tools.
            category: Optional filter ('desktop', 'shell', 'files', 'system', 'git').
        """
        res = self._request("GET", "/api/ai/tools", params={"format": format, "device": device, "category": category})
        if isinstance(res, dict) and "tools" in res:
            return res["tools"]
        return []

    # Synchronous Tool Execution
    def execute(
        self,
        tool: str,
        device: str | None = None,
        args: dict | None = None,
        timeout: int = 30,
        idempotency_key: str | None = None,
    ) -> dict:
        """Execute any tool synchronously on any target device.

        Args:
            tool: Name of the tool (e.g. 'run_shell', 'take_screenshot', 'mouse_click').
            device: Target device name ('ubuntu', 'windows-pc') or ID or 'local'.
            args: Tool arguments dictionary.
            timeout: Execution timeout in seconds (default 30).
            idempotency_key: FR-07 — sent as an ``Idempotency-Key`` header
                so a retried submission is not double-executed. When omitted
                a fresh UUID is generated for every call.
        """
        payload = {
            "tool": tool,
            "device": device,
            "args": args or {},
            "timeout": timeout,
        }
        key = idempotency_key or uuid.uuid4().hex
        # One-shot attribute (see __init__): keeps the _request() call
        # signature identical for existing overrides/mocks.
        self._pending_idempotency_key = key
        try:
            res = self._request("POST", "/api/ai/execute", payload=payload,
                                timeout=timeout + 10)
        finally:
            self._pending_idempotency_key = None
        return res if isinstance(res, dict) else {"result": res}

    # Tasks — list + projection (FR-03)
    def list_tasks(self) -> list[dict]:
        """List tasks (raw rows; may include full result TEXT)."""
        res = self._request("GET", "/api/tasks")
        if isinstance(res, dict) and "tasks" in res:
            return res["tasks"]
        return res if isinstance(res, list) else []

    def list_task_summaries(self, preview_chars: int = 200) -> list[dict]:
        """List task summaries WITHOUT the multi-MB result TEXT (FR-03).

        Client-side projection of the rows returned by ``/api/tasks``.
        Server-side column projection (the real fix for list size) needs
        a control-plane change and is a documented Wave 4 follow-up.
        """
        return project_task_summaries(self.list_tasks(), preview_chars=preview_chars)

    def verify_signed_update_manifest(
        self,
        manifest_path: Path | str | None = None,
        signature_path: Path | str | None = None,
        public_key_path: Path | str | None = None,
    ) -> dict[str, Any]:
        """F-04-20 gate: verify a signed update manifest, refuse if invalid.

        Any update path reached through this SDK must call this first.
        Delegates to ``ai_bridge.policy_simulation.require_signed_update``
        (Ed25519 verification in ``ai_bridge.updates``); raises
        PermissionError on an unconfigured or bad signature.
        """
        from .policy_simulation import require_signed_update

        return require_signed_update(manifest_path, signature_path, public_key_path)

    # Shell Execution
    def run_shell(
        self,
        command: str,
        device: str | None = None,
        working_directory: str = "",
        timeout: int = 60,
    ) -> Any:
        """Execute a shell command on the target device."""
        res = self.execute("run_shell", device=device, args={
            "command": command,
            "working_directory": working_directory,
            "timeout": timeout,
        }, timeout=timeout)
        if res.get("ok"):
            return res.get("result")
        raise AIBridgeError(f"Shell execution failed: {res.get('error') or res}")

    # Files & Workspace
    def read_file(self, path: str, device: str | None = None, max_chars: int = 100000) -> str:
        """Read text from a file on the target device."""
        res = self.execute("read_file", device=device, args={"path": path, "max_chars": max_chars})
        if res.get("ok"):
            return str(res.get("result") or "")
        raise AIBridgeError(f"Read file failed: {res.get('error') or res}")

    def write_file(self, path: str, content: str, overwrite: bool = False, device: str | None = None) -> dict:
        """Write content to a file on the target device."""
        res = self.execute("write_file", device=device, args={
            "path": path,
            "content": content,
            "overwrite": overwrite,
        })
        if res.get("ok"):
            return res.get("result") or {}
        raise AIBridgeError(f"Write file failed: {res.get('error') or res}")

    # Desktop GUI Automation (Windows & Desktop Linux)
    def take_screenshot(self, device: str | None = None, quality: int = 75) -> dict:
        """Capture desktop screenshot on target device.

        Returns:
            dict containing 'screenshot' (base64 JPEG), 'width', 'height', 'format'.
        """
        res = self.execute("take_screenshot", device=device, args={"quality": quality})
        if res.get("ok"):
            return res.get("result") or {}
        raise AIBridgeError(f"Take screenshot failed: {res.get('error') or res}")

    def mouse_click(
        self,
        x: int,
        y: int,
        button: str = "left",
        clicks: int = 1,
        device: str | None = None,
    ) -> dict:
        """Click the mouse at desktop coordinates (x, y)."""
        res = self.execute("mouse_click", device=device, args={
            "x": x,
            "y": y,
            "button": button,
            "clicks": clicks,
        })
        return res.get("result") or res

    def mouse_move(self, x: int, y: int, device: str | None = None) -> dict:
        """Move the mouse cursor to (x, y)."""
        res = self.execute("mouse_move", device=device, args={"x": x, "y": y})
        return res.get("result") or res

    def mouse_scroll(self, delta: int = -120, x: int | None = None, y: int | None = None, device: str | None = None) -> dict:
        """Scroll mouse wheel (negative is down, positive is up)."""
        res = self.execute("mouse_scroll", device=device, args={"delta": delta, "x": x, "y": y})
        return res.get("result") or res

    def mouse_drag(self, start_x: int, start_y: int, end_x: int, end_y: int, device: str | None = None) -> dict:
        """Drag mouse from start coordinates to end coordinates."""
        res = self.execute("mouse_drag", device=device, args={
            "start_x": start_x,
            "start_y": start_y,
            "end_x": end_x,
            "end_y": end_y,
        })
        return res.get("result") or res

    def keyboard_type(self, text: str, device: str | None = None) -> dict:
        """Type text keystrokes into active window."""
        res = self.execute("keyboard_type", device=device, args={"text": text})
        return res.get("result") or res

    def keyboard_press(self, key: str, device: str | None = None) -> dict:
        """Press a special key or hotkey combination (e.g. 'enter', 'tab', 'ctrl+c', 'win+r')."""
        res = self.execute("keyboard_press", device=device, args={"key": key})
        return res.get("result") or res

    def list_windows(self, device: str | None = None) -> list[dict]:
        """List open application windows on target device."""
        res = self.execute("list_desktop_windows", device=device)
        return (res.get("result") or {}).get("windows", [])

    def focus_window(self, title: str, device: str | None = None) -> dict:
        """Bring window to foreground by title substring."""
        res = self.execute("focus_window", device=device, args={"title": title})
        return res.get("result") or res

    def get_screen_size(self, device: str | None = None) -> dict:
        """Get primary monitor screen resolution."""
        res = self.execute("get_screen_size", device=device)
        return res.get("result") or {}

    # High-level Agent & Chat
    def run_agent(
        self,
        prompt: str,
        device: str | None = None,
        provider: str = "openai",
        model: str | None = None,
        api_key: str | None = None,
        max_steps: int = 8,
    ) -> dict:
        """Run an autonomous AI agent to execute a natural language task across your fleet."""
        payload = {
            "prompt": prompt,
            "device": device,
            "provider": provider,
            "model": model,
            "api_key": api_key,
            "max_steps": max_steps,
        }
        return self._request("POST", "/api/ai/agent", payload=payload, timeout=120)

    def chat(self, messages: list[dict], model: str = "ai-bridge-agent", device: str | None = None) -> dict:
        """Send chat messages via OpenAI-compatible endpoint."""
        payload = {
            "model": model,
            "messages": messages,
            "device": device,
        }
        return self._request("POST", "/v1/chat/completions", payload=payload, timeout=120)


