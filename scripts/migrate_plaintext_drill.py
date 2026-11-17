#!/usr/bin/env python3
"""Gate 17 (Wave 6A): end-to-end drill of the plaintext-MCP-secret migration
against a REAL database (staging Postgres via a Render cron job).

SEC-06 (Wave 5A) added Fernet encryption for ``mcp_servers`` secrets and a
``migrate_plaintext_secrets`` function plus a boot hook that runs it at every
plane start. This drill proves the migration works end-to-end on the live
staging database — it was only ever verified on scratch SQLite DBs before:

  --mode drill   insert a test row with PLAINTEXT secrets -> run the
                 migration -> verify every secret is now ``fernet1:`` and
                 decrypts back to the original -> re-run the migration
                 (idempotency: total must be 0) -> delete the test row.
  --mode insert  insert the test row only (for the boot-hook proof: the row
                 is left in place so the next plane boot's hook migrates it).
  --mode verify  verify the row is encrypted + decrypts, then delete it
                 (the second half of the boot-hook proof).

The test values are random hex (generated per run); nothing real is ever
migrated, and the script prints ONLY counts/booleans/row id — never a secret
value. The row is deleted in a ``finally`` block so a failed drill cannot
leave a plaintext test secret behind (a leftover is reported, not hidden).

Usage (inside the Render Docker image; DATABASE_URL + AI_BRIDGE_MCP_TOKEN_KEY
in the environment):
    python3 scripts/migrate_plaintext_drill.py --mode drill
Exit 0 only when every check passes; 1 otherwise.
"""
from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ai_bridge.control import db as dbmod  # noqa: E402
from ai_bridge.control import mcp_oauth  # noqa: E402

ROW_PREFIX = "drill-"
SECRET_COLS = ("auth_token", "oauth_client_secret", "oauth_refresh_token")


def _row_id() -> str:
    return ROW_PREFIX + uuid.uuid4().hex[:12]


def _insert_row(conn, row_id: str) -> dict[str, str]:
    values = {col: secrets.token_hex(16) for col in SECRET_COLS}
    now = time.time()
    conn.execute(
        "INSERT INTO mcp_servers (id, name, url, transport, auth_type, "
        "auth_token, oauth_client_secret, oauth_refresh_token, tenant, "
        "created_at, updated_at) VALUES (?, ?, ?, 'http', 'bearer', ?, ?, ?, "
        "'default', ?, ?)",
        (
            row_id,
            "gate17-drill",
            "https://drill.invalid/mcp",
            values["auth_token"],
            values["oauth_client_secret"],
            values["oauth_refresh_token"],
            now,
            now,
        ),
    )
    conn.commit()
    return values


def _read_row(conn, row_id: str) -> dict[str, str] | None:
    rows = conn.execute(
        "SELECT auth_token, oauth_client_secret, oauth_refresh_token "
        "FROM mcp_servers WHERE id = ?",
        (row_id,),
    ).fetchall()
    if not rows:
        return None
    return dict(rows[0])


def _delete_row(conn, row_id: str) -> bool:
    conn.execute("DELETE FROM mcp_servers WHERE id = ?", (row_id,))
    conn.commit()
    return _read_row(conn, row_id) is None


def _verify_encrypted(conn, row_id: str, originals: dict[str, str]) -> dict[str, bool]:
    row = _read_row(conn, row_id)
    checks: dict[str, bool] = {"row_present": row is not None}
    if row is None:
        return checks
    checks["all_fernet1_prefix"] = all(
        (row.get(col) or "").startswith("fernet1:") for col in SECRET_COLS
    )
    decrypts: dict[str, bool] = {}
    for col in SECRET_COLS:
        try:
            decrypts[col] = mcp_oauth.decrypt_token(row[col]) == originals[col]
        except Exception:  # noqa: BLE001 — a failed decrypt is a failed check
            decrypts[col] = False
    checks["all_decrypt_roundtrip"] = all(decrypts.values())
    checks["decrypt_detail"] = decrypts
    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode", choices=("drill", "insert", "verify"), default="drill"
    )
    parser.add_argument("--row-id", default=None, help="row id for --mode verify")
    args = parser.parse_args()

    summary: dict[str, object] = {"mode": args.mode, "ok": False}
    conn = None
    row_id = args.row_id or _row_id()
    originals: dict[str, str] = {}
    try:
        conn = dbmod.connect()
        if args.mode == "insert":
            originals = _insert_row(conn, row_id)
            summary["row_id"] = row_id
            summary["inserted_plaintext_cols"] = len(SECRET_COLS)
            summary["ok"] = True
            print(json.dumps(summary))
            return 0

        if args.mode == "verify":
            row = _read_row(conn, row_id)
            if row is None:
                summary["error"] = "row not found (already migrated away?)"
                print(json.dumps(summary))
                return 1
            # The boot hook already migrated it; verify encryption + decrypt
            # against the stored values we cannot know — so verify the
            # prefix and that decryption SUCCEEDS (round-trip equality needs
            # the originals, which only --mode drill has).
            summary["row_id"] = row_id
            summary["all_fernet1_prefix"] = all(
                (row.get(col) or "").startswith("fernet1:") for col in SECRET_COLS
            )
            decrypt_ok: dict[str, bool] = {}
            for col in SECRET_COLS:
                try:
                    mcp_oauth.decrypt_token(row[col])
                    decrypt_ok[col] = True
                except Exception:  # noqa: BLE001 — failed decrypt is a check
                    decrypt_ok[col] = False
            summary["all_decrypt_ok"] = all(decrypt_ok.values())
            summary["decrypt_detail"] = decrypt_ok
            summary["deleted"] = _delete_row(conn, row_id)
            summary["ok"] = bool(
                summary["all_fernet1_prefix"]
                and summary["all_decrypt_ok"]
                and summary["deleted"]
            )
            print(json.dumps(summary))
            return 0 if summary["ok"] else 1

        # --mode drill (full end-to-end)
        originals = _insert_row(conn, row_id)
        summary["row_id"] = row_id
        summary["inserted_plaintext_cols"] = len(SECRET_COLS)
        first = mcp_oauth.migrate_plaintext_secrets(conn)
        summary["migrate_total"] = first.get("total")
        summary["migrate_per_column"] = first.get("migrated")
        summary["migrate_errors"] = first.get("errors")
        summary["verify"] = _verify_encrypted(conn, row_id, originals)
        second = mcp_oauth.migrate_plaintext_secrets(conn)
        summary["idempotent_second_run_total"] = second.get("total")
        summary["deleted"] = _delete_row(conn, row_id)
        summary["ok"] = bool(
            first.get("total") == len(SECRET_COLS)
            and not first.get("errors")
            and summary["verify"].get("all_fernet1_prefix")
            and summary["verify"].get("all_decrypt_roundtrip")
            and second.get("total") == 0
            and summary["deleted"]
        )
        print(json.dumps(summary))
        return 0 if summary["ok"] else 1
    except Exception as exc:  # noqa: BLE001 — drill must report, not crash silently
        summary["error"] = f"{type(exc).__name__}: {exc}"
        print(json.dumps(summary))
        return 1
    finally:
        if conn is not None and args.mode == "drill":
            # Safety net: never leave the test row behind, even on failure.
            # The in-flow delete above is the reported one; this only fires
            # if the flow raised before deleting.
            try:
                if not summary.get("deleted"):
                    _delete_row(conn, row_id)
            except Exception:  # noqa: BLE001 — best effort only
                pass
            conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
