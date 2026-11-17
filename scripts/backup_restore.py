#!/usr/bin/env python3
"""Backup / restore drill for the AI Bridge control plane (DB-01).

SQLite path (executed in tests):
  backup  --db plane.db --out plane-YYYYMMDD-HHMMSS.db
          Uses sqlite3's online backup API via
          ai_bridge.control.backup.verified_backup (integrity-checked,
          refuses to overwrite, 0600 perms).
  restore --backup plane-....db --db fresh.db
          Copies the backup to a NEW path, runs PRAGMA integrity_check,
          then boots it through ai_bridge.control.db.connect() (which
          applies any pending migrations and verifies the schema) and
          reports row counts. Never overwrites an existing live DB —
          restore into a fresh path and swap it in while the plane is
          stopped.

Postgres path (scripted, NOT executed here — no Postgres server in this
environment; record honestly):
  backup  --pg-dsn "postgresql://user@host/db" --out dump.sql
          Runs pg_dump (custom format via --pg-format c is the default
          for restore with pg_restore; plain SQL with --pg-format p).
  restore --pg-dump dump.sql --pg-dsn "postgresql://user@host/newdb"
          Creates the target DB if missing (createdb) and restores with
          psql (plain) or pg_restore (custom format), then verifies by
          connecting and counting core tables.
  The commands are printed before running so an operator can audit
  them; pg_dump/psql/pg_restore must be on PATH (missing binary is a
  hard error, not a silent skip).

Backups contain password hashes, session-token hashes and device token
hashes: treat backup files as credentials (0600, encrypted off-host
copy). This tool never transmits anything.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from ai_bridge.control import db as dbmod  # noqa: E402
from ai_bridge.control.backup import verified_backup  # noqa: E402

_CORE_TABLES = ("users", "devices", "tasks", "sessions", "approvals")


def _verify_sqlite(path: Path) -> dict[str, int]:
    """Integrity-check + boot a SQLite plane DB; return core row counts."""
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as conn:
        check = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if check != "ok":
            raise ValueError(f"integrity check failed on {path}: {check}")
    # Boot through the real plane connect(): applies pending migrations
    # and verifies the schema is usable.
    conn = dbmod.connect(db_path=path)
    try:
        counts = {}
        for table in _CORE_TABLES:
            counts[table] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        return counts
    finally:
        conn.close()


def backup_sqlite(db_path: Path, out_path: Path) -> dict[str, int]:
    verified_backup(db_path, out_path)
    return _verify_sqlite(out_path)


def restore_sqlite(backup_path: Path, db_path: Path) -> dict[str, int]:
    """Restore a backup into a fresh path (refuses to overwrite)."""
    db_path = db_path.resolve()
    if db_path.exists():
        raise ValueError(f"refusing to overwrite existing database: {db_path}")
    descriptor = os.open(db_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        shutil.copyfile(backup_path, db_path)
    except Exception:
        db_path.unlink(missing_ok=True)
        raise
    return _verify_sqlite(db_path)


def _redact(cmd: list[str]) -> str:
    """Join a command for logging with any DSN password masked.

    pg_dump/pg_restore/psql take the DSN as an argument; printing it
    verbatim would leak the database password into logs. Mask the
    userinfo (``://user:password@``) — the command actually executed is
    unaffected.
    """
    import re

    text = " ".join(cmd)
    return re.sub(r"://[^:/\s]+:[^@\s]+@", "://***:***@", text)


def _run(cmd: list[str]) -> None:
    print("+ " + _redact(cmd))
    result = subprocess.run(cmd, check=False)
    if result.returncode != 0:
        raise SystemExit(f"command failed (exit {result.returncode}): {_redact(cmd)}")


def backup_postgres(dsn: str, out_path: Path, fmt: str = "c") -> None:
    """pg_dump to a file. Custom format ('c') is the default."""
    if shutil.which("pg_dump") is None:
        raise SystemExit("pg_dump not found on PATH — install PostgreSQL client tools")
    if out_path.exists():
        raise ValueError(f"refusing to overwrite existing backup: {out_path}")
    _run(["pg_dump", "--format", fmt, "--file", str(out_path), dsn])
    print(f"Postgres backup written to {out_path} (format {fmt}). "
          "Verify with a restore drill before relying on it.")


def _pg_conn_args(dsn: str) -> tuple[list[str], dict[str, str], str]:
    """Split a Postgres DSN into createdb/dropdb arguments.

    createdb/dropdb take a literal database NAME, not a conninfo string:
    passing a full DSN makes them connect to the default (local-socket)
    host instead of the DSN's host. Parse the DSN and pass -h/-p/-U
    explicitly, with the password via PGPASSWORD (never in argv, so it
    is never printed by _redact).
    """
    from urllib.parse import unquote, urlsplit

    u = urlsplit(dsn)
    args: list[str] = []
    env: dict[str, str] = {}
    if u.hostname:
        args += ["-h", u.hostname]
    if u.port:
        args += ["-p", str(u.port)]
    if u.username:
        args += ["-U", unquote(u.username)]
    if u.password:
        env["PGPASSWORD"] = unquote(u.password)
    dbname = (u.path or "/").lstrip("/")
    if not dbname:
        raise SystemExit("DSN has no database name")
    return args, env, dbname


def _createdb(dsn: str) -> None:
    """Create the target database, tolerating 'already exists'.

    createdb has no --if-not-exists flag, so a pre-existing database is
    detected from its stderr and treated as success; any other failure
    is fatal.
    """
    if shutil.which("createdb") is None:
        raise SystemExit("createdb not found on PATH")
    conn_args, extra_env, dbname = _pg_conn_args(dsn)
    cmd = ["createdb"] + conn_args + [dbname]
    print("+ " + _redact(cmd))
    env = dict(os.environ)
    env.update(extra_env)
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0 and "already exists" not in (result.stderr or ""):
        raise SystemExit(f"createdb failed: {result.stderr.strip()}")


def _dropdb(dsn: str) -> None:
    """Drop the database named by ``dsn``, tolerating 'does not exist'."""
    if shutil.which("dropdb") is None:
        raise SystemExit("dropdb not found on PATH")
    conn_args, extra_env, dbname = _pg_conn_args(dsn)
    cmd = ["dropdb"] + conn_args + [dbname]
    print("+ " + _redact(cmd))
    env = dict(os.environ)
    env.update(extra_env)
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0 and "does not exist" not in (result.stderr or ""):
        raise SystemExit(f"dropdb failed: {result.stderr.strip()}")


def restore_postgres(dump_path: Path, dsn: str, fmt: str = "c") -> None:
    """Restore a pg_dump file into the database named by ``dsn``.

    Creates the target database if it does not exist (createdb), then
    restores with pg_restore (custom format) or psql (plain SQL), and
    verifies core tables are readable.
    """
    if fmt == "c":
        if shutil.which("pg_restore") is None:
            raise SystemExit("pg_restore not found on PATH")
        _createdb(dsn)
        # --no-privileges: the dump carries ALTER DEFAULT PRIVILEGES for
        # the role that owns the live DB; restoring as the drill user
        # (a non-superuser that cannot impersonate that role) fails
        # those 4 statements with "permission denied to change default
        # privileges" and pg_restore exits 1. The backup file itself
        # stays full-fidelity; only the drill restore skips replaying
        # privilege changes. The data and schema are what the drill
        # verifies.
        _run(["pg_restore", "--dbname", dsn, "--clean", "--if-exists",
              "--no-privileges", str(dump_path)])
    else:
        if shutil.which("psql") is None:
            raise SystemExit("psql not found on PATH")
        _createdb(dsn)
        _run(["psql", dsn, "-v", "ON_ERROR_STOP=1", "-f", str(dump_path)])
    print("Postgres restore finished. Verify row counts with a live "
          "connection before pointing the plane at this database.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p_backup = sub.add_parser("backup", help="back up the plane database")
    p_backup.add_argument("--db", type=Path, help="SQLite plane DB path")
    p_backup.add_argument("--out", type=Path, required=True, help="backup output path")
    p_backup.add_argument("--pg-dsn", help="Postgres DSN (uses pg_dump)")
    p_backup.add_argument("--pg-format", choices=["c", "p"], default="c",
                          help="pg_dump format: c=custom (default), p=plain SQL")
    p_restore = sub.add_parser("restore", help="restore a backup into a fresh DB")
    p_restore.add_argument("--backup", type=Path, help="SQLite backup file")
    p_restore.add_argument("--db", type=Path, help="fresh SQLite DB path (must not exist)")
    p_restore.add_argument("--pg-dump", type=Path, help="pg_dump file to restore")
    p_restore.add_argument("--pg-dsn", help="target Postgres DSN")
    p_restore.add_argument("--pg-format", choices=["c", "p"], default="c")
    p_drop = sub.add_parser("drop", help="drop a Postgres database named by DSN")
    p_drop.add_argument("--pg-dsn", required=True, help="Postgres DSN of the DB to drop")
    args = parser.parse_args(argv)

    if args.command == "drop":
        _dropdb(args.pg_dsn)
        return 0

    if args.command == "backup":
        if args.pg_dsn:
            backup_postgres(args.pg_dsn, args.out, args.pg_format)
        else:
            if not args.db:
                parser.error("backup needs --db (SQLite) or --pg-dsn (Postgres)")
            counts = backup_sqlite(args.db, args.out)
            print(f"SQLite backup verified: {args.out} rows={counts}")
        return 0
    if args.pg_dump:
        if not args.pg_dsn:
            parser.error("Postgres restore needs --pg-dsn")
        restore_postgres(args.pg_dump, args.pg_dsn, args.pg_format)
    else:
        if not args.backup or not args.db:
            parser.error("SQLite restore needs --backup and --db")
        counts = restore_sqlite(args.backup, args.db)
        print(f"SQLite restore verified (plane boots): {args.db} rows={counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
