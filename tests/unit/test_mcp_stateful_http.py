"""Wave 7 — F-06-16: stateless HTTP default vs stateful/SSE opt-in.

The stateless default (`stateless_http=True`, `json_response=True`) is
deliberate: the MCP HTTP app is embedded in the control plane
(`control/combined.py`), which production runs under gunicorn with 4
workers and no sticky sessions, and stateful Streamable HTTP sessions are
in-process — a client whose next request lands on another worker loses
its session. Resumability is a further gap: the SDK ships only the
`EventStore` ABC, no shared implementation.

Wave 7 adds an explicit opt-in (`AI_BRIDGE_MCP_STATEFUL_HTTP=1`) for
single-process deployments: SSE streaming + server-managed sessions.
These tests assert the option parsing, the multi-worker warning, and —
via a fresh subprocess, because the module-level server is built once at
import — the live behaviour of both modes: stateful `initialize` returns
an `Mcp-Session-Id` over `text/event-stream` and the session serves
`tools/list`; stateless `tools/list` works with no session at all.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from ai_bridge.server import _build_mcp_server, _mcp_http_options

REPO = Path(__file__).resolve().parents[2]
ADMIN = "test-admin-secret"

_STATEFUL_PROBE = r"""
import os, sys
sys.path.insert(0, "src")
os.environ["AI_BRIDGE_ADMIN_TOKEN"] = "test-admin-secret"
from starlette.testclient import TestClient
from ai_bridge.server import create_http_app, mcp
assert mcp.settings.stateless_http is False, mcp.settings
assert mcp.settings.json_response is False
app = create_http_app()
headers = {"Authorization": "Bearer test-admin-secret",
           "Content-Type": "application/json",
           "Accept": "application/json, text/event-stream"}
init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                   "clientInfo": {"name": "probe", "version": "1"}}}
with TestClient(app, base_url="http://localhost:8001") as client:
    r = client.post("/mcp", headers=headers, json=init)
    assert r.status_code == 200, r.text
    assert "text/event-stream" in r.headers.get("content-type", ""), r.headers
    sid = r.headers.get("mcp-session-id")
    assert sid, "stateful initialize must return Mcp-Session-Id"
    r2 = client.post("/mcp", headers={**headers, "mcp-session-id": sid},
                     json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert r2.status_code in (200, 202), r2.text  # notification: 202 Accepted
    r3 = client.post("/mcp", headers={**headers, "mcp-session-id": sid},
                     json={"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}})
    assert r3.status_code == 200, r3.text
    # Stateful mode answers over SSE: parse the `data:` event payload.
    import json as _json
    _payload = None
    for _line in r3.text.splitlines():
        if _line.startswith("data:"):
            _payload = _json.loads(_line[5:].strip())
            break
    assert _payload is not None, f"no SSE data event in tools/list response: {r3.text[:300]!r}"
    assert any(t["name"] == "system_info" for t in _payload["result"]["tools"])
print("STATEFUL-PROBE-OK", sid)
"""

_STATELESS_PROBE = r"""
import os, sys
sys.path.insert(0, "src")
os.environ["AI_BRIDGE_ADMIN_TOKEN"] = "test-admin-secret"
from starlette.testclient import TestClient
from ai_bridge.server import create_http_app, mcp
assert mcp.settings.stateless_http is True, mcp.settings
assert mcp.settings.json_response is True
app = create_http_app()
headers = {"Authorization": "Bearer test-admin-secret",
           "Content-Type": "application/json",
           "Accept": "application/json, text/event-stream"}
with TestClient(app, base_url="http://localhost:8001") as client:
    r = client.post("/mcp", headers=headers,
                    json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    assert r.status_code == 200, r.text
    assert not r.headers.get("mcp-session-id"), "stateless mode must not issue a session id"
    assert any(t["name"] == "system_info" for t in r.json()["result"]["tools"])
print("STATELESS-PROBE-OK")
"""


def _run_probe(code: str, extra_env: dict[str, str]) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["TMPDIR"] = str(Path.home() / "workspace" / "tmp")
    env.pop("AI_BRIDGE_MCP_STATEFUL_HTTP", None)
    env.update(extra_env)
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_mcp_http_options_default_is_stateless(monkeypatch):
    monkeypatch.delenv("AI_BRIDGE_MCP_STATEFUL_HTTP", raising=False)
    assert _mcp_http_options() == {"stateless_http": True, "json_response": True}


@pytest.mark.parametrize("value", ["1", "true", "yes", "TRUE", " 1 "])
def test_mcp_http_options_stateful_opt_in(monkeypatch, value):
    monkeypatch.setenv("AI_BRIDGE_MCP_STATEFUL_HTTP", value)
    assert _mcp_http_options() == {"stateless_http": False, "json_response": False}


@pytest.mark.parametrize("value", ["0", "false", "no", ""])
def test_mcp_http_options_other_values_stay_stateless(monkeypatch, value):
    monkeypatch.setenv("AI_BRIDGE_MCP_STATEFUL_HTTP", value)
    assert _mcp_http_options() == {"stateless_http": True, "json_response": True}


def test_build_server_settings_follow_env(monkeypatch):
    monkeypatch.setenv("AI_BRIDGE_MCP_STATEFUL_HTTP", "1")
    monkeypatch.delenv("AI_BRIDGE_WORKERS", raising=False)
    server = _build_mcp_server()
    assert server.settings.stateless_http is False
    assert server.settings.json_response is False
    monkeypatch.setenv("AI_BRIDGE_MCP_STATEFUL_HTTP", "0")
    server = _build_mcp_server()
    assert server.settings.stateless_http is True
    assert server.settings.json_response is True


def test_build_server_warns_when_stateful_and_multiworker(monkeypatch, capsys):
    monkeypatch.setenv("AI_BRIDGE_MCP_STATEFUL_HTTP", "1")
    monkeypatch.setenv("AI_BRIDGE_WORKERS", "4")
    _build_mcp_server()
    err = capsys.readouterr().err
    assert "AI_BRIDGE_WORKERS=4" in err
    assert "single worker" in err


def test_stateful_http_live_session_and_sse():
    """Fresh process with the opt-in: initialize returns a session id
    over SSE and the session serves tools/list (not resumable — no shared
    EventStore exists — but stateful + streaming)."""
    proc = _run_probe(_STATEFUL_PROBE, {"AI_BRIDGE_MCP_STATEFUL_HTTP": "1"})
    assert proc.returncode == 0, proc.stdout[-2000:] + proc.stderr[-2000:]
    assert "STATEFUL-PROBE-OK" in proc.stdout


def test_stateless_http_live_no_session():
    """Fresh process with the default: tools/list works with no session
    and no session id is issued."""
    proc = _run_probe(_STATELESS_PROBE, {})
    assert proc.returncode == 0, proc.stdout[-2000:] + proc.stderr[-2000:]
    assert "STATELESS-PROBE-OK" in proc.stdout
