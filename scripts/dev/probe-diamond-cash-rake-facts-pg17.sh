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
PSQL=("$BIN/psql" -h "$TMP/sock" -p "$PORT" -U postgres -d ca_diamond_rake_facts -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" \
  -f "$FIX/bootstrap.sql" -f "$TMP/settler.sql" -f "$FIX/scenarios.sql" \
  -f "$FIX/engine-scenarios.sql"

# ═══════════════════════════════════════════════════════════════════════════
#  THE ENGINE'S NUMBER AGAINST THE SETTLER'S, FOR THE SAME HAND
# ═══════════════════════════════════════════════════════════════════════════
#
# Up to here the settler has been driven with numbers this fixture computed.
# That proves the settler. It does not prove the ENGINE, which is the half
# that was missing: nothing in server/src produced a Diamond rake at all, so
# every hand declared zero and every raked hand refused.
#
# So the pass below takes the hands in public.ca_probe_scenario, hands their
# FACTS to the server's own pricer - server/src/domain/diamondCashRakeSchedule.ts,
# the same module HandController prices a live hand with - over the very
# economics rows this database holds, and submits each hand to the settler at
# whatever number the engine returned. The settler recomputes from those same
# rows and refuses a disagreement by name, so a hand that settles is a
# Diamond-for-Diamond agreement between the engine and the database.
#
# The engine runs as a separate process because it is TypeScript. It reads one
# JSON document on stdin, writes one on stdout, opens no socket and reads no
# environment.
"${PSQL[@]}" -At -o "$TMP/engine-input.json" -c "
  SELECT jsonb_build_object(
    'rows', (SELECT jsonb_agg(jsonb_build_object(
               'name', name, 'scope', scope, 'value', value, 'value_text', value_text,
               'recorded_at', recorded_at, 'id', id))
               FROM public.ca_diamond_economics),
    'scenarios', (SELECT jsonb_agg(jsonb_build_object(
               'label', label, 'bb', bb, 'saw_flop', saw_flop,
               'pot', (SELECT COALESCE(sum(c),0) FROM unnest(contributed) c),
               'dealt', (SELECT count(*) FROM unnest(dealt_in) d WHERE d)))
               FROM public.ca_probe_scenario))"
[ -s "$TMP/engine-input.json" ] || { echo "no scenarios to price" >&2; exit 2; }

PRICER="$ROOT/scripts/dev/diamond-cash-rake-engine-price.ts"
[ -f "$PRICER" ] || { echo "missing engine pricer: $PRICER" >&2; exit 2; }
# The server's own dependency tree, so the module under test is the installed
# one rather than a copy. Nothing is installed or written here.
( cd "$ROOT/server" && ./node_modules/.bin/tsx "$PRICER" ) \
  < "$TMP/engine-input.json" > "$TMP/engine-output.json"
[ -s "$TMP/engine-output.json" ] || { echo "the engine priced nothing" >&2; exit 2; }

# Loaded as DATA through a psql variable, never interpolated into SQL text.
# (-c does not expand variables, so the statement goes in through -f.)
cat > "$TMP/load-engine-answers.sql" <<'LOADSQL'
\set ON_ERROR_STOP on
INSERT INTO public.ca_probe_engine_rake (label, rake)
SELECT x->>'label', (x->>'rake')::bigint
  FROM jsonb_array_elements((:'ANSWERS'::jsonb)->'prices') x;
INSERT INTO public.ca_probe_engine_reading (name, scope, value)
SELECT x->>'name', x->>'scope', (x->>'value')::numeric
  FROM jsonb_array_elements((:'ANSWERS'::jsonb)->'readings') x;
LOADSQL
"${PSQL[@]}" -v ANSWERS="$(cat "$TMP/engine-output.json")" -f "$TMP/load-engine-answers.sql"

"${PSQL[@]}" -f "$FIX/engine-agreement.sql"
