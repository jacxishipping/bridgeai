"""Tests for single-use stream tickets (D-08 follow-up).

A stream ticket is a short-lived (60 s), single-use credential minted by an
authenticated viewer via POST /api/stream-ticket, bound to one actor +
tenant + device + WebRTC session. The dashboard puts the ticket (never a
long-lived token) in the WebSocket signalling URL; the WS endpoint redeems
it on connect. Only the SHA-256 hash is stored.
"""
from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from ai_bridge.control import db as dbmod
from ai_bridge.control.app import create_app
from ai_bridge.control.v1_routes import save_webrtc_session_db


@pytest.fixture
def db_path():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        path = Path(f.name)
    yield path
    gc.collect()
    try:
        if path.exists():
            path.unlink(missing_ok=True)
    except PermissionError:
        pass


@pytest.fixture
def admin_token():
    return "test-admin-token-12345"


@pytest.fixture
def app_instance(db_path, admin_token):
    application = create_app(admin_token=admin_token, db_path=db_path)
    yield application
    try:
        application.state.conn.close()
    except Exception:
        pass


@pytest.fixture
def client(app_instance):
    return TestClient(app_instance)


@pytest.fixture
def admin_headers(admin_token):
    return {"X-Admin-Token": admin_token}


@pytest.fixture
def viewer_headers(client, admin_headers):
    client.post(
        "/api/auth/users",
        json={"username": "ticket-viewer", "password": "ticketpass123", "role": "viewer"},
        headers=admin_headers,
    )
    resp = client.post(
        "/api/auth/login",
        json={"username": "ticket-viewer", "password": "ticketpass123"},
    )
    assert resp.status_code == 200
    session_token = resp.json()["session_token"]
    # The control plane requires an X-CSRF-Token header on mutating
    # session-authenticated requests (same flow as the dashboard's api.ts).
    csrf = client.get("/api/auth/csrf-token", headers={"X-Session-Token": session_token})
    assert csrf.status_code == 200
    return {"X-Session-Token": session_token, "X-CSRF-Token": csrf.json()["csrf_token"]}


@pytest.fixture
def device_id(client, admin_headers):
    enroll = client.post(
        "/api/devices/enroll", json={"name": "ticket-device", "os": "windows"}, headers=admin_headers
    ).json()
    return enroll["device_id"]


def _mint(client, headers, device_id, session_id="sess-1"):
    return client.post(
        "/api/stream-ticket",
        json={"device_id": device_id, "session_id": session_id},
        headers=headers,
    )


class TestStreamTicketMint:
    def test_mint_returns_ticket_bound_to_device_and_session(self, client, viewer_headers, device_id, app_instance):
        resp = _mint(client, viewer_headers, device_id)
        assert resp.status_code == 200
        data = resp.json()
        assert data["ticket"]
        assert data["device_id"] == device_id
        assert data["session_id"] == "sess-1"
        assert data["expires_in"] == dbmod.STREAM_TICKET_TTL_S
        # Only the hash is stored — the ticket itself never appears in the DB.
        conn = app_instance.state.conn
        row = conn.execute(
            "SELECT * FROM stream_tickets WHERE ticket_hash=?",
            (dbmod.hash_token(data["ticket"]),),
        ).fetchone()
        assert row is not None
        assert row["used"] == 0
        assert row["device_id"] == device_id

    def test_mint_requires_authentication(self, client, device_id):
        resp = _mint(client, {}, device_id)
        assert resp.status_code == 401

    def test_mint_requires_csrf_token(self, client, viewer_headers, device_id):
        headers = {k: v for k, v in viewer_headers.items() if k != "X-CSRF-Token"}
        resp = _mint(client, headers, device_id)
        assert resp.status_code == 403

    def test_mint_requires_device_and_session(self, client, viewer_headers):
        assert client.post("/api/stream-ticket", json={"device_id": "", "session_id": "s"}, headers=viewer_headers).status_code == 400
        assert client.post("/api/stream-ticket", json={"device_id": "d", "session_id": ""}, headers=viewer_headers).status_code == 400


class TestStreamTicketRedeem:
    def test_redeem_once_then_second_use_rejected(self, client, viewer_headers, device_id, app_instance):
        ticket = _mint(client, viewer_headers, device_id).json()["ticket"]
        conn = app_instance.state.conn
        first = dbmod.redeem_stream_ticket(conn, ticket, device_id=device_id, session_id="sess-1")
        assert first is not None
        assert first["device_id"] == device_id
        # Single-use: the same ticket never redeems twice.
        assert dbmod.redeem_stream_ticket(conn, ticket, device_id=device_id, session_id="sess-1") is None

    def test_expired_ticket_rejected(self, client, viewer_headers, device_id, app_instance):
        ticket = _mint(client, viewer_headers, device_id).json()["ticket"]
        conn = app_instance.state.conn
        conn.execute(
            "UPDATE stream_tickets SET expires_at=? WHERE ticket_hash=?",
            (dbmod.now() - 10, dbmod.hash_token(ticket)),
        )
        conn.commit()
        assert dbmod.redeem_stream_ticket(conn, ticket, device_id=device_id, session_id="sess-1") is None

    def test_wrong_device_rejected_and_ticket_survives(self, client, viewer_headers, device_id, app_instance):
        ticket = _mint(client, viewer_headers, device_id).json()["ticket"]
        conn = app_instance.state.conn
        # Wrong device: rejected, and the ticket is NOT consumed by the miss.
        assert dbmod.redeem_stream_ticket(conn, ticket, device_id="some-other-device", session_id="sess-1") is None
        assert dbmod.redeem_stream_ticket(conn, ticket, device_id=device_id, session_id="sess-1") is not None

    def test_wrong_session_rejected(self, client, viewer_headers, device_id, app_instance):
        ticket = _mint(client, viewer_headers, device_id).json()["ticket"]
        conn = app_instance.state.conn
        assert dbmod.redeem_stream_ticket(conn, ticket, device_id=device_id, session_id="other-session") is None
        assert dbmod.redeem_stream_ticket(conn, ticket, device_id=device_id, session_id="sess-1") is not None

    def test_unknown_ticket_rejected(self, app_instance, device_id):
        assert (
            dbmod.redeem_stream_ticket(
                app_instance.state.conn, "not-a-real-ticket", device_id=device_id, session_id="sess-1"
            )
            is None
        )


class TestStreamTicketWebSocket:
    def test_websocket_connect_with_ticket_then_replay_rejected(
        self, client, viewer_headers, device_id, app_instance
    ):
        save_webrtc_session_db(
            app_instance.state.conn,
            app_instance.state,
            {"session_id": "sess-1", "device_id": device_id, "status": "waiting"},
        )
        ticket = _mint(client, viewer_headers, device_id).json()["ticket"]
        with client.websocket_connect(f"/api/v1/ws/sessions/sess-1?ticket={ticket}") as ws:
            snapshot = ws.receive_json()
            assert snapshot["type"] == "session_snapshot"
        # Replay of the same ticket over a new handshake is rejected (4401).
        with pytest.raises(Exception):
            with client.websocket_connect(f"/api/v1/ws/sessions/sess-1?ticket={ticket}"):
                pass

    def test_websocket_connect_with_bad_ticket_rejected(
        self, client, viewer_headers, device_id, app_instance
    ):
        save_webrtc_session_db(
            app_instance.state.conn,
            app_instance.state,
            {"session_id": "sess-1", "device_id": device_id, "status": "waiting"},
        )
        with pytest.raises(Exception):
            with client.websocket_connect("/api/v1/ws/sessions/sess-1?ticket=bogus"):
                pass
