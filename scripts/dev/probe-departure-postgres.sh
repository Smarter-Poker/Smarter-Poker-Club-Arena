#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${PGBIN:-}" ]]; then
  if [[ -x /opt/homebrew/opt/postgresql@17/bin/initdb ]]; then
    PGBIN=/opt/homebrew/opt/postgresql@17/bin
  elif [[ -x /usr/lib/postgresql/17/bin/initdb ]]; then
    PGBIN=/usr/lib/postgresql/17/bin
  else
    echo "PostgreSQL 17 tools are required; set PGBIN to their bin directory." >&2
    exit 1
  fi
fi
case "$("$PGBIN/postgres" --version)" in
  "postgres (PostgreSQL) 17."*) ;;
  *) echo "The accounting contract suite requires PostgreSQL 17." >&2; exit 1 ;;
esac
test -x "$PGBIN/initdb"
test -x "$PGBIN/psql"
# Homebrew may place support files inside the keg rather than the compiled path.
departure_share="$("$PGBIN/pg_config" --sharedir)"
if [[ ! -f "$departure_share/postgres.bki" && -f "$PGBIN/../share/postgresql/postgres.bki" ]]; then
  departure_share="$PGBIN/../share/postgresql"
fi
test -f "$departure_share/postgres.bki"
departure_root="$(node -p 'require("node:os").tmpdir()')"
departure_tmp="$(mktemp -d "$departure_root/ca-departure.XXXXXX")"
cleanup() {
  "$PGBIN/pg_ctl" -D "$departure_tmp/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$departure_tmp"
}
trap cleanup EXIT
mkdir "$departure_tmp/socket"
"$PGBIN/initdb" -L "$departure_share" -D "$departure_tmp/data" -U departure_test -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$departure_tmp/data" -l "$departure_tmp/postgres.log" \
  -o "-h '' -k '$departure_tmp/socket' -p 55443" -w start >/dev/null
export CA_DEPARTURE_PG_HOST="$departure_tmp/socket" CA_DEPARTURE_PSQL="$PGBIN/psql"
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-postgres.sql" >/dev/null
python3 - "$repo" > "$departure_tmp/functions.sql" <<'PY'
import re,sys
from pathlib import Path
root=Path(sys.argv[1])/'supabase/migrations'
for file,name in [
 ('20260906152756_a_seat_cashout_locks_the_game_before_the_seat.sql','atomic_seat_cashout_locked')]:
 text=(root/file).read_text()
 pattern=r'CREATE OR REPLACE FUNCTION public\.'+name+r'\([\s\S]*?\$function\$[\s\S]*?\$function\$;'
 matches=re.findall(pattern,text)
 if len(matches)!=1: raise RuntimeError('Expected exactly one pinned declaration: '+name)
 print(matches[0])
PY
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$departure_tmp/functions.sql" >/dev/null
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-credit-function.sql" >/dev/null
# Execute the complete migration, including permissions and baseline guards,
# twice to prove replay safety, rather than only extracting its function body.
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260908211251_cashout_rejects_invalid_money_before_any_write.sql" >/dev/null
done
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-expiry-function.sql" >/dev/null
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260908214235_seat_expiry_follows_cashout_lock_order.sql" >/dev/null
done
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260908220604_bind_cashout_requests_to_seat_occupancy.sql" >/dev/null
done
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-closing-functions.sql" >/dev/null
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260909024909_table_close_requires_every_occupancy_cashout_to_commit.sql" >/dev/null
done
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-admin-function.sql" >/dev/null

for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260909031958_club_credit_requires_an_actual_destination_wallet_write.sql" >/dev/null
done
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260909040806_admin_departure_authority_is_recorded_before_cashout.sql" >/dev/null
done


"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-game-contract-function.sql" >/dev/null
# Seed old empty and occupied parents before the additive ownership migration.
# Optional scale matches the read-only production inventory without copying data.
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres <<'SQL' >/dev/null
INSERT INTO tables(id) VALUES('77777777-7777-4777-8777-777777777777');
INSERT INTO tables(id,cluster_id) VALUES('88888888-8888-4888-8888-888888888888','99999999-9999-4999-8999-999999999999');
INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at)
VALUES(gen_random_uuid(),'88888888-8888-4888-8888-888888888888','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',1,25,now());
SQL
if [[ "${CA_SCOPE_SCALE:-0}" = 1 ]]; then
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres <<'SQL' >/dev/null
INSERT INTO tables(id) SELECT gen_random_uuid() FROM generate_series(1,203449);
WITH parents AS (
 SELECT id,row_number() OVER(ORDER BY id) AS ordinal FROM tables
 WHERE id NOT IN ('77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888')
)
INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at,left_at)
SELECT gen_random_uuid(),p.id,gen_random_uuid(),((g.n-1)%6)+1,0,now(),now()
FROM generate_series(1,471875) AS g(n) JOIN parents p ON p.ordinal=((g.n-1)/6)+1;
ANALYZE tables; ANALYZE table_seats;
SQL
fi

