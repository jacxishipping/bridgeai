#!/usr/bin/env python3
"""Delete named test users (and their sessions) from the staging database.

Staging-only housekeeping. Run as a one-off Render cron job against the
plane's Docker image, which has psycopg installed and DATABASE_URL set:

    python scripts/cleanup_staging_test_users.py USERNAME [USERNAME ...]

Options:
    --dry-run   print how many sessions/users would be deleted, change nothing.

Why a repo script instead of an inline `python -c` one-liner: Render does
NOT shell-parse a cron job's dockerCommand — double quotes are passed
through intact, so `python -c "print('x')"` arrives as a string literal and
exits 0 having done nothing (proven live 17 Nov 2026: two cron runs
"finished successfully" with no output and no rows deleted). A plain
space-separated command with no quotes is the only reliable form, and this
script is that form. Do not convert it back to an inline one-liner.

Safety: the script deletes ONLY the usernames passed on the command line.
It refuses to run with no usernames. Sessions are deleted explicitly first
(the sessions.username FK to users.username is ON DELETE CASCADE, so this
is belt-and-braces). Exit 0 prints "CLEANUP OK sessions=<n> users=<m>";
any error exits non-zero with a traceback.
"""

import os
import sys


def main(argv):
    dry_run = "--dry-run" in argv
    usernames = [a for a in argv[1:] if not a.startswith("--")]
    if not usernames:
        print(
            "usage: cleanup_staging_test_users.py [--dry-run] USERNAME [USERNAME ...]",
            file=sys.stderr,
        )
        return 2
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    import psycopg

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM sessions WHERE username = ANY(%s)",
                (usernames,),
            )
            sessions = cur.fetchone()[0]
            cur.execute(
                "SELECT count(*) FROM users WHERE username = ANY(%s)",
                (usernames,),
            )
            users = cur.fetchone()[0]
            if dry_run:
                print(f"DRY RUN sessions={sessions} users={users}")
                return 0
            cur.execute("DELETE FROM sessions WHERE username = ANY(%s)", (usernames,))
            deleted_sessions = cur.rowcount
            cur.execute("DELETE FROM users WHERE username = ANY(%s)", (usernames,))
            deleted_users = cur.rowcount
        conn.commit()
    print(f"CLEANUP OK sessions={deleted_sessions} users={deleted_users}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
