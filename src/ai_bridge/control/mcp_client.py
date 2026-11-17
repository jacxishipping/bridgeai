"""Client connector for external Model Context Protocol (MCP) servers.

Supports:
- HTTP JSON-RPC 2.0 and Streamable HTTP (FastMCP / MCP Spec 2024-11-05+)
- MCP ``initialize`` handshake with protocol-version negotiation
  (F-06-15; prefers 2025-06-18, then 2025-03-26, then 2024-11-05)
- Session management via the ``Mcp-Session-Id`` response header
- Cursor-based pagination for ``tools/list`` (and ``resources/list``)
- Tool discovery (tools/list) and tool execution (tools/call)
- Schema adaptation to OpenAI and Anthropic Claude tool calling formats

Backward compatibility: the module-level ``fetch_mcp_tools`` /
``execute_mcp_tool`` / ``format_mcp_tool_for_llm`` signatures are unchanged.
They now run a best-effort ``initialize`` first: a server that answers
``initialize`` with a negotiated protocol version gets a real session
(``Mcp-Session-Id`` sent on every later call); a server that does not
implement ``initialize`` (older / minimal servers, and the fakes used by
the existing OAuth tests) is still usable in legacy mode — the handshake
failure is logged, not fatal. Strict servers that *require* ``initialize``
should be driven through :class:`MCPClient` with ``require_initialize=True``.

DPoP / PAR (F-06-13): evaluated 2026-11-17 — the AI Bridge OAuth gateway
(``deployment/oauth/gateway.py``) implements OAuth 2.1 / PKCE only. It
exposes no Pushed Authorization Request endpoint (RFC 9126) and no DPoP
support (RFC 9449): ``grep -i "par|dpop|pushed_authorization"`` over the
gateway and ``control/mcp_oauth.py`` returns no hits. A client-side DPoP
proof or PAR request has no server side to talk to, so implementing half
of the crypto here would be security theatre. Decision: NOT implemented;
see ``analysis/wave3c-mcp-progress.md``. Revisit if the gateway gains PAR.
"""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
import uuid
from enum import Enum
from typing import Any

logger = logging.getLogger("ai_bridge.mcp_client")

# Protocol versions this client can negotiate, most recent first.
# The MCP spec requires the client to offer the versions it supports and
# accept the version the server selects (which must be one of them).
SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
DEFAULT_PROTOCOL_VERSION = "2024-11-05"

MAX_LIST_PAGES = 50  # hard bound on cursor pagination (F-06-15)


class MCPErrorCode(str, Enum):
    """Small shared error taxonomy for the outbound MCP client (FR-06).

    ``isError`` / JSON-RPC ``error.code`` values from the server are mapped
    onto these codes so callers can distinguish failure kinds without
    parsing message strings.
    """

    PROTOCOL = "protocol"            # bad handshake / version / malformed reply
    AUTH = "auth"                    # 401 / 403 / invalid token
    TRANSPORT = "transport"          # connection / HTTP error / timeout
    TIMEOUT = "timeout"              # request timed out
    TOOL_ERROR = "tool_error"        # server returned isError / tool failure
    INVALID_RESPONSE = "invalid_response"
    SESSION = "session"              # session id lost / expired
    UNKNOWN = "unknown"


