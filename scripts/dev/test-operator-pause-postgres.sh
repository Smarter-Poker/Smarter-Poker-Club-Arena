#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
parent="${OPERATOR_HOLD_PG_SCRATCH_PARENT:-/Volumes/SmarterWork/agent-work}"
[[ -d "$parent" ]] || exit 2
work="$(mktemp -d "$parent/operator-hold.XXXXXX")"
mkdir -p "$work/socket"
port="$((58000 + ($$ % 5000)))"
cleanup() { "$pgbin/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true; find "$work" -depth -delete; }
trap cleanup EXIT
"$pgbin/initdb" -D "$work/data" -U fixture_admin --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$work/data" -l "$work/postgres.log" -o "-h '' -k '$work/socket' -p $port -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap" -w start >/dev/null || { cat "$work/postgres.log"; exit 1; }
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$work/socket" -p "$port" -U fixture_admin -d postgres -f "$repo/tests/fixtures/operator-pause/bootstrap.sql" -f "$repo/tests/fixtures/operator-pause/managed-games-preimage.sql" -f "$repo/tests/fixtures/operator-pause/management-event-preimage.sql" -f "$repo/supabase/migrations/20261007154739_an_operator_pause_survives_its_engine.sql"
OPERATOR_HOLD_PG_HOST="$work/socket" OPERATOR_HOLD_PG_PORT="$port" node --test "$repo/tests/fixtures/operator-pause/native.test.mjs"
