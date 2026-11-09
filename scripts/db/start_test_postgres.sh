#!/usr/bin/env bash
# Starts a local PostgreSQL server for the schema checks.
#
#   scripts/db/start_test_postgres.sh [port]
#
# It downloads a portable PostgreSQL build the first time it is run, so the
# checks can be run on a machine without PostgreSQL installed and without
# root. The server is local and temporary: it holds nothing but the test
# database.
#
# The resulting DSN is printed on the last line:
#
#   host=/tmp port=5433 user=postgres dbname=postgres

set -euo pipefail

PORT="${1:-5433}"
CACHE="${HC_PG_CACHE:-$HOME/.cache/homecoreos-pg}"
PGDIR="$CACHE/pg"
DATA="$CACHE/data"
SOCKET="$CACHE/sock"

if [ ! -x "$PGDIR/bin/postgres" ]; then
  echo "→ downloading a portable PostgreSQL build into $CACHE"
  mkdir -p "$CACHE"
  JAR="$CACHE/postgres.jar"
  if [ ! -f "$JAR" ]; then
    curl -sSL --max-time 300 -o "$JAR" \
      "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/16.2.0/embedded-postgres-binaries-linux-amd64-16.2.0.jar"
  fi
  rm -rf "$PGDIR"
  mkdir -p "$PGDIR"
  (cd "$PGDIR" && unzip -oq "$JAR" && tar xf postgres-linux-x86_64.txz)
fi

export LD_LIBRARY_PATH="$PGDIR/lib"

if [ ! -d "$DATA" ]; then
  echo "→ initialising the data directory"
  mkdir -p "$DATA" "$SOCKET"
  "$PGDIR/bin/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >"$CACHE/initdb.log" 2>&1
fi

if ! "$PGDIR/bin/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  echo "→ starting PostgreSQL on port $PORT"
  mkdir -p "$SOCKET"
  "$PGDIR/bin/pg_ctl" -D "$DATA" \
    -o "-p $PORT -k $SOCKET -c listen_addresses=''" \
    -l "$CACHE/postgres.log" start
  sleep 2
fi

# The roles the schema grants privileges to. They exist on Supabase; on a plain
# PostgreSQL server they have to be created.
"$PGDIR/bin/pg_ctl" -D "$DATA" status >/dev/null 2>&1
python3 - "$PORT" "$SOCKET" <<'PY'
import sys
try:
    import psycopg2
except ImportError:
    sys.exit(0)
port, socket = sys.argv[1], sys.argv[2]
conn = psycopg2.connect(host=socket, port=port, user="postgres", dbname="postgres")
conn.autocommit = True
cur = conn.cursor()
for role in ("anon", "authenticated", "service_role"):
    cur.execute("select 1 from pg_roles where rolname = %s", (role,))
    if cur.fetchone() is None:
        cur.execute('create role "%s" nologin' % role)
PY

echo
echo "PostgreSQL is running. Use this DSN:"
echo "host=$SOCKET port=$PORT user=postgres dbname=postgres"
