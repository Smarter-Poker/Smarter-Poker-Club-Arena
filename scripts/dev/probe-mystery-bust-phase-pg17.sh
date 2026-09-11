#!/usr/bin/env bash
# Rehearse 20260911094503_a_bust_belongs_to_the_phase_its_hand_was_played_in
# on a throwaway local PostgreSQL 17 cluster (unix socket only, no database URL
# accepted, removed afterwards). Loads production table SHAPES and the captured
# live function bodies, proves the defect BEFORE the migration, applies it, proves
# the fix AFTER, and re-applies it to prove idempotence.
#   POKER_AUDIT_PG_BIN may point at a PG17 bin dir (default: Homebrew postgresql@17).
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
BIN="${POKER_AUDIT_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIX="$ROOT/scripts/dev/fixtures/mystery-bust-phase"
MIG="$ROOT/supabase/migrations/20260911094503_a_bust_belongs_to_the_phase_its_hand_was_played_in.sql"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mystery-bust-phase.XXXXXX")"
PORT=55433
cleanup() { "$BIN/pg_ctl" -D "$TMP/data" -m fast -w stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$BIN/postgres" --version | grep -q ' 17\.' || { echo "need PostgreSQL 17 in $BIN" >&2; exit 2; }
"$BIN/initdb" -D "$TMP/data" -U postgres -A trust --locale=en_US.UTF-8 >"$TMP/initdb.log"
mkdir -p "$TMP/sock"
"$BIN/pg_ctl" -D "$TMP/data" -o "-k $TMP/sock -c listen_addresses='' -p $PORT -c fsync=off" -l "$TMP/pg.log" -w start >/dev/null
P() { "$BIN/psql" -h "$TMP/sock" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
P -f "$FIX/schema.sql" >/dev/null
P -f "$FIX/functions.sql" >/dev/null
P -f "$FIX/helpers.sql" >/dev/null
echo "== before (captured live bodies)"; P -f "$FIX/scenarios_before.sql" 2>&1 | sed -n 's/.*NOTICE:  //p' | cut -c1-140
echo "== migration"; P -f "$MIG"
echo "== after"; P -f "$FIX/scenarios_after.sql" 2>&1 | sed -n 's/.*NOTICE:  //p' | cut -c1-140
echo "== re-apply (idempotent)"; P -f "$MIG"
echo "ALL PASS"
