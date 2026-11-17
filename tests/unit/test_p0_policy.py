"""Regression tests for Wave 1C P0 fixes: MCP policy gate, tiers,
audit writer, unrestricted policy (R-P0-02, R-P0-05, R-P0-06, R-P1-05,
F-04-02, F-06-02, F-06-06, F-06-10).

Import-light: imports only ai_bridge.policy and ai_bridge.audit_writer
directly; ai_bridge.server is imported for gate tests (venv has mcp /
fastapi / pydantic installed).
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pytest

from ai_bridge.policy import (
    Policy,
    decide,
    grant_unrestricted_policy,
    revoke_unrestricted_policy,
)


def test_bare_unrestricted_is_ignored():
    # R-P0-02: a bare Policy(unrestricted=True) — e.g. from an
    # enrollment/request body or a default — must NOT bypass anything.
    pol = Policy(unrestricted=True)
    assert not decide(pol, "delete_workspace_file").allowed
    assert decide(pol, "delete_workspace_file",
                  approval_granted=True, is_admin=True).allowed
    # Tier 3 without opt-in/approval is denied even when unrestricted.
    assert not decide(pol, "edit_workspace_file").allowed
    # Tier 1 still allowed by its own rule, not by the bypass.
    assert decide(pol, "get_system_info").allowed


def test_tier4_always_needs_approval_even_with_ceiling_4():
    # R-P0-02: the old max_tier_unattended>=4 escape is deleted.
    pol = Policy(max_tier_unattended=4)
    d = decide(pol, "delete_workspace_file")
    assert not d.allowed and d.needs_approval
    d = decide(pol, "m365_send_mail")
    assert not d.allowed and d.needs_approval


def test_tier4_with_approval_and_admin_allowed():
    pol = Policy(max_tier_unattended=4)
    assert decide(pol, "delete_workspace_file",
                  approval_granted=True, is_admin=True).allowed


def test_tier4_with_approval_but_no_admin_denied():
    assert not decide(Policy(), "delete_workspace_file",
                      approval_granted=True, is_admin=False).allowed


def test_granted_unrestricted_allows_tier3_but_not_tier4_without_approval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
):
    # R-P0-02: an audited grant enables the bypass for Tier <= 3...
    monkeypatch.delenv("AI_BRIDGE_MCP_AUDIT_DB", raising=False)
    monkeypatch.setenv("AI_BRIDGE_MCP_AUDIT_FILE", str(tmp_path / "audit.jsonl"))
    granted = grant_unrestricted_policy(Policy(), granted_by="admin-root")
    assert granted.unrestricted is True
    assert granted.unrestricted_granted_by == "admin-root"
    assert decide(granted, "edit_workspace_file").allowed
    # ...but Tier 4 STILL requires a recorded approval, even unrestricted.
    assert not decide(granted, "delete_workspace_file").allowed
    assert decide(granted, "delete_workspace_file",
                  approval_granted=True, is_admin=True).allowed


def test_unrestricted_grant_is_audited(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    log = tmp_path / "audit.jsonl"
    monkeypatch.delenv("AI_BRIDGE_MCP_AUDIT_DB", raising=False)
    monkeypatch.setenv("AI_BRIDGE_MCP_AUDIT_FILE", str(log))
    grant_unrestricted_policy(Policy(), granted_by="admin-root")
    rows = [json.loads(line) for line in log.read_text().splitlines()]
    assert len(rows) == 1
    assert rows[0]["action"] == "policy.unrestricted_granted"
    assert rows[0]["actor"] == "admin-root"


def test_grant_requires_actor():
    with pytest.raises(ValueError):
        grant_unrestricted_policy(Policy(), granted_by="  ")
    with pytest.raises(ValueError):
        revoke_unrestricted_policy(Policy(unrestricted=True), revoked_by="")


def test_revoke_unrestricted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("AI_BRIDGE_MCP_AUDIT_DB", raising=False)
    monkeypatch.setenv("AI_BRIDGE_MCP_AUDIT_FILE", str(tmp_path / "audit.jsonl"))
    granted = grant_unrestricted_policy(Policy(), granted_by="admin-root")
    revoked = revoke_unrestricted_policy(granted, revoked_by="admin-root")
    assert revoked.unrestricted is False
    assert revoked.unrestricted_granted_by is None
    assert not decide(revoked, "edit_workspace_file").allowed


def test_select_device_is_routing_only_and_allowed():
    # R-P0-05: select_device is SENSITIVE but exempt from the Tier-3
    # opt-in (it changes no device state; later calls are each gated).
    assert decide(Policy(), "select_device").allowed
    assert decide(Policy(), "select_device").reason.startswith("Allowed")


def test_new_tier_entries_exist():
    from ai_bridge.policy import TOOL_TIERS, RiskTier
    assert TOOL_TIERS["system_info"] == RiskTier.READ_ONLY
    assert TOOL_TIERS["view_live_screen"] == RiskTier.READ_ONLY
    assert TOOL_TIERS["interact_and_view_screen"] == RiskTier.READ_ONLY
    assert TOOL_TIERS["select_device"] == RiskTier.SENSITIVE
    assert TOOL_TIERS["browser_navigate_with_shot"] == RiskTier.SENSITIVE


def test_audit_writer_redacts_and_truncates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from ai_bridge import audit_writer

    log = tmp_path / "audit.jsonl"
    monkeypatch.setenv("AI_BRIDGE_MCP_AUDIT_FILE", str(log))
    monkeypatch.delenv("AI_BRIDGE_MCP_AUDIT_DB", raising=False)
    event = audit_writer.record_tool_call(
        actor="stdio", session_id="s1", tool="write_file", tier=3,
        device_id="local", decision="allowed",
        args={"path": "x.txt", "password": "hunter2", "token": "sekrit",
              "content": "A" * 100_000},
        result_summary="ok",
    )
    assert event is not None
    rows = [json.loads(line) for line in log.read_text().splitlines()]
    assert len(rows) == 1
    blob = log.read_text()
    assert "hunter2" not in blob and "sekrit" not in blob
    assert "***REDACTED***" in blob
    assert rows[0]["tool"] == "write_file"
    assert rows[0]["decision"] == "allowed"
    assert len(rows[0]["arguments"]["content"]) < 100_000  # truncated


def test_audit_writer_db_hash_chain(tmp_path: Path):
    from ai_bridge import audit_writer

    db_path = tmp_path / "control.db"
    event = audit_writer.record_tool_call(
        actor="admin", session_id="s1", tool="run_shell", tier=3,
        device_id="local", decision="denied",
        args={"command": "uptime"}, result_summary="denied by policy",
        db_path=str(db_path),
    )
    assert event is not None
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute(
            "SELECT tool, decision, entry_hash FROM audit"
        ).fetchall()
    finally:
        conn.close()
    assert len(rows) == 1
    assert rows[0][0] == "run_shell" and rows[0][1] == "denied"
    assert rows[0][2]  # hash-chain entry hash present


def test_audit_writer_db_failure_falls_back_to_jsonl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
):
    from ai_bridge import audit_writer

    log = tmp_path / "audit.jsonl"
    monkeypatch.setenv("AI_BRIDGE_MCP_AUDIT_FILE", str(log))
    # A directory as db_path makes the DB write fail; JSONL must catch it.
    event = audit_writer.record_tool_call(
        actor="stdio", session_id="s1", tool="get_system_info", tier=1,
        device_id="local", decision="allowed", args={},
        db_path=str(tmp_path),
    )
    assert event is not None
    assert log.exists()
    assert json.loads(log.read_text().splitlines()[0])["tool"] == "get_system_info"
