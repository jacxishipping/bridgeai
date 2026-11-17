"""Fleet device health summary (Phase 7): heartbeats, telemetry, stream health."""
from __future__ import annotations

import json
from typing import Any

from .. import webrtc_stream
from . import db as dbmod

STALE_HEARTBEAT_SEC = 90


def _device_online(row: Any, now_ts: float) -> bool:
    last_seen = row["last_seen"] or 0
    latency = (now_ts - last_seen) if last_seen else 99999.0
    return (row["status"] == "online") and latency < STALE_HEARTBEAT_SEC


def summarize_fleet_health(conn: Any, *, tenant: str = "default") -> dict[str, Any]:
    """Aggregate CPU/RAM, stale heartbeats, and active WebRTC stream health."""
    now_ts = dbmod.now()
    dev_rows = conn.execute(
        "SELECT id, name, os, status, last_seen FROM devices WHERE tenant=? AND revoked=0",
        (tenant,),
    ).fetchall()

    # PERF-04: one query for the latest telemetry row per device, instead
    # of one query per device (N+1). The GROUP BY uses
    # idx_telemetry_device_time, so the grouping is index-ordered. Ties
    # on recorded_at (two rows with the same max timestamp) are deduped
    # in Python, keeping the first.
    latest_rows = conn.execute(
        "SELECT t.device_id, t.cpu_percent, t.memory_percent, t.disk_percent, t.recorded_at "
        "FROM telemetry t "
        "INNER JOIN (SELECT device_id, MAX(recorded_at) AS max_ts FROM telemetry GROUP BY device_id) latest "
        "ON latest.device_id = t.device_id AND latest.max_ts = t.recorded_at "
        "WHERE t.device_id IN (SELECT id FROM devices WHERE tenant=? AND revoked=0)",
        (tenant,),
    ).fetchall()
    latest_tel: dict[str, dict[str, Any]] = {}
    for r in latest_rows:
        dev_id = r["device_id"] if hasattr(r, "keys") else r[0]
        if dev_id not in latest_tel:
            latest_tel[dev_id] = dict(r)

    devices: list[dict[str, Any]] = []
    stale_devices: list[dict[str, Any]] = []
    cpu_vals: list[float] = []
    mem_vals: list[float] = []
    online_count = 0

    for d in dev_rows:
        last_seen = d["last_seen"] or 0
        heartbeat_age_sec = round(now_ts - last_seen, 1) if last_seen else None
        is_online = _device_online(d, now_ts)
        if is_online:
            online_count += 1

        tel = latest_tel.get(d["id"])
        if tel:
            if tel.get("cpu_percent") is not None:
                cpu_vals.append(float(tel["cpu_percent"]))
            if tel.get("memory_percent") is not None:
                mem_vals.append(float(tel["memory_percent"]))

        health = "online" if is_online else ("stale" if d["status"] == "online" else "offline")
        entry = {
            "id": d["id"],
            "name": d["name"],
            "os": d["os"],
            "health": health,
            "last_seen": last_seen,
            "heartbeat_age_sec": heartbeat_age_sec,
            "telemetry": tel,
        }
        devices.append(entry)
        if health == "stale" or (d["status"] == "offline" and last_seen and heartbeat_age_sec and heartbeat_age_sec > STALE_HEARTBEAT_SEC):
            stale_devices.append({"id": d["id"], "name": d["name"], "heartbeat_age_sec": heartbeat_age_sec})

    streams = webrtc_stream.list_active_stream_health()
    unhealthy_streams = [s for s in streams if not s.get("healthy")]

    return {
        "tenant": tenant,
        "ts": now_ts,
        "total_devices": len(dev_rows),
        "online_devices": online_count,
        "stale_device_count": len(stale_devices),
        "avg_cpu_percent": round(sum(cpu_vals) / len(cpu_vals), 1) if cpu_vals else None,
        "avg_memory_percent": round(sum(mem_vals) / len(mem_vals), 1) if mem_vals else None,
        "stale_devices": stale_devices,
        "active_streams": len(streams),
        "unhealthy_streams": len(unhealthy_streams),
        "streams": streams,
        "devices": devices,
    }