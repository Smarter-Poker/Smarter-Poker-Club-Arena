#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d /tmp/unified-weekly-accounting-test.XXXXXX)
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null;fi;rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55504 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55504 -d postgres \
 -f "$root/tests/fixtures/routed-accounting/bootstrap.sql" \
 -f "$root/tests/fixtures/routed-accounting/preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914132449_rakeback_follows_recorded_hierarchy_in_one_funded_transaction.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914135008_standalone_clubs_use_the_same_atomic_routed_stages.sql" \
 -f "$root/tests/fixtures/routed-accounting/seed.sql" \
 -f "$root/tests/fixtures/routed-accounting/central-delivery-schema.sql" \
 -f "$root/tests/fixtures/routed-accounting/central-delivery-preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914133404_routed_invoice_roles_follow_the_recorded_payment.sql" \
 -f "$root/tests/fixtures/routed-accounting/central-delivery-triggers.sql" \
 -f "$root/tests/fixtures/unified-weekly-accounting/schema.sql" \
 -f "$root/tests/fixtures/mixed-rake-period/schema.sql" \
 -c "ALTER TABLE accounting_tournament_fee_recognitions ADD COLUMN union_wallet_transaction_id uuid,ADD COLUMN bank_journal_id uuid;" \
 -f "$root/tests/fixtures/mixed-rake-period/tournament-authority.sql" \
 -c "DROP VIEW accounting_payable_earning_sources;" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914140015_recognized_cash_and_tournament_sources_share_one_payment_route.sql" \
 -f "$root/tests/fixtures/unified-weekly-accounting/preimages.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914142256_weekly_statements_follow_recorded_union_and_standalone_books.sql" \
 -c "INSERT INTO union_accounting_runs(union_id,period_start,period_end,scheduled_at,status,attempts,result) VALUES(u(999),'2026-08-31 07:00Z','2026-09-07 07:00Z','2026-09-07 09:00Z','failed',7,'{\"success\":false,\"original\":true}');" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914142600_unions_and_standalone_clubs_share_one_weekly_run_journal.sql" \
 -f "$root/tests/fixtures/union-earned-close/conservation-preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914143500_weekly_conservation_requires_recorded_scope_and_payment_receipts.sql" \
 -c "SELECT proname,md5(pg_get_functiondef(oid)) FROM pg_proc WHERE proname IN('fn_process_weekly_accounting','fn_process_weekly_accounting_scope','fn_accounting_failure_identity','fn_union_settlement_cascade','fn_accounting_week_clubs','fn_mark_scope_accounting_settled');" \
 -f "$root/tests/fixtures/unified-weekly-accounting/controls.sql"
"$pgbin/createdb" -h "$fixture/socket" -p 55504 -T postgres standalone_book
"$pgbin/createdb" -h "$fixture/socket" -p 55504 -T postgres concurrent_book
if [ "${UNIFIED_BOOK:-all}" != "union" ]; then
 "$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55504 -d standalone_book -f "$root/tests/fixtures/unified-weekly-accounting/standalone.sql"
fi
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55504 -d postgres -f "$root/tests/fixtures/unified-weekly-accounting/union.sql"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys,time
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55504','-d','concurrent_book']
subprocess.run(psql,input="DELETE FROM unions;DELETE FROM union_clubs;DELETE FROM accounting_agreement_history;UPDATE clubs SET union_id=NULL;UPDATE accounting_cash_rake_sources SET union_id=NULL,coordinator_union_id=NULL;UPDATE accounting_rakeback_period_calculations SET coordinator_union_id=NULL;",text=True,check=True,capture_output=True)
clock="SET test.clock='2026-09-14T09:20:00Z';"
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
try:
 first.stdin.write('BEGIN;'+clock+"SELECT fn_process_weekly_accounting(NULL)->>'success';\\echo coordinator_lock_held\n");first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line: raise RuntimeError('Coordinator exited before holding lock: '+first.stderr.read())
  if 'coordinator_lock_held' in line: break
 second=subprocess.run(psql,input=clock+"SELECT fn_process_weekly_accounting(NULL)->>'reason';",text=True,capture_output=True,timeout=10,check=True)
 if second.stdout.strip()!='already_running': raise RuntimeError('Second caller failed to honor the single scheduler lock: '+second.stdout+second.stderr)
 print('PASS: a competing coordinator caller observes the single active scheduler and does not start a second payment run')
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 if first.returncode: raise RuntimeError(first.stderr.read())
 proof=subprocess.run(psql,input=clock+"SELECT fn_process_weekly_accounting(NULL)->>'checked';SELECT (SELECT count(*)=1 AND bool_and(status='complete' AND attempts=1) FROM union_accounting_runs) AND (SELECT count(*)=2 FROM accounting_routed_settlement_runs) AND (SELECT count(*)=7 FROM settlement_invoices) AND (SELECT count(*)=11 FROM notifications) AND (SELECT chip_treasury=153.40 FROM clubs);",text=True,check=True,capture_output=True)
 if proof.stdout.strip().splitlines()!=['0','t']: raise RuntimeError('Concurrent accounting repeated or lost payment/document evidence: '+proof.stdout)
 print('PASS: after the first coordinator commits, retry observes one complete run, exact balances and one document per obligation')
finally:
 if first.poll() is None: first.terminate();first.wait(timeout=10)
PY
