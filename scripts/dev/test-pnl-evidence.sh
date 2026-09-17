#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d /tmp/pnl-evidence.XXXXXX)
started=0
cleanup() { if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55507 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55507 -d postgres \
 -f "$root/tests/fixtures/pnl-evidence/schema.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914150848_union_pnl_evidence_is_distinct_from_posted_chip_payments.sql" \
 -f "$root/tests/fixtures/pnl-evidence/regression.sql"
"$pgbin/psql" -X -q -t -A -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55507 -d postgres \
 -c "SELECT jsonb_object_agg(proname,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE proname IN('fn_union_pnl_evidence_report','fn_union_pnl_posted_payment_evidence','fn_pnl_cash_hand_evidence','fn_pnl_evidence_cents');"
