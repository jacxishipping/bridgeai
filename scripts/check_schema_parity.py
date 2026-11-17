#!/usr/bin/env python3
"""Check that the control-plane schema has ONE source of truth (DB-03).

Builds two SQLite databases and compares their schemas:

* DB-A: ``db.connect()`` — the fresh-install path (inline ``SCHEMA`` in
  ``src/ai_bridge/control/db.py`` + ``migrations.run_migrations``).
* DB-B: migrations alone — an empty database with only
  ``migrations/001``-``016`` applied (the PostgreSQL path, where the
  schema comes from migrations and ``SCHEMA`` is never executed).

Both must produce identical tables, columns, indexes, foreign keys and
CHECKs. Any drift fails with exit code 1 and a diff, so CI can gate on
it: every SCHEMA change must have a matching migration and vice versa.

Usage:
    python scripts/check_schema_parity.py [--keep DIR]
    python scripts/check_schema_parity.py --postgres DSN [--keep DIR]

``--postgres DSN`` additionally compares the migrations-only schema
built on a real PostgreSQL server against the migrations-only schema
built on SQLite (structural comparison — tables/columns, unique sets,
explicit indexes, foreign keys, CHECKs — with cross-dialect type and
expression normalization). DSN must point at an existing database the
caller can CREATE DATABASE from (the script creates and drops two
scratch databases, ``parity_a``/``parity_b``, unless --keep is given).

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
from urllib.parse import urlparse, urlunparse

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "src"))

from ai_bridge.control import db as dbmod  # noqa: E402
from ai_bridge.control import migrations  # noqa: E402

# Objects that legitimately differ between the two boots.
IGNORED = {"sqlite_sequence"}


# --- cross-dialect normalization (Gate 16, Wave 6) --------------------------

# PostgreSQL data_type -> canonical type used for comparison. SQLite
# stores the declared type as written; migrations spell timestamps as
# DOUBLE PRECISION and keys as SERIAL, so those map too.
_PG_TYPE_MAP = {
    "double precision": "REAL",
    "real": "REAL",
    "integer": "INTEGER",
    "bigint": "INTEGER",
    "smallint": "INTEGER",
    "text": "TEXT",
    "character varying": "TEXT",
    "boolean": "INTEGER",
}


def _canonical_type(raw: str | None) -> str:
    if not raw:
        return ""
    out = raw.strip().upper()
    out = out.replace("DOUBLE PRECISION", "REAL")
    return _PG_TYPE_MAP.get(out.lower(), out)


def _canonical_default(raw: object) -> str:
    """Normalize a column default for comparison.

    PostgreSQL renders defaults with casts (``'1'::integer``,
    ``''::text``) and serial defaults as ``nextval(...)``; SQLite stores
    the literal as written. Strip casts, drop nextval (a serial artifact
    whose SQLite twin is "no default"), and compare the rest verbatim.
    """
    if raw is None:
        return ""
    out = str(raw).strip()
    if out.startswith("nextval("):
        return ""
    out = re.sub(r"::[A-Za-z ]+", "", out)
    # Dialect-specific "epoch seconds now": SQLite spells it
    # strftime('%s','now'), PostgreSQL EXTRACT(epoch FROM now()).
    # Same value, different spelling — canonicalize (Gate 16).
    squashed = re.sub(r"\s+", "", out).lower()
    if squashed in ("strftime('%s','now')", "extract(epochfromnow())"):
        return "epoch_now()"
    return out


def _strip_outer_parens(s: str) -> str:
    """Strip balanced outer parens while they wrap the whole string."""
    s = s.strip()
    while len(s) >= 2 and s[0] == "(" and s[-1] == ")":
        depth = 0
        wraps = True
        for i, ch in enumerate(s):
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0 and i != len(s) - 1:
                    wraps = False
                    break
        if not wraps or depth != 0:
            break
        s = s[1:-1].strip()
    return s


def _strip_redundant_check_parens(expr: str) -> str:
    """Drop parens that only group a single comparison or an AND-chain.

    PostgreSQL's pg_get_constraintdef parenthesizes every AND/OR operand
    (``(TIER IS NULL) OR ((TIER >= 1) AND (TIER <= 4))``) while SQLite
    stores the expression as written (``TIER IS NULL OR (TIER >= 1 AND
    TIER <= 4)``). Removing parens around a single comparison, or around
    an AND-chain, is semantics-preserving: AND binds tighter than OR, so
    an AND-group needs no parens as an OR operand and a lone comparison
    needs none anywhere. Parens around an OR-chain are NEVER stripped
    (they matter inside an AND), and the parens of an IN (...) list are
    never touched (guarded by the IN lookbehind). Runs to a fixpoint
    because stripping inner groups can expose an outer strippable group.
    """
    out = expr

    def _strip_once(text: str) -> str:
        def _repl(m: re.Match[str]) -> str:
            inner = m.group(1)
            if re.search(r"\bOR\b", inner, re.IGNORECASE):
                return m.group(0)  # OR-chain: parens may be load-bearing
            # Pad with spaces: the input may already be tight
            # (``)OR(``), and unwrapping without a boundary would fuse
            # words (``NULLOR``). The later whitespace collapse removes
            # the padding.
            return " " + inner + " "

        return re.sub(r"(?<!IN )(?<!IN)\(([^()]+)\)", _repl, text, flags=re.IGNORECASE)

    prev = None
    while out != prev:
        prev = out
        out = _strip_once(out)
    return out


def _normalize_check_expr(expr: str) -> str:
    """Normalize a CHECK expression for cross-dialect comparison.

    PostgreSQL rewrites ``x IN (...)`` as ``(x)::text = ANY
    (ARRAY[...])`` and wraps columns in casts/parens; SQLite stores the
    expression as written in the migration. After this normalization
    both spellings reduce to the same string.
    """
    out = expr.strip().upper()
    out = re.sub(r"::(TEXT|INTEGER|BIGINT|DOUBLE PRECISION|BOOLEAN|SMALLINT)", "", out)
    out = re.sub(r"=\s*ANY\s*\(ARRAY\[(.*?)\]\)", r"IN (\1)", out)
    out = _strip_outer_parens(out)
    # Strip redundant inner parens BEFORE whitespace is tightened: the
    # spaces around parens are word boundaries (``)OR(`` would otherwise
    # fuse into ``OR`` glued to its neighbours). A second outer strip
    # follows because unwrapping inner groups can expose a new outer wrap.
    out = _strip_redundant_check_parens(out)
    out = _strip_outer_parens(out)
    out = re.sub(r"\s+", " ", out)
    out = re.sub(r"\s*([(),])\s*", r"\1", out)
    return out


def _extract_sqlite_checks(sql: str) -> list[str]:
    """All CHECK expressions in a SQLite CREATE TABLE statement."""
    out: list[str] = []
    for m in re.finditer(r"CHECK\s*\(", sql, re.IGNORECASE):
        start = m.end() - 1  # the "("
        depth = 0
        for i in range(start, len(sql)):
            if sql[i] == "(":
                depth += 1
            elif sql[i] == ")":
                depth -= 1
                if depth == 0:
                    out.append(sql[start + 1:i])
                    break
    return out


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


# --- structural snapshots (cross-dialect, Gate 16) -------------------------

def snapshot_struct_sqlite(db_path: Path) -> dict[str, list[str]]:
    """Structural snapshot of a SQLite DB: tables/columns, unique sets,
    explicit indexes, foreign keys, CHECKs — in the same canonical form
    as :func:`snapshot_struct_pg`."""
    conn = sqlite3.connect(str(db_path))
    try:
        tables: dict[str, list[str]] = {}
        uniques: set[str] = set()
        indexes: set[str] = set()
        fks: set[str] = set()
        checks: set[str] = set()
        names = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()]
        for table in names:
            cols = []
            for _cid, name, ctype, notnull, dflt, pk in conn.execute(
                f"PRAGMA table_info({table})"
            ).fetchall():
                # SQLite's table_info reports NOT NULL = 0 for PRIMARY KEY
                # columns unless NOT NULL was spelled out (a TEXT/INTEGER
                # PRIMARY KEY is still effectively NOT NULL); PostgreSQL
                # reports 1 for every PK column. Normalize: PK implies
                # NOT NULL (Gate 16).
                cols.append(f"{name}|{_canonical_type(ctype)}|{1 if pk else notnull}|{_canonical_default(dflt)}|{pk}")
            tables[table] = cols
            for _seq, idx_name, unique, origin, _partial in conn.execute(
                f"PRAGMA index_list({table})"
            ).fetchall():
                idx_cols = tuple(r[2] for r in conn.execute(
                    f"PRAGMA index_info({idx_name})"
                ).fetchall())
                if unique and origin != "pk":
                    uniques.add(f"{table}|{','.join(idx_cols)}")
                if origin == "c":
                    indexes.add(f"{idx_name}|{table}|{','.join(idx_cols)}|{unique}")
            grouped: dict[int, list[tuple]] = {}
            for row in conn.execute(f"PRAGMA foreign_key_list({table})").fetchall():
                grouped.setdefault(row[0], []).append(row)
            for _fid, rows in grouped.items():
                rows.sort(key=lambda r: r[1])
                from_cols = ",".join(r[3] for r in rows)
                to_cols = ",".join(r[4] for r in rows)
                ref_table = rows[0][2]
                on_update, on_delete = rows[0][5], rows[0][6]
                fks.add(f"{table}|{from_cols}|{ref_table}|{to_cols}|{on_delete}|{on_update}")
            sql = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()[0]
            for expr in _extract_sqlite_checks(sql or ""):
                checks.add(f"{table}|{_normalize_check_expr(expr)}")
    finally:
        conn.close()
    return _render_struct(tables, uniques, indexes, fks, checks)


def _render_struct(tables: dict[str, list[str]], uniques: set[str],
                   indexes: set[str], fks: set[str], checks: set[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {"tables": [], "uniques": sorted(uniques),
                                 "indexes": sorted(indexes), "fks": sorted(fks),
                                 "checks": sorted(checks)}
    for table in sorted(tables):
        out["tables"].append(f"{table}:")
        # Column order is cosmetic (all access is by name): the PG
        # dialect adds tenant columns via ALTER TABLE (appended last)
        # while the SQLite dialect has them inline, so the two engines
        # legitimately disagree on ordinal position. Compare columns as
        # a name-keyed set (Gate 16).
        out["tables"].extend(
            f"  {c}" for c in sorted(tables[table], key=lambda ln: ln.split("|", 1)[0])
        )
    return out


def _pg_index_cols(indexdef: str | None) -> str:
    """Column list of a pg_get_indexdef() string, direction stripped.

    PostgreSQL renders ``(agent_id, started_at DESC)`` for indexes the
    migration spells with DESC; SQLite's PRAGMA index_info reports only
    column names, so the SQLite side is direction-blind by construction.
    Strip ASC/DESC so the comparison is about the indexed columns, not
    their sort order (both engines store the same DESC indexes — the
    migration SQL spells DESC and both honor it). Gate 16.
    Known limitation (6B audit): stripping direction means an ASC-vs-
    DESC divergence between the two dialect blocks would NOT be caught
    here. Both sides derive from the same migration SQL in practice, so
    they agree; a future migration that spells direction differently
    per dialect would need a direction-aware check (SQLite would need
    PRAGMA index_xinfo, which reports the desc flag).
    """
    m = re.search(r"\(([^)]+)\)\s*$", indexdef or "")
    if not m:
        return ""
    cols = []
    for c in m.group(1).split(","):
        # Strip the direction BEFORE the quotes: '"b" ASC' must lose the
        # ASC first, or the trailing quote survives the strip.
        c = re.sub(r"\s+(ASC|DESC)$", "", c.strip(), flags=re.IGNORECASE)
        cols.append(c.strip().strip('"'))
    return ",".join(cols)


def snapshot_struct_pg(dsn: str) -> dict[str, list[str]]:
    """Structural snapshot of a PostgreSQL DB, same canonical form as
    :func:`snapshot_struct_sqlite`."""
    import psycopg

    tables: dict[str, list[str]] = {}
    uniques: set[str] = set()
    indexes: set[str] = set()
    fks: set[str] = set()
    checks: set[str] = set()
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT tc.table_name, kcu.column_name, kcu.ordinal_position "
                "FROM information_schema.table_constraints tc "
                "JOIN information_schema.key_column_usage kcu "
                "  ON tc.constraint_name=kcu.constraint_name "
                "  AND tc.table_schema=kcu.table_schema "
                "WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema='public'"
            )
            pk_pos = {(r[0], r[1]): r[2] for r in cur.fetchall()}
            cur.execute(
                "SELECT table_name, column_name, data_type, is_nullable, "
                "column_default, ordinal_position "
                "FROM information_schema.columns "
                "WHERE table_schema='public' ORDER BY table_name, ordinal_position"
            )
            for table, col, dtype, nullable, dflt, _ord in cur.fetchall():
                pk = pk_pos.get((table, col), 0)
                # PK implies NOT NULL on both engines (see the SQLite
                # snapshot's comment); normalize here too for symmetry.
                nn = 1 if pk else (0 if nullable == "YES" else 1)
                tables.setdefault(table, []).append(
                    f"{col}|{_canonical_type(dtype)}|{nn}|"
                    f"{_canonical_default(dflt)}|{pk}"
                )
            # Indexes: separate constraint-backed ones (PK/unique) from
            # explicit CREATE INDEX ones via pg_constraint.conindid.
            cur.execute(
                "SELECT c.relname, i.relname, ix.indisunique, ix.indisprimary, "
                "pg_get_indexdef(ix.indexrelid) "
                "FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid "
                "JOIN pg_class c ON c.oid=ix.indrelid "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public'"
            )
            idx_rows = cur.fetchall()
            cur.execute("SELECT conindid FROM pg_constraint WHERE contype IN ('p','u')")
            constraint_indexes = {r[0] for r in cur.fetchall()}
            for table, idx_name, is_unique, is_primary, indexdef in idx_rows:
                cols = _pg_index_cols(indexdef)
                # Re-resolve the index oid for the constraint check.
                if is_unique and not is_primary:
                    uniques.add(f"{table}|{cols}")
            # Explicit indexes need their oid; re-query with oid.
            cur.execute(
                "SELECT ix.indexrelid, c.relname, i.relname, ix.indisunique, "
                "pg_get_indexdef(ix.indexrelid) "
                "FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid "
                "JOIN pg_class c ON c.oid=ix.indrelid "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public'"
            )
            for oid, table, idx_name, is_unique, indexdef in cur.fetchall():
                if oid in constraint_indexes:
                    continue
                cols = _pg_index_cols(indexdef)
                indexes.add(f"{idx_name}|{table}|{cols}|{1 if is_unique else 0}")
            # Foreign keys + actions.
            cur.execute(
                "SELECT tc.table_name, kcu.column_name, ccu.table_name, "
                "ccu.column_name, kcu.ordinal_position, tc.constraint_name "
                "FROM information_schema.table_constraints tc "
                "JOIN information_schema.key_column_usage kcu "
                "  ON tc.constraint_name=kcu.constraint_name "
                "  AND tc.table_schema=kcu.table_schema "
                "JOIN information_schema.constraint_column_usage ccu "
                "  ON tc.constraint_name=ccu.constraint_name "
                "  AND tc.table_schema=ccu.table_schema "
                "WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public' "
                "ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position"
            )
            grouped: dict[str, list[tuple]] = {}
            for table, col, ref_table, ref_col, _ord, cname in cur.fetchall():
                grouped.setdefault(cname, []).append((table, col, ref_table, ref_col))
            cur.execute(
                "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE contype='f'"
            )
            actions = {}
            for cname, cdef in cur.fetchall():
                on_delete = re.search(r"ON DELETE ([A-Z ]+?)(?:\s+DEFERRABLE|\s+NOT DEFERRABLE|\s+INITIALLY|$)", cdef or "")
                on_update = re.search(r"ON UPDATE ([A-Z ]+?)(?:\s+DEFERRABLE|\s+NOT DEFERRABLE|\s+INITIALLY|$)", cdef or "")
                actions[cname] = (
                    (on_delete.group(1).strip() if on_delete else "NO ACTION"),
                    (on_update.group(1).strip() if on_update else "NO ACTION"),
                )
            for cname, rows in grouped.items():
                table, ref_table = rows[0][0], rows[0][2]
                from_cols = ",".join(r[1] for r in rows)
                to_cols = ",".join(r[3] for r in rows)
                on_delete, on_update = actions.get(cname, ("NO ACTION", "NO ACTION"))
                fks.add(f"{table}|{from_cols}|{ref_table}|{to_cols}|{on_delete}|{on_update}")
            # CHECK constraints.
            cur.execute(
                "SELECT c.relname, pg_get_constraintdef(p.oid) "
                "FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE p.contype='c' AND n.nspname='public'"
            )
            for table, cdef in cur.fetchall():
                m = re.match(r"CHECK\s*\(", cdef or "")
                if not m:
                    continue
                expr = _strip_outer_parens((cdef or "")[m.end() - 1:])
                checks.add(f"{table}|{_normalize_check_expr(expr)}")
    return _render_struct(tables, uniques, indexes, fks, checks)


def _pg_db_dsn(base_dsn: str, dbname: str) -> str:
    u = urlparse(base_dsn)
    return urlunparse(u._replace(path="/" + dbname))


def _pg_create_drop(base_dsn: str, dbname: str, drop: bool) -> None:
    import psycopg

    with psycopg.connect(base_dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            if drop:
                cur.execute(f'DROP DATABASE IF EXISTS "{dbname}"')
            else:
                cur.execute(f'CREATE DATABASE "{dbname}"')


def build_pg_migrations_db(dsn: str) -> list[str]:
    """Apply all migrations to a fresh Postgres DB via the app's own
    connect path (the same path the control plane boots with)."""
    conn = dbmod.connect(database_url=dsn)
    try:
        rows = conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
        return [r["version"] if hasattr(r, "keys") else r[0] for r in rows]
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", type=Path, default=None,
                        help="Keep both databases under DIR for inspection.")
    parser.add_argument("--postgres", type=str, default=None, metavar="DSN",
                        help="Also compare against a real PostgreSQL server: "
                        "DSN of an existing database the caller can CREATE "
                        "DATABASE from (scratch parity_a/parity_b databases "
                        "are created and dropped unless --keep is given).")
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

    if args.postgres:
        return _postgres_parity(args.postgres, args.keep, db_b)
    return 0


def _postgres_parity(base_dsn: str, keep: Path | None, sqlite_db: Path) -> int:
    """Compare the migrations-only schema on Postgres vs SQLite.

    ``sqlite_db`` is the migrations-only SQLite DB already built by
    main(); the Postgres side is built fresh in a scratch database
    (``parity_a``) via the app's own connect path.
    """
    try:
        import psycopg  # noqa: F401
    except ImportError:
        print("ERROR: --postgres needs psycopg (pip install 'psycopg[binary]')",
              file=sys.stderr)
        return 2
    snap_sqlite = snapshot_struct_sqlite(sqlite_db)
    applied_sqlite = sorted(
        r[0] for r in sqlite3.connect(str(sqlite_db)).execute(
            "SELECT version FROM schema_migrations"
        )
    )

    try:
        _pg_create_drop(base_dsn, "parity_a", drop=True)
    except Exception as exc:
        print(f"ERROR dropping stale parity_a: {exc}", file=sys.stderr)
        return 2
    try:
        _pg_create_drop(base_dsn, "parity_a", drop=False)
        try:
            applied_pg = build_pg_migrations_db(_pg_db_dsn(base_dsn, "parity_a"))
        except Exception as exc:
            print(f"ERROR building Postgres migrations DB: {exc}", file=sys.stderr)
            return 2
        snap_pg = snapshot_struct_pg(_pg_db_dsn(base_dsn, "parity_a"))
    finally:
        if keep is None:
            try:
                _pg_create_drop(base_dsn, "parity_a", drop=True)
            except Exception:
                pass
        else:
            print(f"kept Postgres scratch database parity_a on {base_dsn}")

    print(f"Postgres migrations applied: {sorted(applied_pg)}")
    print(f"SQLite migrations applied: {sorted(applied_sqlite)}")
    diffs: list[str] = []
    for section in ("tables", "uniques", "indexes", "fks", "checks"):
        a = snap_sqlite.get(section, [])
        b = snap_pg.get(section, [])
        if a != b:
            diffs.append(section)
            print(f"DRIFT [{section}]:")
            for line in difflib.unified_diff(
                a, b, "SQLite migrations", "Postgres migrations", lineterm=""
            ):
                print(f"  {line}")
    if diffs:
        print(f"\nPG PARITY FAILED: drifted section(s): {', '.join(diffs)}")
        print("Fix: reconcile the migration SQL so both engines produce the "
              "same schema, and re-run with --postgres.")
        return 1
    n_tables = len([ln for ln in snap_sqlite["tables"] if ln.endswith(":")])
    print(f"\nPG PARITY OK: Postgres and SQLite migrations produce the same "
          f"schema ({n_tables} tables, {len(snap_sqlite['indexes'])} explicit "
          f"indexes, {len(snap_sqlite['fks'])} FKs, {len(snap_sqlite['checks'])} CHECKs).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
