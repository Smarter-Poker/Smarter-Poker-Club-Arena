#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  A DIAMOND CASH HAND SETTLES WITH THE RAKE FACTS THE ENGINE NOW SENDS
# ═══════════════════════════════════════════════════════════════════════════
#
# Private Unix-socket PostgreSQL 17, created and destroyed by this script.
# Accepts no database URL, reads no environment connection settings and
# touches nothing outside its own temporary directory, so it can never reach
# production. It extracts fn_poker_diamond_settle_cash_hand VERBATIM from the
# applied migration rather than keeping a second copy of it here, then drives
# roster payloads of exactly the shape the engine builds through it.
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
BIN="${POKER_AUDIT_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIX="$ROOT/scripts/dev/fixtures/diamond-cash-rake-facts"
MIG="$ROOT/supabase/migrations/20261005183028_diamond_cash_rake_reads_the_owner_settings.sql"
PORT=55471
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ca-diamond-rake-facts.XXXXXX")"
cleanup() {
  "$BIN/pg_ctl" -D "$TMP/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

[ -f "$MIG" ] || { echo "missing migration: $MIG" >&2; exit 2; }
"$BIN/postgres" --version | grep -q ' 17\.' || { echo "PostgreSQL 17 required" >&2; exit 2; }

# THE SETTLER UNDER TEST IS THE ONE THAT IS APPLIED. One definition in the
# migration, one range here; a second CREATE of the same function in that file
# would make this ambiguous, so refuse rather than guess.
starts="$(grep -c '^CREATE OR REPLACE FUNCTION public\.fn_poker_diamond_settle_cash_hand(' "$MIG")"
[ "$starts" = "1" ] || { echo "expected exactly one settler definition, found $starts" >&2; exit 2; }
awk '/^CREATE OR REPLACE FUNCTION public\.fn_poker_diamond_settle_cash_hand\(/{f=1}
     f{print}
     f&&/^END \$function\$;$/{exit}' "$MIG" > "$TMP/settler.sql"
grep -q 'diamond_cash_rake_facts_required' "$TMP/settler.sql" \
  || { echo "the extracted settler does not carry the facts contract" >&2; exit 2; }
grep -q '^END \$function\$;$' "$TMP/settler.sql" \
  || { echo "the extracted settler is truncated" >&2; exit 2; }

"$BIN/initdb" -D "$TMP/data" -U postgres -A trust --locale=en_US.UTF-8 >"$TMP/initdb.log"
mkdir -p "$TMP/sock"
"$BIN/pg_ctl" -D "$TMP/data" \
  -o "-k $TMP/sock -c listen_addresses='' -p $PORT -c fsync=off" \
  -l "$TMP/pg.log" -w start >/dev/null
"$BIN/createdb" -h "$TMP/sock" -p "$PORT" -U postgres ca_diamond_rake_facts

# One session: the fixture's pg_temp helpers have to outlive the bootstrap.
"$BIN/psql" -h "$TMP/sock" -p "$PORT" -U postgres -d ca_diamond_rake_facts \
  -X -q -v ON_ERROR_STOP=1 \
  -f "$FIX/bootstrap.sql" -f "$TMP/settler.sql" -f "$FIX/scenarios.sql"
