#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d /tmp/scope-weekly-accounting-test.XXXXXX)
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null;fi;rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55503 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55503 -d postgres \
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
 -f "$root/supabase/migrations/20260914130611_invoice_inboxes_only_show_visible_documents_and_discussions.sql" \
 -f "$root/tests/fixtures/club-weekly-summary/regression.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914133404_routed_invoice_roles_follow_the_recorded_payment.sql" \
 -f "$root/tests/fixtures/scope-weekly-accounting/schema.sql" \
 -f "$root/tests/fixtures/mixed-rake-period/schema.sql" \
 -f "$root/tests/fixtures/mixed-rake-period/tournament-authority.sql" \
 -f "$root/tests/fixtures/scope-weekly-accounting/authority-preimage.sql" \
 -f "$root/tests/fixtures/scope-weekly-accounting/scope-authority.sql" \
 -c "ALTER TABLE accounting_tournament_fee_recognitions ADD COLUMN union_wallet_transaction_id uuid,ADD COLUMN bank_journal_id uuid;" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914142256_weekly_statements_follow_recorded_union_and_standalone_books.sql" \
 -f "$root/tests/fixtures/scope-weekly-accounting/regression.sql" \
 -c "SELECT proname,md5(pg_get_functiondef(oid)) FROM pg_proc WHERE proname IN('fn_club_weekly_accounting_summary','fn_issue_scope_weekly_accounting','fn_issue_club_weekly_accounting','fn_deliver_accounting_invoice','fn_accounting_tournament_week_quality');"
python3 - "$pgbin/psql" "$fixture/socket" <<'PY'
import subprocess,sys,time
psql=[sys.argv[1],'-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h',sys.argv[2],'-p','55503','-d','postgres']
context="SELECT set_config('app.union_accounting_validated_period','20000000-0000-0000-0000-000000000003:'||'2026-09-07 07:00Z'::timestamptz::text||':'||'2026-09-14 07:00Z'::timestamptz::text,false);"
issue="SELECT fn_issue_club_weekly_accounting('20000000-0000-0000-0000-000000000003','2026-09-07 07:00Z','2026-09-14 07:00Z')->>'issued';"
first=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
second=None
try:
 first.stdin.write('BEGIN;'+context+issue+'\\echo statement_scope_locked\n');first.stdin.flush()
 while True:
  line=first.stdout.readline()
  if not line: raise RuntimeError('First issuer exited before holding lock: '+first.stderr.read())
  if 'statement_scope_locked' in line: break
 second=subprocess.Popen(psql,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 second.stdin.write(context+issue+'\n');second.stdin.close()
 time.sleep(.15)
 if second.poll() is not None: raise RuntimeError('Competing statement caller bypassed scope lock: '+second.stdout.read()+second.stderr.read())
 first.stdin.write('COMMIT;\n');first.stdin.close();first.wait(timeout=10)
 if first.returncode: raise RuntimeError(first.stderr.read())
 second.wait(timeout=10)
 if second.returncode: raise RuntimeError(second.stderr.read())
 if second.stdout.read().strip().splitlines()[-1]!='0': raise RuntimeError('Second issuer did not observe committed statement replay')
 proof=subprocess.run(psql,input="SELECT (SELECT count(*)=1 FROM settlement_invoices WHERE club_id=u(912) AND invoice_type='club_weekly_accounting') AND (SELECT count(*)=1 FROM accounting_invoice_deliveries d JOIN settlement_invoices i ON i.id=d.invoice_id WHERE i.club_id=u(912)) AND (SELECT count(*)=0 FROM chip_ledger WHERE club_id=u(912));",text=True,check=True,capture_output=True)
 if proof.stdout.strip()!='t': raise RuntimeError('Concurrent statement issuance duplicated a document or moved money: '+proof.stdout)
 print('PASS: competing issuers create one weekly document, one real delivery, and no duplicate money movement')
finally:
 for process in (first,second):
  if process is not None and process.poll() is None: process.terminate();process.wait(timeout=10)
PY
