#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG_BIN:-${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}}"
parent="${RUNNER_TEMP:-${TMPDIR:-}}"
[ -n "$parent" ] && [ -d "$parent" ] || { echo 'Owned scratch parent required'; exit 1; }
work="$(mktemp -d "$parent/member-jackpot.XXXXXX")"
cleanup() { "$pgbin/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
mkdir "$work/socket"
"$pgbin/initdb" -D "$work/data" -U fixture_admin --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$work/data" -l "$work/postgres.log" -o "-h '' -k '$work/socket' -p 57649" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p 57649 -U fixture_admin -d postgres)
fixture="$repo/tests/fixtures/member-jackpot-win-loss"
migration="$repo/supabase/migrations/20261031040028_member_win_loss_includes_paid_jackpot_shares.sql"
"${psql[@]}" -f "$fixture/bootstrap.sql"
for source in "$fixture"/*-before.sql; do "${psql[@]}" -f "$source"; done
"${psql[@]}" -c "ALTER FUNCTION public.bbj_credit_one_recipient(uuid,uuid,uuid,numeric,boolean) OWNER TO postgres"
"${psql[@]}" -f "$fixture/scenario.sql"
if "${psql[@]}" -f "$fixture/regression.sql" > "$work/before.log" 2>&1; then echo 'BBJ regression unexpectedly passed'; exit 1; fi
grep -q 'Paid jackpot missing from Win/Loss' "$work/before.log"
"${psql[@]}" -f "$migration" -f "$fixture/regression.sql"
if ! "${psql[@]}" -f "$fixture/assertions.sql" > "$work/after.log" 2>&1; then cat "$work/after.log"; exit 1; fi
cat "$work/after.log"
[ "$(grep -c 'Asynchronous notification.*jackpot_fixture_committed' "$work/after.log")" -eq 2 ]
if "${psql[@]}" -f "$migration" > "$work/replay.log" 2>&1; then echo 'Replay unexpectedly accepted'; exit 1; fi
echo 'MEMBER_JACKPOT PASS: before/after, all readers, retained ownership, DST/cutoffs, variants, access, seat/wallet, duplicate/rollback/parked, committed notifications, replay refusal'

"${psql[@]}" -f "$fixture/everyone-bootstrap.sql"
"${psql[@]}" -f "$repo/supabase/migrations/20261031044413_preserve_every_paid_jackpot_reporting_owner_and_wallet_recei.sql"
"${psql[@]}" -f "$fixture/everyone-assertions.sql"
echo 'EVERYONE_JACKPOT PASS: Main/Mini, all three recipient roles, seat/wallet, exact historical wallet receipt, display-only seed exclusion, immutable owner/variant, duplicate/rollback, six private signals'

"${psql[@]}" -f "$fixture/history-bootstrap.sql"
history="$repo/supabase/migrations/20261031053131_retain_historical_paid_jackpot_clubs_from_original_seat_occu.sql"
if "${psql[@]}" -f "$fixture/history-assertions.sql" > "$work/history-before.log" 2>&1; then echo 'Historical regression unexpectedly passed'; exit 1; fi
grep -q 'Historical seat recovery missed/duplicated or guessed ownership' "$work/history-before.log"
"${psql[@]}" -f "$history" -f "$fixture/history-assertions.sql"
# Re-running the original capture must neither overwrite nor signal/pay again.
"${psql[@]}" -f "$history" -f "$fixture/history-assertions.sql"
"${psql[@]}" <<'SQL'
DELETE FROM table_seats;
DO $$ BEGIN
 IF ca_club_member_jackpot_money('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002',NULL,NULL)<>20 THEN
  RAISE EXCEPTION 'Original seat retention changed historical winnings'; END IF;
END $$;
SQL
echo 'HISTORY_JACKPOT PASS: original occupancy, agreeing duplicates, conflicts, time bounds, missing club, seed exclusion, existing owner, immutable amounts, replay, retained witnesses and signals'
