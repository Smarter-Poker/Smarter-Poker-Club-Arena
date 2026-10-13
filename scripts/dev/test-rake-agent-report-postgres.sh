#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pgbin="${PG17_BINDIR:-/opt/homebrew/opt/postgresql@17/bin}"
scratch_parent="${DATA_CONSOLE_PG_SCRATCH_PARENT:-${STATS_PG_SCRATCH_PARENT:-/Volumes/SmarterWork/agent-work}}"
fixture="$repo/tests/fixtures/rake-agent-report"
migration="$repo/supabase/migrations/20261013121004_rake_agent_reports_read_qualified_days_and_uncovered_commiss.sql"
[[ -x "$pgbin/initdb" && -x "$pgbin/postgres" && -x "$pgbin/psql" && -d "$scratch_parent" ]] || exit 2
"$pgbin/postgres" --version | grep -Eq ' 17\.' || exit 2
work="$(mktemp -d "$scratch_parent/rake-agent-report.XXXXXX")"
data="$work/data";socket="$work/socket";port="$((57000+($$%7000)))"
mkdir -p "$socket"
cleanup(){ "$pgbin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true; [[ "$work" == "$scratch_parent"/rake-agent-report.* ]] && find "$work" -depth -delete; }
trap cleanup EXIT
"$pgbin/initdb" -D "$data" -U postgres --auth-local=trust --auth-host=reject --no-locale -E UTF8 -c shared_memory_type=mmap >/dev/null
"$pgbin/pg_ctl" -D "$data" -o "-h '' -k '$socket' -p $port" -w start >/dev/null
psql=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$socket" -p "$port" -U postgres -d postgres)
"${psql[@]}" -f "$fixture/bootstrap.sql" -f "$fixture/original-function.sql"
"${psql[@]}" -c 'ALTER FUNCTION public.fn_ca_rake_by_agent(uuid,date,date,integer,integer,text,text) RENAME TO fixture_original_rake_by_agent' -f "$fixture/original-function.sql"
"${psql[@]}" -f "$migration" -f "$fixture/assertions.sql"
# A competing original writer key must refuse qualification without a marker.
PGAPPNAME=rake_fixture_blocker "${psql[@]}" -c "SELECT pg_advisory_lock(hashtextextended('agent-commission:a41434bb-8d0c-400a-8f0d-e8b3d65afed4',0)); SELECT 'LOCK_HELD'; SELECT pg_sleep(2);" >"$work/blocker.log" &
blocker=$!
ready=f
for attempt in {1..50};do ready="$("${psql[@]}" -At -c "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='rake_fixture_blocker' AND wait_event='PgSleep')")";[[ "$ready" == t ]] && break;done
[[ "$ready" == t ]]
if "${psql[@]}" -c "BEGIN;SET LOCAL lock_timeout='100ms';SELECT smarter_private.qualify_rake_agent_report_day('a41434bb-8d0c-400a-8f0d-e8b3d65afed4',current_date-103);COMMIT;" >"$work/lock.log" 2>&1;then echo 'Writer lock was bypassed' >&2;exit 1;fi
grep -q 'lock timeout' "$work/lock.log"
wait "$blocker"
"${psql[@]}" <<'SQL'
DO $$BEGIN IF EXISTS(SELECT 1 FROM smarter_private.agent_commission_report_days WHERE club_id='a41434bb-8d0c-400a-8f0d-e8b3d65afed4' AND day=current_date-103) THEN RAISE EXCEPTION 'locked qualification persisted';END IF;END$$;
SQL
if "${psql[@]}" -f "$migration" >"$work/replay.log" 2>&1;then echo 'Replay incorrectly accepted' >&2;exit 1;fi
grep -q RAKE_REPORT_SOURCE_PREIMAGE_CHANGED "$work/replay.log"
RAKE_FIXTURE_SOCKET="$socket" RAKE_FIXTURE_PORT="$port" node "$repo/scripts/dev/qualify-rake-report-installation-fixture.mjs"
echo 'RAKE_AGENT_REPORT_NATIVE_PASS exact JSON and baseline guards; replay refused'
