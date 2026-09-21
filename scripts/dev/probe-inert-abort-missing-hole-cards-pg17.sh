#!/usr/bin/env bash
# A FINANCIALLY INERT ABORT NEEDS NO HOLE CARDS - PostgreSQL 17 gate.
#
# Runs every scenario in
# scripts/dev/fixtures/a-financially-inert-abort-needs-no-hole-cards
# against byte-exact captures of the LIVE
# smarter_private.f06_retired_origin_snapshot(jsonb) and
# smarter_private.f06_retained_mtt_abort_snapshot(jsonb) (installed.sql, which
# re-derives both from the repo migrations that installed them and refuses to
# load unless md5(prosrc) of each is what kuklfnapbkmacvwxktbh reports). Then
# it applies the migration twice and runs them all again:
#
#   FIXED scenarios must FAIL on the live bodies, on a probe assertion (never
#         on a broken script), and PASS after the migration;
#   KEPT  scenarios must pass on both.
#
# Every scenario exercises BOTH functions end to end - world A reaches
# f06_retired_origin_snapshot (no lease, the retired-origin delegation) and
# world B reaches f06_retained_mtt_abort_snapshot (a stale protocol-2 lease) -
# so a repair that fixed only one of them fails here.
#
# Last it feeds the migration six kinds of drift and requires a refusal with
# the whole function catalog rolled back.
#
# A disposable cluster in a directory of its own; no database URL is accepted
# and nothing outside that directory is touched. PGDATA lives beside this
# probe's evidence; only the unix socket sits in a short temporary path,
# because a socket path is capped at ~104 bytes.
set -euo pipefail
export LC_ALL=C LANG=C PGTZ=UTC

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$repo/scripts/dev/fixtures/a-financially-inert-abort-needs-no-hole-cards"
migration="$repo/supabase/migrations/20260921023053_a_financially_inert_abort_needs_no_hole_cards.sql"

if [[ -z "${PGBIN:-}" ]]; then
  if [[ -x /opt/homebrew/opt/postgresql@17/bin/initdb ]]; then
    PGBIN=/opt/homebrew/opt/postgresql@17/bin
  elif [[ -x /usr/lib/postgresql/17/bin/initdb ]]; then
    PGBIN=/usr/lib/postgresql/17/bin
  else
    echo "PostgreSQL 17 tools are required; set PGBIN to their bin directory." >&2
    exit 2
  fi
fi
case "$("$PGBIN/postgres" --version)" in
  "postgres (PostgreSQL) 17."*) ;;
  *) echo "This gate requires PostgreSQL 17." >&2; exit 2 ;;
esac
test -f "$migration" || { echo "missing $migration" >&2; exit 2; }

root="$(mktemp -d "${PROBE_ROOT:-${TMPDIR:-/tmp}}/ca-inertabort-pg17.XXXXXX")"
sock="$(mktemp -d "/tmp/iask.XXXXXX")"
port="$((47100 + $$ % 800))"
cleanup() {
  "$PGBIN/pg_ctl" -D "$root/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$root" "$sock"
}
trap cleanup EXIT
"$PGBIN/initdb" -D "$root/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$root/data" -l "$root/postgres.log" \
  -o "-h '' -k '$sock' -p $port" -w start >/dev/null

psql_db() {
  local db="$1"; shift
  "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$sock" -p "$port" -U postgres -d "$db" "$@"
}

psql_db postgres -c 'CREATE DATABASE fx_live' >/dev/null
psql_db fx_live -f "$fixture/bootstrap.sql" >/dev/null
psql_db fx_live -f "$fixture/installed.sql" >/dev/null   # self-checks the capture
psql_db fx_live -f "$fixture/seed.sql" >/dev/null
psql_db fx_live -f "$fixture/probe-helpers.sql" >/dev/null
echo "ok   installed.sql re-derives both live bodies from the repo migrations and matches their live md5"

# The identity the migration must preserve, as the live capture has it.
identity_sql="SELECT string_agg(p.oid::regprocedure::text||'|'||md5(pg_get_functiondef(p.oid))||'|'||proowner::regrole::text||'|'||prosecdef::text||'|'||provolatile::text||'|'||proconfig::text||'|'||proacl::text, E'\n' ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid IN (to_regprocedure('smarter_private.f06_retired_origin_snapshot(jsonb)'),to_regprocedure('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)'))"
live_identity="$(psql_db fx_live -Atc "$identity_sql")"

failures=0
verdicts="$root/verdicts.txt"
: > "$verdicts"

