#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
scratch_parent="${MANAGED_GAME_PG_SCRATCH_PARENT:-/Volumes/SmarterWork/agent-work}"
[[ -d "$scratch_parent" ]] || {
  echo "Managed-game PostgreSQL scratch parent is unavailable: $scratch_parent" >&2
  exit 2
}

work="$(mktemp -d "$scratch_parent/managed-game-one-door.XXXXXX")"
data="$work/data"
socket="$work/socket"
port="$((58000 + ($$ % 5000)))"
mkdir -p "$socket"

cleanup() {
  "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true
  find "$work" -depth -delete
}
trap cleanup EXIT

"$pgbin/initdb" -D "$data" -U fixture_admin \
  --auth-local=trust --auth-host=reject --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$data" \
  -o "-h '' -k '$socket' -p $port -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap" \
  -w start >/dev/null

psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 \
  -h "$socket" -p "$port" -U fixture_admin -d postgres)
"${psql[@]}" \
  -f "$repo/tests/fixtures/managed-game-one-door/bootstrap.sql" \
  -f "$repo/supabase/migrations/20261004195024_managed_game_browser_updates_use_command_gateway.sql" \
  -f "$repo/tests/fixtures/managed-game-one-door/assertions.sql"
