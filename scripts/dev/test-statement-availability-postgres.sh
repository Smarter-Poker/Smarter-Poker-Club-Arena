#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
scratch_parent="${UNION_OPS_PG_SCRATCH_PARENT:-/Volumes/SmarterWork/agent-work}"

[[ -x "$pgbin/initdb" && -x "$pgbin/postgres" ]] || {
  echo 'PostgreSQL 17 tools unavailable; set PG17_BINDIR.' >&2; exit 2;
}
[[ -d "$scratch_parent" ]] || { echo "Statement PostgreSQL scratch parent is unavailable: $scratch_parent" >&2; exit 2; }
"$pgbin/postgres" --version | grep -Eq ' 17\.' || {
  echo 'PostgreSQL 17 is required.' >&2; exit 2;
}

work="$(mktemp -d "$scratch_parent/stmt.XXXXXX")"
data="$work/data"
socket="$work/socket"
port="$((56000 + ($$ % 7000)))"
mkdir -p "$socket"
cleanup() {
  "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true
  [[ "$work" == "$scratch_parent"/stmt.* ]] && find "$work" -depth -delete
}
trap cleanup EXIT

"$pgbin/initdb" -D "$data" -U postgres --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U postgres -d postgres)
"${psql[@]}" -c 'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;'
"${psql[@]}" -f "$repo/tests/fixtures/union-statement-availability/bootstrap.sql" -f "$repo/supabase/migrations/20260907212347_union_statement_reports_identify_missing_accounting_snapshots.sql" -f "$repo/tests/fixtures/union-statement-availability/before.sql" -f "$repo/supabase/migrations/20261018170308_union_statements_distinguish_missing_legacy_payment_details.sql" -f "$repo/tests/fixtures/union-statement-availability/after.sql"
if "${psql[@]}" -f "$repo/supabase/migrations/20261018170308_union_statements_distinguish_missing_legacy_payment_details.sql" >"$work/replay.log" 2>&1; then echo 'Replay was not refused' >&2; exit 1; fi
grep -q 'Statement availability already installed' "$work/replay.log"
"${psql[@]}" -f "$repo/tests/fixtures/union-statement-availability/bomb-bootstrap.sql" -f "$repo/tests/fixtures/union-statement-availability/bomb-readers-before.sql" -f "$repo/tests/fixtures/union-statement-availability/bomb-before.sql" -f "$repo/supabase/migrations/20261018171801_bomb_pot_reports_bound_their_hosted_club_scan_and_utc_calend.sql" -f "$repo/tests/fixtures/union-statement-availability/bomb-after.sql"
if "${psql[@]}" -f "$repo/supabase/migrations/20261018171801_bomb_pot_reports_bound_their_hosted_club_scan_and_utc_calend.sql" >"$work/bomb-replay.log" 2>&1; then echo 'Bomb patch replay allowed' >&2; exit 1; fi
grep -q 'Bomb report source changed' "$work/bomb-replay.log"
echo 'Statement availability PostgreSQL17 fail-before/pass-after, source preservation, authorization and replay refusal passed.'
