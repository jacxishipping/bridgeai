#!/usr/bin/env python3
"""One-shot migration: re-encrypt legacy plaintext MCP OAuth secrets.

SEC-06 (Wave 5A): ``mcp_servers`` rows written before Fernet
encryption landed store ``auth_token`` / ``oauth_client_secret`` /
``oauth_refresh_token`` in plaintext (no ``fernet1:`` prefix). This
script re-encrypts them in place with the configured
``AI_BRIDGE_MCP_TOKEN_KEY`` (see ``control/mcp_oauth.py``:
``migrate_plaintext_secrets``). It is idempotent — a second run
migrates zero rows — and never prints a secret value, only counts.

Usage:
    AI_BRIDGE_MCP_TOKEN_KEY=<key> python scripts/migrate_mcp_secrets_to_fernet.py [--db PATH]

--db defaults to the control-plane DB (AI_BRIDGE_DATA_DIR/control.db
or ~/.ai-bridge/control.db); DATABASE_URL (Postgres) is honoured when
set. Exits 0 on success, 2 when no token key is configured, 1 on
any other failure.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=None, help="Control-plane SQLite DB path")
    args = parser.parse_args()

    from ai_bridge.control import db as dbmod
    from ai_bridge.control import mcp_oauth

    try:
        conn = dbmod.connect(Path(args.db) if args.db else None)
    except Exception as exc:
        print(f"cannot open control DB: {exc}", file=sys.stderr)
        return 1
    try:
        result = mcp_oauth.migrate_plaintext_secrets(conn)
    except RuntimeError as exc:
        print(f"migration refused: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"migration failed: {exc}", file=sys.stderr)
        return 1
    finally:
        try:
            conn.close()
        except Exception:
            pass
    per_col = ", ".join(f"{col}={n}" for col, n in result["migrated"].items())
    print(f"migrated {result['total']} plaintext secret(s) ({per_col}); "
          f"{result['already_encrypted']} already encrypted; "
          f"errors on {len(result['errors'])} server(s)")
    if result["errors"]:
        print("migration incomplete: set AI_BRIDGE_MCP_TOKEN_KEY and re-run",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
