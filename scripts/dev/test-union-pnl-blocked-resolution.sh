#!/usr/bin/env bash
# Native qualification: a blocked accepted cash hand is accepted by the weekly
# close only through a receipt re-proved from primary evidence and bound to the
# outcome; everything unprovable stays blocked.
#   GREEN (default): the migration under review must pass every stage.
#   RED=1: the same run with the migration's report replacement withheld must
#          FAIL (red control: the gate keeps refusing without the change).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fx="$root/tests/fixtures/union-pnl-blocked-resolution"
migration=$(ls "$root"/supabase/migrations/*_a_late_seat_credit_is_resolved_from_its_receipts_not_forgive.sql)
work=$(mktemp -d "${TMPDIR:-/tmp}/pnlres.XXXXXX")
port=${PORT:-55543}
started=0
cleanup() { if [ "$started" = 1 ]; then LC_ALL=C "$pgbin/pg_ctl" -D "$work/data" -m immediate stop > "$work/stop.log" 2>&1 || true; fi; }
trap cleanup EXIT
mkdir "$work/s"
LC_ALL=C LANG=C "$pgbin/initdb" -D "$work/data" -U postgres -A trust --no-locale -E UTF8 > "$work/init.log"
LC_ALL=C LANG=C "$pgbin/pg_ctl" -D "$work/data" -l "$work/server.log" -o "-k $work/s -p $port -h ''" -w start > "$work/start.log"
started=1
# The production dry run must execute the migration's proof core byte-for-byte
# (only the not-yet-existing receipt lookup is read as false).
python3 - "$migration" "$fx/production-dryrun.sql" <<'PY'
import sys,re
core=lambda t:t[t.index('-- CORE BEGIN'):t.index('-- CORE END')]
m=re.sub(r'/\*R\*/.*?/\*R\*/','false /* no resolution receipt exists before the migration */',core(open(sys.argv[1]).read()),flags=re.S)
if m!=core(open(sys.argv[2]).read()): sys.exit('production dry run does not execute the migration proof core')
print('PASS dry-run core is the migration core')
PY
mig="$migration"
if [ "${RED:-0}" = 1 ]; then
  # Withhold the report change (keep the preimage body) and its postimage check.
  python3 - "$migration" "$fx/captured-preimages.sql" "$work/red.sql" <<'PY'
import sys,re
m=open(sys.argv[1]).read(); pre=open(sys.argv[2]).read()
old=pre[pre.index('CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report'):pre.index('CREATE OR REPLACE FUNCTION public.fn_union_pnl_close_quality')]
i=m.index('CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report'); j=m.index('REVOKE ALL ON FUNCTION public.fn_union_pnl_cash_outcome_accepted')
m=m[:i]+old+'\n'+m[j:]
m=re.sub(r"DO \$post\$.*?END \$post\$;",'',m,flags=re.S)
open(sys.argv[3],'w').write(m)
PY
  mig="$work/red.sql"
fi
set +e
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -U postgres -h "$work/s" -p "$port" -d postgres \
  -f "$fx/schema.sql" -f "$fx/captured-preimages.sql" -f "$fx/seed.sql" -f "$fx/stage1.sql" \
  -f "$mig" -f "$fx/stage2.sql" > "$work/run.log" 2>&1
rc=$?
set -e
grep -E "PASS|ALL PASS|ERROR|EXCEPTION" "$work/run.log" | sed 's/^psql:[^ ]* //' || true
if [ "${RED:-0}" = 1 ]; then
  if [ $rc -eq 0 ]; then echo "RED CONTROL FAILED: the gate passed without the report change"; exit 1; fi
  echo "RED CONTROL OK: without the report change the run fails (rc=$rc)"
else
  if [ $rc -ne 0 ]; then echo "FAIL (rc=$rc); log: $work/run.log"; exit $rc; fi
  echo "GREEN OK"
fi
