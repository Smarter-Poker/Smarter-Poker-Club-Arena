#!/usr/bin/env bash
# fn_horse_river_one_pair_calls agrees with HoldemLiveMeasure.riverOnePairCalls
# on the same fixture hands, in a throwaway local Postgres.
#
#   PG_BIN=/usr/lib/postgresql/16/bin bash scripts/dev/test-horse-river-one-pair-calls.sh
#
# The fixture hands are generated ONCE by server/scripts/river-one-pair-fixture.ts
# (the TypeScript side computes the expected cells from the pure module), loaded
# into a minimal horse_hand_reviews, and the SQL function's answer must equal
# the TypeScript answer cell for cell. A disagreement between the two readers
# of the same hand is the regression this exists to catch.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# initdb refuses root; a root shell (CI containers, cloud sessions) re-enters
# as the unprivileged postgres user with a writable HOME for npm's cache.
if [ "$(id -u)" = 0 ] && id postgres >/dev/null 2>&1; then
  home=$(mktemp -d "${TMPDIR:-/tmp}/river-one-pair-home.XXXXXX"); chown postgres "$home"
  exec su postgres -s /bin/bash -c "cd '$root' && HOME='$home' TMPDIR='${TMPDIR:-/tmp}' PG_BIN='${PG_BIN:-}' RIVER_ONE_PAIR_PORT='${RIVER_ONE_PAIR_PORT:-}' bash '$root/scripts/dev/test-horse-river-one-pair-calls.sh'"
fi
pgbin=${PG_BIN:-}
[ -n "$pgbin" ] || pgbin=/opt/homebrew/opt/postgresql@17/bin
[ -x "$pgbin/initdb" ] || { for c in /usr/lib/postgresql/17/bin /usr/lib/postgresql/16/bin; do [ -x "$c/initdb" ] && pgbin=$c && break; done; }
[ -x "$pgbin/initdb" ] || { echo "FAIL: no initdb under PG_BIN=$pgbin"; exit 1; }
port=${RIVER_ONE_PAIR_PORT:-}
[ -n "$port" ] || port=55571
fixture=$(mktemp -d "${TMPDIR:-/tmp}/river-one-pair.XXXXXX")
cleanup() {
  "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT

"$pgbin/initdb" -D "$fixture/data" -A trust -U postgres >/dev/null
mkdir -p "$fixture/socket"
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -w -o "-k $fixture/socket -p $port -h ''" start >/dev/null
PSQL=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p "$port" -U postgres -d postgres)

# The TypeScript side writes the fixture rows and its own expected answer.
cd "$root/server"
npx tsx scripts/river-one-pair-fixture.ts "$fixture/rows.json" "$fixture/expected.json"
cd "$root"

"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.horse_hand_reviews (
  id bigserial PRIMARY KEY,
  played_at timestamptz NOT NULL DEFAULT now(),
  game_variant text,
  horse_user_id uuid NOT NULL,
  net_bb numeric,
  hole_cards jsonb,
  board jsonb,
  actions jsonb
);
SQL
"${PSQL[@]}" -f "$root/supabase/migrations/20261031024652_horse_river_one_pair_calls_by_size_class.sql"

# Load the fixture rows (one JSON array) through a staging column.
"${PSQL[@]}" -v rows="$(cat "$fixture/rows.json")" <<'SQL'
INSERT INTO public.horse_hand_reviews (played_at, game_variant, horse_user_id, net_bb, hole_cards, board, actions)
SELECT now() - (ordinality || ' seconds')::interval, r->>'game_variant', (r->>'horse_user_id')::uuid,
       (r->>'net_bb')::numeric, r->'hole_cards', r->'board', r->'actions'
FROM jsonb_array_elements(:'rows'::jsonb) WITH ORDINALITY AS t(r, ordinality);
SQL

actual=$("${PSQL[@]}" -At -c "SELECT public.fn_horse_river_one_pair_calls(now() - interval '1 hour', 20000)")
python3 - "$fixture/expected.json" "$actual" <<'PY'
import json, sys
expected = json.load(open(sys.argv[1]))
actual = json.loads(sys.argv[2])
cells = {c["sizeClass"]: (c["calls"], c["won"]) for c in actual["cells"]}
want = {c["sizeClass"]: (c["calls"], c["won"]) for c in expected["cells"]}
problems = []
if cells != want: problems.append(f"cells differ: sql={cells} ts={want}")
if actual["consideredRows"] != expected["consideredRows"]: problems.append(f"considered differ: sql={actual['consideredRows']} ts={expected['consideredRows']}")
if actual["unreadableRows"] != expected["unreadableRows"]: problems.append(f"unreadable differ: sql={actual['unreadableRows']} ts={expected['unreadableRows']}")
if actual.get("schema") != "horse-river-one-pair-calls/v1": problems.append("schema missing")
if "20bb" not in actual.get("caveat", ""): problems.append("caveat missing")
if problems:
    print("FAIL: " + "; ".join(problems)); sys.exit(1)
print(f"PASS: SQL and TypeScript agree on {expected['consideredRows']} readable fixture hands: {cells}")
PY

# Privileges and bounds: service_role only; anon/authenticated refused; bounds enforced.
"${PSQL[@]}" <<'SQL'
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_horse_river_one_pair_calls(timestamptz, integer)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL: anon may execute'; END IF;
  IF has_function_privilege('authenticated', 'public.fn_horse_river_one_pair_calls(timestamptz, integer)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL: authenticated may execute'; END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_horse_river_one_pair_calls(timestamptz, integer)', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL: service_role may not execute'; END IF;
  BEGIN
    PERFORM public.fn_horse_river_one_pair_calls(now() - interval '15 days', 10);
    RAISE EXCEPTION 'FAIL: 15-day window accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%14 days%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.fn_horse_river_one_pair_calls(now() - interval '1 hour', 20001);
    RAISE EXCEPTION 'FAIL: limit 20001 accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%1..20000%' THEN RAISE; END IF;
  END;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.fn_horse_river_one_pair_calls(timestamptz, integer)'::regprocedure) <> 's' THEN RAISE EXCEPTION 'FAIL: not STABLE'; END IF;
  RAISE NOTICE 'PASS: privileges, bounds and volatility';
END $$;
SQL
echo "PASS: fn_horse_river_one_pair_calls qualified"
