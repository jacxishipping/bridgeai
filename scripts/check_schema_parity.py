#!/usr/bin/env python3
"""Check that the control-plane schema has ONE source of truth (DB-03).

Builds two SQLite databases and compares their schemas:

* DB-A: ``db.connect()`` — the fresh-install path (inline ``SCHEMA`` in
  ``src/ai_bridge/control/db.py`` + ``migrations.run_migrations``).
* DB-B: migrations alone — an empty database with only
  ``migrations/001``-``015`` applied (the PostgreSQL path, where the
  schema comes from migrations and ``SCHEMA`` is never executed).

Both must produce identical tables, columns, indexes, foreign keys and
CHECKs. Any drift fails with exit code 1 and a diff, so CI can gate on
it: every SCHEMA change must have a matching migration and vice versa.

Usage:
    python scripts/check_schema_parity.py [--keep DIR]

``--keep DIR`` keeps both databases under DIR for inspection instead of
using (and deleting) a temporary directory.

Exit codes: 0 = parity, 1 = drift found, 2 = error building a database.
"""
from __future__ import annotations

import argparse
import difflib
import re
import sqlite3
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from ai_bridge.control import db as dbmod  # noqa: E402
from ai_bridge.control import migrations  # noqa: E402

# Objects that legitimately differ between the two boots.
IGNORED = {"sqlite_sequence"}


def _normalize_sql(sql: str | None) -> str:
    """Normalize a sqlite_master sql string for comparison."""
    if not sql:
        return ""
    out = sql.strip()
    out = re.sub(r"\s+", " ", out)
    out = out.upper()
    # Migration files spell REAL as DOUBLE PRECISION; the runner adapts it.
    out = out.replace("DOUBLE PRECISION", "REAL")
    # Ignore spacing around punctuation: migration files tend to write
    # "col REAL NOT NULL )" where SCHEMA writes "col REAL NOT NULL)".
    out = re.sub(r"\s*([(),])\s*", r"\1", out)
    return out


def snapshot(db_path: Path) -> dict[str, str]:
    """{object-name: normalized sql} for every table and index."""
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute(
            "SELECT type, name, sql FROM sqlite_master "
            "WHERE sql IS NOT NULL ORDER BY type, name"
        ).fetchall()
    finally:
        conn.close()
    out: dict[str, str] = {}
    for type_, name, sql in rows:
        if name in IGNORED:
            continue
        out[f"{type_}:{name}"] = _normalize_sql(sql)
    return out


def build_schema_db(db_path: Path) -> None:
    dbmod.connect(db_path=db_path).close()


def build_migrations_db(db_path: Path) -> None:
    raw = sqlite3.connect(str(db_path))
    try:
        raw.execute("PRAGMA foreign_keys=ON")
        applied = migrations.run_migrations(raw, dialect="sqlite")
    finally:
        raw.close()
    return applied


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", type=Path, default=None,
                        help="Keep both databases under DIR for inspection.")
    args = parser.parse_args()

    tmp = args.keep
    if tmp is not None:
        tmp.mkdir(parents=True, exist_ok=True)
        workdir = tmp
    else:
        workdir = Path(tempfile.mkdtemp(prefix="aibridge-parity-"))

    db_a = workdir / "schema_boot.db"
    db_b = workdir / "migrations_boot.db"
    for p in (db_a, db_b):
        p.unlink(missing_ok=True)
    try:
        build_schema_db(db_a)
    except Exception as exc:
        print(f"ERROR building SCHEMA boot DB: {exc}", file=sys.stderr)
        return 2
    try:
        applied = build_migrations_db(db_b)
    except Exception as exc:
        print(f"ERROR building migrations-only DB: {exc}", file=sys.stderr)
        return 2

    snap_a = snapshot(db_a)
    snap_b = snapshot(db_b)
    names = sorted(set(snap_a) | set(snap_b))
    diffs: list[str] = []
    for name in names:
        if snap_a.get(name) != snap_b.get(name):
            diffs.append(name)
            print(f"DRIFT {name}:")
            if name not in snap_a:
                print(f"  only in migrations boot: {snap_b[name]}")
            elif name not in snap_b:
                print(f"  only in SCHEMA boot:     {snap_a[name]}")
            else:
                for line in difflib.unified_diff(
                    [snap_a[name]], [snap_b[name]], "SCHEMA boot", "migrations boot", lineterm=""
                ):
                    print(f"  {line}")
    versions_a = {
        r[0] for r in sqlite3.connect(str(db_a)).execute("SELECT version FROM schema_migrations")
    }
    print(f"migrations-only boot applied: {sorted(applied)}")
    print(f"SCHEMA boot versions: {sorted(versions_a)}")
    if diffs:
        print(f"\nPARITY FAILED: {len(diffs)} drifted object(s): {', '.join(diffs)}")
        print("Fix: add the missing change to the other source (SCHEMA in db.py "
              "or a new migration) and re-run this script.")
        return 1
    print("\nPARITY OK: SCHEMA boot and migrations-only boot are identical "
          f"({len(snap_a)} objects).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
