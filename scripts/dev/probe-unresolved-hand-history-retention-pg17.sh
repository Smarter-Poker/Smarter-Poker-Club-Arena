#!/usr/bin/env bash
# UNRESOLVED HAND PERMITS RETAIN THEIR ORIGINAL HAND HISTORY - PostgreSQL 17 gate.
#
# Runs every scenario in
# scripts/dev/fixtures/unresolved-hand-permits-retain-their-original-hand-history
# against a byte-exact capture of the LIVE public.sp_prune_hand_history(integer)
# (installed.sql, which refuses to load if it is not the captured live body,
# owner, ACL, search_path, volatility and security mode). Then it applies the
# migration twice and runs them all again:
#
#   FIXED scenarios must FAIL on the live body, on a probe assertion (never on
#         a broken script), and PASS after the migration;
#   KEPT  scenarios must pass on both.
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
fixture="$repo/scripts/dev/fixtures/unresolved-hand-permits-retain-their-original-hand-history"
migration="$repo/supabase/migrations/20260921023215_unresolved_hand_permits_retain_their_original_hand_history.sql"

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

root="$(mktemp -d "${PROBE_ROOT:-${TMPDIR:-/tmp}}/ca-handhist-pg17.XXXXXX")"
sock="$(mktemp -d "/tmp/hhsk.XXXXXX")"
port="$((47100 + $$ % 900))"
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
psql_db fx_live -f "$fixture/probe-helpers.sql" >/dev/null
# Permits in every state the enum admits, so the migration's own executable
# proof runs over real rows rather than an empty table.
psql_db fx_live -f "$fixture/seed-permit-states.sql" >/dev/null
echo "ok   installed.sql is the captured live body, owner, ACL, search_path, volatility and security mode"

failures=0
census="$root/census.txt"
: > "$census"

run_scenario() {
  local template="$1" scenario="$2" phase="$3" db="run_$RANDOM$RANDOM"
  psql_db postgres -c "CREATE DATABASE $db TEMPLATE $template" >/dev/null
  local status=0
  psql_db "$db" -f "$scenario" >"$root/out.log" 2>&1 || status=$?
  psql_db postgres -c "DROP DATABASE $db" >/dev/null
  sed -n 's/.*NOTICE:  CENSUS \(.*\)/'"$phase"' \1/p' "$root/out.log" >> "$census"
  return "$status"
}

scenarios=("$fixture"/scenarios/*.sql)

echo "== against the live body"
for s in "${scenarios[@]}"; do
  name="$(basename "$s")"
  kind="$(head -1 "$s" | sed -nE 's/^-- (FIXED|KEPT)\..*/\1/p')"
  if [[ "$kind" != "FIXED" && "$kind" != "KEPT" ]]; then
    echo "FAIL $name does not say whether it is FIXED or KEPT"; failures=$((failures + 1)); continue
  fi
  if run_scenario fx_live "$s" RED; then
    if [[ "$kind" == "FIXED" ]]; then
      echo "FAIL $name passes on the live body, so it does not prove the fix"; failures=$((failures + 1))
    else
      echo "ok   $name (kept behaviour holds today)"
    fi
  else
    if [[ "$kind" == "FIXED" ]] && grep -q 'PROBE FAILED' "$root/out.log"; then
      echo "ok   $name fails today: $(grep -o 'PROBE FAILED: .*' "$root/out.log" | head -1 | cut -c1-150)"
    else
      echo "FAIL $name on the live body:"; sed 's/^/     /' "$root/out.log" | tail -6; failures=$((failures + 1))
    fi
  fi
done

# The complete migration, twice: the second apply proves replay safety and that
# the preflight accepts its own result.
psql_db postgres -c 'CREATE DATABASE fx_fixed TEMPLATE fx_live' >/dev/null
psql_db fx_fixed -f "$migration" >"$root/apply.log" 2>&1
psql_db fx_fixed -f "$migration" >>"$root/apply.log" 2>&1
echo "ok   the migration applies twice (replay safe)"
# The migration's own proof must have been exercised, not merely present: it
# reports how many permit states it checked both directions of.
proof_states="$(grep -o 'hand-history retention proof: both directions hold for [0-9]* permit state' "$root/apply.log" | head -1 | grep -o '[0-9]*')"
if [[ "${proof_states:-0}" -eq 4 ]]; then
  echo "ok   the migration's in-transaction proof checked both directions for all 4 permit states"
else
  echo "FAIL the migration's in-transaction proof was vacuous: ${proof_states:-none} state(s)"; failures=$((failures + 1))
fi
grep -o 'NOTICE:  hand-history retention proof: [0-9]* reserved permit.*' "$root/apply.log" | head -1 | sed 's/^/     /'
grep -o 'NOTICE:  sp_prune_hand_history already retains.*' "$root/apply.log" | head -1 | sed 's/^/     /'

echo "== after $(basename "$migration")"
for s in "${scenarios[@]}"; do
  name="$(basename "$s")"
  if run_scenario fx_fixed "$s" GREEN; then
    echo "ok   $name"
  else
    echo "FAIL $name:"; sed 's/^/     /' "$root/out.log" | tail -6; failures=$((failures + 1))
  fi
done

# The identity the migration promised to preserve, read back from the catalog.
echo "== preserved identity"
identity="$(psql_db fx_fixed -Atc "SELECT proowner::regrole::text||'|'||prosecdef::text||'|'||provolatile::text||'|'||proconfig::text||'|'||proacl::text FROM pg_proc WHERE oid='public.sp_prune_hand_history(integer)'::regprocedure")"
if [[ "$identity" == 'postgres|false|v|{"search_path=public, pg_temp"}|{postgres=X/postgres}' ]]; then
  echo "ok   owner, security mode, volatility, search_path and ACL are unchanged: $identity"
else
  echo "FAIL identity drifted: $identity"; failures=$((failures + 1))
fi
helper_identity="$(psql_db fx_fixed -Atc "SELECT proowner::regrole::text||'|'||prosecdef::text||'|'||provolatile::text||'|'||proconfig::text||'|'||proacl::text||'|'||md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid='smarter_private.f06_hand_cards_unresolved(uuid,bigint)'::regprocedure")"
if [[ "$helper_identity" == 'postgres|true|s|{"search_path=pg_catalog, public, smarter_private"}|{postgres=X/postgres,service_role=X/postgres}|2a0ae05eeef418193cefc4ef5881b289' ]]; then
  echo "ok   the reused helper is migration 20260920232341's, unchanged: $helper_identity"
else
  echo "FAIL helper drifted: $helper_identity"; failures=$((failures + 1))
fi

# Six kinds of drift, each refused, each leaving the function catalog exactly
# as it was. These exercise the real transaction, not the presence of guard text.
catalog="SELECT md5(jsonb_agg(jsonb_build_array(oid,pg_get_functiondef(oid),proowner,proacl) ORDER BY oid)::text) FROM pg_proc WHERE pronamespace IN ('public'::regnamespace,'smarter_private'::regnamespace)"
python3 - "$migration" "$root/wrong-postimage.sql" <<'FAULT_PY'
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
pin = '0838c5ee8e0d57a26371a2fdfa22671c'
assert text.count(pin) == 4, text.count(pin)
# Break only the composition pin, so the migration composes a body it then
# refuses to accept: the post-image guard must roll the whole transaction back.
Path(sys.argv[2]).write_text(text.replace(
  "IF replacement=original OR md5(replacement) IS DISTINCT FROM '" + pin + "'",
  "IF replacement=original OR md5(replacement) IS DISTINCT FROM '" + '0'*32 + "'"))
FAULT_PY

echo "== refusals"
for fault in body acl secdef permit_enum delete_key composition; do
  psql_db postgres -c 'CREATE DATABASE fx_fault TEMPLATE fx_live' >/dev/null
  fault_migration="$migration"
  case "$fault" in
    body)
      psql_db fx_fault <<'DRIFT' >/dev/null
