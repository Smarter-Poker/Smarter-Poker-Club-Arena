#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
work="$(mktemp -d /Volumes/SmarterWork/agent-work/stats-evidence-session.XXXXXX)"; data="$work/data"; socket="$work/socket"; port="$((57000+($$%6000)))"; mkdir -p "$socket"
cleanup(){ "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1||true; find "$work" -depth -delete; };trap cleanup EXIT
"$pgbin/initdb" -D "$data" -U fixture_admin --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U fixture_admin -d postgres \
  -f "$repo/tests/fixtures/stats-evidence-session/bootstrap.sql" \
  -f "$repo/supabase/migrations/20261003142631_stats_hand_evidence_cash_session.sql" \
  -f "$repo/tests/fixtures/stats-evidence-session/assertions.sql"
