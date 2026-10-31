#!/usr/bin/env bash
# Focused native replay-gate transition only. No network or production database.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
HERE="$ROOT/scripts/ci/probes/horse-phase4-certified-solver"
PG_BIN=${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}
: "${TMPDIR:?set the task-owned scratch directory}"
WORK=$(mktemp -d "$TMPDIR/v31-ingress.XXXXXX")
if [[ "$(uname -s)" == Darwin ]]; then
  SOCKET=$(mktemp -d /Volumes/SmarterWork/agent-work/shared-capacity/v31i.XXXXXX)
else
  SOCKET="$WORK/socket";mkdir "$SOCKET"
fi
cleanup(){ "$PG_BIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1 || true;rm -rf "$WORK" "$SOCKET"; }
trap cleanup EXIT
"$PG_BIN/initdb" -D "$WORK/data" -A trust -U "$USER" >/dev/null
"$PG_BIN/pg_ctl" -D "$WORK/data" -o "-k $SOCKET -h '' -p 55461" -l "$WORK/server.log" -w start >/dev/null
PSQL=("$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET" -p 55461 -U "$USER" -d postgres)
"${PSQL[@]}" <<'SQL'
CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT 'service_role'::text$$;
SQL
# Byte-exact original owners, not a rewritten/mock implementation of the defect.
python3 -B - "$ROOT" <<'PY' | "${PSQL[@]}"
import sys
from pathlib import Path
s=(Path(sys.argv[1])/'supabase/migrations/20260908181724_both_solver_hosts_and_the_compactor_leave_receipts.sql').read_text()
a=s.index('CREATE TABLE IF NOT EXISTS public.solver_ingress_nonces (');b=s.index('\n);',a)+3
print(s[a:b])
a=s.index('CREATE OR REPLACE FUNCTION public.fn_solver_ingress_claim(');b=s.index('$fn$;',s.index('AS $fn$',a))+5
print(s[a:b])
print('REVOKE ALL ON FUNCTION public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text) FROM PUBLIC,anon,authenticated;')
print('GRANT EXECUTE ON FUNCTION public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text) TO service_role;')
PY
"${PSQL[@]}" -f "$HERE/model-ingress-before.sql"
"${PSQL[@]}" -f "$ROOT/supabase/migrations/20261030023627_v31_model_operations_enter_the_scoped_replay_gate.sql"
"${PSQL[@]}" -f "$HERE/model-ingress-after.sql"
"${PSQL[@]}" -Atc "SELECT md5(pg_get_functiondef('public.fn_solver_ingress_claim(text,uuid,text,timestamptz,text)'::regprocedure)) AS function_md5;SELECT md5(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='public.solver_ingress_nonces'::regclass AND conname='solver_ingress_nonces_operation_check';"
