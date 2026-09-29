#!/usr/bin/env bash
# Native qualification: the sealed-checkpoint inventory reader returns exactly
# what the previous reader returns, on randomized histories, and a sealed week
# is read without re-reading the event history.
#   GREEN (default): the migration under review must pass every stage.
#   RED=1: the same run with the previous reader body restored after the
#          migration must FAIL (it re-reads the whole history every call).
#   SEEDS=n (default 24) randomized histories of ROWS=n (default 240) rows.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fx="$root/tests/fixtures/union-pnl-inventory-checkpoint"
migration=$(ls "$root"/supabase/migrations/*_a_closed_week_s_inventory_is_read_from_its_sealed_checkpoint.sql)
work=$(mktemp -d "${TMPDIR:-/tmp}/pnlckpt.XXXXXX")
port=${PORT:-55547}
seeds=${SEEDS:-24}; rows=${ROWS:-240}
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
psql() { "$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -U postgres -h "$work/s" -p "$port" "$@"; }
psql -d postgres -c "CREATE DATABASE tmpl" >/dev/null
psql -d tmpl -f "$fx/schema.sql" -f "$fx/captured-preimage.sql" -f "$migration" -f "$fx/generator.sql" > "$work/tmpl.log" 2>&1 \
  || { cat "$work/tmpl.log"; exit 1; }
if [ "${RED:-0}" = 1 ]; then
  # Withhold the reader change: the previous body serves fn_union_pnl_inventory_as_of again.
  psql -d tmpl -f "$fx/captured-preimage.sql" >> "$work/tmpl.log" 2>&1
fi
rc=0
set +e
for i in $(seq 1 "$seeds"); do
  seed=$(python3 -c "print(round(((${i}*0.6180339887)%1.0)*2-1,6))")
  psql -d postgres -c "CREATE DATABASE s$i TEMPLATE tmpl" >/dev/null
  clean=$([ $((i % 3)) = 0 ] && echo true || echo false)
  out=$(psql -d "s$i" -At -v seed="$seed" -v rows="$rows" -v clean="$clean" -f "$fx/exactness.sql" 2>&1); r=$?
  if [ $r -ne 0 ]; then echo "FAIL seed $seed: $(echo "$out" | grep -E 'ERROR|MISMATCH' | head -2)"; rc=1; continue; fi
  echo "$out" | grep '^COVERAGE' | sed "s/^COVERAGE/seed $seed:/" >> "$work/coverage.log"
  echo "PASS seed $seed (clean=$clean): $(echo "$out" | grep -c '^PASS') boundary sweeps equal the previous reader"
  psql -d postgres -c "DROP DATABASE s$i" >/dev/null
done
python3 - "$work/coverage.log" <<'PY' || true
import json,sys
tot={}
for line in open(sys.argv[1]):
    d=json.loads(line.split(':',1)[1])
    for k,v in d.items(): tot[k]=tot.get(k,0)+(v or 0)
print('COVERAGE across seeds', json.dumps(tot))
PY
psql -d postgres -c "CREATE DATABASE behaviour TEMPLATE tmpl" >/dev/null
psql -d behaviour -f "$fx/behaviour.sql" > "$work/behaviour.log" 2>&1; r=$?
grep -E "PASS|FAIL|ERROR" "$work/behaviour.log" | sed 's/^psql:[^ ]* //'
[ $r -ne 0 ] && rc=1
psql -d postgres -c "CREATE DATABASE concurrency TEMPLATE tmpl" >/dev/null
"$fx/concurrency.sh" "$pgbin/psql" "$work/s" "$port" concurrency || rc=1
set -e
if [ "${RED:-0}" = 1 ]; then
  if [ $rc -eq 0 ]; then echo "RED CONTROL FAILED: the previous reader passed"; exit 1; fi
  echo "RED CONTROL OK: with the previous reader body the run fails"; keep=0
else
  if [ $rc -ne 0 ]; then echo "FAIL; evidence: $work"; exit 1; fi
  echo "GREEN OK"
fi
keep=0
