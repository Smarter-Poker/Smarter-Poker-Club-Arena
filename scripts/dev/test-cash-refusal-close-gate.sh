#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/cash-close-gate.XXXXXX")
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
 -f "$root/tests/fixtures/cash-source-refusals/regression.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914152500_unresolved_cash_sources_prevent_weekly_close.sql" \
 -f "$root/tests/fixtures/cash-source-refusals/close-gate-regression.sql"
