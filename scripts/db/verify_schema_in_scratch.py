#!/usr/bin/env python3
"""
Runs the schema verification in a scratch database.

The schema check rebuilds the whole schema and registers test accounts, so it
must never be pointed at a database that holds real data. This wrapper creates
a temporary database, runs the check inside it, and removes it again.

    python3 scripts/db/verify_schema_in_scratch.py --dsn "host=/tmp port=5433 user=postgres dbname=postgres"
"""

import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VERIFY = os.path.join(HERE, "verify_schema.py")


def parse_dsn(dsn: str) -> dict:
    """Reads the key=value pairs of a PostgreSQL connection string."""
    out = {}
    for part in dsn.split():
        if "=" in part:
            key, value = part.split("=", 1)
            out[key] = value
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True)
    args = ap.parse_args()

    try:
        import psycopg2
    except ImportError:
        sys.stderr.write("verify_schema_in_scratch.py needs psycopg2\n")
        return 2

    parts = parse_dsn(args.dsn)
    admin = {
        "host": parts.get("host", "localhost"),
        "port": parts.get("port", "5432"),
        "user": parts.get("user", "postgres"),
    }
    if parts.get("password"):
        admin["password"] = parts["password"]

    scratch = "homecoreos_verify"

    conn = psycopg2.connect(dbname=parts.get("dbname", "postgres"), **admin)
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("select 1 from pg_database where datname = %s", (scratch,))
    if cur.fetchone():
        cur.execute(f'drop database if exists "{scratch}"')
    cur.execute(f'create database "{scratch}"')
    cur.close()
    conn.close()

    try:
        scratch_dsn = (
            f"host={admin['host']} port={admin['port']} user={admin['user']} dbname={scratch}"
        )
        if admin.get("password"):
            scratch_dsn += f" password={admin['password']}"
        result = subprocess.run(
            [sys.executable, VERIFY, "--dsn", scratch_dsn],
            cwd=os.path.dirname(os.path.dirname(HERE)),
        )
        return result.returncode
    finally:
        conn = psycopg2.connect(dbname=parts.get("dbname", "postgres"), **admin)
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute(f'drop database if exists "{scratch}"')
        cur.close()
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