run_scenario() {
  local template="$1" scenario="$2" phase="$3" db="run_$RANDOM$RANDOM"
  psql_db postgres -c "CREATE DATABASE $db TEMPLATE $template" >/dev/null
  local status=0
  psql_db "$db" -f "$scenario" >"$root/out.log" 2>&1 || status=$?
  psql_db postgres -c "DROP DATABASE $db" >/dev/null
  # -E, because BSD sed does not read \| as alternation and would record nothing.
  sed -nE 's/.*NOTICE:  (VERDICT|GATE|CANONICAL) +(.*)/'"$phase"' '"$(basename "$scenario" .sql)"' \1 \2/p' \
    "$root/out.log" >> "$verdicts"
  return "$status"
}

scenarios=("$fixture"/scenarios/*.sql)

echo "== against the live bodies"
for s in "${scenarios[@]}"; do
  name="$(basename "$s")"
  kind="$(head -1 "$s" | sed -nE 's/^-- (FIXED|KEPT)\..*/\1/p')"
  if [[ "$kind" != "FIXED" && "$kind" != "KEPT" ]]; then
    echo "FAIL $name does not say whether it is FIXED or KEPT"; failures=$((failures + 1)); continue
  fi
  if run_scenario fx_live "$s" RED; then
    if [[ "$kind" == "FIXED" ]]; then
      echo "FAIL $name passes on the live bodies, so it does not prove the fix"; failures=$((failures + 1))
    else
      echo "ok   $name (kept behaviour holds today)"
    fi
  else
    if [[ "$kind" == "FIXED" ]] && grep -q 'PROBE FAILED' "$root/out.log"; then
      echo "ok   $name fails today: $(grep -o 'PROBE FAILED: .*' "$root/out.log" | head -1 | cut -c1-160)"
    else
      echo "FAIL $name on the live bodies:"; sed 's/^/     /' "$root/out.log" | tail -8; failures=$((failures + 1))
    fi
  fi
done

# The complete migration, twice: the second apply proves replay safety and that
# the preflight accepts its own result.
psql_db postgres -c 'CREATE DATABASE fx_fixed TEMPLATE fx_live' >/dev/null
psql_db fx_fixed -f "$migration" >"$root/apply.log" 2>&1
psql_db fx_fixed -f "$migration" >>"$root/apply.log" 2>&1
echo "ok   the migration applies twice (replay safe)"
for want in 'still hold cards and every one of them is refused' \
            'the predicate equals its five stated conditions' \
            'the refusal algebra holds for all 7 reviewed card shapes'; do
  if grep -q "$want" "$root/apply.log"; then
    echo "ok   in-transaction proof ran: $(grep -o "inert-abort proof: .*$want.*" "$root/apply.log" | head -1)"
  else
    echo "FAIL the migration in-transaction proof did not run: $want"; failures=$((failures + 1))
  fi
done
grep -o 'NOTICE:  inert-abort admits .*' "$root/apply.log" | sort -u | sed 's/^/     /'
grep -o 'NOTICE:  smarter_private.* already admits .*' "$root/apply.log" | sed 's/^/     /'

echo "== after $(basename "$migration")"
for s in "${scenarios[@]}"; do
  name="$(basename "$s")"
  if run_scenario fx_fixed "$s" GREEN; then
    echo "ok   $name"
  else
    echo "FAIL $name:"; sed 's/^/     /' "$root/out.log" | tail -8; failures=$((failures + 1))
  fi
done

echo "== preserved identity"
fixed_identity="$(psql_db fx_fixed -Atc "$identity_sql")"
if [[ "$(echo "$live_identity" | cut -d'|' -f3-)" == "$(echo "$fixed_identity" | cut -d'|' -f3-)" ]]; then
  echo "ok   owner, security mode, volatility, search_path and ACL are unchanged for both functions"
  echo "$fixed_identity" | sed 's/^/     /'
else
  echo "FAIL identity drifted:"; echo "$fixed_identity" | sed 's/^/     /'; failures=$((failures + 1))
fi

# Six kinds of drift, each refused, each leaving the function catalog exactly
# as it was. These exercise the real transaction, not the presence of guard text.
catalog="SELECT md5(jsonb_agg(jsonb_build_array(oid,pg_get_functiondef(oid),proowner,proacl) ORDER BY oid)::text) FROM pg_proc WHERE pronamespace IN ('public'::regnamespace,'smarter_private'::regnamespace)"
python3 - "$migration" "$root/wrong-composition.sql" "$root/wrong-helper.sql" <<'FAULT_PY'
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
pin = '83d871d42ecc2e1933035b62bdb5be72'
assert text.count(pin) == 3, text.count(pin)
# Break only the composition pin, so the migration composes a body it then
# refuses to accept: the guard must roll the whole transaction back.
composition = text.replace(
  "'smarter_private.f06_retired_origin_snapshot(jsonb)',     '" + pin + "',",
  "'smarter_private.f06_retired_origin_snapshot(jsonb)',     '" + '0'*32 + "',")
assert composition != text
Path(sys.argv[2]).write_text(composition)
helper_pin = '5d92c217691518a3a6cf90a9ba328e6a'
assert text.count(helper_pin) == 2, text.count(helper_pin)
# Widen the predicate by dropping condition 1, the exactly-zero test. The
# helper post-image pin must catch it before anything is committed.
broken = text.replace("""    NOT EXISTS (SELECT 1 FROM public.table_hole_cards c
                 WHERE c.table_id = p_table_id AND c.hand_number = p_hand_number)
    -- 2. The hand never committed.
    AND NOT EXISTS""", """    NOT EXISTS (SELECT 1 FROM public.table_hole_cards c
                 WHERE false AND c.table_id = p_table_id AND c.hand_number = p_hand_number)
    -- 2. The hand never committed.
    AND NOT EXISTS""")
assert broken != text
Path(sys.argv[3]).write_text(broken)
FAULT_PY

echo "== refusals"
for fault in body acl secdef column_type snapshot_key composition widened_predicate; do
  psql_db postgres -c 'CREATE DATABASE fx_fault TEMPLATE fx_live' >/dev/null
  fault_migration="$migration"
  case "$fault" in
    body)
      psql_db fx_fault <<'DRIFT' >/dev/null