class MCPClientError(RuntimeError):
    """MCP client failure carrying a taxonomy code (FR-06)."""

    def __init__(self, message: str, code: MCPErrorCode = MCPErrorCode.UNKNOWN,
                 status_code: int | None = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _redact_secret(text: str, *secrets: str) -> str:
    """Remove secret values from a message before it is returned/logged."""
    out = str(text)
    for secret in secrets:
        if secret and len(secret) >= 4:
            out = out.replace(secret, "***")
    return out


def _build_headers(
    auth_header: str = "",
    auth_token: str = "",
    extra_headers: dict[str, str] | None = None,
    session_id: str | None = None,
) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream, */*",
        "User-Agent": "AI-Bridge-MCP-Client/0.3",
    }
    if auth_token:
        header_name = auth_header.strip() if auth_header and auth_header.strip() else "Authorization"
        val = auth_token.strip()
        if header_name.lower() == "authorization" and not val.lower().startswith("bearer "):
            headers[header_name] = f"Bearer {val}"
        else:
            headers[header_name] = val
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    if extra_headers:
        for k, v in extra_headers.items():
            if k and v:
                headers[k] = str(v)
    return headers


def _parse_mcp_response(raw_text: str) -> dict[str, Any]:
    """Parse JSON or SSE (event: message\\ndata: {...}) MCP response payload."""
    clean = raw_text.strip()
    if not clean:
        return {}

    # Check for Server-Sent Events stream format
    if "data:" in clean:
        lines = clean.splitlines()
        for line in lines:
            line_s = line.strip()
            if line_s.startswith("data:"):
                payload_str = line_s[5:].strip()
                try:
                    return json.loads(payload_str)
                except Exception:
                    continue

    try:
        return json.loads(clean)
    except Exception:
        return {"raw": clean}


def _response_headers(resp: Any) -> dict[str, str]:
    """Best-effort case-insensitive header read (fakes may lack headers)."""
    try:
        info = resp.info() if hasattr(resp, "info") else None
        if info is not None:
            return {str(k).lower(): str(v) for k, v in info.items()}
    except Exception:
        pass
    raw = getattr(resp, "headers", None)
    if raw:
        try:
            return {str(k).lower(): str(v) for k, v in dict(raw).items()}
        except Exception:
            pass
    return {}


def _normalize_tools(raw_tools: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    if not isinstance(raw_tools, list):
        return normalized
    for t in raw_tools:
        if not isinstance(t, dict):
            continue
        name = t.get("name") or ""
        if not name:
            continue
        normalized.append({
            "name": name,
            "description": t.get("description") or f"MCP tool: {name}",
            "inputSchema": t.get("inputSchema") or {"type": "object", "properties": {}},
        })
    return normalized


class MCPClient:
    """Stateful outbound MCP client: initialize, session, pagination.

    One instance = one server endpoint + one session. ``initialize()`` is
    explicit so callers that need strict conformance can require it; the
    module-level helpers call it best-effort and fall back to legacy mode.
    """

    def __init__(
        self,
        url: str,
        auth_header: str = "",
        auth_token: str = "",
        extra_headers: dict[str, str] | None = None,
        timeout: float = 12.0,
        client_name: str = "ai-bridge",
        client_version: str = "0.3",
        require_initialize: bool = False,
    ):
        clean_url = (url or "").strip()
        if not clean_url:
            raise ValueError("MCP Server URL cannot be empty.")
        if not (clean_url.startswith("http://") or clean_url.startswith("https://")):
            raise ValueError("MCP Server URL must start with http:// or https://")
        self.base_url = clean_url
        self.auth_header = auth_header
        self.auth_token = auth_token
        self.extra_headers = extra_headers
        self.timeout = timeout
        self.client_name = client_name
        self.client_version = client_version
        self.require_initialize = require_initialize
        self._endpoint: str | None = None  # resolved working URL (url or url/mcp)
        self.session_id: str | None = None
        self.protocol_version: str | None = None
        self.server_info: dict[str, Any] = {}
        self.server_capabilities: dict[str, Any] = {}
        self.initialized = False

    # -- transport ------------------------------------------------------
    def _candidate_urls(self) -> list[str]:
        urls = [self.base_url]
        if not self.base_url.rstrip("/").endswith("/mcp"):
            urls.append(f"{self.base_url.rstrip('/')}/mcp")
        if self._endpoint:
            return [self._endpoint] + [u for u in urls if u != self._endpoint]
        return urls

    def _post(self, method: str, params: dict[str, Any],
              timeout: float | None = None) -> tuple[dict[str, Any], dict[str, str]]:
        """POST one JSON-RPC request; returns (parsed body, response headers).

        Raises MCPClientError (never leaks the auth token in the message).
        """
        body = {
            "jsonrpc": "2.0",
            "id": f"ai-bridge-{uuid.uuid4().hex[:8]}",
            "method": method,
            "params": params,
        }
        last_error = ""
        for target_url in self._candidate_urls():
            try:
                req = urllib.request.Request(
                    target_url,
                    data=json.dumps(body).encode("utf-8"),
                    headers=_build_headers(
                        self.auth_header, self.auth_token, self.extra_headers,
                        session_id=self.session_id,
                    ),
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                    self._endpoint = target_url
                    resp_text = resp.read().decode("utf-8", errors="replace")
                    data = _parse_mcp_response(resp_text)
                    headers = _response_headers(resp)
                    sid = headers.get("mcp-session-id")
                    if sid:
                        self.session_id = sid
                    return data, headers
            except urllib.error.HTTPError as err:
                try:
                    err_body = err.read().decode("utf-8", errors="replace") if err.fp else str(err)
                except Exception:
                    err_body = str(err)
                last_error = f"HTTP {err.code}: {err_body[:180]}"
                if err.code in (401, 403):
                    raise MCPClientError(
                        _redact_secret(f"Authentication rejected by MCP server ({last_error})",
                                       self.auth_token),
                        MCPErrorCode.AUTH, status_code=err.code,
                    ) from err
                if err.code == 404:
                    continue  # try the /mcp fallback
            except (TimeoutError, urllib.error.URLError) as exc:
                last_error = _redact_secret(str(exc), self.auth_token)
                raise MCPClientError(
                    f"MCP request timed out / unreachable: {last_error}",
                    MCPErrorCode.TIMEOUT,
                ) from exc
            except MCPClientError:
                raise
            except Exception as exc:
                last_error = _redact_secret(str(exc), self.auth_token)
        raise MCPClientError(
            _redact_secret(f"Could not connect to MCP server: {last_error}", self.auth_token),
            MCPErrorCode.TRANSPORT,
        )

    @staticmethod
    def _rpc_error(data: dict[str, Any]) -> str | None:
        if "error" in data:
            err = data["error"]
            if isinstance(err, dict):
                return str(err.get("message") or err.get("code") or err)
            return str(err)
        return None

    def _notify(self, method: str) -> None:
        """Fire-and-forget JSON-RPC notification (no ``id``, no response)."""
        if not self._endpoint:
            return
        try:
            req = urllib.request.Request(
                self._endpoint,
                data=json.dumps({"jsonrpc": "2.0", "method": method}).encode("utf-8"),
                headers=_build_headers(
                    self.auth_header, self.auth_token, self.extra_headers,
                    session_id=self.session_id,
                ),
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                resp.read()
        except Exception as exc:  # noqa: BLE001 - notification must never fail the session
            logger.debug("notification %s failed (ignored): %s", method, exc)

    # -- handshake / session --------------------------------------------
    def initialize(self) -> dict[str, Any]:
        """Run the MCP ``initialize`` handshake (F-06-15).

        Offers SUPPORTED_PROTOCOL_VERSIONS (latest first), requires the
        server to select one of them, stores the ``Mcp-Session-Id`` and
        sends ``notifications/initialized``. Raises MCPClientError with
        code PROTOCOL when the server answer is not a conformant
        initialize result.
        """
        data, _headers = self._post("initialize", {
            "protocolVersion": SUPPORTED_PROTOCOL_VERSIONS[0],
            "capabilities": {},
            "clientInfo": {"name": self.client_name, "version": self.client_version},
        })
        err = self._rpc_error(data)
        if err:
            raise MCPClientError(
                _redact_secret(f"MCP initialize rejected: {err}", self.auth_token),
                MCPErrorCode.PROTOCOL,
            )
        result = data.get("result")
        if not isinstance(result, dict):
            raise MCPClientError("MCP initialize returned no result object.",
                                 MCPErrorCode.PROTOCOL)
        negotiated = result.get("protocolVersion")
        if negotiated not in SUPPORTED_PROTOCOL_VERSIONS:
            raise MCPClientError(
                f"MCP server negotiated unsupported protocol version: {negotiated!r} "
                f"(supported: {SUPPORTED_PROTOCOL_VERSIONS})",
                MCPErrorCode.PROTOCOL,
            )
        self.protocol_version = str(negotiated)
        self.server_info = result.get("serverInfo") if isinstance(result.get("serverInfo"), dict) else {}
        self.server_capabilities = result.get("capabilities") if isinstance(result.get("capabilities"), dict) else {}
        self.initialized = True
        # Best-effort: the spec requires notifications/initialized after a
        # successful initialize; a server that rejects the notification
        # must not invalidate the session.
        self._notify("notifications/initialized")
        return {
            "protocolVersion": self.protocol_version,
            "serverInfo": self.server_info,
            "capabilities": self.server_capabilities,
            "sessionId": self.session_id,
        }

    def ensure_initialized(self) -> bool:
        """Best-effort initialize; returns False (legacy mode) on failure.

        Used by the module-level helpers so minimal/older servers keep
        working. Strict callers should use ``initialize()`` directly or
        construct the client with ``require_initialize=True``.
        """
        if self.initialized:
            return True
        try:
            self.initialize()
            return True
        except MCPClientError as exc:
            logger.warning("MCP initialize failed (%s); continuing without a session.", exc)
            if self.require_initialize:
                raise
            return False

    # -- discovery / execution ------------------------------------------
    def list_tools(self, cursor: str | None = None) -> tuple[list[dict[str, Any]], str | None]:
        """One page of ``tools/list``; returns (tools, next_cursor|None)."""
        params: dict[str, Any] = {}
        if cursor:
            params["cursor"] = cursor
        data, _ = self._post("tools/list", params)
        err = self._rpc_error(data)
        if err:
            raise MCPClientError(f"MCP server returned error: {err}", MCPErrorCode.TOOL_ERROR)
        result = data.get("result", data)
        tools: list[dict[str, Any]] = []
        next_cursor: str | None = None
        if isinstance(result, dict):
            tools = _normalize_tools(result.get("tools", []))
            nxt = result.get("nextCursor")
            next_cursor = str(nxt) if nxt else None
        elif isinstance(result, list):
            tools = _normalize_tools(result)
        return tools, next_cursor

    def list_all_tools(self, max_pages: int = MAX_LIST_PAGES) -> list[dict[str, Any]]:
        """All tools, following ``nextCursor`` until exhausted (F-06-15).

        Bounded by ``max_pages`` so a server that loops cursors forever
        cannot hang discovery.
        """
        all_tools: list[dict[str, Any]] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()
        for _ in range(max(1, max_pages)):
            tools, cursor = self.list_tools(cursor=cursor)
            all_tools.extend(tools)
            if not cursor or cursor in seen_cursors:
                break
            seen_cursors.add(cursor)
        return all_tools

    def call_tool(self, tool_name: str, arguments: dict[str, Any],
                  timeout: float = 60.0) -> dict[str, Any]:
        """Execute one tool via ``tools/call``; returns the parsed result."""
        data, _ = self._post("tools/call", {
            "name": tool_name,
            "arguments": arguments or {},
        }, timeout=timeout)
        err = self._rpc_error(data)
        if err:
            raise MCPClientError(f"MCP tool error: {err}", MCPErrorCode.TOOL_ERROR)
        result = data.get("result", data)
        if isinstance(result, dict) and "content" in result and isinstance(result["content"], list):
            text_parts: list[str] = []
            images: list[dict[str, Any]] = []
            for item in result["content"]:
                if isinstance(item, dict):
                    if item.get("type") == "text":
                        text_parts.append(item.get("text", ""))
                    elif item.get("type") == "image":
                        images.append(item)
            full_text = "\n".join(text_parts).strip()
            is_err = bool(result.get("isError", False))
            out: dict[str, Any] = {"ok": not is_err, "result": full_text or result}
            if images:
                out["images"] = images
            return out
        return {"ok": True, "result": result}

    def close(self) -> None:
        """Drop local session state (Streamable HTTP has no close RPC)."""
        self.session_id = None
        self.initialized = False
        self.protocol_version = None


def fetch_mcp_tools(
    url: str,
    auth_header: str = "",
    auth_token: str = "",
    extra_headers: dict[str, str] | None = None,
    timeout: float = 12.0,
    max_pages: int = MAX_LIST_PAGES,
) -> tuple[bool, list[dict[str, Any]], str]:
    """Discover tools from an external MCP server via tools/list.

    Runs a best-effort ``initialize`` handshake first (negotiated protocol
    version + ``Mcp-Session-Id`` when the server supports it), then follows
    cursor pagination. Servers without ``initialize`` still work (legacy).

    Returns:
        (success, tools_list, status_message)
    """
    clean_url = (url or "").strip()
    if not clean_url:
        return False, [], "MCP Server URL cannot be empty."
    if not (clean_url.startswith("http://") or clean_url.startswith("https://")):
        return False, [], "MCP Server URL must start with http:// or https://"
    try:
        client = MCPClient(clean_url, auth_header, auth_token, extra_headers, timeout=timeout)
        client.ensure_initialized()
        tools = client.list_all_tools(max_pages=max_pages)
        count = len(tools)
        proto = f" (protocol {client.protocol_version})" if client.protocol_version else ""
        return True, tools, f"Connected successfully. Found {count} tool{'s' if count != 1 else ''}.{proto}"
    except MCPClientError as exc:
        return False, [], _redact_secret(str(exc), auth_token)
    except ValueError as exc:
        return False, [], str(exc)


def execute_mcp_tool(
    url: str,
    tool_name: str,
    arguments: dict[str, Any],
    auth_header: str = "",
    auth_token: str = "",
    extra_headers: dict[str, str] | None = None,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Execute a tool on an external MCP server via tools/call.

    Runs a best-effort ``initialize`` handshake first (same legacy
    fallback as :func:`fetch_mcp_tools`). Returns structured execution result.
    """
    clean_url = (url or "").strip()
    if not clean_url:
        return {"ok": False, "error": "MCP Server URL cannot be empty."}
    try:
        client = MCPClient(clean_url, auth_header, auth_token, extra_headers, timeout=timeout)
        client.ensure_initialized()
        return client.call_tool(tool_name, arguments or {}, timeout=timeout)
    except MCPClientError as exc:
        code = exc.code.value if isinstance(exc.code, MCPErrorCode) else str(exc.code)
        return {"ok": False, "error": _redact_secret(str(exc), auth_token), "code": code}
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}


def format_mcp_tool_for_llm(
    mcp_tool: dict[str, Any],
    server_id: str,
    server_name: str,
    tool_format: str = "openai",
) -> dict[str, Any]:
    """Adapt an MCP tool schema into an OpenAI or Anthropic tool spec.

    Prefixes the tool name so the model can identify the external MCP service.
    Example: `mcp__github__create_issue` or `mcp__slack__post_message`.
    """
    clean_srv = "".join(c if c.isalnum() else "_" for c in server_name.lower().strip())
    raw_name = mcp_tool.get("name") or "tool"
    qualified_name = f"mcp__{clean_srv}__{raw_name}"

    desc = mcp_tool.get("description") or f"Tool provided by MCP service '{server_name}'"
    schema = mcp_tool.get("inputSchema") or {"type": "object", "properties": {}}

    if tool_format == "openai":
        return {
            "type": "function",
            "function": {
                "name": qualified_name,
                "description": f"[MCP: {server_name}] {desc}",
                "parameters": schema,
            },
        }
    elif tool_format == "anthropic":
        return {
            "name": qualified_name,
            "description": f"[MCP: {server_name}] {desc}",
            "input_schema": schema,
        }
    else:
        return {
            "name": qualified_name,
            "raw_name": raw_name,
            "server_id": server_id,
            "server_name": server_name,
            "description": desc,
            "parameters": schema,
        }
