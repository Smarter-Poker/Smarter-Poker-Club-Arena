#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/cash-commission-sources.XXXXXX")
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55490 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55490 -d postgres \
 -f "$root/tests/fixtures/accounting-agreement-history/bootstrap.sql" \
 -f "$root/supabase/migrations/20260914120926_accounting_agreements_preserve_observed_history.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/bootstrap.sql" \
 -f "$root/supabase/migrations/20260914132929_cash_rakeback_reads_observed_earning_evidence.sql" \
 -f "$root/tests/fixtures/cash-commission-sources/bootstrap.sql" \
 -f "$root/tests/fixtures/cash-commission-sources/preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914131539_cash_commissions_account_for_every_contributor_once.sql" \
 -f "$root/tests/fixtures/cash-commission-sources/regression.sql" \
 -f "$root/tests/fixtures/cash-commission-sources/allocator.sql" \
 -f "$root/tests/fixtures/cash-commission-sources/producer-fixture.sql"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys,time
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55490','-d','postgres']
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
second=None
try:
 first.stdin.write("BEGIN; SELECT fn_accrue_cash_hand_commissions(u(131));\\echo cash_source_held\n");first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line:raise RuntimeError('First accrual exited before lock proof: '+first.stderr.read())
  if 'cash_source_held' in line:break
 second=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 second.stdin.write("SELECT fn_accrue_cash_hand_commissions(u(131))->>'duplicate';\n");second.stdin.close()
 time.sleep(.2)
 if second.poll() is not None:raise RuntimeError('Competing accrual bypassed the uncommitted source')
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 second.wait(timeout=10)
 if first.returncode or second.returncode:raise RuntimeError(first.stderr.read()+second.stderr.read())
 if second.stdout.read().strip()!='true':raise RuntimeError('Competing caller failed to return committed duplicate')
 proof=subprocess.run(psql,input="SELECT count(*) FROM agent_commissions ac JOIN accounting_cash_rake_sources s ON s.id=ac.source_id WHERE s.rake_record_id=u(130);",capture_output=True,text=True,check=True,timeout=10)
 if proof.stdout.strip()!='3':raise RuntimeError('Concurrent source did not produce exactly one row per tier: '+proof.stdout)
 print('PASS: competing cash accrual callers serialize one source and exactly three tier rows')
finally:
 for proc in (first,second):
  if proc is not None and proc.poll() is None:proc.terminate();proc.wait(timeout=10)

# The same lock must cover the bank deposit, not only later commissions.
# A producer already waiting on a closing week must observe the committed
# close marker and leave no bank credit or raw source behind.
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
second=None
try:
 first.stdin.write("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('union-accounting:'||u(20)::text||':'||extract(epoch FROM fn_union_week_start(now()))::text||':'||extract(epoch FROM fn_union_week_start(fn_union_week_start(now())+interval '8 days'))::text,0)); INSERT INTO union_rakeback_log VALUES(u(20),fn_union_week_start(now()),fn_union_week_start(fn_union_week_start(now())+interval '8 days'));\\echo closing_week_held\n");first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line:raise RuntimeError('Closing owner exited before lock proof: '+first.stderr.read())
  if 'closing_week_held' in line:break
 second=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 second.stdin.write("SELECT * FROM atomic_distribute_rake(u(200),u(10),u(203),1000005,1,0,20,1,jsonb_build_object(u(12)::text,20),NULL,NULL,'WEIGHTED_CONTRIBUTED');\n");second.stdin.close()
 time.sleep(.2)
 if second.poll() is not None:raise RuntimeError('Cash bank producer bypassed the closing weekly scope')
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 second.wait(timeout=10)
 failure=second.stderr.read()
 if first.returncode or second.returncode==0 or 'cash_bank_closed_week_requires_adjustment' not in failure:raise RuntimeError(first.stderr.read()+failure)
 proof=subprocess.run(psql,input="SELECT NOT EXISTS(SELECT 1 FROM rake_records WHERE hand_id=u(203)) AND (SELECT chip_treasury=0 FROM clubs WHERE id=u(10)) AND (SELECT count(*)=2 FROM accounting_cash_bank_receipts b JOIN rake_records r ON r.id=b.rake_record_id WHERE r.hand_id IN(u(201),u(211)));",capture_output=True,text=True,check=True,timeout=10)
 if proof.stdout.strip()!='t':raise RuntimeError('Late producer left a bank credit or partial raw source: '+proof.stdout)
 print('PASS: cash bank producer waits for the exact closing scope then refuses without bank/source drift')
finally:
 for proc in (first,second):
  if proc is not None and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
PY
"$pgbin/psql" -X -q -t -A -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55490 -d postgres -c "SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE proname IN('fn_process_weekly_accounting','fn_union_settlement_cascade','fn_accounting_week_clubs');"
