#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/cash-rake-period-test.XXXXXX")
started=0
cleanup() {
  if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi
  rm -rf "$fixture"
}
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55489 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55489 -d postgres \
 -f "$root/tests/fixtures/accounting-agreement-history/bootstrap.sql" \
 -f "$root/supabase/migrations/20260914120926_accounting_agreements_preserve_observed_history.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/bootstrap.sql" \
 -f "$root/supabase/migrations/20260914132929_cash_rakeback_reads_observed_earning_evidence.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/period-writer-bootstrap.sql" \
 -f "$root/supabase/accounting/weekly-v3/components/20260914132216_cash_rakeback_periods_require_one_certified_week.sql" \
 -f "$root/tests/fixtures/cash-rake-earning-evidence/period-writer-regression.sql"
if [ "${ACCOUNTING_BENCHMARK:-0}" = 1 ]; then
 "$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55489 -d postgres \
  -f "$root/tests/fixtures/cash-rake-earning-evidence/period-writer-benchmark.sql"
fi
# Two sessions retry the same unfinished week without creating another request.
"$pgbin/psql" -X -At -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55489 -d postgres \
 -c "SELECT attempts FROM accounting_period_recompute_requests WHERE club_id=u(20) AND period_start='2025-12-22'" > "$fixture/attempts-before"
read -r attempts_before < "$fixture/attempts-before"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55489 -d postgres \
 -c "BEGIN; SELECT fn_rakeback_recompute_periods(u(20),'2025-12-22','2025-12-28'); SELECT pg_sleep(0.2); COMMIT;" > "$fixture/retry-a.log" &
retry_a=$!
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55489 -d postgres \
 -c "SELECT fn_rakeback_recompute_periods(u(20),'2025-12-22','2025-12-28');" > "$fixture/retry-b.log" &
retry_b=$!
wait "$retry_a"
wait "$retry_b"
expected_attempts=$((attempts_before + 2))
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55489 -d postgres \
 -c "SELECT assert_true(count(*)=1 AND min(attempts)=$expected_attempts AND bool_and(status='blocked'),'concurrent retries preserve one durable request and both attempts') FROM accounting_period_recompute_requests WHERE club_id=u(20) AND period_start='2025-12-22';"
