#!/usr/bin/env bash
# SATELLITE AND DEAL LADDERS RANK A SAME-HAND BUST BY STARTING STACK
# - PostgreSQL 17 behaviour gate.
#
# Runs every scenario in scripts/dev/fixtures/satellite-same-hand-bust-order
# against a byte-exact capture of the LIVE bodies (installed.sql), then applies
# migration 20260921095012 twice and runs them all again:
#
#   FIXED scenarios must FAIL on the live bodies, on a probe assertion (never on
#         a broken script), and PASS after the migration;
#   KEPT  scenarios must pass on both.
#
# A disposable cluster in a temporary directory; no database URL is accepted and
# nothing outside that directory is touched.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIX="$HERE/scripts/dev/fixtures/satellite-same-hand-bust-order"
MIG="$HERE/supabase/migrations/20260921095012_satellite_awards_and_final_table_deals_rank_a_same_hand_bust.sql"
FIXED=(01_one_hand_decides_the_last_seat_by_starting_stack
       03_an_equal_stack_same_hand_tie_falls_to_user_id)
KEPT=(02_a_one_at_a_time_ladder_is_unchanged)

if [[ -z "${PGBIN:-}" ]]; then
  if [[ -x /opt/homebrew/opt/postgresql@17/bin/postgres ]]; then
    PGBIN=/opt/homebrew/opt/postgresql@17/bin
  elif [[ -x /usr/lib/postgresql/17/bin/postgres ]]; then
    PGBIN=/usr/lib/postgresql/17/bin
  else
    echo "PostgreSQL 17 tools are required; set PGBIN to their bin directory." >&2
    exit 1
  fi
fi
case "$("$PGBIN/postgres" --version)" in
  *" 17."*) ;;
  *) echo "this gate requires PostgreSQL 17, found $("$PGBIN/postgres" --version)" >&2; exit 1;;
esac

TMP="$(mktemp -d)"
trap '"$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
export LC_ALL=C LANG=C
"$PGBIN/initdb" -D "$TMP/data" -U postgres -A trust --no-locale -E UTF8 >"$TMP/initdb.log" 2>&1
"$PGBIN/pg_ctl" -D "$TMP/data" -o "-p 55433 -k $TMP" -l "$TMP/pg.log" -w start >/dev/null
PSQL=("$PGBIN/psql" -X -h "$TMP" -p 55433 -U postgres -v ON_ERROR_STOP=1 -q)

fresh() {
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS probe" -c "CREATE DATABASE probe" >/dev/null
  "${PSQL[@]}" -d probe -f "$FIX/bootstrap.sql" >/dev/null
  "${PSQL[@]}" -d probe -f "$FIX/installed.sql" >/dev/null
}

# The capture must be the tree the migration's pre-image guard expects, or this
# gate is proving nothing about production.
fresh
"${PSQL[@]}" -d probe -c "DO \$\$ BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname LIKE 'fn_%') <> 7 THEN
    RAISE EXCEPTION 'the live capture did not install its seven bodies';
  END IF;
END \$\$;" >/dev/null

run() { # run <scenario> ; 0 = passed
  "${PSQL[@]}" -d probe -f "$FIX/scenarios/$1.sql" >"$TMP/out.$1" 2>&1
}

echo "== on the LIVE bodies =="
for s in "${FIXED[@]}"; do
  fresh
  if run "$s"; then echo "  UNEXPECTED PASS: $s"; exit 1; fi
  grep -q "PROBE FAILED" "$TMP/out.$s" || {
    echo "  $s failed for the wrong reason:"; sed -n '1,20p' "$TMP/out.$s"; exit 1; }
  echo "  fails as it must: $s"
done
for s in "${KEPT[@]}"; do
  fresh
  run "$s" || { echo "  KEPT scenario already fails: $s"; sed -n '1,20p' "$TMP/out.$s"; exit 1; }
  echo "  passes: $s"
done

echo "== applying the migration twice =="
fresh
# The bodies the migration installs reference the whole tournament economy;
# bootstrap.sql carries only what the scenarios EXECUTE. Compilation of the
# other bodies is proved separately, against a full production schema replica -
# here they are stored, and the guards and post-image assertions still run.
MPSQL=(env "PGOPTIONS=-c check_function_bodies=off" "${PSQL[@]}")
"${MPSQL[@]}" -d probe -f "$MIG" >/dev/null
"${MPSQL[@]}" -d probe -f "$MIG" >/dev/null
echo "  applied, and applied again"

echo "== after the migration =="
for s in "${FIXED[@]}" "${KEPT[@]}"; do
  "${PSQL[@]}" -d probe -c "TRUNCATE public.tournament_knockout_candidates, public.hand_atomic_commits; DELETE FROM public.tournament_satellite_settlements; DELETE FROM public.tournament_players; DELETE FROM public.tournaments;" >/dev/null
  run "$s" || { echo "  STILL FAILS: $s"; sed -n '1,20p' "$TMP/out.$s"; exit 1; }
  echo "  passes: $s"
done

echo "SATELLITE SAME-HAND BUST ORDER: all scenarios behave as the law says."
