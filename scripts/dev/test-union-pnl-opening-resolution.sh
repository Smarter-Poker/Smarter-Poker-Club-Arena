#!/usr/bin/env bash
# Native qualification: a registration of a tournament that precedes the
# original inventory is counted in a union P&L boundary only through an
# immutable resolution re-proved from the posted chip ledger and bound to the
# exact population rows; everything unprovable keeps its tournament refused,
# and every other tournament is computed exactly as before.
#   GREEN (default): the migration under review must pass every stage.
#   RED=1: the same run with the boundary replacement withheld (the
#          20260928211132 definition kept) must FAIL.
# Builds on the definition migration 20260928211132 installs (its fixture
# new/fn_union_pnl_boundary.sql is the "before").
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fx="$root/tests/fixtures/union-pnl-opening-resolution"
fast="$root/tests/fixtures/union-pnl-evidence-fast"
migration=$(ls "$root"/supabase/migrations/*_an_opening_registration_is_resolved_from_its_ledger_entry.sql)
work=$(mktemp -d "${TMPDIR:-/tmp}/pnlopen.XXXXXX")
port=${PORT:-55547}
started=0
cleanup() { if [ "$started" = 1 ]; then LC_ALL=C "$pgbin/pg_ctl" -D "$work/data" -m immediate stop > /dev/null 2>&1 || true; fi; rm -rf "$work"; }
trap cleanup EXIT
mkdir "$work/s"
LC_ALL=C LANG=C "$pgbin/initdb" -D "$work/data" -U postgres -A trust --no-locale -E UTF8 > "$work/init.log"
LC_ALL=C LANG=C "$pgbin/pg_ctl" -D "$work/data" -l "$work/server.log" -o "-k $work/s -p $port -h '' -c shared_buffers=16MB -c max_wal_size=64MB" -w start > "$work/start.log"
started=1
# The production dry runs must execute the migration's proof core byte for
# byte (only the argument line is replaced by literals).
python3 - "$migration" "$fx" <<'PY'
import sys,re
from pathlib import Path
core=lambda t:t[t.index('-- CORE BEGIN'):t.index('-- CORE END')]
m=core(Path(sys.argv[1]).read_text())
args='WITH args AS MATERIALIZED (SELECT p_union_id AS union_id, p_at AS boundary),'
for f in sorted(Path(sys.argv[2]).glob('production-dryrun-*.sql')):
    d=core(f.read_text())
    d=re.sub(r"WITH args AS MATERIALIZED \(SELECT '[0-9a-f-]{36}'::uuid AS union_id, '[^']+'::timestamptz AS boundary\),",args,d,count=1)
    if d!=m: sys.exit(f'{f.name} does not execute the migration proof core')
    print(f'PASS {f.name} executes the migration proof core')
PY
mig="$migration"
if [ "${RED:-0}" = 1 ]; then
  python3 - "$migration" "$fast/new/fn_union_pnl_boundary.sql" "$work/red.sql" <<'PY'
import sys,re
m=open(sys.argv[1]).read(); old=open(sys.argv[2]).read().rstrip('\n')+';\n'
i=m.index('CREATE OR REPLACE FUNCTION public.fn_union_pnl_boundary'); j=m.index('REVOKE ALL ON FUNCTION public.fn_union_pnl_opening_registration_resolution')
m=m[:i]+old+'\n'+m[j:]
m=re.sub(r"DO \$post\$.*?END \$post\$;",'',m,flags=re.S)
open(sys.argv[3],'w').write(m)
PY
  mig="$work/red.sql"
fi
{ cat "$fast/new/fn_union_pnl_boundary.sql"; echo ';'; } > "$work/before.sql"
set +e
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -U postgres -h "$work/s" -p "$port" -d postgres \
  -f "$fast/prelude.sql" -f "$fast/schema-tables.sql" -f "$fast/stubs.sql" -f "$fx/schema.sql" \
  -f "$fast/preimage/fn_union_week_start.sql" -f "$fast/preimage/fn_pnl_evidence_cents.sql" \
  -f "$fast/preimage/fn_union_pnl_tournament_entry_club.sql" -f "$work/before.sql" \
  -f "$fx/seed.sql" -f "$fx/stage1.sql" -f "$mig" -f "$fx/stage2.sql" > "$work/run.log" 2>&1
rc=$?
set -e
grep -E "PASS|ERROR|FAIL|EXCEPTION" "$work/run.log" | sed 's/^psql:[^ ]* //' || true
if [ "${POSTIMAGE:-0}" = 1 ]; then
  "$pgbin/psql" -X -A -t -U postgres -h "$work/s" -p "$port" -d postgres -c "SELECT json_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid)))
   FROM pg_proc p WHERE p.proname IN ('fn_union_pnl_boundary','fn_union_pnl_opening_registration_resolution','fn_union_pnl_prove_opening_registrations','fn_union_pnl_resolve_opening_registrations')" | sed 's/public\.//g'
  "$pgbin/psql" -X -A -t -U postgres -h "$work/s" -p "$port" -d postgres -c "SELECT md5(pg_get_functiondef('public.fn_union_pnl_boundary(uuid,timestamptz)'::regprocedure))"
fi
if [ "${RED:-0}" = 1 ]; then
  if [ $rc -eq 0 ]; then echo "RED CONTROL FAILED: the gate passed without the boundary change"; exit 1; fi
  echo "RED CONTROL OK: without the boundary change the run fails (rc=$rc)"
else
  if [ $rc -ne 0 ]; then echo "FAIL (rc=$rc)"; tail -5 "$work/run.log"; exit $rc; fi
  echo "GREEN OK"
fi
