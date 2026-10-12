#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
scratch_parent="${VIP_POINTS_PG_SCRATCH_PARENT:-/Volumes/SmarterWork/agent-work}"
migration="$repo/supabase/migrations/20261012063724_retire_unauthorized_vip_points.sql"
fixture="$repo/tests/fixtures/retired-vip-points"

[[ -x "$pgbin/initdb" && -x "$pgbin/postgres" ]] || {
  echo 'PostgreSQL 17 tools unavailable; set PG17_BINDIR.' >&2; exit 2;
}
[[ -d "$scratch_parent" ]] || { echo "VIP points PostgreSQL scratch parent is unavailable: $scratch_parent" >&2; exit 2; }

work="$(mktemp -d "$scratch_parent/retired-vip-points-fixture.XXXXXX")"
data="$work/data"
socket="$work/socket"
port="$((57000 + ($$ % 7000)))"
mkdir -p "$socket"
cleanup() {
  "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true
  [[ "$work" == "$scratch_parent"/retired-vip-points-fixture.* ]] && find "$work" -depth -delete
}
trap cleanup EXIT

"$pgbin/initdb" -D "$data" -U postgres --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U postgres -d postgres)
"${psql[@]}" -f "$fixture/bootstrap.sql" -f "$migration" -f "$fixture/assertions.sql"
