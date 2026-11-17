"""Wave 5A remediation tests: F-04-15, F-04-22, F-04-01, SEC-06.

* F-04-15: Pillow-missing fallback must fail loudly, never fabricate
  images; the native DLL accepts an optional SHA-256 pin.
* F-04-22: the MCP gate blocks state-changing tools while the
  emergency stop is active (local mirror or durable flag).
* F-04-01: approvals live in the control DB when one is configured
  and survive an in-memory wipe (simulated restart).
* SEC-06: legacy plaintext MCP OAuth secrets are re-encrypted to
  Fernet by migrate_plaintext_secrets (idempotent).
"""
from __future__ import annotations

import hashlib
import time
from pathlib import Path

import pytest

from ai_bridge import screen_capture
from ai_bridge import server as mcp_server
from ai_bridge.control import approval_store, mcp_oauth
from ai_bridge.control import db as dbmod

# ---------------------------------------------------------------- F-04-15

def _pil_missing() -> bool:
    try:
        import PIL  # noqa: F401
    except ImportError:
        return True
    return False


@pytest.mark.skipif(not _pil_missing(), reason="Pillow installed; fallback inactive")
def test_pillow_fallback_fails_loudly_instead_of_fabricating():
    with pytest.raises(RuntimeError, match="Pillow is required"):
        screen_capture.Image.frombuffer("RGB", (4, 4), b"\x00" * 48)
    with pytest.raises(RuntimeError, match="Pillow is required"):
        screen_capture.Image.fromarray([[0]], mode="RGB")


def test_dll_pin_accepts_matching_hash_and_rejects_mismatch(tmp_path: Path, monkeypatch):
    from cryptography.fernet import Fernet  # noqa: F401  (asserts dep present)

    dll = tmp_path / "ai_bridge_native.dll"
    dll.write_bytes(b"fake-dll-bytes")
    digest = hashlib.sha256(b"fake-dll-bytes").hexdigest()
    monkeypatch.setenv("AI_BRIDGE_NATIVE_DLL_SHA256", digest)
    assert screen_capture._verify_dll_pin(dll) is True
    monkeypatch.setenv("AI_BRIDGE_NATIVE_DLL_SHA256", "0" * 64)
    assert screen_capture._verify_dll_pin(dll) is False
    monkeypatch.delenv("AI_BRIDGE_NATIVE_DLL_SHA256")
    assert screen_capture._verify_dll_pin(dll) is True


# ---------------------------------------------------------------- F-04-22

@pytest.fixture(autouse=True)
def _estop_clean(monkeypatch):
    monkeypatch.delenv("AI_BRIDGE_MCP_AUDIT_DB", raising=False)
    monkeypatch.delenv("AI_BRIDGE_ALLOW_TIER3", raising=False)
    monkeypatch.delenv("AI_BRIDGE_DESKTOP_ENABLED", raising=False)
    from ai_bridge import plane_control_flags

    plane_control_flags.set_emergency_stop(False)
    mcp_server._reset_emergency_stop_cache_for_tests()
    mcp_server._reset_approval_store_for_tests()
    yield
    plane_control_flags.set_emergency_stop(False)
    mcp_server._reset_emergency_stop_cache_for_tests()
    mcp_server._reset_approval_store_for_tests()
    mcp_server._APPROVALS.clear()


def test_emergency_stop_blocks_state_changing_mcp_tool(monkeypatch):
    from ai_bridge import plane_control_flags

    monkeypatch.setenv("AI_BRIDGE_ALLOW_TIER3", "1")
    monkeypatch.setenv("AI_BRIDGE_DISABLE_HOST_TOOLS", "0")
    seen: dict = {}
    monkeypatch.setattr(
        mcp_server.tools, "write_file",
        lambda path, content, overwrite=False, **kwargs: seen.update(kwargs) or {"written": path},
    )
    # No stop: the tool runs (approval not needed for the gate here —
    # write_file is tier 3 with AI_BRIDGE_ALLOW_TIER3=1; the wrapper
    # passes approval_granted=False through).
    mcp_server.write_file("x.txt", "hello")
    assert "approval_granted" in seen

    # With the stop active the gate denies before execution.
    plane_control_flags.set_emergency_stop(True)
    with pytest.raises(PermissionError, match="Emergency stop is active"):
        mcp_server.write_file("x.txt", "hello")


