#!/usr/bin/env bash
set -euo pipefail
probe_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${PGBIN:-}" ]]; then
  # The estate runners have psql but no Docker or PostgreSQL server.
  npm ci --prefix "$probe_dir/postgres-runtime" --ignore-scripts --no-audit --no-fund
  PGBIN="$probe_dir/postgres-runtime/node_modules/@embedded-postgres/linux-x64/native/bin"
  export LD_LIBRARY_PATH="$PGBIN/../lib:${LD_LIBRARY_PATH:-}"
fi
PSQL="${PSQL:-$(command -v psql)}"
test -x "$PGBIN/initdb"
test -x "$PGBIN/pg_ctl"
test -x "$PSQL"
journal_tmp="$(mktemp -d /tmp/ca-journal.XXXXXX)"
cleanup() {
  "$PGBIN/pg_ctl" -D "$journal_tmp/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$journal_tmp"
}
trap cleanup EXIT
mkdir "$journal_tmp/socket"
"$PGBIN/initdb" -D "$journal_tmp/data" -U journal_test -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$journal_tmp/data" -l "$journal_tmp/postgres.log" \
  -o "-h '' -k '$journal_tmp/socket' -p 55441" -w start >/dev/null
export PSQL PGHOST="$journal_tmp/socket" PGPORT=55441 PGUSER=journal_test PGDATABASE=postgres
unset PGCONTAINER
"$PSQL" -X -q -c "SELECT version();"
python3 "$probe_dir/test_atomicity.py" fixed --bootstrap
