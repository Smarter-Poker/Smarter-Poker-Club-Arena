#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/cash-compat.XXXXXX")
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55506 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55506 -d postgres \
 -f "$root/tests/fixtures/accounting-agreement-history/bootstrap.sql" \
 -f "$root/supabase/migrations/20260914120926_accounting_agreements_preserve_observed_history.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/bootstrap.sql" \
 -f "$root/supabase/migrations/20260914132929_cash_rakeback_reads_observed_earning_evidence.sql" \
 -f "$root/tests/fixtures/cash-commission-sources/bootstrap.sql" \
 -f "$root/tests/fixtures/cash-commission-sources/preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914131539_cash_commissions_account_for_every_contributor_once.sql" \
 -f "$root/tests/fixtures/cash-source-refusals/schema.sql" \
 -f "$root/tests/fixtures/cash-source-refusals/preimages.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914144442_cash_accounting_refusals_are_durable_and_retryable.sql" \
 -f "$root/tests/fixtures/cash-source-refusals/seed.sql" \
 -f "$root/tests/fixtures/cash-source-refusals/regression.sql"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys,time
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55506','-d','postgres']
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
second=None
try:
 first.stdin.write("BEGIN; SELECT fn_process_cash_accounting_source(u(140));\\echo source_held\n");first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line:raise RuntimeError('First source exited before lock proof: '+first.stderr.read())
  if 'source_held' in line:break
 second=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 second.stdin.write("SELECT fn_process_cash_accounting_source(u(140))->>'duplicate';\n");second.stdin.close()
 time.sleep(.2)
 if second.poll() is not None:raise RuntimeError('Competing source bypassed the uncommitted source')
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 second.wait(timeout=10)
 if first.returncode or second.returncode:raise RuntimeError(first.stderr.read()+second.stderr.read())
 if second.stdout.read().strip()!='true':raise RuntimeError('Competing caller failed to return committed duplicate')
 proof=subprocess.run(psql,input="SELECT (SELECT count(*)=3 FROM agent_commissions ac JOIN accounting_cash_rake_sources s ON s.id=ac.source_id WHERE s.rake_record_id=u(140)) AND (SELECT count(*)=1 FROM accounting_cash_source_receipts WHERE rake_record_id=u(140)) AND (SELECT count(*)=1 FROM rakeback_stats_applied WHERE rake_record_id=u(140)) AND (SELECT total_rake=7 FROM player_stats WHERE user_id=u(12));",capture_output=True,text=True,check=True,timeout=10)
 if proof.stdout.strip()!='t':raise RuntimeError('Concurrent retry duplicated source/stat receipts: '+proof.stdout)
 print('PASS: competing cash source callers serialize one liability, original stats and acknowledgement')
finally:
 for proc in (first,second):
  if proc is not None and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
PY
"$pgbin/psql" -X -q -t -A -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55506 -d postgres -c "SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE proname IN('fn_prepare_accounting_week','fn_cash_source_refusals_for_period','fn_process_cash_accounting_source','fn_credit_agent_commissions_batch','fn_retry_cash_accounting_sources','credit_agent_commission_from_rake','calculate_cascading_commission','fn_accrue_cash_hand_commissions');"

"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55506 -d postgres \
 -f "$root/supabase/accounting/weekly-v3/components/20260914145706_cash_compatibility_calls_share_durable_source_authority.sql" \
 -f "$root/tests/fixtures/cash-source-compatibility/regression.sql" \
 -f "$root/tests/fixtures/cash-commission-sources/allocator.sql" \
 -f "$root/tests/fixtures/cash-commission-sources/producer-fixture.sql" \
 -f "$root/tests/fixtures/cash-source-compatibility/producer-order.sql"
