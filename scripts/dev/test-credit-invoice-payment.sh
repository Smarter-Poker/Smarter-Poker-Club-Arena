#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/credit-payment-test.XXXXXX")
started=0
cleanup() {
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55487 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -d postgres \
  -f "$root/tests/fixtures/accounting-delivery/bootstrap.sql" \
  -f "$root/tests/fixtures/accounting-delivery/baseline.sql" \
  -f "$root/supabase/migrations/20260914113214_accounting_transfers_deliver_one_invoice_message_and_notification.sql" \
  -f "$root/supabase/migrations/20260914113315_transaction_receipts_require_a_source_and_preserve_issued_figures.sql" \
  -f "$root/tests/fixtures/accounting-delivery/credit-payment-setup.sql" \
  -f "$root/tests/fixtures/accounting-delivery/credit-payment-baseline.sql" \
  -f "$root/supabase/migrations/20260914114159_credit_payments_use_one_scoped_idempotent_transaction.sql" \
  -f "$root/tests/fixtures/accounting-delivery/credit-payment-regression.sql"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -d postgres <<'SQL'
UPDATE agents SET credit_used=5.04 WHERE id='30000000-0000-0000-0000-000000000001';
INSERT INTO credit_invoices(id,agent_id,period_start,period_end,debt_owed,amount_remaining,due_date)
 VALUES('70000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','2026-09-07','2026-09-14',5.04,5.04,'2026-09-17');
SQL
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -d postgres \
  -f "$root/tests/fixtures/accounting-delivery/credit-payment-concurrent.sql" >"$fixture/first.log" 2>&1 &
first_pid=$!
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -d postgres \
  -f "$root/tests/fixtures/accounting-delivery/credit-payment-concurrent.sql" >"$fixture/second.log" 2>&1 &
second_pid=$!
wait "$first_pid" || { cat "$fixture/first.log"; exit 1; }
wait "$second_pid" || { cat "$fixture/second.log"; exit 1; }
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -d postgres <<'SQL'
SELECT assert_true((SELECT count(*)=1 FROM credit_payments WHERE operation_id='80000000-0000-0000-0000-000000000099')
 AND (SELECT count(*)=1 FROM fixture_credit_debits WHERE invoice_id='70000000-0000-0000-0000-000000000002')
 AND (SELECT credit_used=0 FROM agents WHERE id='30000000-0000-0000-0000-000000000001'),
 'overlapping payment retries commit exactly one debit and receipt');
SQL
