#!/usr/bin/env bash
# Exact 20261012135622 migration against captured production preimage. Private
# PostgreSQL 17 only; never consumes DATABASE_URL or any configured database.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${PGBIN:-}" ]]; then
  if [[ -x /opt/homebrew/opt/postgresql@17/bin/postgres ]]; then
    PGBIN=/opt/homebrew/opt/postgresql@17/bin
  else
    PGBIN=/usr/lib/postgresql/17/bin
  fi
fi
case "$("$PGBIN/postgres" --version)" in
  *" 17."*) ;;
  *) echo 'PostgreSQL 17 is required' >&2; exit 1;;
esac
if [[ -d /Volumes/SmarterWork ]]; then
  df /Volumes/SmarterWork
  # Do not silently use an internal directory when an external disk is absent.
  [[ "$(df /Volumes/SmarterWork | tail -1 | awk '{print $NF}')" == /Volumes/SmarterWork ]]
  BASE=/Volumes/SmarterWork/agent-work
elif [[ "$(uname)" == Darwin ]]; then
  echo 'SmarterWork must be mounted; no internal-drive fallback' >&2; exit 1
else
  BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
fi
PROBE_OUT="$(mktemp -d "$BASE/inventory-seal-buckets.XXXXXX")"
cleanup() {
  "$PGBIN/pg_ctl" -D "$PROBE_OUT/data" -m immediate stop >/dev/null 2>&1 || true
  if [[ -n "${PROBE_EVIDENCE:-}" ]]; then
    mkdir -p "$PROBE_EVIDENCE"
    for evidence in old-digest.json new-digest.json multi-digest.json diagnostic-3000.sql pg.log; do
      if [[ -f "$PROBE_OUT/$evidence" ]]; then
        cp "$PROBE_OUT/$evidence" "$PROBE_EVIDENCE/$evidence"
      fi
    done
  fi
  rm -rf "$PROBE_OUT"
}
trap cleanup EXIT
export LC_ALL=C LANG=C PGBIN PROBE_OUT
export PROBE_SOCKET="$PROBE_OUT" PROBE_PORT=56433
export PROBE_MIGRATION="$ROOT/supabase/migrations/20261012135622_the_inventory_seal_assembles_bucket_by_bucket.sql"
"$PGBIN/initdb" -D "$PROBE_OUT/data" -U postgres -A trust --no-locale -E UTF8 >"$PROBE_OUT/initdb.log" 2>&1
"$PGBIN/pg_ctl" -D "$PROBE_OUT/data" -o "-p $PROBE_PORT -k $PROBE_SOCKET -c listen_addresses=''" -l "$PROBE_OUT/pg.log" -w start >/dev/null
python3 -I "$ROOT/scripts/dev/fixtures/inventory-seal-buckets/qualify.py"
