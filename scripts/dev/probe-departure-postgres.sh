#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
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
    -d postgres -f "$repo/supabase/migrations/20260909031204_retire_direct_browser_cashout_after_occupancy_adoption.sql" >/dev/null
done
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260909031958_club_credit_requires_an_actual_destination_wallet_write.sql" >/dev/null
done
for departure_apply in 1 2; do
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
    -d postgres -f "$repo/supabase/migrations/20260909040806_admin_departure_authority_is_recorded_before_cashout.sql" >/dev/null
done
"$PGBIN/postgres" --version
"$PGBIN/psql" -X -qAt -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -c "SELECT proname, md5(pg_get_functiondef(oid)) FROM pg_proc WHERE proname IN ('atomic_seat_cashout_locked','atomic_credit_wallet_and_log','player_leave_table') ORDER BY proname"
cd "$repo/server"
npx vitest run src/engine/CashoutDeparturePostgres.test.ts