# A pre-existing trigger must not silently mutate chips during the backfill.
if "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -c "SET test.scope_backfill_corruption='on'" \
  -f "$repo/supabase/migrations/20260909052547_one_committed_cash_game_seat_per_player.sql" \
  >"$departure_tmp/rejected-backfill.log" 2>&1; then
  echo "Backfill incorrectly accepted a trigger-induced stack change" >&2
  exit 1
fi
python3 - "$departure_tmp/rejected-backfill.log" <<'PY'
from pathlib import Path
import sys
assert 'Scope backfill changed existing game or seat data' in Path(sys.argv[1]).read_text()
PY
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres <<'SQL' >/dev/null
DO $test$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
   AND table_name='table_seats' AND column_name='active_game_scope') THEN
  RAISE EXCEPTION 'Rejected migration left a schema change behind';
 END IF;
 IF (SELECT stack FROM table_seats WHERE left_at IS NULL) <> 25 THEN
  RAISE EXCEPTION 'Rejected migration left a financial change behind';
 END IF;
END $test$;
SQL

departure_scope_started=$SECONDS
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260909052547_one_committed_cash_game_seat_per_player.sql" >/dev/null
done

printf 'Ownership migration replay elapsed: %ss\n' "$((SECONDS-departure_scope_started))"
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres <<'SQL' >/dev/null
DO $test$
BEGIN
 IF (SELECT seat_game_scope FROM tables WHERE id='77777777-7777-4777-8777-777777777777') IS NOT NULL THEN
  RAISE EXCEPTION 'Historical empty parent was unnecessarily backfilled';
 END IF;
 IF (SELECT active_game_scope FROM table_seats WHERE left_at IS NULL) <> 'cluster:99999999-9999-4999-8999-999999999999' THEN
  RAISE EXCEPTION 'Occupied parent/child was not backfilled';
 END IF;
END $test$;
INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,joined_at)
VALUES(gen_random_uuid(),'77777777-7777-4777-8777-777777777777','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',1,25,now());
DO $test$
BEGIN
 IF (SELECT seat_game_scope FROM tables WHERE id='77777777-7777-4777-8777-777777777777') <> 'table:77777777-7777-4777-8777-777777777777' THEN
  RAISE EXCEPTION 'First admission did not initialize its old empty parent';
 END IF;
END $test$;
SQL

"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-cluster-function.sql" >/dev/null
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -c "REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid,integer) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid,integer) TO service_role" >/dev/null
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260909054702_retire_cluster_duplicate_chair_cashouts_after_native_ownership.sql" >/dev/null
done

"$PGBIN/psql" -X -qAt -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -c "SELECT json_agg(json_build_object('name',conname,'definition',pg_get_constraintdef(oid))) FROM pg_constraint WHERE conname IN ('table_game_scope_is_derived','table_game_scope_parent_key','active_seat_requires_game_scope','active_seat_game_scope_parent','one_committed_seat_per_game_player')"

"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-clear-seat-function.sql" >/dev/null

"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-managed-close-function.sql" >/dev/null

"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -c "INSERT INTO tables(id,is_template) VALUES('66666666-6666-4666-8666-666666666666',false),('55555555-5555-4555-8555-555555555555',true)" >/dev/null
if "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -c "SET test.admission_backfill_corruption='on'" \
  -f "$repo/supabase/migrations/20260909062236_terminal_tables_cannot_commit_live_occupancies.sql" \
  >"$departure_tmp/rejected-admission-backfill.log" 2>&1; then
  echo "Admission backfill incorrectly accepted a trigger-induced stack change" >&2
  exit 1
