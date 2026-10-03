#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
migration="$repo/supabase/migrations/20261003140226_stats_owner_workspace.sql"
fixture="$repo/tests/fixtures/stats-owner-workspace"

[[ -x "$pgbin/initdb" && -x "$pgbin/postgres" ]] || {
  echo 'PostgreSQL 17 tools unavailable; set PG17_BINDIR.' >&2; exit 2;
}

work="$(mktemp -d /Volumes/SmarterWork/agent-work/stats-owner-workspace-fixture.XXXXXX)"
data="$work/data"
socket="$work/socket"
port="$((57000 + ($$ % 7000)))"
mkdir -p "$socket"
cleanup() {
  "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true
  [[ "$work" == /Volumes/SmarterWork/agent-work/stats-owner-workspace-fixture.* ]] && find "$work" -depth -delete
}
trap cleanup EXIT

"$pgbin/initdb" -D "$data" -U fixture_admin --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U fixture_admin -d postgres)
"${psql[@]}" -f "$fixture/bootstrap.sql" -f "$migration" -f "$fixture/assertions.sql"
