"""Unit tests for Dual-Engine Database & Native Migrations Runner."""
from pathlib import Path

import pytest

from ai_bridge.control import db as dbmod
from ai_bridge.control import migrations


def test_to_pg_sql_translation():
    assert dbmod.to_pg_sql("SELECT * FROM devices WHERE id=?") == "SELECT * FROM devices WHERE id=%s"
    assert dbmod.to_pg_sql("INSERT INTO audit (a, b) VALUES (?, ?)") == "INSERT INTO audit (a, b) VALUES (%s, %s)"
    # String literal with ? should be preserved
    assert dbmod.to_pg_sql("SELECT 'question?' AS q, id FROM t WHERE id=?") == "SELECT 'question?' AS q, id FROM t WHERE id=%s"
    # LIKE wildcards and other literal % must be escaped for psycopg pyformat
    assert (
        dbmod.to_pg_sql("SELECT key FROM settings WHERE key LIKE 'plane.human_takeover.%'")
        == "SELECT key FROM settings WHERE key LIKE 'plane.human_takeover.%%'"
    )
    assert (
        dbmod.to_pg_sql("SELECT id FROM custom_agents WHERE id LIKE 'agent-role-%' AND tenant=?")
        == "SELECT id FROM custom_agents WHERE id LIKE 'agent-role-%%' AND tenant=%s"
    )
    # F-05-18 (Wave 4 Track B): the translation is a tokenizer, not regex.
    # A literal "%s" inside a string is escaped, never a placeholder.
    assert (
        dbmod.to_pg_sql("SELECT '100%s sure' FROM t WHERE id=?")
        == "SELECT '100%%s sure' FROM t WHERE id=%s"
    )
    # "?" inside comments, dollar-quoted bodies, and quoted identifiers is
    # literal text, never a placeholder (the old quote-tracker converted
    # comment/dollar-body "?" into phantom placeholders).
    assert (
        dbmod.to_pg_sql("SELECT id FROM t -- 100% why ?\nWHERE id=?")
        == "SELECT id FROM t -- 100%% why ?\nWHERE id=%s"
    )
    assert (
        dbmod.to_pg_sql("SELECT id FROM t /* what ? */ WHERE id=?")
        == "SELECT id FROM t /* what ? */ WHERE id=%s"
    )
    assert (
        dbmod.to_pg_sql("SELECT $$body ? $$, id FROM t WHERE id=?")
        == "SELECT $$body ? $$, id FROM t WHERE id=%s"
    )
    assert (
        dbmod.to_pg_sql('SELECT "we?ird" FROM t WHERE id=?')
        == 'SELECT "we?ird" FROM t WHERE id=%s'
    )
    # Upsert allowlist: only the settings forms translate (the exact
    # migration-011 statement is the one in-tree occurrence).
    assert (
        dbmod.to_pg_sql("INSERT OR IGNORE INTO settings (key, value) VALUES ('plane.emergency_stop', '0');")
        == "INSERT INTO settings (key, value) VALUES ('plane.emergency_stop', '0') ON CONFLICT DO NOTHING"
    )
    assert (
        dbmod.to_pg_sql("INSERT OR REPLACE INTO settings (key, value) VALUES ('k', 'v')")
        == "INSERT INTO settings (key, value) VALUES ('k', 'v') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )
    # Any other INSERT OR ... head is refused, not regex-rewritten.
    with pytest.raises(ValueError):
        dbmod.to_pg_sql("INSERT OR IGNORE INTO devices (id) VALUES ('d1')")
    with pytest.raises(ValueError):
        dbmod.to_pg_sql("INSERT OR REPLACE INTO tasks (id) VALUES ('t1')")
    # No regex rewriting remains: upsert-looking text inside a string
    # literal passes through untouched (the old regex rewrote it in place).
    assert (
        dbmod.to_pg_sql("SELECT 'INSERT OR IGNORE INTO settings' FROM t")
        == "SELECT 'INSERT OR IGNORE INTO settings' FROM t"
    )
    # And the translator (plus its helpers) contains no regex rewriting.
    import inspect

    module_src = inspect.getsource(dbmod)
    assert "re.sub" not in module_src and "re.search" not in module_src
    assert "import re\n" not in module_src


def test_to_pg_sql_ratelimit_atomic_upsert():
    """F-05-08: the single-statement DB rate-limit UPSERT must survive
    to_pg_sql — six placeholders, the ``%`` modulo escaped as ``%%``
    (psycopg collapses it back), ON CONFLICT + RETURNING intact."""
    from ai_bridge.control.durable_ratelimit import _DB_ALLOW_SQL

    pg = dbmod.to_pg_sql(_DB_ALLOW_SQL)
    assert pg.count("%s") == 6
    assert "%%" in pg
    assert "ON CONFLICT(key)" in pg
    assert "RETURNING value" in pg
    assert "?" not in pg


def test_row_dict_access():
    rd = dbmod.RowDict({"id": "d-123", "name": "srv-prod"}, ["id", "name"])
    # By name
    assert rd["id"] == "d-123"
    assert rd["name"] == "srv-prod"
    # By index
    assert rd[0] == "d-123"
    assert rd[1] == "srv-prod"


def test_migration_runner_lifecycle(tmp_path: Path):
    db_file = tmp_path / "test_mig.db"
    conn = dbmod.connect(db_path=db_file)

    # Verify schema_migrations table exists and has recorded migrations
    rows = conn.execute("SELECT version, name FROM schema_migrations ORDER BY version ASC").fetchall()
    applied_versions = [r["version"] for r in rows]

    assert "001" in applied_versions
    assert "002" in applied_versions
    assert "003" in applied_versions

    # Calling run_migrations again should be a no-op
    newly_applied = migrations.run_migrations(conn, dialect="sqlite")
    assert newly_applied == []

    conn.close()

