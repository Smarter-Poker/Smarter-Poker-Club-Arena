#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d /tmp/mixed-rake-period-test.XXXXXX)
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55502 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55502 -d postgres \
 -f "$root/tests/fixtures/accounting-agreement-history/bootstrap.sql" \
 -f "$root/supabase/migrations/20260914120926_accounting_agreements_preserve_observed_history.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/bootstrap.sql" \
 -f "$root/supabase/migrations/20260914132929_cash_rakeback_reads_observed_earning_evidence.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/period-writer-bootstrap.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914132216_cash_rakeback_periods_require_one_certified_week.sql" \
 -c "SELECT proname,md5(pg_get_functiondef(oid)) FROM pg_proc WHERE proname IN('fn_calculate_cash_rakeback_periods','fn_rakeback_recompute_periods');"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55502 -d postgres \
 -f "$root/tests/fixtures/mixed-rake-period/schema.sql" \
 -f "$root/tests/fixtures/mixed-rake-period/tournament-authority.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914141013_weekly_player_certificates_include_recognized_tournament_fees.sql" \
 -f "$root/tests/fixtures/mixed-rake-period/cash-regression.sql" \
 -f "$root/tests/fixtures/mixed-rake-period/helpers.sql"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55502 -d postgres \
 -f "$root/tests/fixtures/mixed-rake-period/regression.sql" \
 -c "SELECT proname,md5(pg_get_functiondef(oid)) FROM pg_proc WHERE proname IN('fn_calculate_cash_rakeback_periods','fn_rakeback_recompute_periods','fn_accounting_tournament_week_quality');"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys,time
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55502','-d','postgres']
subprocess.run(psql,input="SELECT test_fee_source(941,503,20,10,'2026-08-18Z');SELECT test_fee_recognition(941,'2026-08-25Z');",text=True,check=True,capture_output=True)
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1);second=None
try:
 first.stdin.write("BEGIN;SELECT fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30');\\echo mixed_request_held\n");first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line: raise RuntimeError('First request failed before lock proof: '+first.stderr.read())
  if 'mixed_request_held' in line: break
 second=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 second.stdin.write("SELECT fn_rakeback_recompute_periods(u(20),'2026-08-24','2026-08-30')->>'written';\n");second.stdin.close();time.sleep(.15)
 if second.poll() is not None: raise RuntimeError('Second certificate writer bypassed its durable request lock')
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 if first.returncode: raise RuntimeError(first.stderr.read())
 second.wait(timeout=10)
 if second.returncode: raise RuntimeError(second.stderr.read())
 if second.stdout.read().strip()!='0': raise RuntimeError('Second writer did not reuse the exact committed certificate')
 proof=subprocess.run(psql,input="SELECT (SELECT count(*) FROM accounting_period_recompute_requests WHERE club_id=u(20) AND period_start='2026-08-24' AND status='complete' AND attempts=2)=1 AND (SELECT count(*) FROM accounting_rakeback_period_calculations WHERE club_id=u(20) AND period_start='2026-08-24')=1 AND (SELECT rakeback_amount FROM rakeback_periods WHERE club_id=u(20) AND period_start='2026-08-24')=1;",text=True,check=True,capture_output=True)
 if proof.stdout.strip()!='t': raise RuntimeError('Concurrent request/certificate proof failed: '+proof.stdout)
 print('PASS: concurrent recognized-fee requests preserve one durable request, both attempts and one exact player liability')
finally:
 for process in (first,second):
  if process is not None and process.poll() is None: process.terminate();process.wait(timeout=10)
PY
