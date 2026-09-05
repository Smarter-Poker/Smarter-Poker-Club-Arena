#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# probe-cluster-boards.sh: runs scripts/dev/probe-cluster-boards.sql against
# production, every board in its own transaction, every transaction rolled
# back. See the header of the .sql for what the boards are and why they are
# not vitest.
#
#   npm run probe:cluster
#   bash scripts/dev/probe-cluster-boards.sh
#
# Needs SUPABASE_DB_PASSWORD (read from the repo .env, or already exported).
# The password is never printed and never put on a command line: libpq reads
# it from PGPASSWORD. The script refuses to run without it, refuses to run
# without ON_ERROR_STOP (a failed assertion must abort the run, not skip to
# the next board with the transaction still open), and connects directly to
# the database host; when that host refuses the connection (it did for twenty
# minutes on 2026-09-05, IPv6 only) it falls back to the Supavisor SESSION
# pooler, which holds a real session so BEGIN ... ROLLBACK still spans the
# board. Never the transaction pooler (6543): CLAUDE.md 11.5 rule 1.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
sql="$here/probe-cluster-boards.sql"

# The .env: this checkout's, or - in a worktree, which has none - the main
# checkout's (the directory that holds the shared .git). Only the one
# variable is read; the rest of .env stays out of this process.
env_file="${CA_ENV_FILE:-}"
if [ -z "$env_file" ]; then
  for f in "$repo/.env" "$(cd "$repo" && git rev-parse --git-common-dir 2>/dev/null)/../.env"; do
    if [ -n "$f" ] && [ -f "$f" ]; then env_file="$f"; break; fi
  done
fi
if [ -z "${SUPABASE_DB_PASSWORD:-}" ] && [ -n "$env_file" ]; then
  SUPABASE_DB_PASSWORD="$(grep -E '^SUPABASE_DB_PASSWORD=' "$env_file" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
fi
if [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
  echo "probe-cluster-boards: SUPABASE_DB_PASSWORD is not set and no .env provides it (looked in $repo and the main checkout; CA_ENV_FILE overrides). Refusing to run." >&2
  exit 2
fi
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
unset SUPABASE_DB_PASSWORD

PSQL="${PSQL:-}"
if [ -z "$PSQL" ]; then
  for c in psql /opt/homebrew/opt/libpq/bin/psql /usr/local/opt/libpq/bin/psql /usr/lib/postgresql/*/bin/psql; do
    if command -v "$c" >/dev/null 2>&1; then PSQL="$c"; break; fi
  done
fi
if [ -z "$PSQL" ]; then echo "probe-cluster-boards: psql not found (brew install libpq)" >&2; exit 2; fi

PROJECT_REF="${SUPABASE_PROJECT_REF:-kuklfnapbkmacvwxktbh}"
DIRECT="host=db.${PROJECT_REF}.supabase.co port=5432 user=postgres dbname=postgres sslmode=require connect_timeout=8 application_name=probe-cluster-boards"
POOLER="host=${SUPABASE_POOLER_HOST:-aws-0-us-west-2.pooler.supabase.com} port=5432 user=postgres.${PROJECT_REF} dbname=postgres sslmode=require connect_timeout=10 application_name=probe-cluster-boards"

run() {
  # -v ON_ERROR_STOP=1: a failed assertion (RAISE EXCEPTION in a DO block)
  # aborts psql with exit 3 and the server rolls the open transaction back.
  # -X: no psqlrc can turn it off. The .sql also \sets it, belt and braces.
  "$PSQL" "$1" -X -v ON_ERROR_STOP=1 -f "$sql"
}

echo "probe-cluster-boards: $(date -u +%Y-%m-%dT%H:%M:%SZ) UTC, direct host first"
set +e
out="$("$PSQL" "$DIRECT" -X -At -v ON_ERROR_STOP=1 -c 'select 1' 2>&1)"; rc=$?
set -e
if [ $rc -eq 0 ]; then
  run "$DIRECT"
elif printf '%s' "$out" | grep -qE 'Connection refused|timeout expired|could not connect|could not translate'; then
  echo "probe-cluster-boards: direct host unreachable ($(printf '%s' "$out" | head -1 | cut -c1-90)); using the session pooler"
  run "$POOLER"
else
  printf '%s\n' "$out" >&2
  exit $rc
fi
