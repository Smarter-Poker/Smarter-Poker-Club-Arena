#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
scratch_parent="${DATA_CONSOLE_PG_SCRATCH_PARENT:-${STATS_PG_SCRATCH_PARENT:-/Volumes/SmarterWork/agent-work}}"
fixture="$repo/tests/fixtures/financial-admin-revenue"
migration="$repo/supabase/migrations/20261004130932_financial_admin_revenue_reads_complete_daily_ledger.sql"

[[ -x "$pgbin/initdb" && -x "$pgbin/postgres" && -x "$pgbin/psql" ]] || {
  echo 'PostgreSQL 17 tools unavailable; set PG17_BINDIR.' >&2
  exit 2
}
"$pgbin/postgres" --version | grep -Eq ' 17\.' || {
  echo 'PostgreSQL 17 is required.' >&2
  exit 2
}
[[ -d "$scratch_parent" ]] || {
  echo "Data console PostgreSQL scratch parent is unavailable: $scratch_parent" >&2
  exit 2
}

work="$(mktemp -d "$scratch_parent/financial-admin-revenue.XXXXXX")"
data="$work/data"
socket="$work/socket"
port="$((57000 + ($$ % 7000)))"
mkdir -p "$socket"
cleanup() {
  "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true
  [[ "$work" == "$scratch_parent"/financial-admin-revenue.* ]] && find "$work" -depth -delete
}
trap cleanup EXIT

"$pgbin/initdb" -D "$data" -U fixture_admin --auth-local=trust --auth-host=reject --no-locale -E UTF8 \
  -c shared_memory_type=mmap >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U fixture_admin -d postgres \
  -f "$fixture/bootstrap.sql" -f "$migration" -f "$fixture/assertions.sql"
