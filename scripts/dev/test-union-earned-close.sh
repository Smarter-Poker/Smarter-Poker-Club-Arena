#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/union-earned.XXXXXX")
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55479 -h ''" start >/dev/null
started=1
python3 - "$root" "$fixture" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1]);fixture=Path(sys.argv[2])
sql=(root/'supabase/accounting/weekly-v3/components/20260914140015_recognized_cash_and_tournament_sources_share_one_payment_route.sql').read_text()
start=sql.index('CREATE VIEW public.accounting_payable_earning_sources');end=sql.index('CREATE OR REPLACE FUNCTION',start)
(fixture/'source-view.sql').write_text(sql[start:end])
scope=(root/'supabase/accounting/weekly-v3/components/20260914142600_unions_and_standalone_clubs_share_one_weekly_run_journal.sql').read_text()
start=scope.index('CREATE OR REPLACE FUNCTION public.fn_accounting_week_clubs');end=scope.index('CREATE FUNCTION public.fn_mark_scope_accounting_settled',start)
(fixture/'week-scope.sql').write_text(scope[start:end])
for kind in ('basis','close'):
 source=(root/f'tests/fixtures/union-earned-close/{kind}-preimage.sql').read_text().rstrip()
 (fixture/f'{kind}-preimage.sql').write_text(source+';\n')
PY
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55479 -d postgres \
 -f "$root/tests/fixtures/accounting-delivery/bootstrap.sql" \
 -f "$root/tests/fixtures/accounting-delivery/baseline.sql" \
 -f "$root/supabase/migrations/20260914113214_accounting_transfers_deliver_one_invoice_message_and_notification.sql" \
 -f "$root/supabase/migrations/20260914113315_transaction_receipts_require_a_source_and_preserve_issued_figures.sql" \
 -f "$root/tests/fixtures/club-weekly-summary/bootstrap.sql" \
 -f "$root/tests/fixtures/club-weekly-summary/delivery-preimage.sql" \
 -f "$root/tests/fixtures/club-weekly-summary/coordinator-preimage.sql" \
 -f "$root/tests/fixtures/club-weekly-summary/legacy.sql" \
 -f "$root/supabase/migrations/20260914124421_clubs_receive_one_weekly_accounting_statement.sql" \
 -f "$root/supabase/migrations/20260914124554_weekly_summary_respects_text_journal_settlement_identity.sql" \
 -f "$root/tests/fixtures/union-earned-close/bootstrap.sql" \
 -f "$root/tests/fixtures/union-earned-close/credit-and-ledger-preimage.sql" \
 -f "$fixture/source-view.sql" -f "$fixture/basis-preimage.sql" -f "$fixture/close-preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914141800_union_close_matches_recorded_earnings_to_every_bank_credit.sql" \
 -f "$root/tests/fixtures/union-earned-close/seed.sql"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55479 -d postgres -c 'CREATE DATABASE close_concurrent TEMPLATE postgres'
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55479 -d postgres -c 'CREATE DATABASE close_volume TEMPLATE postgres'
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55479 -d postgres -f "$root/tests/fixtures/union-earned-close/regression.sql"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55479 -d postgres \
 -f "$fixture/week-scope.sql" -f "$root/tests/fixtures/union-earned-close/conservation-preimage.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914143500_weekly_conservation_requires_recorded_scope_and_payment_receipts.sql" \
 -f "$root/tests/fixtures/union-earned-close/conservation-regression.sql"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55479 -d close_volume -f "$root/tests/fixtures/union-earned-close/volume.sql"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys,time
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55479','-d','close_concurrent']
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
second=None
try:
 first.stdin.write("BEGIN; SELECT close_week()->>'success';\\echo complete_week_held\n");first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line:raise RuntimeError('First close exited before lock proof: '+first.stderr.read())
  if 'complete_week_held' in line:break
 second=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 second.stdin.write("SELECT close_week()->>'error';\n");second.stdin.close()
 time.sleep(.2)
 if second.poll() is not None:raise RuntimeError('Competing close bypassed the uncommitted weekly source')
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 second.wait(timeout=10)
 if first.returncode or second.returncode:raise RuntimeError(first.stderr.read()+second.stderr.read())
 if second.stdout.read().strip()!='already_executed':raise RuntimeError('Competing close did not replay the completed week')
 proof=subprocess.run(psql,input="SELECT (SELECT rake_wallet=0 AND chip_balance=115 FROM union_wallets WHERE union_id=u(1)) AND (SELECT sum(chip_treasury)=245 FROM clubs WHERE id IN(u(2),u(3))) AND (SELECT count(*)=3 FROM chip_ledger WHERE union_id=u(1)) AND (SELECT count(*)=3 FROM settlement_invoices i JOIN chip_ledger l ON l.id=i.source_ledger_id WHERE l.union_id=u(1));",capture_output=True,text=True,check=True,timeout=10)
 if proof.stdout.strip()!='t':raise RuntimeError('Concurrent close duplicated money or documents: '+proof.stdout)
 print('PASS: concurrent union close pays 245 once, retains 105 once and emits exactly three actual journal invoices')
finally:
 for proc in (first,second):
  if proc is not None and proc.poll() is None:proc.terminate();proc.wait(timeout=10)
PY
