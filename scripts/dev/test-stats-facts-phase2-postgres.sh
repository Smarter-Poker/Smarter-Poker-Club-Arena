#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
migration="$repo/supabase/migrations/20261003134650_stats_facts_outbox_and_corrections.sql"
fixture="$repo/tests/fixtures/stats-facts-phase2"
"$pgbin/postgres" --version | grep -Eq ' 17\.' || { echo 'PostgreSQL 17 required' >&2; exit 2; }
work_root="${RUNNER_TEMP:-/Volumes/SmarterWork/agent-work}"
work="$(mktemp -d "$work_root/stats-facts-phase2.XXXXXX")"
data="$work/data"; socket="$work/socket"; port="$((57000 + ($$ % 7000)))"; mkdir -p "$socket"
cleanup(){ "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true; find "$work" -depth -delete; }
trap cleanup EXIT
"$pgbin/initdb" -D "$data" -U postgres --auth-local=trust --auth-host=reject --no-locale -E UTF8 \
  -c shared_memory_type=mmap >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
sed -n '/-- A revision is one serialized operation/,/-- These triggers were replaced/p' \
  "$repo/supabase/migrations/20261004122156_keep_voided_stats_and_nullable_session_closes_honest.sql" \
  > "$work/revision-repair.sql"
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U postgres -d postgres \
  -f "$fixture/bootstrap.sql" -f "$migration" -f "$work/revision-repair.sql" \
  -f "$fixture/assertions.sql"
