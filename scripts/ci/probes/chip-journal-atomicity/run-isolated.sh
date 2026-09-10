#!/usr/bin/env bash
set -euo pipefail
probe_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
npm ci --prefix "$probe_dir/postgres-runtime" --ignore-scripts --no-audit --no-fund
if [[ -z "${PGBIN:-}" ]]; then
  # All PostgreSQL server and client dependencies are private to this test.
  PGBIN="$probe_dir/postgres-runtime/node_modules/@embedded-postgres/linux-x64/native/bin"
  # npm tarballs omit symlinks. Run only the reviewed, pinned package hydrator.
  (cd "$PGBIN/../.." && node scripts/hydrate-symlinks.js)
  export LD_LIBRARY_PATH="$PGBIN/../lib:${LD_LIBRARY_PATH:-}"
fi
PGNODE="$(command -v node)"
test -x "$PGBIN/initdb"
test -x "$PGBIN/pg_ctl"
test -x "$PGNODE"
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
export PGNODE PGHOST="$journal_tmp/socket" PGPORT=55441 PGUSER=journal_test PGDATABASE=postgres
unset PGCONTAINER
"$PGBIN/postgres" --version
python3 "$probe_dir/test_atomicity.py" fixed --bootstrap

python3 "$probe_dir/test_satellite_split.py"

"$PGNODE" "$probe_dir/postgres-runtime/lease-heartbeat-concurrency.mjs"
"$PGNODE" "$probe_dir/postgres-runtime/maintenance-expired-owner.mjs"

# The prepared cutover must preserve authenticated rebuy/decline routes.
PG17_BINDIR="$PGBIN" python3 "$probe_dir/../../../dev/probe-tournament-player-request-routes.py"

# Exact occupancy identity must survive the terminal writer replacement.
PG17_BINDIR="$PGBIN" python3 "$probe_dir/../../../dev/probe-hand-seat-generation.py"

# Entry funding and the corrected charged-club receipt use real local transactions.
POKER_AUDIT_PG_BIN="$PGBIN" python3 "$probe_dir/../../../dev/probe-tournament-registration-funding-pg17.py"
