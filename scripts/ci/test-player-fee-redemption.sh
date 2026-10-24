#!/usr/bin/env bash
# Native regression against the three production reader definitions captured
# October 23. No financial writes or credentials, only a disposable database.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_BIN="${PG_BIN:?Set PG_BIN to PostgreSQL 17 binaries}"
WORK="$(mktemp -d "${FEE_REDEMPTION_SCRATCH:?Set an external SSD scratch path on macOS}/fee-redemption.XXXXXX")"
FIXTURE="$ROOT/scripts/ci/fixtures/player-fee-redemption"
cleanup() {
  "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
"$PG_BIN/initdb" -D "$WORK/data" -U fee_test -A trust --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/postgres.log" \
  -o "-k $WORK -c listen_addresses=''" -w start >/dev/null
PSQL=("$PG_BIN/psql" -X -q -h "$WORK" -U fee_test -d postgres -v ON_ERROR_STOP=1)
"${PSQL[@]}" -f "$FIXTURE/fee-redemption-schema.sql" -f "$FIXTURE/fee-redemption-source-functions.sql"
# The regression must demonstrably fail on the captured pre-fix reader.
if "${PSQL[@]}" -c "DO \$\$ BEGIN ASSERT (SELECT cash_fees FROM ca_club_member_fee_totals('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',null,null,'69f2cefa-017d-49f3-ac3e-61505633747c'))=373.06, 'redemption missing'; END \$\$;" > "$WORK/before.log" 2>&1; then
  echo 'FAIL: regression unexpectedly passed before the migration' >&2
  exit 1
fi
grep -q 'redemption missing' "$WORK/before.log"
MIGRATIONS=("$ROOT"/supabase/migrations/*_player_fee_redemption_reaches_metrics_and_statistics.sql)
test "${#MIGRATIONS[@]}" = 1
test -f "${MIGRATIONS[0]}"
"${PSQL[@]}" -f "${MIGRATIONS[0]}" -f "$FIXTURE/fee-redemption-assert.sql"
echo 'PASS: regression fails before and passes after; fixed redemption, repeated reads, date, player, club, asset, gross evidence, grants, duplicate operation and future fees'
