#!/usr/bin/env bash
# A BUST IS RANKED BY WHEN IT HAPPENED - PostgreSQL 17 behaviour gate.
#
# Runs every scenario in scripts/dev/fixtures/a-bust-is-ranked-by-when-it-happened
# against a byte-exact capture of the LIVE bodies (installed.sql): the engine's
# terminal cash authority (fn_settle_tournament_places), both knockout doors and
# their write halves, the standings normalizer, the place prepare and the
# unfinished-finish alarm. The money authorities the settlement calls - the
# settlement lane, guarantee funding and the raw place payer - are small test
# doubles in bootstrap.sql, named as such; everything the migration pins is the
# captured production body. Then it applies the migration twice and runs them
# all again:
#
#   FIXED scenarios must FAIL on the live bodies, on a probe assertion (never on
#         a broken script), and PASS after the migration;
#   KEPT  scenarios must pass on both.
#
# Last, it applies the reviewed rollback
# (docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql)
# twice over the migrated database: every captured body must come back to its
# live md5, and the migration must then apply again.
#
# A disposable cluster in a temporary directory; no database URL is accepted and
# nothing outside that directory is touched.
set -euo pipefail
export LC_ALL=C LANG=C PGTZ=UTC

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$repo/scripts/dev/fixtures/a-bust-is-ranked-by-when-it-happened"
migration="$repo/supabase/migrations/20260911062048_a_bust_is_ranked_by_when_it_happened.sql"

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

