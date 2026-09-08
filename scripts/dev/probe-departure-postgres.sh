#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
test -x "$PGBIN/initdb"
test -x "$PGBIN/psql"
departure_root="$(node -p 'require("node:os").tmpdir()')"
departure_tmp="$(mktemp -d "$departure_root/ca-departure.XXXXXX")"
cleanup() {
  "$PGBIN/pg_ctl" -D "$departure_tmp/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$departure_tmp"
}
trap cleanup EXIT
mkdir "$departure_tmp/socket"
"$PGBIN/initdb" -D "$departure_tmp/data" -U departure_test -A trust --no-locale -E UTF8 >/dev/null
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
"$PGBIN/postgres" --version
"$PGBIN/psql" -X -qAt -v ON_ERROR_STOP=1 -h "$departure_tmp/socket" -p 55443 -U departure_test \
  -d postgres -c "SELECT proname, md5(pg_get_functiondef(oid)) FROM pg_proc WHERE proname IN ('atomic_seat_cashout_locked','atomic_credit_wallet_and_log') ORDER BY proname"
cd "$repo/server"
npx vitest run src/engine/CashoutDeparturePostgres.test.ts
