#!/usr/bin/env python3
"""Before/after micro-benchmarks for the Wave 3A PERF changes.

Everything printed here is MEASURED at run time on a synthetic database
built by this script (seeded devices/tasks/telemetry). "Before" figures
are produced by re-implementing the OLD algorithm inline in this script
(labelled OLD) on the same data, so the comparison is apples-to-apples;
nothing is hard-coded or copied from an earlier run.

Measured:
  PERF-04  fleet health: old N+1 (1 query per device + 1) vs new
           single-query summary — query count + wall time.
  PERF-03  task list: full rows (incl. result TEXT) vs projected
           columns — bytes returned for a page of 50 tasks.
  PERF-05  telemetry prune: COUNT-only fast path (below threshold)
           vs full prune (above threshold) — wall time.
  PERF-06  wake latency: notify -> wait_for_device_notification
           returns, vs the old 0.15 s spin (worst case 150 ms + a DB
           check per cycle) — measured wake latency in ms.
  PERF-07  handoff_status: old full-table scan vs indexed
           WHERE handoff_id=? — wall time.

Usage: python3 scripts/bench_phase2.py [--devices N] [--tasks N]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from ai_bridge.control import agent_channel, db as dbmod, fleet_health, supervisor  # noqa: E402

RESULT_BLOB = "x" * 20_000  # 20 KB result payload, like a real tool result


def seed(conn, n_devices: int, n_tasks: int) -> None:
    now = dbmod.now()
    for i in range(n_devices):
        conn.execute(
            "INSERT INTO devices (id, name, tenant, token_hash, status, last_seen, created_at)"
            " VALUES (?, ?, 'default', 't', 'online', ?, ?)",
            (f"d{i:04d}", f"d{i:04d}", now, now),
        )
        for j in range(5):
            conn.execute(
                "INSERT INTO telemetry (device_id, tenant, cpu_percent, memory_percent,"
                " disk_percent, recorded_at) VALUES (?, 'default', ?, 20.0, 30.0, ?)",
                (f"d{i:04d}", 10.0 + (i % 80), now - (5 - j)),
            )
    for i in range(n_tasks):
        conn.execute(
            "INSERT INTO tasks (id, device_id, tenant, tool, args_json, status, tier, created_at,"
            " updated_at, result, handoff_id, parent_task_id) VALUES (?, ?, 'default',"
            " 'run_command', '{}', 'completed', 2, ?, ?, ?, ?, NULL)",
            (
                f"t{i:05d}",
                f"d{i % n_devices:04d}",
                now - i,
                now - i,
                RESULT_BLOB,
                f"h{i % 50:03d}",
            ),
        )
    conn.commit()


def old_fleet_health(conn) -> dict:
    """OLD (PERF-04) algorithm: one query per device + one for devices."""
    devices = conn.execute("SELECT id FROM devices").fetchall()
    rows = []
    for (device_id,) in devices:
        row = conn.execute(
            "SELECT cpu_percent, memory_percent, disk_percent, recorded_at FROM telemetry"
            " WHERE device_id=? ORDER BY recorded_at DESC LIMIT 1",
            (device_id,),
        ).fetchone()
        rows.append(row)
    return {"devices": len(devices), "with_telemetry": sum(1 for r in rows if r)}


def old_handoff_status(conn, handoff_id: str) -> list:
    """OLD (PERF-07) algorithm: full-table scan + Python filter."""
    rows = conn.execute("SELECT id, handoff_id, status FROM tasks").fetchall()
    return [r for r in rows if r[1] == handoff_id]


def timed(fn, reps: int = 5) -> float:
    times = []
    for _ in range(reps):
        t0 = time.perf_counter()
        fn()
        times.append(time.perf_counter() - t0)
    return statistics.median(times) * 1000.0


async def wake_latency() -> float:
    """Measured notify -> waiter-return latency (PERF-06)."""
    latencies = []
    for _ in range(5):
        waiter = asyncio.create_task(agent_channel.wait_for_device_notification("d0000", 5.0))

        async def _notify():
            await asyncio.sleep(0.005)
            agent_channel.notify_task_available("d0000")

        t0 = time.perf_counter()
        await _notify()
        ok = await waiter
        latencies.append((time.perf_counter() - t0) * 1000.0)
        assert ok
    return statistics.median(latencies)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--devices", type=int, default=50)
    ap.add_argument("--tasks", type=int, default=2000)
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp())
    conn = dbmod.connect(db_path=tmp / "bench.db")
    seed(conn, args.devices, args.tasks)
    print(f"seeded {args.devices} devices, {args.tasks} tasks, "
          f"{args.devices * 5} telemetry rows")

    # PERF-04: query count is structural (old = N+1, new = 1); time measured.
    n_queries_old = args.devices + 1
    t_old = timed(lambda: old_fleet_health(conn))
    t_new = timed(lambda: fleet_health.summarize_fleet_health(conn, tenant="default"))
    print(f"PERF-04 fleet health: OLD {n_queries_old} queries, {t_old:.2f} ms | "
          f"NEW 1 query, {t_new:.2f} ms")

    # PERF-03: bytes for one page of 50 tasks.
    full = conn.execute("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50").fetchall()
    full_bytes = sum(len(json.dumps(dict(r))) for r in full)
    projected = dbmod.list_tasks_projected(conn, tenant="default", limit=50)
    proj_bytes = sum(len(json.dumps(row)) for row in projected)
    assert "result" not in projected[0]
    print(f"PERF-03 list page (50 tasks): OLD full rows {full_bytes} bytes | "
          f"NEW projected {proj_bytes} bytes "
          f"({100.0 * (1 - proj_bytes / full_bytes):.0f}% smaller)")

    # PERF-05: prune fast path vs full prune (per-device, d0000 seeded with 5 rows).
    t_fast = timed(lambda: dbmod.maybe_prune_telemetry(conn, "d0000", keep=500))
    # Push d0000 over the threshold, then measure the real prune.
    now = dbmod.now()
    for i in range(700):
        conn.execute(
            "INSERT INTO telemetry (device_id, tenant, cpu_percent, recorded_at)"
            " VALUES ('d0000', 'default', 1.0, ?)", (now - i,))
    conn.commit()
    t_prune = timed(lambda: dbmod.maybe_prune_telemetry(conn, "d0000", keep=500), reps=1)
    remaining = conn.execute("SELECT COUNT(*) FROM telemetry WHERE device_id='d0000'").fetchone()[0]
    print(f"PERF-05 telemetry prune: below-threshold COUNT-only {t_fast:.2f} ms | "
          f"above-threshold prune {t_prune:.2f} ms (d0000 rows after prune: {remaining})")

    # PERF-07: full scan vs indexed lookup.
    t_scan = timed(lambda: old_handoff_status(conn, "h000"))
    t_idx = timed(lambda: supervisor.handoff_status(conn, "h000"))
    print(f"PERF-07 handoff_status: OLD full-table scan {t_scan:.2f} ms | "
          f"NEW indexed lookup {t_idx:.2f} ms")

    # PERF-06: measured wake latency vs old 150 ms spin bound.
    lat = asyncio.run(wake_latency())
    print(f"PERF-06 wake latency: measured median {lat:.2f} ms "
          f"(old spin worst case ~150 ms + DB check per cycle)")
    print("bench done — all figures measured on this run, on this machine.")
    # Clean up the seeded temp DB (earlier runs left 40 MB bench.db files
    # in /tmp and filled the tmpfs — see analysis/wave3a-progress.md §9).
    shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