DO $$ DECLARE d text; b text; BEGIN
 SELECT pg_get_functiondef(oid), prosrc INTO d, b FROM pg_proc
  WHERE oid='smarter_private.f06_retained_mtt_abort_snapshot(jsonb)'::regprocedure;
 EXECUTE replace(d, b, E'\n-- isolated source drift\n' || b);
END $$;
DRIFT
      expected='F06_INERT_ABORT_CARDS_PREIMAGE_CHANGED' ;;
    acl)
      psql_db fx_fault -c 'GRANT EXECUTE ON FUNCTION smarter_private.f06_retired_origin_snapshot(jsonb) TO authenticated' >/dev/null
      expected='F06_INERT_ABORT_CARDS_PREIMAGE_CHANGED' ;;
    secdef)
      psql_db fx_fault -c 'ALTER FUNCTION smarter_private.f06_retired_origin_snapshot(jsonb) SECURITY INVOKER' >/dev/null
      expected='F06_INERT_ABORT_CARDS_PREIMAGE_CHANGED' ;;
    column_type)
      psql_db fx_fault -c 'ALTER TABLE public.tournament_players ALTER COLUMN chips TYPE bigint' >/dev/null
      expected='F06_INERT_ABORT_CARDS_DEPENDENCY_CHANGED' ;;
    snapshot_key)
      psql_db fx_fault -c 'ALTER TABLE public.hand_state_snapshots DROP CONSTRAINT hand_state_snapshots_table_hand_key' >/dev/null
      expected='F06_INERT_ABORT_CARDS_DEPENDENCY_CHANGED' ;;
    composition)
      fault_migration="$root/wrong-composition.sql"
      expected='F06_INERT_ABORT_CARDS_COMPOSITION_CHANGED' ;;
    widened_predicate)
      fault_migration="$root/wrong-helper.sql"
      expected='F06_INERT_ABORT_CARDS_HELPER_CHANGED' ;;
  esac
  before_catalog="$(psql_db fx_fault -Atc "$catalog")"
  if psql_db fx_fault -f "$fault_migration" >"$root/guard.log" 2>&1; then
    echo "FAIL the migration accepts $fault drift"; failures=$((failures + 1))
  elif grep -Fq "$expected" "$root/guard.log" \
       && [[ "$before_catalog" == "$(psql_db fx_fault -Atc "$catalog")" ]]; then
    echo "ok   refuses $fault drift ($expected) with the function catalog rolled back"
  else
    echo "FAIL guard $fault:"; sed 's/^/     /' "$root/guard.log" | tail -6; failures=$((failures + 1))
  fi
  psql_db postgres -c 'DROP DATABASE fx_fault' >/dev/null
done

echo "== literal verdicts (RED = live bodies, GREEN = after the migration)"
sed 's/^/     /' "$verdicts"
if [[ ! -s "$verdicts" ]]; then
  echo "FAIL no scenario verdicts were recorded"; failures=$((failures + 1))
fi

if [[ "$failures" -ne 0 ]]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all ${#scenarios[@]} scenarios behave as reviewed, on both functions"
