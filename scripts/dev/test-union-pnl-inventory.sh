#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/pnl.XXXXXX")
started=0
cleanup() {
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop > "$fixture/stop.log" 2>&1; fi
}
trap cleanup EXIT
mkdir "$fixture/s"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 > "$fixture/init.log"
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/s -p 55529 -h ''" start > "$fixture/start.log"
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/s" -p 55529 -d postgres \
 -f "$root/tests/fixtures/union-pnl-inventory/bootstrap.sql" \
 -f "$root/tests/fixtures/union-pnl-inventory/seed.sql" \
 -f "$root/supabase/migrations/20260917233148_union_pnl_inventory_preserves_original_boundaries.sql" \
 -f "$root/tests/fixtures/union-pnl-inventory/regression.sql" 2>&1 | tee "$fixture/native.log"
python3 "$root/tests/fixtures/union-pnl-inventory/concurrency.py" "$pgbin/psql" "$fixture/s" 55529 2>&1 | tee "$fixture/concurrency.log"
echo "Evidence retained: $fixture"
