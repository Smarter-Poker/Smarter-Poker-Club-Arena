#!/usr/bin/env bash
# A balance never moves without its ledger row: execute the invariant that
# 20261001160611_a_balance_never_moves_without_its_ledger_row installs, on an
# isolated PostgreSQL 17, against the real-shaped fixture in
# tests/fixtures/ledger-invariant. Every refusal case plants the regression and
# proves the named refusal at commit; every pass case is a live money-path shape.
set -euo pipefail
# macOS: a postmaster listening on TCP aborts ("became multithreaded during
# startup") unless LC_ALL names a valid locale.
export LC_ALL="${LC_ALL:-C}"
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
# A ledger refusal is recorded outside its rollback (20261002135708): the
# recorder connects back over TCP as its own login with the password the
# migration generated and kept in Vault. Production's project host asks that
# login for scram; so does the fixture, ahead of initdb's trust lines, so the
# recorded rows prove the unseen password authenticates.
{ echo "host all ca_ledger_refusal_recorder 127.0.0.1/32 scram-sha-256"; cat "$fixture/data/pg_hba.conf"; } > "$fixture/pg_hba.conf"
mv "$fixture/pg_hba.conf" "$fixture/data/pg_hba.conf"
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" \
  -o "-k $fixture/socket -p 55493 -h 127.0.0.1" start >/dev/null
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
# No balance moves against settlement suspense (20261002065836): a store that
# balances with a leg whose other end is suspense is refused, installed after
# every store proof has run unchanged.
suspense=$(ls "$root"/supabase/migrations/*_no_balance_moves_against_settlement_suspense.sql | head -1)
# A ledger refusal is recorded outside its rollback (20261002135708): a refused
# transaction rolls back whole, and its record, its count and its incident
# must exist afterwards. Installed last, after every judgement has been proved
# unchanged; the three settings point the recorder's loopback at this fixture.
recorder=$(ls "$root"/supabase/migrations/*_a_ledger_refusal_is_recorded_outside_its_rollback.sql | head -1)
export PGOPTIONS='-c statement_timeout=60000 -c lock_timeout=5000 -c timezone=UTC -c client_min_messages=notice -c ca.ledger_refusal_recorder_host=127.0.0.1 -c ca.ledger_refusal_recorder_port=55493 -c ca.ledger_refusal_recorder_sslmode=disable'
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55493 -d postgres \
  -f "$root/tests/fixtures/ledger-invariant/bootstrap.sql" \
  -f "$root/tests/fixtures/ledger-invariant/setup.sql" \
  -f "$migration" \
  -f "$receipt" \
  -f "$root/tests/fixtures/ledger-invariant/regression.sql" \
  -f "$root/tests/fixtures/ledger-invariant/stores-bootstrap.sql" \
  -f "$stores" \
  -f "$root/tests/fixtures/ledger-invariant/stores-regression.sql" \
  -f "$root/tests/fixtures/ledger-invariant/suspense-bootstrap.sql" \
  -f "$suspense" \
  -f "$root/tests/fixtures/ledger-invariant/suspense-regression.sql" \
  -f "$root/tests/fixtures/ledger-invariant/cashout-bootstrap.sql" \
  -f "$root/supabase/migrations/20261006140948_cashout_escrow_balances_with_its_own_ledger_leg.sql" \
  -f "$root/tests/fixtures/ledger-invariant/cashout-regression.sql" \
  -f "$root/tests/fixtures/ledger-invariant/refusal-bootstrap.sql" \
  -f "$recorder" \
  -f "$root/tests/fixtures/ledger-invariant/refusal-regression.sql"
# Read-only chart qualification in a separate database: no custody guards are stubbed.
"$pgbin/createdb" -h "$fixture/socket" -p 55493 cashout_readers
python3 "$root/scripts/dev/cashout-reader-sql.py" > "$fixture/cashout-readers.sql"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55493 -d cashout_readers -f "$fixture/cashout-readers.sql"
echo "ledger invariant: every refusal named, every live shape committed, on every chip store, nothing balances against suspense, and every refusal is recorded outside its rollback"