fi
python3 - "$departure_tmp/rejected-admission-backfill.log" <<'PY'
from pathlib import Path
import sys
assert 'Admission backfill changed existing game or seat data' in Path(sys.argv[1]).read_text()
PY
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres <<'SQL' >/dev/null
DO $test$
BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
   AND table_name='table_seats' AND column_name='active_parent_key') THEN
  RAISE EXCEPTION 'Rejected admission migration left schema behind';
 END IF;
 IF (SELECT sum(stack) FROM table_seats WHERE left_at IS NULL) <> 50 THEN
  RAISE EXCEPTION 'Rejected admission migration left financial changes behind';
 END IF;
 IF md5(pg_get_functiondef('public.fn_clear_table_seats(uuid,boolean)'::regprocedure))
   <> '1383315f595906d6f1b77190355c4c7b' THEN
  RAISE EXCEPTION 'Rejected admission migration left a function replacement behind';
 END IF;
END $test$;
SQL
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260909062236_terminal_tables_cannot_commit_live_occupancies.sql" >/dev/null
done

"$PGBIN/psql" -X -qAt -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -c "SELECT json_agg(json_build_object('name',conname,'definition',pg_get_constraintdef(oid))) FROM pg_constraint WHERE conname IN ('table_seat_admission_is_derived','table_seat_admission_parent_key','active_seat_requires_open_parent','live_seat_parent_cannot_close')"


"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres <<'SQL' >/dev/null
DO $test$
BEGIN
 IF EXISTS(SELECT 1 FROM tables WHERE id IN ('66666666-6666-4666-8666-666666666666','55555555-5555-4555-8555-555555555555')
   AND seat_admission_key IS NOT NULL) THEN
  RAISE EXCEPTION 'Admission migration unnecessarily backfilled old empty parents';
 END IF;
 INSERT INTO table_seats(id,table_id,user_id,seat_number,stack)
 VALUES(gen_random_uuid(),'66666666-6666-4666-8666-666666666666','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',1,10);
 IF (SELECT seat_admission_key FROM tables WHERE id='66666666-6666-4666-8666-666666666666') <> 'cash' THEN
  RAISE EXCEPTION 'First admission did not atomically initialize its old parent';
 END IF;
 BEGIN
  INSERT INTO table_seats(id,table_id,user_id,seat_number,stack)
  VALUES(gen_random_uuid(),'55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',1,10);
  RAISE EXCEPTION 'Old saved template accepted a seat';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM NOT LIKE '%CLOSED_TABLE_REJECTS_ACTIVE_SEAT%' THEN RAISE; END IF;
 END;
 IF (SELECT seat_admission_key FROM tables WHERE id='55555555-5555-4555-8555-555555555555') IS NOT NULL THEN
  RAISE EXCEPTION 'Failed template admission did not roll back its parent initialization';
 END IF;
END $test$;
SQL

for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260909072021_retain_original_admin_departure_outcomes.sql" >/dev/null
done

"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-seat-move-schema.sql" >/dev/null
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-seat-move-functions.sql" >/dev/null

"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres <<'SQL' >/dev/null
INSERT INTO cash_games(id) VALUES('99999999-9999-4999-8999-999999999999');
INSERT INTO cash_seat_moves(id,game_id,player_id,from_table_id,to_table_id,reason,expires_at)
VALUES('12121212-1212-4212-8212-121212121212','99999999-9999-4999-8999-999999999999',
 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','88888888-8888-4888-8888-888888888888',
 '66666666-6666-4666-8666-666666666666','must_move',now()+interval '5 minutes');
SQL
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260909074353_bind_cash_seat_moves_to_original_occupancies.sql" >/dev/null
done
"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres <<'SQL' >/dev/null
DO $proof$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM cash_seat_moves WHERE id='12121212-1212-4212-8212-121212121212'
   AND state='cancelled' AND source_occupancy_id IS NULL AND note='original_occupancy_not_recorded')
 OR EXISTS(SELECT 1 FROM cash_seat_move_receipts) THEN
  RAISE EXCEPTION 'Unbound historical plan was not retired without invented evidence';
 END IF;
END $proof$;
SQL


"$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -f "$repo/scripts/dev/fixtures/departure-legacy-cashout-alias.sql" >/dev/null
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/scripts/deploy/phase-two-retire-unbound-cashout.sql" >/dev/null
done

"$PGBIN/postgres" --version
"$PGBIN/psql" -X -qAt -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -c "SELECT proname, md5(pg_get_functiondef(oid)) FROM pg_proc WHERE proname IN ('atomic_seat_cashout_locked','atomic_credit_wallet_and_log','player_leave_table') ORDER BY proname"
cd "$repo/server"
npx vitest run src/engine/CashoutDeparturePostgres.test.ts
