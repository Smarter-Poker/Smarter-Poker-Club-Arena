#!/usr/bin/env bash
# A BUST IS RANKED BY WHEN IT HAPPENED - PostgreSQL 17 behaviour gate.
#
# Runs every scenario in scripts/dev/fixtures/a-bust-is-ranked-by-when-it-happened
# against a byte-exact capture of the LIVE knockout door, standings normalizer and
# place prepare (installed.sql), then applies the migration twice and runs them
# all again:
#
#   FIXED scenarios must FAIL on the live bodies, on a probe assertion (never on
#         a broken script), and PASS after the migration;
#   KEPT  scenarios must pass on both.
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

if [[ "$failures" -ne 0 ]]; then
  echo "$failures scenario check(s) failed" >&2
  exit 1
fi
echo "all ${#scenarios[@]} scenarios behave as reviewed"
