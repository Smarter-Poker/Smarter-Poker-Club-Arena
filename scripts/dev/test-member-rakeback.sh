#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:?Set TMPDIR To An Owned Scratch Directory}/member-rate.XXXXXX")
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55541 -h ''" start >/dev/null
started=1
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -U postgres -h "$fixture/socket" -p 55541 -d postgres)
"${psql[@]}" -f "$root/tests/fixtures/member-rakeback/bootstrap.sql" -f "$root/tests/fixtures/member-rakeback/preimage.sql"
python3 - "$root" "$fixture/history.sql" <<'PY'
import re,sys
from pathlib import Path
root,output=map(Path,sys.argv[1:])
original=(root/'supabase/migrations/20260914120926_accounting_agreements_preserve_observed_history.sql').read_text()
capture=re.search(r'CREATE FUNCTION public.fn_accounting_agreement_capture\(\).*?\$function\$;',original,re.S)
assert capture
output.write_text(capture.group(0)+'''\nCREATE TRIGGER accounting_agreement_history AFTER UPDATE OF player_rakeback_pct ON club_members FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture();\n''')
PY
"${psql[@]}" -f "$fixture/history.sql"
if "${psql[@]}" -c "SELECT fn_member_rakeback_terms(u(10),u(3),'player');" >"$fixture/before" 2>&1; then
  echo 'FAIL: Individual Editor Already Existed In Preimage'; exit 1
fi
"${psql[@]}" -f "$root/supabase/migrations/20261021173355_member_role_panel_edits_individual_rakeback_agreements.sql" -f "$root/tests/fixtures/member-rakeback/regression.sql"
"${psql[@]}" -c "SELECT assert_true(EXISTS(SELECT 1 FROM accounting_agreement_history WHERE subject_user_id=u(3) AND after_terms->>'player_rakeback_explicit'='true' AND (after_terms->>'player_rakeback_pct')::numeric=0),'Original History Trigger Records Explicit Zero');"
python3 - "${psql[@]}" <<'PY'
import concurrent.futures,json,subprocess,sys,threading
barrier=threading.Barrier(2)
def save(rate):
 barrier.wait()
 result=subprocess.run(sys.argv[1:]+['-t','-A','-c',f"SET test.uid='00000000-0000-4000-8000-000000000002';SELECT fn_member_rakeback_terms(u(10),u(3),'player',{rate},0);"],text=True,capture_output=True,check=True)
 return json.loads(result.stdout.strip().splitlines()[-1])
with concurrent.futures.ThreadPoolExecutor(2) as pool: results=list(pool.map(save,['.1','.2']))
assert sum(row['success'] for row in results)==1,results
assert any('Reload Terms' in row.get('error','') for row in results),results
print('PASS: Concurrent Editors Serialize And Refuse The Stale Writer')
PY
# Before the boundary fix, an authenticated direct percentage UPDATE succeeds.
# The fixture raises afterwards, so the reproduction rolls itself back.
if "${psql[@]}" -f "$root/tests/fixtures/member-rakeback/browser-boundary.sql" >"$fixture/browser-before" 2>&1; then
  echo 'FAIL: Browser Boundary Preimage Was Not Reproduced'; exit 1
fi
grep -q 'FAIL: Direct Player Percentage Bypassed Authorization' "$fixture/browser-before"
"${psql[@]}" -f "$root/supabase/migrations/20261021175019_individual_player_rates_cannot_bypass_agreement_authorizatio.sql" -f "$root/tests/fixtures/member-rakeback/browser-boundary.sql"
"${psql[@]}" -c "SET test.uid='00000000-0000-4000-8000-000000000002';SELECT assert_true((fn_member_rakeback_terms(u(10),u(3),'player',.25,fn_player_rakeback_rate(u(3),u(10),0))->>'success')::boolean,'Authorized RPC Still Writes Through The Hardened Boundary');"
# The migration cannot be replayed and must leave the installed function intact.
if "${psql[@]}" -f "$root/supabase/migrations/20261021173355_member_role_panel_edits_individual_rakeback_agreements.sql" >"$fixture/replay" 2>&1; then
  echo 'FAIL: Migration Replay Was Accepted'; exit 1
fi
if "${psql[@]}" -f "$root/supabase/migrations/20261021175019_individual_player_rates_cannot_bypass_agreement_authorizatio.sql" >"$fixture/boundary-replay" 2>&1; then
  echo 'FAIL: Boundary Migration Replay Was Accepted'; exit 1
fi
echo 'PASS: Individual Rakeback Native Regression And Replay Refusal'
