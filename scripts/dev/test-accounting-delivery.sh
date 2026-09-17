#!/usr/bin/env bash
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/accounting-delivery-test.XXXXXX")
started=0
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$fixture/server.log" ]; then
    cat "$fixture/server.log" >&2
  fi
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
  -f "$root/tests/fixtures/accounting-delivery/regression.sql"

# The same private cluster owns the two maintained Diamond probes. A separate
# database preserves the accounting test's original fixture and starting state.
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -d postgres <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN
   CREATE ROLE postgres SUPERUSER LOGIN;
 END IF;
END $$;
CREATE DATABASE diamond_games_probe OWNER postgres;
SQL
diamond="$root/tests/fixtures/accounting-delivery/diamond-games"
diamond_psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55487 -U postgres -d diamond_games_probe)
# Match the original database-owner trigger context; client identities remain
# synthetic authenticated claims, never a service-role override in the probes.
export PGOPTIONS='-c statement_timeout=90000 -c lock_timeout=2000'
"${diamond_psql[@]}" \
  -f "$diamond/schema.sql" -f "$diamond/auth.sql" \
  -f "$diamond/functions.sql" -f "$diamond/constraints.sql" \
  -f "$diamond/policy.sql" -f "$diamond/seed.sql" -f "$diamond/triggers.sql" \
  -f "$root/supabase/migrations/20260914100738_a_funding_replay_belongs_to_the_same_request.sql" \
  -f "$root/supabase/migrations/20260914132533_a_claimed_tenth_day_bonus_carries_one_mint_funded_spin.sql"

# The original money path keeps its actual invoice/delivery triggers. Load only
# the captured dependencies needed by the bank fallback regression, never stubs.
"${diamond_psql[@]}" \
  -f "$diamond/invoice-schema.sql" -f "$diamond/union-clubs-schema.sql" \
  -f "$diamond/invoice-functions.sql" \
  -f "$diamond/invoice-constraints.sql" -f "$diamond/invoice-seed.sql" \
  -f "$diamond/invoice-triggers.sql" -f "$diamond/union-clubs-triggers.sql"

"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-before.jsonl"
funding_status=0
"${diamond_psql[@]}" -f "$root/tests/sql/diamond-games-funding-identity.sql" \
  > "$fixture/funding.stdout" 2> "$fixture/funding.stderr" || funding_status=$?
cat "$fixture/funding.stdout" "$fixture/funding.stderr"
expected_funding='ERROR:  PROBE PASS (rolled back): union: one journal leg, exact replay accepted, amount, host and operator changes refused; club: one journal leg, exact replay accepted, amount, host and operator changes refused;'
if [ "$funding_status" -ne 3 ] ||
   [ "$(grep -c 'ERROR:' "$fixture/funding.stderr")" -ne 1 ] ||
   ! grep -Fq "$expected_funding" "$fixture/funding.stderr" ||
   grep -Eq 'WARNING:|FATAL:|PANIC:' "$fixture/funding.stderr"; then
  echo 'Diamond funding probe did not reach its exact rollback terminal' >&2
  exit 1
fi
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-after-funding.jsonl"
cmp "$fixture/diamond-before.jsonl" "$fixture/diamond-after-funding.jsonl"

daily_status=0
"${diamond_psql[@]}" -f "$root/tests/sql/diamond-spins-claimed-daily-bonus.sql" \
  > "$fixture/daily.stdout" 2> "$fixture/daily.stderr" || daily_status=$?
cat "$fixture/daily.stdout" "$fixture/daily.stderr"
expected_daily='NOTICE:  PASS milestones 9/10/11/19/20/29/30/31/40, chest preserved, preview, claim required, duplicate claim, foreign user, canonical Mint refusal, entry=100, player cost=0, host funding, exact replay, welcome independent and once only, private permissions'
if [ "$daily_status" -ne 0 ] ||
   [ "$(grep -Fc "$expected_daily" "$fixture/daily.stderr")" -ne 1 ] ||
   grep -Eq 'ERROR:|WARNING:|FATAL:|PANIC:' "$fixture/daily.stderr"; then
  echo 'Diamond daily-spin probe did not reach its exact rollback terminal' >&2
  exit 1
fi
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-after-daily.jsonl"
cmp "$fixture/diamond-before.jsonl" "$fixture/diamond-after-daily.jsonl"
echo 'PASS: both Diamond probes reached their complete terminal and all public/auth rows rolled back'

# Promo-first and exact Main Bank shortfall for all four game payout categories.
bank_status=0
"${diamond_psql[@]}" -f "$root/tests/sql/diamond-games-bank-fallback.sql" \
  > "$fixture/bank.stdout" 2> "$fixture/bank.stderr" || bank_status=$?
cat "$fixture/bank.stdout" "$fixture/bank.stderr"
expected_bank='NOTICE:  PASS Diamond Main Bank fallback: Union and Club, Promo first, exact shortfall, four game categories, balanced journals, actual invoices/messages/notifications, host isolation, atomic insufficient cover'
if [ "$bank_status" -ne 0 ] ||
   [ "$(grep -Fc "$expected_bank" "$fixture/bank.stderr")" -ne 1 ] ||
   grep -Eq 'ERROR:|WARNING:|FATAL:|PANIC:' "$fixture/bank.stderr"; then
  echo 'Diamond Main Bank probe did not reach its exact rollback terminal' >&2
  exit 1
fi
"${diamond_psql[@]}" -At -f "$diamond/snapshot.sql" > "$fixture/diamond-after-bank.jsonl"
cmp "$fixture/diamond-before.jsonl" "$fixture/diamond-after-bank.jsonl"
echo 'PASS: Diamond Main Bank payout, invoice and notification rows rolled back'