def test_emergency_stop_durable_flag_blocks_tool(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("AI_BRIDGE_ALLOW_TIER3", "1")
    monkeypatch.setenv("AI_BRIDGE_DISABLE_HOST_TOOLS", "0")
    db_path = tmp_path / "control.db"
    conn = dbmod.connect(db_path)
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('plane.emergency_stop', '1') "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
    conn.commit()
    monkeypatch.setenv("AI_BRIDGE_MCP_AUDIT_DB", str(db_path))
    mcp_server._reset_emergency_stop_cache_for_tests()
    with pytest.raises(PermissionError, match="Emergency stop is active"):
        mcp_server.write_file("x.txt", "hello")


def test_emergency_stop_does_not_block_read_only_tool(monkeypatch):
    from ai_bridge import plane_control_flags

    monkeypatch.setattr(
        mcp_server.tools, "get_system_info",
        lambda: {"system": "Linux", "machine": "test"},
    )
    plane_control_flags.set_emergency_stop(True)
    assert mcp_server.system_info()["system"] == "Linux"


# ---------------------------------------------------------------- F-04-01

def _admin(monkeypatch):
    monkeypatch.setenv("AI_BRIDGE_ADMIN_TOKEN", "test-admin")
    # _is_admin_caller compares the bearer token from the request
    # context; drive it via the module's bearer-token hook used by
    # the stdio tests: set the env var and monkeypatch _bearer_token.
    monkeypatch.setattr(mcp_server, "_bearer_token", lambda: "test-admin")


def test_durable_approval_survives_in_memory_wipe(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "control.db"
    monkeypatch.setenv("AI_BRIDGE_MCP_AUDIT_DB", str(db_path))
    mcp_server._reset_approval_store_for_tests()
    _admin(monkeypatch)

    created = mcp_server.request_approval("delete_workspace_file", "test")
    approval_id = created["approval_id"]
    assert mcp_server.approve_task(approval_id)["status"] == "approved"

    # Simulate an MCP server restart: drop all in-memory state.
    mcp_server._APPROVALS.clear()
    mcp_server._reset_emergency_stop_cache_for_tests()
    assert mcp_server._peek_local_approval("delete_workspace_file") is True
    # Single-use: consume once, then it is gone.
    assert mcp_server._consume_local_approval("delete_workspace_file") is True
    assert mcp_server._peek_local_approval("delete_workspace_file") is False


def test_durable_approval_scoped_and_expiring(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "control.db"
    monkeypatch.setenv("AI_BRIDGE_MCP_AUDIT_DB", str(db_path))
    mcp_server._reset_approval_store_for_tests()
    conn = mcp_server._approval_store_conn()
    assert conn is not None
    session = mcp_server._session_key()
    approval_store.create_approval(
        conn, "old-1", "delete_workspace_file", "stale",
        session, created_at=time.time() - (mcp_server._APPROVAL_TTL_S + 60),
    )
    approval_store.set_approval_status(conn, "old-1", "approved")
    assert mcp_server._peek_local_approval("delete_workspace_file") is False
    approval_store.create_approval(
        conn, "other-1", "delete_workspace_file", "other session",
        "someone-else", created_at=time.time(),
    )
    approval_store.set_approval_status(conn, "other-1", "approved")
    assert mcp_server._peek_local_approval("delete_workspace_file") is False


def test_approval_store_prune_and_roundtrip(tmp_path: Path):
    conn = dbmod.connect(tmp_path / "control.db")
    rec = approval_store.create_approval(conn, "a1", "run_shell", "r", "s1")
    assert rec["status"] == "pending"
    assert approval_store.get_approval(conn, "a1")["tool"] == "run_shell"
    assert approval_store.set_approval_status(conn, "a1", "approved") is True
    assert approval_store.find_approved(conn, "run_shell", "s1", 900) == "a1"
    assert approval_store.consume_approved(conn, "run_shell", "s1", 900) is True
    assert approval_store.get_approval(conn, "a1")["status"] == "used"
    assert approval_store.set_approval_status(conn, "missing", "approved") is False


# ---------------------------------------------------------------- SEC-06

@pytest.fixture
def _fernet_key(monkeypatch):
    from cryptography.fernet import Fernet

    monkeypatch.setenv("AI_BRIDGE_MCP_TOKEN_KEY", Fernet.generate_key().decode())
    monkeypatch.delenv("DATABASE_URL", raising=False)


def _seed_mcp_server(conn, server_id, token, secret, refresh):
    now = time.time()
    conn.execute(
        "INSERT INTO mcp_servers (id, name, url, transport, auth_type, "
        "auth_token, oauth_client_secret, oauth_refresh_token, tenant, "
        "created_at, updated_at) "
        "VALUES (?, 'srv', 'https://example.com/mcp', 'http', 'bearer', ?, ?, ?, 'default', ?, ?)",
        (server_id, token, secret, refresh, now, now),
    )
    conn.commit()


def test_migrate_plaintext_secrets_reencrypts_and_is_idempotent(tmp_path: Path, _fernet_key):
    conn = dbmod.connect(tmp_path / "control.db")
    _seed_mcp_server(conn, "srv-plain", "tok-plain", "sec-plain", "ref-plain")
    _seed_mcp_server(conn, "srv-mixed", mcp_oauth.encrypt_token("tok-enc"), "", "ref-plain-2")
    _seed_mcp_server(conn, "srv-empty", "", "", "")

    result = mcp_oauth.migrate_plaintext_secrets(conn)
    assert result["total"] == 4  # 3 on srv-plain + 1 refresh on srv-mixed
    assert result["migrated"]["auth_token"] == 1
    assert result["migrated"]["oauth_client_secret"] == 1
    assert result["migrated"]["oauth_refresh_token"] == 2
    assert result["errors"] == []

    srv = mcp_oauth.get_mcp_server(conn, "srv-plain")
    assert srv["auth_token"] == "tok-plain"
    assert srv["oauth_client_secret"] == "sec-plain"
    assert srv["oauth_refresh_token"] == "ref-plain"
    raw = conn.execute(
        "SELECT auth_token FROM mcp_servers WHERE id='srv-plain'"
    ).fetchone()[0]
    assert raw.startswith("fernet1:")

    # Second run: nothing left to migrate.
    result2 = mcp_oauth.migrate_plaintext_secrets(conn)
    assert result2["total"] == 0


def test_migrate_plaintext_secrets_fails_closed_without_key(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("AI_BRIDGE_MCP_TOKEN_KEY", raising=False)
    conn = dbmod.connect(tmp_path / "control.db")
    _seed_mcp_server(conn, "srv-plain", "tok-plain", "", "")
    # No key: the row is reported in errors, nothing is migrated, and
    # the row is left untouched plaintext (no half-encryption, no
    # silent success) — the CLI exits 2 on this result.
    result = mcp_oauth.migrate_plaintext_secrets(conn)
    assert result["total"] == 0
    assert result["errors"] == ["srv-plain"]
    raw = conn.execute(
        "SELECT auth_token FROM mcp_servers WHERE id='srv-plain'"
    ).fetchone()[0]
    assert raw == "tok-plain"


# ---------------------------------------------------------------- F08-07 (Python half)

def test_dll_input_permissions_helper_arms_only_what_session_allows():
    from ai_bridge import webrtc_stream

    calls: list = []

    class FakeDll:
        def aibridge_set_input_permissions(self, m, k, c, s):
            calls.append((m, k, c, s))

    webrtc_stream._set_dll_input_permissions(FakeDll(), True, False)
    assert calls == [(1, 0, 0, 1)]
    webrtc_stream._set_dll_input_permissions(FakeDll(), False, True)
    assert calls[-1] == (0, 1, 0, 1)
    webrtc_stream._set_dll_input_permissions(FakeDll(), False, False)
    assert calls[-1] == (0, 0, 0, 0)
    # A DLL without the export (pre-5A build) is left alone, no crash.
    webrtc_stream._set_dll_input_permissions(object(), True, True)
    webrtc_stream._set_dll_input_permissions(None, True, True)


def test_release_all_held_keys_revokes_dll_input(monkeypatch):
    from ai_bridge import webrtc_stream

    calls: list = []

    class FakeDll:
        def aibridge_release_all_keys(self):
            return 2

        def aibridge_set_input_permissions(self, m, k, c, s):
            calls.append((m, k, c, s))

    monkeypatch.setattr(
        "ai_bridge.screen_capture.get_native_dll", lambda: FakeDll()
    )
    assert webrtc_stream.release_all_held_keys() == 2
    assert calls == [(0, 0, 0, 0)]
