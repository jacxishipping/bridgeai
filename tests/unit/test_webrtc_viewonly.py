"""Regression tests for R-P0-13 / F13-03 and F13-04: WebRTC input authorisation.

* Unknown session shape (the remote HttpSignaling path, which has no
  ``.session`` dict) must DENY input — the old code returned True.
* ``view_only`` mode must reject mouse/keyboard input agent-side.
* A mid-session mode change delivered via poll_session() must take effect
  through the streamer's cached session state.
* Human takeover must refuse all DataChannel input until handed back,
  while read-only ping/pong and the safety key release keep working.

These tests construct AgentStreamer directly (no aiortc peer connection,
no network); only the authorisation gates are exercised.
"""

import json

import pytest

from ai_bridge.webrtc_stream import AgentStreamer, DictSignaling


@pytest.fixture(autouse=True)
def _clear_global_input_gates():
    """Other test modules set the process-global emergency-stop / takeover
    flags and do not always clear them. Reset them here so these gate
    tests measure the session state, not leftover global state.
    """
    from ai_bridge.plane_control_flags import set_emergency_stop

    set_emergency_stop(False)
    try:
        from ai_bridge.control.v1_routes import _HUMAN_TAKEOVER_BY_DEVICE

        _HUMAN_TAKEOVER_BY_DEVICE.clear()
    except Exception:
        pass
    yield
    set_emergency_stop(False)
    try:
        from ai_bridge.control.v1_routes import _HUMAN_TAKEOVER_BY_DEVICE

        _HUMAN_TAKEOVER_BY_DEVICE.clear()
    except Exception:
        pass


class FakeRemoteSignaling:
    """Stand-in for HttpSignaling: no ``.session`` attribute at all."""

    def __init__(self, polled=None):
        self.polled = dict(polled or {"status": "connected"})

    def poll_session(self):
        return dict(self.polled)

    def post_offer(self, offer):
        pass

    def post_candidate(self, candidate):
        pass

    def post_error(self, message):
        pass


def _streamer(signaling, session_id="sess-test-1"):
    return AgentStreamer(session_id, signaling)


def _mouse_move():
    return json.dumps({"action": "mouse_move", "x": 0.5, "y": 0.5})


# --- R-P0-13: default-deny for unknown session shape ------------------------


def test_unknown_session_shape_denies_input():
    streamer = _streamer(FakeRemoteSignaling())
    assert streamer._session_allows_input(is_mouse=True) is False
    assert streamer._session_allows_input(is_keyboard=True) is False
    assert streamer._session_allows_input(require_clipboard=True) is False


def test_unknown_session_shape_rejects_mouse_move():
    streamer = _streamer(FakeRemoteSignaling())
    res = streamer._handle_input_payload(_mouse_move())
    assert res.get("ok") is False
    assert res.get("error") in ("mouse_control_denied", "human_takeover_active")


def test_empty_cached_state_still_denies():
    streamer = _streamer(FakeRemoteSignaling())
    # A poll that carries no mode/permission keys must not unlock input.
    streamer._refresh_session_state({"status": "connected", "answer": None})
    assert streamer._session_allows_input(is_mouse=True) is False


# --- R-P0-13: view_only enforced agent-side ---------------------------------


def test_view_only_session_rejects_input():
    streamer = _streamer(DictSignaling({"mode": "view_only", "device_id": "d1"}))
    assert streamer._session_allows_input(is_mouse=True) is False
    assert streamer._session_allows_input(is_keyboard=True) is False
    res = streamer._handle_input_payload(_mouse_move())
    assert res.get("ok") is False
    assert res.get("error") == "mouse_control_denied"


def test_human_control_session_allows_input_at_the_gate():
    streamer = _streamer(DictSignaling({"mode": "human_control", "device_id": "d1"}))
    assert streamer._session_allows_input(is_mouse=True) is True
    assert streamer._session_allows_input(is_keyboard=True) is True


def test_mode_change_via_poll_takes_effect():
    streamer = _streamer(FakeRemoteSignaling())
    assert streamer._session_allows_input(is_mouse=True) is False
    streamer._refresh_session_state(
        {"mode": "human_control", "permissions": {"control_mouse": True}}
    )
    assert streamer._session_allows_input(is_mouse=True) is True
    # Mid-session switch to view_only stops input on the next refresh.
    streamer._refresh_session_state({"mode": "view_only"})
    assert streamer._session_allows_input(is_mouse=True) is False
    res = streamer._handle_input_payload(_mouse_move())
    assert res.get("ok") is False


def test_view_only_with_explicit_permissions_still_denies():
    streamer = _streamer(
        DictSignaling(
            {
                "mode": "view_only",
                "permissions": {"control_mouse": True, "control_keyboard": True},
            }
        )
    )
    assert streamer._session_allows_input(is_mouse=True) is False


# --- F13-04: human takeover --------------------------------------------------


def test_takeover_rejects_input():
    streamer = _streamer(
        DictSignaling(
            {"mode": "human_control", "device_id": "d1", "human_takeover_active": True}
        )
    )
    assert streamer._session_allows_input(is_mouse=True) is False
    res = streamer._handle_input_payload(_mouse_move())
    assert res.get("ok") is False
    assert res.get("error") == "human_takeover_active"


def test_takeover_via_cached_remote_state_rejects_input():
    streamer = _streamer(FakeRemoteSignaling())
    streamer._refresh_session_state(
        {"mode": "human_control", "human_takeover_active": True}
    )
    res = streamer._handle_input_payload(_mouse_move())
    assert res.get("ok") is False
    assert res.get("error") == "human_takeover_active"


def test_ping_and_key_release_still_work_during_takeover():
    streamer = _streamer(
        DictSignaling(
            {"mode": "human_control", "device_id": "d1", "human_takeover_active": True}
        )
    )
    pong = streamer._handle_input_payload(json.dumps({"action": "ping"}))
    assert pong.get("ok") is True
    released = streamer._handle_input_payload(
        json.dumps({"action": "release_all_keys"})
    )
    assert released.get("ok") is True


def test_takeover_cleared_restores_input_gate():
    session = {"mode": "human_control", "device_id": "d1", "human_takeover_active": True}
    streamer = _streamer(DictSignaling(session))
    assert streamer._session_allows_input(is_mouse=True) is False
    session["human_takeover_active"] = False
    assert streamer._session_allows_input(is_mouse=True) is True


# --- F13-02: the shifted native-encode timing call is gone -------------------


def test_shifted_native_encode_call_removed():
    """The old per-frame call passed (rgb, len(rgb), w, h, 3, ...) against
    the (bgra, width, height, fps, bitrate_kbps, ...) ABI and discarded
    the result. It was deleted, not repaired; this guards against it
    coming back.
    """
    from pathlib import Path

    src = Path(__file__).resolve().parents[2] / "src" / "ai_bridge" / "webrtc_stream.py"
    text = src.read_text(encoding="utf-8")
    assert "aibridge_encode_h264_frame" not in text
    assert "should_use_native_encode_timing" not in text
