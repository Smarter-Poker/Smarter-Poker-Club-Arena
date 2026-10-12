#!/usr/bin/env bash
# Native qualification: after 20260928211132 and 20260928222109, a
# registration the opening boundary carried through a valid resolution is the
# entry evidence for its week (touched-registration test), and an award that
# names no entry receipt is accepted only through that resolution and its
# posted ledger credit. Every other value of the report is unchanged.
#   GREEN (default): the migration under review must pass every stage.
#   RED=1: the same run with the report replacement withheld must FAIL.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fx="$root/tests/fixtures/union-pnl-award-owner"
open="$root/tests/fixtures/union-pnl-opening-resolution"
fast="$root/tests/fixtures/union-pnl-evidence-fast"
migration=$(ls "$root"/supabase/migrations/*_a_resolved_opening_registration_is_the_entry_evidence_for_it.sql)
m5553=$(ls "$root"/supabase/migrations/*_an_opening_registration_is_resolved_from_its_ledger_entry.sql)
work=$(mktemp -d "${TMPDIR:-/tmp}/pnlaward.XXXXXX")
port=${PORT:-55549}
started=0
cleanup() { if [ "$started" = 1 ]; then LC_ALL=C "$pgbin/pg_ctl" -D "$work/data" -m immediate stop > /dev/null 2>&1 || true; fi; rm -rf "$work"; }
trap cleanup EXIT
mkdir "$work/s"
LC_ALL=C LANG=C "$pgbin/initdb" -D "$work/data" -U postgres -A trust --no-locale -E UTF8 > "$work/init.log"
LC_ALL=C LANG=C "$pgbin/pg_ctl" -D "$work/data" -l "$work/server.log" -o "-k $work/s -p $port -h '' -c shared_buffers=16MB -c max_wal_size=64MB" -w start > "$work/start.log"
started=1
mig="$migration"
if [ "${RED:-0}" = 1 ]; then
  python3 - "$migration" "$fast/new/fn_union_pnl_evidence_report.sql" "$work/red.sql" <<'PY'
import sys,re
m=open(sys.argv[1]).read(); old=open(sys.argv[2]).read().rstrip('\n')+';\n'
i=m.index('CREATE OR REPLACE FUNCTION public.fn_union_pnl_evidence_report'); j=m.index('REVOKE ALL ON FUNCTION public.fn_union_pnl_award_owner_resolved')
m=m[:i]+old+'\n'+m[j:]
m=re.sub(r"DO \$post\$.*?END \$post\$;",'',m,flags=re.S)
open(sys.argv[3],'w').write(m)
PY
  mig="$work/red.sql"
fi
{ cat "$fast/new/fn_union_pnl_boundary.sql"; echo ';'; cat "$fast/new/fn_union_pnl_evidence_report.sql"; echo ';'; } > "$work/after5551.sql"
python3 -c "import sys;t=open(sys.argv[1]).read();open(sys.argv[2],'w').write(t[:t.index(chr(10)+'-- T_INS')]+chr(10))" "$open/seed.sql" "$work/helpers.sql"
set +e
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -U postgres -h "$work/s" -p "$port" -d postgres \
  -f "$fast/prelude.sql" -f "$fast/schema-tables.sql" -f "$fast/stubs.sql" -f "$open/schema.sql" \
  -f "$fast/preimage/fn_union_week_start.sql" -f "$fast/preimage/fn_pnl_evidence_cents.sql" \
  -f "$fast/preimage/fn_union_pnl_tournament_entry_club.sql" -f "$fast/preimage/fn_union_pnl_cash_outcome_accepted.sql" \
  -f "$fast/preimage/fn_union_pnl_tournament_returns.sql" -f "$fast/preimage/fn_union_pnl_original_flow_evidence.sql" \
  -f "$fast/preimage/fn_accounting_union_earned_plan.sql" -f "$work/after5551.sql" -f "$m5553" \
  -f "$work/helpers.sql" -f "$fx/seed.sql" -f "$fx/stage1.sql" -f "$mig" -f "$fx/stage2.sql" > "$work/run.log" 2>&1
rc=$?
set -e
grep -E "PASS|ERROR|FAIL" "$work/run.log" | sed 's/^psql:[^ ]* //' || true
if [ "${POSTIMAGE:-0}" = 1 ]; then
  "$pgbin/psql" -X -A -t -U postgres -h "$work/s" -p "$port" -d postgres -c "SELECT json_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)))
   FROM pg_proc p WHERE p.proname IN ('fn_union_pnl_evidence_report','fn_union_pnl_award_owner_resolved')"
fi
if [ "${RED:-0}" = 1 ]; then
  if [ $rc -eq 0 ]; then echo "RED CONTROL FAILED: the gate passed without the report change"; exit 1; fi
  echo "RED CONTROL OK: without the report change the run fails (rc=$rc)"
else
  if [ $rc -ne 0 ]; then echo "FAIL (rc=$rc)"; tail -8 "$work/run.log"; exit $rc; fi
  echo "GREEN OK"
fi
