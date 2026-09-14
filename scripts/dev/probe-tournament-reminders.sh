#!/usr/bin/env bash
set -euo pipefail
# macOS + PostgreSQL 17: without this the postmaster aborts at startup with
# "postmaster became multithreaded during startup" and the probe cannot run at all.
export LC_ALL=C
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
case "$("$PGBIN/postgres" --version)" in
  "postgres (PostgreSQL) 17."*) ;;
  *) echo 'PostgreSQL 17 is required' >&2; exit 1 ;;
esac
reminder_tmp="$(mktemp -d "${TMPDIR:-/tmp}/ca-reminders.XXXXXX")"
cleanup() {
  "$PGBIN/pg_ctl" -D "$reminder_tmp/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$reminder_tmp"
}
trap cleanup EXIT
mkdir "$reminder_tmp/socket"
reminder_share="$("$PGBIN/pg_config" --sharedir)"
if [[ ! -f "$reminder_share/postgres.bki" ]]; then reminder_share="$PGBIN/../share/postgresql"; fi
"$PGBIN/initdb" -L "$reminder_share" -D "$reminder_tmp/data" -U reminder_test -A trust --no-locale -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$reminder_tmp/data" -l "$reminder_tmp/postgres.log" -o "-h '' -k '$reminder_tmp/socket' -p 55446" -w start >/dev/null
CA_REMINDER_SOCKET="$reminder_tmp/socket" node "$repo/scripts/dev/verify-tournament-reminders.mjs"
