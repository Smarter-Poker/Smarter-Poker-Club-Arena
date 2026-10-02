#!/usr/bin/env bash
# A balance never moves without its ledger row: execute the invariant that
# 20261001160611_a_balance_never_moves_without_its_ledger_row installs, on an
# isolated PostgreSQL 17, against the real-shaped fixture in
# tests/fixtures/ledger-invariant. Every refusal case plants the regression and
# proves the named refusal at commit; every pass case is a live money-path shape.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d "${TMPDIR:-/tmp}/ledger-invariant-test.XXXXXX")
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
  -o "-k $fixture/socket -p 55493 -h ''" start >/dev/null
started=1
migration=$(ls "$root"/supabase/migrations/*_a_balance_never_moves_without_its_ledger_row.sql | head -1)
# The hand receipt joins the felt (20261001231409): the fees a cash hand takes
# are counted on the felt from the accepted-hand transaction to the obligations
# transaction that posts their legs, so each half balances on its own.
receipt=$(ls "$root"/supabase/migrations/*_a_hands_fees_stay_on_the_felt_until_their_legs_are_posted.sql | head -1)
# Every remaining chip store (20261002030942): promo, agent, club wallet,
# insurance, Spin reserve, tournament liability, ticket escrow and the clearing
# stores, installed after the six-store proof above has run unchanged.
stores=$(ls "$root"/supabase/migrations/*_every_chip_store_balances_with_its_ledger_row.sql | head -1)
export PGOPTIONS='-c statement_timeout=60000 -c lock_timeout=5000 -c timezone=UTC -c client_min_messages=notice'
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55493 -d postgres \
  -f "$root/tests/fixtures/ledger-invariant/bootstrap.sql" \
  -f "$root/tests/fixtures/ledger-invariant/setup.sql" \
  -f "$migration" \
  -f "$receipt" \
  -f "$root/tests/fixtures/ledger-invariant/regression.sql" \
  -f "$root/tests/fixtures/ledger-invariant/stores-bootstrap.sql" \
  -f "$stores" \
  -f "$root/tests/fixtures/ledger-invariant/stores-regression.sql"
echo "ledger invariant: every refusal named, every live shape committed, on every chip store"