DO $$ DECLARE d text; b text; BEGIN
 SELECT pg_get_functiondef(oid), prosrc INTO d, b FROM pg_proc
  WHERE oid='public.sp_prune_hand_history(integer)'::regprocedure;
 EXECUTE replace(d, b, E'\n-- isolated source drift\n' || b);
END $$;
DRIFT
      expected='F06_HAND_HISTORY_RETENTION_PREIMAGE_CHANGED' ;;
    acl)
      psql_db fx_fault -c 'GRANT EXECUTE ON FUNCTION public.sp_prune_hand_history(integer) TO authenticated' >/dev/null
      expected='F06_HAND_HISTORY_RETENTION_PREIMAGE_CHANGED' ;;
    secdef)
      psql_db fx_fault -c 'ALTER FUNCTION public.sp_prune_hand_history(integer) SECURITY DEFINER' >/dev/null
      expected='F06_HAND_HISTORY_RETENTION_PREIMAGE_CHANGED' ;;
    permit_enum)
      psql_db fx_fault <<'DRIFT' >/dev/null
ALTER TABLE smarter_private.f06_hand_permits DROP CONSTRAINT f06_hand_permits_state_check;
ALTER TABLE smarter_private.f06_hand_permits ADD CONSTRAINT f06_hand_permits_state_check
  CHECK (state = ANY (ARRAY['reserved'::text,'accepted'::text,'never_started'::text,'aborted_unsettled'::text,'parked'::text]));
DRIFT
      expected='F06_HAND_HISTORY_RETENTION_DEPENDENCY_CHANGED' ;;
    delete_key)
      # If a table the prune deletes by hand_id ever gains its own hand number,
      # the single-point exemption must be re-reasoned rather than assumed.
      psql_db fx_fault -c 'ALTER TABLE public.rake_attributions ADD COLUMN hand_number bigint' >/dev/null
      expected='F06_HAND_HISTORY_RETENTION_DEPENDENCY_CHANGED' ;;
    composition)
      fault_migration="$root/wrong-postimage.sql"
      expected='F06_HAND_HISTORY_RETENTION_COMPOSITION_CHANGED' ;;
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

echo "== literal row counts (before -> after each prune call)"
sort -k2,2 -k1,1r "$census" | awk '{printf "     %-6s %-38s %s %s\n", $1, $2, $3, $4}'

if [[ "$failures" -ne 0 ]]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all ${#scenarios[@]} scenarios behave as reviewed"
