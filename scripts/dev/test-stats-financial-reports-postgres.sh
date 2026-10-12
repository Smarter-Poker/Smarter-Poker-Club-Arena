#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
scratch_parent="${STATS_PG_SCRATCH_PARENT:-/Volumes/SmarterWork/agent-work}"; [[ -d "$scratch_parent" ]] || { echo "Stats PostgreSQL scratch parent is unavailable: $scratch_parent" >&2; exit 2; }
work="$(mktemp -d "$scratch_parent/stats-financial-fixture.XXXXXX")"; data="$work/data"; socket="$work/socket"; port="$((57000+($$%6000)))"; mkdir -p "$socket"
cleanup(){ "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1||true; find "$work" -depth -delete; };trap cleanup EXIT
"$pgbin/initdb" -D "$data" -U fixture_admin --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U fixture_admin -d postgres)
"${psql[@]}" -f "$repo/tests/fixtures/stats-financial-reports/bootstrap.sql" -f "$repo/supabase/migrations/20261003141340_stats_financial_reports.sql" -f "$repo/tests/fixtures/stats-financial-reports/assertions.sql"