root="$(mktemp -d "${TMPDIR:-/tmp}/ca-bust-rank-pg17.XXXXXX")"
port="$((45432 + $$ % 10000))"
cleanup() {
  "$PGBIN/pg_ctl" -D "$root/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT
mkdir "$root/socket"
"$PGBIN/initdb" -D "$root/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$root/data" -l "$root/postgres.log" \
  -o "-h '' -k '$root/socket' -p $port" -w start >/dev/null

psql_db() {
  local db="$1"; shift
  "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$root/socket" -p "$port" -U postgres -d "$db" "$@"
}

psql_db postgres -c 'CREATE DATABASE fx_live' >/dev/null
psql_db fx_live -f "$fixture/bootstrap.sql" >/dev/null
psql_db fx_live -f "$fixture/installed.sql" >/dev/null
psql_db fx_live -f "$fixture/probe-helpers.sql" >/dev/null

# The capture must be the live bodies, byte for byte.
python3 - "$fixture/source-manifest.json" <<'PY' > "$root/manifest-check.sql"
import json, sys
bodies = json.load(open(sys.argv[1]))['bodies']
for identity, digest in bodies.items():
    print(f"SELECT probe.check((SELECT md5(prosrc) FROM pg_proc WHERE oid = '{identity}'::regprocedure) = '{digest}', 'installed body of {identity} is the captured live body');")
PY
psql_db fx_live -f "$root/manifest-check.sql" >/dev/null

failures=0
run_scenario() {
  local template="$1" scenario="$2" db="run_$RANDOM$RANDOM"
  psql_db postgres -c "CREATE DATABASE $db TEMPLATE $template" >/dev/null
  local status=0
  psql_db "$db" -f "$scenario" >"$root/out.log" 2>&1 || status=$?
  psql_db postgres -c "DROP DATABASE $db" >/dev/null
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
  if run_scenario fx_live "$s"; then
    if [[ "$kind" == "FIXED" ]]; then
      echo "FAIL $name passes on the live bodies, so it does not prove the fix"; failures=$((failures + 1))
    else
      echo "ok   $name (kept behaviour holds today)"
    fi
  else
    if [[ "$kind" == "FIXED" ]] && grep -q 'PROBE FAILED' "$root/out.log"; then
      echo "ok   $name fails today: $(grep -o 'PROBE FAILED: .*' "$root/out.log" | head -1 | cut -c1-160)"
    else
      echo "FAIL $name on the live bodies:"; sed 's/^/     /' "$root/out.log" | tail -5; failures=$((failures + 1))
    fi
  fi
done

# The complete migration, twice: the second apply proves replay safety and that
# the preflight accepts its own result.
psql_db postgres -c 'CREATE DATABASE fx_fixed TEMPLATE fx_live' >/dev/null
psql_db fx_fixed -f "$migration" >/dev/null
psql_db fx_fixed -f "$migration" >/dev/null

echo "== after $(basename "$migration")"
for s in "${scenarios[@]}"; do
  name="$(basename "$s")"
  if run_scenario fx_fixed "$s"; then
    echo "ok   $name"
  else
    echo "FAIL $name:"; sed 's/^/     /' "$root/out.log" | tail -5; failures=$((failures + 1))
  fi
done

# The reviewed inverse, twice, then the migration once more over its result.
rollback="$repo/docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql"
echo "== after $(basename "$rollback")"
psql_db postgres -c 'CREATE DATABASE fx_rolled TEMPLATE fx_fixed' >/dev/null
if psql_db fx_rolled -f "$rollback" >"$root/out.log" 2>&1 \
   && psql_db fx_rolled -f "$rollback" >>"$root/out.log" 2>&1; then
  echo "ok   the rollback applies twice"
else
  echo "FAIL the rollback:"; sed 's/^/     /' "$root/out.log" | tail -5; failures=$((failures + 1))
fi
if psql_db fx_rolled -f "$root/manifest-check.sql" >"$root/out.log" 2>&1; then
  echo "ok   every body is its captured live body again"
else
  echo "FAIL a body is not its live body after the rollback:"; sed 's/^/     /' "$root/out.log" | tail -5; failures=$((failures + 1))
fi
if psql_db fx_rolled -f "$migration" >"$root/out.log" 2>&1; then
  echo "ok   the migration applies again over the rolled-back bodies"
else
  echo "FAIL the migration over the rolled-back bodies:"; sed 's/^/     /' "$root/out.log" | tail -5; failures=$((failures + 1))
fi

# The current elimination lookup regression reuses this owned cluster and the
# existing structural ranking fixture. Its exact four authority definitions
# replace only this separate test database, never the historical scenarios.
# The empty Diamond ledger below supplies its actual captured column types for
# read-only generation checks; this reduced test does not certify Diamond money.
lookup_capture="$repo/scripts/dev/fixtures/a-bust-is-ranked-by-when-it-happened/candidate-lookup-authority-20260917.json"
lookup_tables="$repo/scripts/dev/fixtures/a-bust-is-ranked-by-when-it-happened/candidate-lookup-tables-20260917.json"
lookup_migration="$repo/supabase/migrations/20260917054818_resolve_elimination_candidate_once.sql"
lookup_scenario="$fixture/candidate-lookup.sql"
python3 - "$lookup_capture" "$lookup_tables" <<'LOOKUP_PY' > "$root/current-lookup-authority.sql"
import hashlib,json,sys
q=lambda s:'"'+s.replace('"','""')+'"'
literal=lambda s:"'"+s.replace("'","''")+"'"
selected={'fn_ca_latest_committed_knockout_candidate','fn_claim_tournament_bounty_elimination',
 'fn_eliminate_player_legacy_candidate_20260907','fn_eliminate_tournament_player_atomic'}
rows=[r for r in json.load(open(sys.argv[1]))['rows'] if r['proname'] in selected]
assert len(rows)==4 and {r['proname'] for r in rows}==selected
ledger=next(r for r in json.load(open(sys.argv[2]))['rows'] if r['name']=='poker_diamond_tournament_ledger')
# Only an empty typed read relation is needed by these non-purchase cases;
# full financial constraints, custody and journal writes are qualified elsewhere.
assert all(not c['identity'] and not c['generated'] for c in ledger['columns'])
print('CREATE TABLE public.poker_diamond_tournament_ledger('+','.join(
 q(c['name'])+' '+c['type']+(' NOT NULL' if c['notnull'] else '') for c in ledger['columns'])+');')
for r in rows:
 d=r['definition'];body=d.split('AS $function$',1)[1].split('$function$',1)[0]
 assert hashlib.md5(body.encode()).hexdigest()==r['source_md5']
 assert hashlib.md5(d.encode()).hexdigest()==r['definition_md5']
 sig='public.'+r['signature']
 print(d.rstrip().rstrip(';')+';')
 print('ALTER FUNCTION '+sig+' OWNER TO '+q(r['owner'])+';')
 print('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role,postgres;')
 for g in r['grants']:
  assert g['grantor']=='postgres' and g['privilege']=='EXECUTE'
  print('GRANT EXECUTE ON FUNCTION '+sig+' TO '+q(g['role'])+(' WITH GRANT OPTION' if g['grantable'] else '')+';')
 print('SELECT probe.check(EXISTS(SELECT 1 FROM pg_proc WHERE oid='+literal(sig)+'::regprocedure'
  +' AND md5(prosrc)='+literal(r['source_md5'])+' AND md5(pg_get_functiondef(oid))='+literal(r['definition_md5'])
  +' AND proowner='+literal(r['owner'])+'::regrole AND proacl::text='+literal(r['raw_acl'])
  +'),'+literal('lookup exact captured definition and ACL: '+sig)+');')
LOOKUP_PY
psql_db postgres -c 'CREATE DATABASE fx_lookup TEMPLATE fx_fixed' >/dev/null
psql_db fx_lookup -f "$root/current-lookup-authority.sql" >/dev/null
if run_scenario fx_lookup "$lookup_scenario"; then
  echo "FAIL candidate lookup passes before repair"; failures=$((failures + 1))
elif grep -q 'PROBE FAILED: candidate lookup ordinary outer and core resolve once each' "$root/out.log"; then
  echo "ok   candidate lookup fails on real repeated resolver calls before repair"
else
  echo "FAIL candidate lookup before repair:"; tail -8 "$root/out.log"; failures=$((failures + 1))
fi
# These refusals exercise the same transaction, including rollback AFTER all
# three replacements, rather than merely checking that guard text exists.
python3 - "$lookup_migration" "$root/wrong-lookup-postimage.sql" <<'LOOKUP_FAULT_PY'
from pathlib import Path
import sys
text=Path(sys.argv[1]).read_text(); pin='e9615b08f4d5b46857fc7ac5d902b2d2'
assert text.count(pin)==1
Path(sys.argv[2]).write_text(text.replace(pin,'0'*32))
LOOKUP_FAULT_PY
lookup_catalog="SELECT md5(jsonb_agg(jsonb_build_array(oid,pg_get_functiondef(oid),proowner,proacl) ORDER BY oid)::text) FROM pg_proc WHERE pronamespace='public'::regnamespace"
for fault in body acl resolver_acl postimage; do
  psql_db postgres -c "CREATE DATABASE fx_lookup_fault TEMPLATE fx_lookup" >/dev/null
  fault_migration="$lookup_migration"
  case "$fault" in
    body)
      psql_db fx_lookup_fault <<'LOOKUP_DRIFT_SQL' >/dev/null
DO $$ DECLARE d text; b text; BEGIN
 SELECT pg_get_functiondef(oid),prosrc INTO d,b FROM pg_proc
 WHERE oid='public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure;
 EXECUTE replace(d,b,E'\n-- isolated source drift\n'||b);
END $$;
LOOKUP_DRIFT_SQL
      expected='candidate lookup pre authority drift:' ;;
    acl)
      psql_db fx_lookup_fault -c 'GRANT EXECUTE ON FUNCTION public.fn_eliminate_player_legacy_candidate_20260907(uuid,uuid,integer,numeric,numeric) TO authenticated' >/dev/null
      expected='candidate lookup pre ACL drift:' ;;
    resolver_acl)
      psql_db fx_lookup_fault -c 'GRANT EXECUTE ON FUNCTION public.fn_ca_latest_committed_knockout_candidate(uuid,uuid) TO service_role' >/dev/null
      expected='candidate lookup resolver ACL drift' ;;
    postimage)
      fault_migration="$root/wrong-lookup-postimage.sql"
      expected='candidate lookup post authority drift:' ;;
  esac
  before_lookup_catalog="$(psql_db fx_lookup_fault -Atc "$lookup_catalog")"
  if psql_db fx_lookup_fault -f "$fault_migration" >"$root/lookup-guard.log" 2>&1; then
    echo "FAIL candidate lookup accepts $fault drift"; failures=$((failures + 1))
  elif grep -Fq "$expected" "$root/lookup-guard.log" &&
       [[ "$before_lookup_catalog" == "$(psql_db fx_lookup_fault -Atc "$lookup_catalog")" ]]; then
    echo "ok   candidate lookup refuses $fault drift with exact function catalog rollback"
  else
    echo "FAIL candidate lookup guard $fault:"; tail -8 "$root/lookup-guard.log"; failures=$((failures + 1))
  fi
  psql_db postgres -c 'DROP DATABASE fx_lookup_fault' >/dev/null
done
psql_db fx_lookup -f "$lookup_migration" >/dev/null
if run_scenario fx_lookup "$lookup_scenario" && grep -q '^ CANDIDATE_LOOKUP_CI_PASS' "$root/out.log"; then
  echo "ok   candidate lookup uses ordinary2 / PKO1 resolver calls, indexed UUID and unchanged refusals"
else
  echo "FAIL candidate lookup after repair:"; tail -10 "$root/out.log"; failures=$((failures + 1))
fi

if [[ "$failures" -ne 0 ]]; then
  echo "$failures scenario check(s) failed" >&2
  exit 1
fi
echo "all ${#scenarios[@]} scenarios behave as reviewed, and the rollback restores the live bodies"
