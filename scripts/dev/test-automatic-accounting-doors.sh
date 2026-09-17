#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d /tmp/automatic-accounting-doors.XXXXXX)
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null;fi;rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55509 -h ''" start >/dev/null
started=1
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55509 -d postgres)
"${psql[@]}" -f "$root/tests/fixtures/automatic-accounting-doors/bootstrap.sql" -f "$root/tests/fixtures/automatic-accounting-doors/preimage.sql"
migration="$root/supabase/accounting/weekly-v3/components/20260914145000_legacy_claims_enter_only_automatic_weekly_accounting.sql"
if "${psql[@]}" -f "$migration" >"$fixture/missing-coordinator.log" 2>&1; then
 echo 'FAIL: legacy cutover accepted before scoped coordinator';exit 1
fi
rg -q 'scoped weekly coordinator must be installed' "$fixture/missing-coordinator.log"
echo 'PASS: cutover refuses installation before the scoped coordinator exists'
# Compile the exact J financial implementation, preserving its real authority
# and scope validation. Do not substitute an empty/success coordinator stub.
python3 - "$root" "$fixture/coordinator.sql" <<'PY'
import pathlib,re,sys
root=pathlib.Path(sys.argv[1])
source=(root/'supabase/accounting/weekly-v3/components/20260914142600_unions_and_standalone_clubs_share_one_weekly_run_journal.sql').read_text()
chunks=[]
for name in ['fn_process_weekly_accounting_scope','fn_process_weekly_accounting']:
 pattern=r'CREATE(?: OR REPLACE)? FUNCTION public\.'+name+r'\(.*?\$function\$.*?\$function\$\s*;'
 matches=re.findall(pattern,source,re.S)
 if len(matches)!=1: raise SystemExit(f'Expected one actual coordinator definition for {name}, found {len(matches)}')
 chunks+=matches
chunks.append('REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting_scope(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;')
pathlib.Path(sys.argv[2]).write_text('\n'.join(chunks))
PY
"${psql[@]}" -f "$fixture/coordinator.sql"
# A modified preimage must fail before a claim function changes.
"${psql[@]}" -c "CREATE OR REPLACE FUNCTION fn_claim_rakeback(p_club_id uuid DEFAULT NULL::uuid) RETURNS jsonb LANGUAGE plpgsql AS \$\$BEGIN RETURN '{}'::jsonb;END\$\$;"
if "${psql[@]}" -f "$migration" >"$fixture/changed-preimage.log" 2>&1; then
 echo 'FAIL: changed legacy function was overwritten';exit 1
fi
rg -q 'legacy door preimage changed' "$fixture/changed-preimage.log"
echo 'PASS: cutover refuses an unreviewed legacy preimage'
"${psql[@]}" -f "$root/tests/fixtures/automatic-accounting-doors/preimage.sql" -f "$migration" -f "$root/tests/fixtures/automatic-accounting-doors/regression.sql"
