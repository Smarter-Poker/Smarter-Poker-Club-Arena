#!/usr/bin/env bash
# Native qualification: one weekly-accounting scope that runs out of the
# tick's statement budget, or raises, cannot starve the other scopes.
#   GREEN (default): the migration under review must pass every stage.
#   RED=1: the same run on the coordinator production serves today must FAIL
#          (the timed-out union stays first and the healthy union never closes).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fx="$root/tests/fixtures/weekly-scheduler-scope-isolation"
migration=$(ls "$root"/supabase/migrations/*_a_scope_that_times_out_does_not_starve_the_others.sql)
work=$(mktemp -d "${TMPDIR:-/tmp}/schedfair.XXXXXX")
port=${PORT:-55549}
started=0
keep=1
cleanup() {
  if [ "$started" = 1 ]; then LC_ALL=C "$pgbin/pg_ctl" -D "$work/data" -m immediate stop > "$work/stop.log" 2>&1 || true; fi
  if [ "$keep" = 0 ]; then rm -rf "$work"; fi
}
trap cleanup EXIT
mkdir "$work/s"
LC_ALL=C LANG=C "$pgbin/initdb" -D "$work/data" -U postgres -A trust --no-locale -E UTF8 > "$work/init.log"
LC_ALL=C LANG=C "$pgbin/pg_ctl" -D "$work/data" -l "$work/server.log" -o "-k $work/s -p $port -h ''" -w start > "$work/start.log"
started=1
# The coordinator refuses to start in minutes 45-59 of the hour. Read the
# clock in a zone whose minute is well inside the working window for the
# whole run (a +05:30 zone shifts the minute by 30).
minute=$((10#$(date -u +%M)))
if [ "$minute" -lt 35 ]; then export PGTZ=UTC; else export PGTZ=Asia/Kolkata; fi
mig="$migration"
if [ "${RED:-0}" = 1 ]; then
  # Only the visit table, so the assertions can be read; the coordinator stays as served.
  python3 - "$migration" "$work/red.sql" <<'PY'
import sys,re
m=open(sys.argv[1]).read()
i=m.index('DO $patch$'); j=m.index('END $patch$;')+len('END $patch$;')
m=m[:i]+m[j:]
m=re.sub(r"DO \$post\$.*?END \$post\$;",'',m,flags=re.S)
open(sys.argv[2],'w').write(m)
PY
  mig="$work/red.sql"
fi
set +e
"$pgbin/psql" -X -v ON_ERROR_STOP=1 -U postgres -h "$work/s" -p "$port" -d postgres \
  -f "$fx/schema.sql" -f "$fx/captured-preimage.sql" -f "$mig" -f "$fx/regression.sql" > "$work/run.log" 2>&1
rc=$?
set -e
grep -E "PASS|FAIL|ERROR" "$work/run.log" | grep -v "canceling statement due to statement timeout" | sed 's/^psql:[^ ]* //' || true
if [ "${RED:-0}" = 1 ]; then
  if [ $rc -eq 0 ]; then echo "RED CONTROL FAILED: the served coordinator passed"; exit 1; fi
  echo "RED CONTROL OK: on the served coordinator the healthy union is starved (rc=$rc)"; keep=0
else
  if [ $rc -ne 0 ]; then echo "FAIL (rc=$rc); log: $work/run.log"; exit $rc; fi
  echo "GREEN OK"
fi
keep=0
