#!/usr/bin/env bash
# Native harness for 20260927221335_push_prompt_events_record_the_enrolment_funnel.sql:
# players insert their own prompt events only, never read them, and an admin
# (or the engine) reads the funnel.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
work="$root/tests/fixtures/push-prompt-events"
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
if [ "$(uname -s)" = Darwin ] && [ -z "${LC_ALL:-}" ]; then export LC_ALL=en_US.UTF-8; fi
fixture=$(mktemp -d "${TMPDIR:-/tmp}/push-prompt-events.XXXXXX")
started=0
cleanup(){ if [ "$started" = 1 ]; then "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null; fi; rm -rf "$fixture"; }
trap cleanup EXIT
mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55495 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55495 -d postgres \
 -f "$work/bootstrap.sql" \
 -f "$root/supabase/migrations/20260927221335_push_prompt_events_record_the_enrolment_funnel.sql" \
 -f "$work/regression.sql"
