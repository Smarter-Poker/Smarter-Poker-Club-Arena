#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
migration="$repo/supabase/migrations/20261003141857_stats_operational_quality_center.sql"
retirement="$repo/supabase/migrations/20261003214510_retire_stats_fact_repair_door.sql"
fixture="$repo/tests/fixtures/stats-operational-quality"
"$pgbin/postgres" --version | grep -Eq ' 17\.' || { echo 'PostgreSQL 17 required' >&2; exit 2; }
work="$(mktemp -d /Volumes/SmarterWork/agent-work/stats-operational-quality.XXXXXX)"
data="$work/data"; socket="$work/socket"; port="$((57000 + ($$ % 7000)))"; mkdir -p "$socket"
cleanup(){ "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true; find "$work" -depth -delete; }
trap cleanup EXIT
"$pgbin/initdb" -D "$data" -U postgres --auth-local=trust --auth-host=reject --no-locale -E UTF8 \
  -c shared_memory_type=mmap >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U postgres -d postgres \
  -f "$fixture/bootstrap.sql" -f "$migration" -f "$retirement" -f "$fixture/assertions.sql"
