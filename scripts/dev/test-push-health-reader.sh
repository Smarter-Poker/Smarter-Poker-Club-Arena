#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
work="$root/tests/fixtures/push-health-reader"
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/push-health-test.XXXXXX")
started=0
cleanup(){
  original_status=$?; trap - EXIT; set +e
  cleanup_failed=0
  if [ "$started" = 1 ]; then
    "$pgbin/pg_ctl" -D "$fixture/data" status >"$fixture/cleanup-before.log" 2>&1
    status=$?
    if [ "$status" = 0 ]; then
      "$pgbin/pg_ctl" -D "$fixture/data" -m immediate -w -t 60 stop >"$fixture/cleanup-stop.log" 2>&1 || cleanup_failed=1
      "$pgbin/pg_ctl" -D "$fixture/data" status >"$fixture/cleanup-after.log" 2>&1
      [ "$?" = 3 ] || cleanup_failed=1
    elif [ "$status" != 3 ]; then cleanup_failed=1; fi
  fi
  if [ "$original_status" != 0 ] || [ "$cleanup_failed" != 0 ]; then
    echo "FAIL: probe=$original_status cleanup=$cleanup_failed; retained $fixture" >&2
    for log in "$fixture"/*.log; do [ ! -f "$log" ] || cat "$log" >&2; done
    [ "$original_status" = 0 ] || exit "$original_status"
    exit 1
  fi
  rm -rf -- "$fixture" || exit 1
}
trap cleanup EXIT
"$pgbin/postgres" --version | grep -Eq "PostgreSQL\) 17\." || { echo "PostgreSQL17 required" >&2; exit 2; }
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
started=1
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55492 -h ''" start >/dev/null
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55492 -d postgres -f "$work/bootstrap.sql" -f "$root/supabase/migrations/20260914140459_push_health_uses_exact_database_counts_and_device_receipts.sql" -f "$root/supabase/migrations/20260916024000_push_health_preserves_addressable_delivery_rate.sql" -f "$work/regression.sql"
