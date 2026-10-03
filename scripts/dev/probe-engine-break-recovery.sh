#!/usr/bin/env bash
# =============================================================================
#  AN ENGINE BREAK RECOVERY FOLLOWS ITS FAULT - LIVE PROOF
# =============================================================================
#
# Red before, green after, against a throwaway PostgreSQL cluster on a unix
# socket. Never against production.
#
# It proves 20260928155739 (an engine break recovery follows its fault) and
# scripts/ci/check-engine-break-recoveries.mjs (the audit). The migration may
# only run after store-only delivery (20260927235053, #5512), so this builds
# production as it stands before it from scripts/dev/fixtures/owner-inbox-
# store-only/ (roles, grants, policies, triggers; every function pinned to its
# production md5) and scripts/dev/fixtures/engine-break-recovery/ (the recorder
# verbatim, the tables it reads, pg_cron's tables), installs the REAL
# store-only migration, and proves:
#
#   REFUSED  without store-only delivery, naming each missing piece; with a
#            changed recorder, a classifier that does not route the recovery to
#            the task (or routes it for another account), a function already
#            holding the new name, an hourly job that is not the no-argument
#            call, or a delivery path that discards the recovery (the install
#            proof); and on a second run. Each refusal changes nothing.
#   RED      before it: fail, fail, pass; an old pass re-scored to a notified
#            fail; a fault ended by a backfilled clean pass - each pass sends
#            nothing and the faults stay open (the defect), which the audit
#            reports; and a fault scored from another time zone is keyed in it.
#   GREEN    after it (and after every later migration that names the
#            recorder, the push or the recovery), through the hourly job's own
#            call, logged in cron.job_run_details as pg_cron logs it: each shape
#            gets one recovery per route that was told; re-runs and re-scores
#            send nothing more and keep the pass row's account; a later fault
#            gets a numbered one; faults sent before 2026-09-28 stay with the
#            task. For the owner account only a resolved receipt addressed to
#            the task counts: a recovery the classifier would not file with the
#            task is not written, one in his personal inbox is held open. A
#            refused, discarded, unreceipted, crashed or lock-blocked delivery
#            (lock_timeout, under the job's statement timeout) never costs the
#            pass and is held by ONE firing NotifiedFaultWithoutRecovery that
#            recovers on its key once repaired; a double fault keeps the pass
#            and the audit reports it. No role but the owner may call the
#            recovery; keys are UTC from any session; measurements are
#            unchanged. The audit reads pg_cron's run log: it reports the
#            pre-image recorder, a job passing an hour or scoring an earlier
#            one, never an explicit re-score (even inside the hour), keeps a
#            purged run's pass by its own hour, and cannot tell without a run.
#
# Exit 0 proven, 1 failed, 2 could not run (missing toolchain, store-only
# delivery absent from the tree, a fixture that no longer matches production,
# a later migration the fixture cannot hold, or an hour that turned during the
# proof). Could not run is never a pass.
#
# --touches <file>...  prints each file that names the recorder, the push or
# the recovery outside a comment, in any case: the migrations this proof
# applies on top of 20260928155739, and the ones whose pull request must run it
# (.github/workflows/engine-break-recovery.yml).
set -euo pipefail
export LC_ALL=C

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migrations_dir="${repo_dir}/supabase/migrations"
migration="${migrations_dir}/20260928155739_engine_break_recoveries_follow_their_fault.sql"

GUARDED='fn_ca_record_break_scorecard|fn_ca_break_scorecard_push|fn_ca_break_scorecard_recovered'
# grep -c reads to the end, so pipefail never sees sed killed by a closed pipe.
touches() { sed -e 's/--.*$//' "$1" | grep -Eic "$GUARDED" >/dev/null; }
if [[ "${1:-}" == "--touches" ]]; then
  shift
  for f in "$@"; do if [[ -f "$f" ]] && touches "$f"; then echo "$f"; fi; done
  exit 0
fi

store_only_fixture="${repo_dir}/scripts/dev/fixtures/owner-inbox-store-only"
fixture_dir="${repo_dir}/scripts/dev/fixtures/engine-break-recovery"
store_only="${migrations_dir}/20260927235053_owner_operational_notifications_are_delivered_to_the_operati.sql"
scorecard_names_cause="${migrations_dir}/20260910132747_the_break_scorecard_names_why_a_break_never_started.sql"
fragment="${repo_dir}/scripts/ci/schema-manifest.d/engine-break-recovery.json"
detector="${repo_dir}/scripts/ci/check-engine-break-recoveries.mjs"
OWNER='47965354-0e56-43ef-931c-ddaab82af765'
TASK='01a09b86-5ba8-7290-8657-1041f13dd3ca'
OTHER='22222222-2222-4222-8222-222222222222'
THIRD='33333333-3333-4333-8333-333333333333'

# md5(pg_get_functiondef(...)) read from production kuklfnapbkmacvwxktbh on
# 2026-09-28 (read-only), and the post-images this migration installs.
PRE_RECORDER=0d9eb4d63244cfc69879f87596439c99
POST_RECORDER=2d4be3ca3149d4ee69adc7286ed9a82c
POST_RECOVERED=d5079242515f836f8d07b7f7158c77f0
PRE_PUSH=0de54de4eee0f2cfee9a5fd9e1e368ff
STORE_ONLY_PUSH=1c240cddb84994e906a4eb09d7ca3323
declare -A VERBATIM=(
  ["public.fn_is_owner_operational_notification(uuid,text,text,jsonb)"]=8c2c62359d92dcbd3b3621a762b981ca
  ["public.fn_try_record_owner_notification(uuid)"]=bbc44eb76b74576906f55e9ae370a508
  ["public.fn_record_operational_alert(text,text,text,text,text,jsonb)"]=36601e205494e8768f5a1dce09f4a186
  ["public.fn_capture_owner_notification_destination()"]=765a320465a49f71c26c4b747d61f1fd
)
REC="public.fn_ca_record_break_scorecard(timestamp with time zone)"
RCV="public.fn_ca_break_scorecard_recovered(public.ca_break_scorecards)"

# Store-only delivery's migration and fixture ship with #5512. This refuses to
# install without store-only delivery and its proof cannot be built without
# them: a tree lacking them is a pull request not stacked on #5512, and that
# fails here - it is never skipped (CLAUDE.md 10.86).
missing=()
for f in "${store_only_fixture}/roles.sql" "${store_only_fixture}/schema.sql" "$store_only"; do
  [[ -f "$f" ]] || missing+=("${f#"${repo_dir}/"}")
done
if [[ "${#missing[@]}" -gt 0 ]]; then
  echo "COULD NOT RUN: store-only delivery (#5512, migration 20260927235053) is not in this tree: missing ${missing[*]}. Not a pass." >&2
  exit 2
fi
for f in "${fixture_dir}/schema.sql" "${fixture_dir}/psql-db.mjs" "$scorecard_names_cause" "$migration" "$fragment" "$detector"; do
  [[ -f "$f" ]] || { echo "COULD NOT RUN: missing ${f#"${repo_dir}/"}" >&2; exit 2; }
done
command -v node >/dev/null 2>&1 || { echo "COULD NOT RUN: no node to run ${detector#"${repo_dir}/"}" >&2; exit 2; }

# Every later migration that names what this proof guards is applied on top.
later=()
for f in "${migrations_dir}"/*.sql; do
  if [[ "$(basename "$f")" > "$(basename "$migration")" ]] && touches "$f"; then later+=("$f"); fi
done

pg_bindir="${PG_BINDIR:-}"
if [[ -z "$pg_bindir" ]]; then
  for candidate in /usr/lib/postgresql/17/bin /usr/lib/postgresql/16/bin /usr/lib/postgresql/*/bin; do
    if [[ -x "${candidate}/initdb" ]]; then pg_bindir="$candidate"; break; fi
  done
fi
if [[ -z "$pg_bindir" ]] && command -v brew >/dev/null 2>&1; then
  pg_bindir="$(brew --prefix postgresql@17 2>/dev/null)/bin"
fi
[[ -x "${pg_bindir}/initdb" ]] || { echo "COULD NOT RUN: no PostgreSQL initdb (set PG_BINDIR)" >&2; exit 2; }

# initdb refuses to run as root; a root container runs the cluster as postgres.
as_db() { "$@"; }
if [[ "$(id -u)" == "0" ]]; then
  id postgres >/dev/null 2>&1 || { echo "COULD NOT RUN: root without a postgres user" >&2; exit 2; }
  as_db() { runuser -u postgres -- "$@"; }
fi

workdir="$(mktemp -d)"
chmod 0777 "$workdir"
port="${PROBE_PORT:-55443}"
# A step the proof depends on that stops it early is a failure, never a pass.
finished=''
cleanup() {
  local rc=$?
  as_db "${pg_bindir}/pg_ctl" -D "${workdir}/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$workdir"
  if [[ -z "$finished" && "$rc" != 2 ]]; then
    echo "RESULT: failed - the proof stopped before its end (exit ${rc})" >&2
    exit 1
  fi
}
trap cleanup EXIT

# UTF8, as production is: a later migration may carry non-ASCII text.
as_db "${pg_bindir}/initdb" -D "${workdir}/data" -U supabase_admin --auth=trust -E UTF8 --locale=C >"${workdir}/initdb.log" 2>&1 \
  || { cat "${workdir}/initdb.log" >&2; echo "COULD NOT RUN: initdb failed" >&2; exit 2; }
as_db "${pg_bindir}/pg_ctl" -D "${workdir}/data" -w \
  -o "-k ${workdir} -p ${port} -c listen_addresses=''" -l "${workdir}/pg.log" start >/dev/null \
  || { cat "${workdir}/pg.log" >&2; echo "COULD NOT RUN: postgres did not start" >&2; exit 2; }
# The hourly job runs in UTC; the time-zone cases run sessions in America/Chicago.
export PGTZ=UTC PGCLIENTENCODING=UTF8
psql_as() { local user="$1"; shift; "${pg_bindir}/psql" -X -q -h "${workdir}" -p "${port}" -U "$user" -d postgres -v ON_ERROR_STOP=1 "$@"; }
psql() { psql_as postgres "$@"; }
val() { psql -t -A -c "$1"; }
chicago() { PGTZ=America/Chicago psql -t -A -c "$1"; }

# Verdicts are counted in files, so a check made inside $(...) is never lost.
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1" >&2; echo "$1" >>"${workdir}/failures"; }
expect() { # expect <label> <actual> <wanted>
  if [[ "$2" == "$3" ]]; then pass "$1 ($2)"; else fail "$1 (got '$2', wanted '$3')"; fi
}
could_not_run() { echo "COULD NOT RUN: $1" >&2; echo "$1" >>"${workdir}/could-not-run"; exit 2; }

psql_as supabase_admin -f "${store_only_fixture}/roles.sql" >/dev/null
psql -f "${store_only_fixture}/schema.sql" >/dev/null
psql -f "${fixture_dir}/schema.sql" >/dev/null

# ----------------------------------------------------- FIXTURE = PRODUCTION --
fn_md5() { val "select md5(pg_get_functiondef('$1'::regprocedure))"; }
[[ "$(fn_md5 "$REC")" == "$PRE_RECORDER" ]] || could_not_run "fixture recorder is $(fn_md5 "$REC"), production is $PRE_RECORDER"
[[ "$(fn_md5 'public.fn_ca_break_scorecard_push(public.ca_break_scorecards)')" == "$PRE_PUSH" ]] \
  || could_not_run "fixture push is not production's pre-image $PRE_PUSH"
for f in "${!VERBATIM[@]}"; do
  got="$(fn_md5 "$f")"
  [[ "$got" == "${VERBATIM[$f]}" ]] || could_not_run "fixture $f is $got, production is ${VERBATIM[$f]}"
done
[[ "$(val "select proacl::text||' '||proconfig::text||' '||prosecdef::text||' '||proowner::regrole::text from pg_proc where oid='${REC}'::regprocedure")" \
   == '{postgres=X/postgres,service_role=X/postgres} {"search_path=public, pg_temp"} true postgres' ]] \
  || could_not_run "fixture recorder authority differs from production"
[[ "$(val "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='ca_break_scorecards'")" \
   == 'break_ended_at,break_started_at,hands_in_window,tables_dealing_in_window,thaw_ran,thaw_frozen_seconds,kill_rebuilds_after,recovery_seconds,pre_break_tables,shipped_sha,shipped,freeze_conserved,freeze_delta,verdict,detail,recorded_at,unparked_at_countdown,peak_unparked,ready_for_restart_at,gate_opened' ]] \
  || could_not_run "fixture ca_break_scorecards columns differ from production"
echo "fixture: the recorder, the push, ${#VERBATIM[@]} routing functions and ca_break_scorecards equal production"

# The CI gate check-migrations-applied reads this fragment: it must promise
# exactly the functions this migration creates.
expect "the schema-manifest fragment promises exactly the functions this migration creates" \
  "$(grep -o '"fn_[a-z_]*"' "$fragment" | tr -d '"' | sort | paste -sd' ')" \
  "$(sed -n 's/^CREATE FUNCTION public\.\(fn_[a-z_]*\)(.*$/\1/p' "$migration" | sort | paste -sd' ')"
# tests/the-break-clocks-agree.law.test.ts reads the verdict from the newest
# migration defining the recorder, which is now this one: the first block, as
# the law reads it (indexOf, then the next END;).
verdict_block() { awk '/v_verdict := CASE/{f=1} f{print} f&&/END;/{exit}' "$1"; }
expect "the verdict CASE is byte-for-byte 20260910132747's" \
  "$(verdict_block "$migration" | md5sum | cut -c1-32)" "$(verdict_block "$scorecard_names_cause" | md5sum | cut -c1-32)"
expect "--touches names the migrations that name a guarded function outside a comment, in any case" \
  "$(printf -- '-- fn_ca_record_break_scorecard\nselect 1;\n' >"${workdir}/c.sql"
     printf 'CREATE OR REPLACE FUNCTION "public"."FN_CA_RECORD_BREAK_SCORECARD"()\n' >"${workdir}/u.sql"
     printf "execute 'drop function public.fn_ca_break_scorecard_recovered(x)';\n" >"${workdir}/e.sql"
     bash "${BASH_SOURCE[0]}" --touches "${workdir}/c.sql" "${workdir}/u.sql" "${workdir}/e.sql" "$migration" | xargs -n1 basename | paste -sd' ')" \
  "u.sql e.sql $(basename "$migration")"

# ---------------------------------------------------------------- helpers ----
# Everything the proof could have written, as one digest.
state() {
  val "select md5(concat_ws('|',
    (select coalesce(string_agg(to_jsonb(n)::text, ',' order by n.id), '') from public.notifications n),
    (select coalesce(string_agg(to_jsonb(d)::text, ',' order by d.notification_id), '') from public.operational_notification_destinations d),
    (select coalesce(string_agg(to_jsonb(e)::text, ',' order by e.id), '') from public.operational_alert_events e),
    (select coalesce(string_agg(to_jsonb(s)::text, ',' order by s.break_ended_at), '') from public.ca_break_scorecards s),
    (select coalesce(string_agg(p.proname||':'||md5(pg_get_functiondef(p.oid)), ',' order by p.proname), '') from pg_proc p where p.proname like 'fn_ca_break_scorecard%' or p.proname = 'fn_ca_record_break_scorecard')))"
}
# attempt <sql> [role]: runs <sql> as one implicit transaction (as <role>,
# which cannot log in, through SET ROLE) and prints "ok", or "<SQLSTATE>|<message>".
attempt() {
  local out code msg
  if out="$(psql -v VERBOSITY=verbose -c "${2:+set role $2; }$1" 2>&1)"; then echo "ok"; return; fi
  code="$(printf '%s\n' "$out" | sed -n 's/^.*ERROR:  \([0-9A-Z]\{5\}\): .*$/\1/p' | head -1)"
  msg="$(printf '%s\n' "$out" | sed -n 's/^.*ERROR:  [0-9A-Z]\{5\}: \(.*\)$/\1/p' | head -1)"
  echo "${code}|${msg}"
}
install_refused() { # <label> <setup sql> <undo sql> <error>
  local before out
  psql -c "$2" >/dev/null
  before="$(state)"
  if out="$(psql -f "$migration" 2>&1)"; then fail "$1: the migration applied"; psql -c "$3" >/dev/null; return; fi
  if [[ "$out" != *"$4"* ]]; then fail "$1: refused for another reason: $(printf '%s\n' "$out" | grep -m1 ERROR || true)"; psql -c "$3" >/dev/null; return; fi
  [[ "$before" == "$(state)" ]] && pass "$1 (refused: $4; nothing changed)" || fail "$1: the refusal changed something"
  psql -c "$3" >/dev/null
}

# THE CLOCK. The hourly job scores date_trunc('hour', now()), so each case is
# laid out in the hours before the current one. It waits for a fresh hour when
# too little is left, and every call of the hourly path checks the hour it
# scored.
H0=''
settle_hour() {
  local left
  left="$(val "select floor(extract(epoch from date_trunc('hour', now()) + interval '1 hour' - now()))::int")"
  if (( left < 240 )); then
    echo "clock: ${left}s left in this hour, waiting for the next one"
    sleep $((left + 3))
  fi
  H0="$(val "select to_char(date_trunc('hour', now()) at time zone 'UTC', 'YYYY-MM-DD HH24:00:00+00')")"
}
hr() { echo "('${H0}'::timestamptz + interval '$1 hour')"; }
key_at() { val "select 'break-failed:' || to_char($(hr "$1") at time zone 'UTC', 'YYYYMMDD\"T\"HH24MI')"; }
when_at() { val "select to_char($(hr "$1") at time zone 'UTC', 'YYYY-MM-DD HH24:MI')"; }
reset() {
  psql -c "delete from public.notifications; delete from public.operational_notification_destinations;
           delete from public.operational_alert_events; delete from public.ca_break_scorecards;
           delete from public.engine_maintenance_thaws where freeze_started_at > '2026-06-01';
           delete from public.ca_incident_recipients;
           insert into public.ca_incident_recipients(user_id) values ('${OWNER}');" >/dev/null
}
# A break passes when its thaw ran (and it dealt no hands); it fails otherwise.
passing() { for h in "$@"; do psql -c "insert into public.engine_maintenance_thaws(freeze_started_at, frozen_seconds, shifted) values ($(hr "$h") - interval '5 minutes', 300, '{}')" >/dev/null; done; }
unthaw() { psql -c "delete from public.engine_maintenance_thaws where freeze_started_at = $(hr "$1") - interval '5 minutes'" >/dev/null; }
score() { for h in "$@"; do psql -c "select public.fn_ca_record_break_scorecard($(hr "$h"))" >/dev/null; done; }
# job_run <sql>: runs <sql> as the pg_cron job does, logging the run in
# cron.job_run_details around it (the audit knows the hourly job's passes by
# it). Prints the output; fails as the command fails.
job_run() {
  local rid out rc=0
  rid="$(val "insert into cron.job_run_details(jobid, database, username, command, status, start_time) values (244, 'postgres', 'postgres', \$c\$$1\$c\$, 'running', clock_timestamp()) returning runid")"
  out="$(psql -t -A -c "$1" 2>"${workdir}/live.err")" || rc=$?
  psql -c "update cron.job_run_details set status = case when ${rc} = 0 then 'succeeded' else 'failed' end, end_time = clock_timestamp() where runid = ${rid}" >/dev/null
  printf '%s\n' "$out"
  return "$rc"
}
# The hourly job's own call. It must score this hour, H0. A call that raises is
# a failure of the proof, never mistaken for the hour turning.
live() {
  local got
  if ! got="$(job_run "select to_char(break_ended_at at time zone 'UTC', 'YYYY-MM-DD HH24:00:00+00')||'|'||verdict from public.fn_ca_record_break_scorecard()")"; then
    fail "the hourly job's call raised: $(grep -m1 ERROR "${workdir}/live.err" || head -1 "${workdir}/live.err")"
    echo "raised"; return 0
  fi
  [[ "${got%%|*}" == "$H0" ]] || could_not_run "the hour turned during the proof (scored ${got%%|*}, laid out ${H0})"
  echo "${got#*|}"
}
recoveries() { # engine_break_recovered on every route
  val "select (select count(*) from public.notifications where type='engine_break_recovered')
            + (select count(*) from public.operational_notification_destinations where original_notification->>'type'='engine_break_recovered')"
}
owner_personal() { val "select count(*) from public.notifications where user_id='${OWNER}' and type like 'engine_break%'"; }
firing_faults() { val "select count(*) from public.operational_alert_events where source='owner-operational-notifications' and status='firing' and payload->'original_notification'->>'type'='engine_break_failed'"; }
fault_keys() { val "select coalesce(string_agg(k, ',' order by k), '') from (select original_notification->'data'->>'key' k from public.operational_notification_destinations where original_notification->>'type'='engine_break_failed') x"; }
owner_recovery() { # <field sql over d (the newest recovery destination) and e (its receipt)>
  val "select $1 from public.operational_notification_destinations d left join public.operational_alert_events e on e.id=d.inbox_event_id
        where d.original_notification->>'type'='engine_break_recovered' order by d.captured_at desc limit 1"
}
scored() { val "select coalesce((select verdict from public.ca_break_scorecards where break_ended_at=$(hr "$1")), 'none')"; }
account() { val "select coalesce(detail->'recovery'->>'$2', 'null') from public.ca_break_scorecards where break_ended_at=$(hr "$1")"; }
open_why() { val "select coalesce(string_agg((o->>'route')||':'||(o->>'unresolved')||':'||split_part(o->>'why', ':', 1), ';'), '') from public.ca_break_scorecards s, jsonb_array_elements(s.detail->'recovery'->'open') o where s.break_ended_at=$(hr "$1")"; }
guard() { # count|latest status|severity|task|key shape of the recovery guard's records
  val "select count(*)||'|'||coalesce((select status||'|'||severity||'|'||(payload->>'target_task_id')||'|'||regexp_replace(event_key, '^open:[0-9T]{13}:[0-9a-f]{12}', 'open:<hour>:<id>')
            from public.operational_alert_events where source='break-scorecard-recovery-guard' order by last_received_at desc, id desc limit 1), '-')
         from public.operational_alert_events where source='break-scorecard-recovery-guard'"
}
guard_key() { val "select event_key from public.operational_alert_events where source='break-scorecard-recovery-guard' and status='firing' order by id desc limit 1"; }
# The independent audit, run as the hourly job runs it, through psql instead
# of node-postgres (fixtures/engine-break-recovery/psql-db.mjs: the same SQL).
# settle is shortened to 0 unless a case asks for the job's own 5 minutes.
audit() { # [settle] -> the audit's exit code; its output stays in audit.out
  local rc=0
  PROBE_PSQL="${pg_bindir}/psql" PROBE_HOST="$workdir" PROBE_PORT="$port" PROBE_SETTLE="${1-0 seconds}" \
    node --input-type=module -e "
      import { run } from '${detector}';
      import { db } from '${fixture_dir}/psql-db.mjs';
      try { process.exitCode = await run(db, process.env.PROBE_SETTLE ? { settle: process.env.PROBE_SETTLE } : {}); }
      catch (e) { console.error('COULD NOT TELL  ' + e.message); process.exitCode = 3; }
    " >"${workdir}/audit.out" 2>&1 || rc=$?
  echo "$rc"
}
audit_rows() { # count|latest status|task|overdue of the audit's own records
  val "select count(*)||'|'||coalesce((select status||'|'||(payload->>'target_task_id')||'|'||coalesce(payload->>'overdue', 'resolves '||(payload->>'resolves' = (select min(event_key) from public.operational_alert_events where source='engine-break-recovery-audit'))::text)
            from public.operational_alert_events where source='engine-break-recovery-audit' order by last_received_at desc, id desc limit 1), '-')
         from public.operational_alert_events where source='engine-break-recovery-audit'"
}
# Fault injection on the delivery path, removed with unhook.
hook() { # <name> <table> <when> <plpgsql body>
  psql -c "create function public.probe_$1() returns trigger language plpgsql as \$h\$ begin $4 end \$h\$;
           create trigger aaa_probe_$1 before insert on public.$2 for each row when ($3) execute function public.probe_$1()" >/dev/null
}
unhook() { psql -c "drop trigger aaa_probe_$1 on public.$2; drop function public.probe_$1()" >/dev/null; }

# --------------------------------------------- REFUSED WITHOUT STORE-ONLY ----
before="$(state)"
if out="$(psql -f "$migration" 2>&1)"; then
  fail "the migration installed without store-only delivery"
else
  expect "without store-only delivery the install is refused, naming every missing piece" \
    "$(printf '%s\n' "$out" | grep -o 'ENGINE_BREAK_RECOVERY_NEEDS_STORE_ONLY_DELIVERY: .*missing' | head -1)" \
    "ENGINE_BREAK_RECOVERY_NEEDS_STORE_ONLY_DELIVERY: capture, break scorecard reader, guarantee bank reader, alarm drill reader, authority trigger, detector trigger missing"
  expect "that refusal changed nothing" "$(state)" "$before"
fi

psql -f "$store_only" >"${workdir}/store-only.log" 2>&1 || { cat "${workdir}/store-only.log"; could_not_run "store-only delivery (20260927235053) did not install on the fixture"; }
[[ "$(fn_md5 'public.fn_ca_break_scorecard_push(public.ca_break_scorecards)')" == "$STORE_ONLY_PUSH" ]] \
  || could_not_run "store-only delivery installed a push other than $STORE_ONLY_PUSH"
echo "store-only delivery (20260927235053) installed: the push is its post-image"

# Every measurement the recorder takes, over hours that exercise every branch,
# scored now with the pre-image and again below with the post-image.
psql <<'SQL' >/dev/null
insert into public.tables(id, status) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'open'), ('aaaaaaaa-0000-4000-8000-000000000002', 'open'),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'closed');
-- 01:00 a clean break; 02:00 dealt 60 hands inside it and resumed 71 s early;
-- 03:00 never started (the engine's fault row); 04:00 no thaw; 05:00 shipped.
insert into public.engine_maintenance_break_log(break_started_at, break_ended_at, unparked_at_countdown, peak_unparked, ready_for_restart_at, tables_resumed) values
  ('2026-01-01 00:55:02+00', '2026-01-01 01:00:04+00', 0, 1, '2026-01-01 00:55:30+00', 2),
  ('2026-01-01 01:55:01+00', '2026-01-01 01:58:49+00', 2, 3, NULL, 2),
  ('2026-01-01 04:55:01+00', '2026-01-01 05:00:03+00', 0, 0, NULL, 2);
insert into public.engine_maintenance_break_faults(announced_at, stage, outcome, error)
  values ('2026-01-01 02:53:00+00', 'announcement', 'cancelled', 'write timed out');
insert into public.engine_maintenance_thaws(freeze_started_at, frozen_seconds, shifted) values
  ('2026-01-01 00:55:00+00', 300, '{}'), ('2026-01-01 01:55:00+00', 228, '{}'), ('2026-01-01 04:55:00+00', 300, '{}');
insert into public.hand_history(table_id, created_at)
  select 'aaaaaaaa-0000-4000-8000-000000000001', '2026-01-01 01:56:00+00'::timestamptz + make_interval(secs => g) from generate_series(1, 60) g;
insert into public.hand_history(table_id, created_at)
  select t, h from (values ('aaaaaaaa-0000-4000-8000-000000000001'::uuid), ('aaaaaaaa-0000-4000-8000-000000000002'), ('aaaaaaaa-0000-4000-8000-000000000003')) v(t),
       (values ('2026-01-01 00:50:00+00'::timestamptz), ('2026-01-01 01:01:30+00'), ('2026-01-01 01:03:00+00')) w(h);
insert into public.engine_recovery_events(event, created_at) values ('watchdog_kill_rebuild', '2026-01-01 01:01:00+00');
insert into public.ca_engine_deploy_attempts(at, target_sha, shipped) values
  ('2026-01-01 04:57:08+00', 'f1992eeb00000000000000000000000000000000', true), ('2026-01-01 05:01:04+00', 'f1992eeb00000000000000000000000000000000', false);
insert into public.ca_freeze_circulation_marks(window_hour, kind, member_wallets, on_the_felt, total) values
  ('2026-01-01 01:00:00+00', 'pre', 100, 10, 110), ('2026-01-01 01:00:00+00', 'post', 100, 10, 110);
insert into public.ca_incident_recipients(user_id) values ('47965354-0e56-43ef-931c-ddaab82af765');
create table public.probe_measure(image text, h timestamptz, row_json jsonb);
insert into public.probe_measure
  select 'pre', h, to_jsonb(public.fn_ca_record_break_scorecard(h)) - 'recorded_at'
    from generate_series('2026-01-01 01:00+00'::timestamptz, '2026-01-01 05:00+00', interval '1 hour') h;
SQL
expect "the pre-image grades the five measured hours pass, fail, fail, fail, pass" \
  "$(val "select string_agg(row_json->>'verdict', ',' order by h) from public.probe_measure")" "pass,fail,fail,fail,pass"
psql -c "create table public.probe_pre_recorder as select pg_get_functiondef('${REC}'::regprocedure) as def" >/dev/null

# ---------------------------------------------------------------- RED --------
red=()
settle_hour; reset; passing -3 0; score -3 -2 -1
red+=("fail, fail, pass|$(live)|$(recoveries)|$(firing_faults)|pass|0|2")
red+=("  the audit reports both faults|$(audit)|$(audit_rows)|1|1|firing|${TASK}|2")
settle_hour; reset; passing -3 -2 -1 0; score -3 -2 -1; unthaw -3; score -3
red+=("an old pass re-scored to a notified fail, then a pass|$(scored -3)|$(live)|$(recoveries)|$(firing_faults)|fail|pass|0|1")
settle_hour; reset; passing -2 -1 0; score -3 -2 -1
red+=("a fault, a backfilled clean pass, a pass|$(live)|$(recoveries)|$(firing_faults)|pass|0|1")
settle_hour; reset; passing -3
chicago "select 1 from public.fn_ca_record_break_scorecard($(hr -2))" >/dev/null
red+=("a failing hour scored from America/Chicago is keyed in Chicago time, not UTC|$(fault_keys)|$([[ "$(fault_keys)" == "$(key_at -2)" ]] && echo utc || echo not-utc)|$(chicago "select 'break-failed:' || to_char($(hr -2), 'YYYYMMDD\"T\"HH24MI')")|not-utc")
for r in "${red[@]}"; do
  IFS='|' read -r -a f <<<"$r"
  n=$(( (${#f[@]} - 1) / 2 ))
  got="$(IFS='|'; echo "${f[*]:1:n}")"; want="$(IFS='|'; echo "${f[*]:1+n}")"
  if [[ "$got" == "$want" ]]; then echo "RED   ${f[0]}: ${got}"; else echo "FAIL  red phase did not reproduce: ${f[0]} (got ${got}, wanted ${want})"; exit 1; fi
done
psql -c "delete from public.operational_alert_events where source='engine-break-recovery-audit'" >/dev/null

# ------------------------------------------------------- INSTALL REFUSALS ----
psql -c "create table public.probe_classifier as select pg_get_functiondef('public.fn_is_owner_operational_notification(uuid,text,text,jsonb)'::regprocedure) as def" >/dev/null
restore_classifier="do \$r\$ begin execute (select def from public.probe_classifier); end \$r\$;"
install_refused "install refused: the recorder is not production's" \
  "do \$c\$ begin execute replace((select def from public.probe_pre_recorder), 'RETURN v_row;', 'RETURN v_row; -- changed'); end \$c\$;" \
  "do \$c\$ begin execute (select def from public.probe_pre_recorder); end \$c\$;" "BREAK_SCORECARD_RECORDER_SOURCE_OR_AUTHORITY_CHANGED"
install_refused "install refused: the classifier does not route a recovery to the task" \
  "do \$c\$ begin execute replace((select def from public.probe_classifier), '''engine_break_recovered'',', ''); end \$c\$;" \
  "$restore_classifier" "ENGINE_BREAK_RECOVERY_NOT_ROUTED_TO_THE_TASK"
install_refused "install refused: the classifier routes a recovery for another account too" \
  "do \$c\$ begin execute replace((select def from public.probe_classifier), 'SELECT COALESCE(', 'SELECT p_type = ''engine_break_recovered'' OR COALESCE('); end \$c\$;" \
  "$restore_classifier" "ENGINE_BREAK_RECOVERY_NOT_ROUTED_TO_THE_TASK"
install_refused "install refused: a function already holds the new name" \
  "create function public.fn_ca_break_scorecard_recovered(p_row public.ca_break_scorecards) returns void language plpgsql as 'begin end'" \
  "drop function public.fn_ca_break_scorecard_recovered(public.ca_break_scorecards)" "BREAK_SCORECARD_RECOVERY_ALREADY_EXISTS"
install_refused "install refused: the hourly job passes the recorder an hour (no live path)" \
  "update cron.job set command = 'SELECT public.fn_ca_record_break_scorecard(date_trunc(''hour'', now()))' where jobid = 244" \
  "update cron.job set command = 'SELECT public.fn_ca_record_break_scorecard()' where jobid = 244" "BREAK_SCORECARD_HOURLY_JOB_NOT_THE_LIVE_PATH"
install_refused "install refused: the hourly job is inactive" \
  "update cron.job set active = false where jobid = 244" "update cron.job set active = true where jobid = 244" \
  "BREAK_SCORECARD_HOURLY_JOB_NOT_THE_LIVE_PATH"
install_refused "install refused by its own proof: the delivery path discards a recovery" \
  "create function public.probe_discard() returns trigger language plpgsql as \$d\$ begin return null; end \$d\$;
   create trigger aaa_probe_discard before insert on public.notifications for each row
     when (new.type = 'engine_break_recovered') execute function public.probe_discard()" \
  "drop trigger aaa_probe_discard on public.notifications; drop function public.probe_discard()" \
  "ENGINE_BREAK_RECOVERY_INSTALL_CHECK_FAILED"

# Each @live-proof must be about what this installs: none may hold before it.
n=0
while IFS= read -r proof; do
  n=$((n + 1))
  expect "@live-proof ${n} does not hold before the install" "$(val "select coalesce((select (${proof}))::text, 'null')")" "false"
done < <(sed -n 's/^-- @live-proof: \(.*\)$/\1/p' "$migration")

# ---------------------------------------------------------------- APPLY ------
psql -f "$migration" >"${workdir}/apply.log" 2>&1 || { cat "${workdir}/apply.log"; fail "migration did not apply"; exit 1; }
pass "migration applied after store-only delivery, its install proof included"
expect "the install proof rolled itself back" \
  "$(val "select count(*) from public.ca_break_scorecards where break_ended_at < '2001-01-01'")|$(val "select count(*) from public.operational_notification_destinations where original_notification->'data'->>'key' like 'break-%:2000%'")|$(val "select count(*) from public.operational_alert_events where source='break-scorecard-recovery-guard'")" "0|0|0"
expect "recorder post-image md5" "$(fn_md5 "$REC")" "$POST_RECORDER"
expect "recovery function md5" "$(fn_md5 "$RCV")" "$POST_RECOVERED"
expect "the recovery is SECURITY DEFINER, postgres-owned, UTC, and no other role may EXECUTE it" \
  "$(val "select prosecdef::text||' '||proowner::regrole::text||' '||proacl::text||' '||proconfig::text||' '||has_function_privilege('service_role',oid,'EXECUTE')::text||' '||has_function_privilege('authenticated',oid,'EXECUTE')::text||' '||has_function_privilege('anon',oid,'EXECUTE')::text from pg_proc where oid='${RCV}'::regprocedure")" \
  'true postgres {postgres=X/postgres} {"search_path=public, pg_temp",TimeZone=UTC,lock_timeout=5s} false false false'
expect "the recorder keeps production's authority and runs in UTC" \
  "$(val "select proacl::text||' '||proconfig::text||' '||prosecdef::text from pg_proc where oid='${REC}'::regprocedure")" \
  '{postgres=X/postgres,service_role=X/postgres} {"search_path=public, pg_temp",TimeZone=UTC} true'
n=0
while IFS= read -r proof; do
  n=$((n + 1))
  expect "@live-proof ${n} holds after the install" "$(val "select coalesce((select (${proof}))::text, 'null')")" "true"
done < <(sed -n 's/^-- @live-proof: \(.*\)$/\1/p' "$migration")
[[ "$n" -ge 3 ]] || fail "the migration declares fewer than three @live-proof lines"

psql -c "insert into public.probe_measure
  select 'post', h, to_jsonb(public.fn_ca_record_break_scorecard(h)) - 'recorded_at'
    from generate_series('2026-01-01 01:00+00'::timestamptz, '2026-01-01 05:00+00', interval '1 hour') h" >/dev/null
expect "every measurement of the five hours is unchanged by the migration" \
  "$(val "select count(*) from public.probe_measure a join public.probe_measure b on b.h=a.h and b.image='post' where a.image='pre' and a.row_json = b.row_json")" "5"

for f in "${later[@]}"; do
  psql -f "$f" >"${workdir}/later.log" 2>&1 \
    || could_not_run "later migration $(basename "$f") names the recorder, the push or the recovery and does not apply on this fixture; extend ${fixture_dir#"${repo_dir}/"} so it does: $(grep -m1 ERROR "${workdir}/later.log" || true)"
  echo "later migration applied on top: $(basename "$f")"
done
echo "later migrations naming the recorder, the push or the recovery: ${#later[@]}"
psql -c "create table public.probe_recorder as select pg_get_functiondef('${REC}'::regprocedure) as def;
         create table public.probe_recovered as select pg_get_functiondef('${RCV}'::regprocedure) as def;
         create table public.probe_classifier_now as select pg_get_functiondef('public.fn_is_owner_operational_notification(uuid,text,text,jsonb)'::regprocedure) as def" >/dev/null

# ---------------------------------------------------------------- GREEN ------
settle_hour; reset; passing -3 0; score -3 -2 -1
K2="$(key_at -2)"; K1="$(key_at -1)"
expect "fail, fail, pass: the hourly job records the pass" "$(live)" "pass"
expect "one recovery, on the owner account's route" "$(recoveries)" "1"
expect "delivered to the Production Alerts task only: no personal row" "$(owner_personal)" "0"
expect "its receipt is resolved, addressed to the task, keyed by its id" \
  "$(owner_recovery "e.source||'|'||e.status||'|'||(e.event_key=d.notification_id::text)::text||'|'||(e.payload->>'target_task_id')||'|'||e.alertname")" \
  "owner-operational-notifications|resolved|true|${TASK}|engine_break_recovered:Engine Break Recovered"
expect "it names both faults it resolves" "$(owner_recovery "d.original_notification->'data'->>'resolves'")" "[\"${K2}\", \"${K1}\"]"
expect "it names the faults' notices, which are their receipts' event keys" \
  "$(owner_recovery "(select string_agg(x, ',' order by x) from jsonb_array_elements_text(d.original_notification->'data'->'resolves_notification_ids') x)")" \
  "$(val "select string_agg(event_key, ',' order by event_key) from public.operational_alert_events where source='owner-operational-notifications' and status='firing'")"
expect "its key is this hour's, in UTC" "$(owner_recovery "d.original_notification->'data'->>'key'")" \
  "$(val "select 'break-recovered:' || to_char($(hr 0) at time zone 'UTC', 'YYYYMMDD\"T\"HH24MI')")"
expect "its message names the hour and the failures" "$(owner_recovery "d.original_notification->>'message'")" \
  "Maintenance Break At $(val "select to_char($(hr 0) at time zone 'UTC', 'HH24:MI')") Passed. It Resolves 2 Earlier Failed Breaks: $(when_at -2), $(when_at -1)."
expect "the fault receipts are left as they were (firing)" "$(firing_faults)" "2"
expect "the pass row keeps the account: one written, nothing open, nothing recorded" \
  "$(account 0 written)|$(account 0 open)|$(account 0 recorded)|$(account 0 error)|$(account 0 record_error)" "1|[]|null|null|null"
expect "nothing is recorded for the task" "$(guard)" "0|-"
expect "the audit finds nothing overdue and records nothing" "$(audit)|$(audit_rows)" "0|0|-"
expect "the audit with the job's own settle finds nothing either" "$(audit '5 minutes')|$(audit_rows)" "0|0|-"

expect "a re-run of the hourly job in the same hour sends nothing more" "$(live)|$(recoveries)|$(account 0 written)" "pass|1|0"
score 0
expect "an explicit re-score of this hour sends nothing and keeps the account" "$(recoveries)|$(account 0 written)|$(account 0 open)" "1|0|[]"
score -1
expect "an explicit re-score of a failed hour sends neither a fault nor a recovery" "$(firing_faults)|$(recoveries)" "2|1"
passing -4; score -4; unthaw -4; score -4
K4="$(key_at -4)"
expect "a fault notified after this hour's recovery (an old pass re-scored to fail)" "$(firing_faults)|$(fault_keys)" "3|${K4},${K2},${K1}"
expect "gets a second recovery in the same hour, numbered, naming only it" \
  "$(live)|$(recoveries)|$(owner_recovery "(d.original_notification->'data'->>'key' = 'break-recovered:' || to_char($(hr 0) at time zone 'UTC', 'YYYYMMDD\"T\"HH24MI') || ':2')::text || '|' || (d.original_notification->'data'->>'resolves')")" \
  "pass|2|true|[\"${K4}\"]"
before="$(state)"
got="$(attempt "select public.fn_ca_break_scorecard_recovered(jsonb_populate_record(null::public.ca_break_scorecards, to_jsonb(s) || jsonb_build_object('break_ended_at', $(hr 1)))) from public.ca_break_scorecards s where s.break_ended_at = $(hr 0)")"
expect "a pass the scorecard never recorded closes nothing" "${got%%|*}|$(state)" "22023|${before}"
got="$(attempt "select public.fn_ca_break_scorecard_recovered(jsonb_populate_record(null::public.ca_break_scorecards, to_jsonb(s) || '{\"verdict\":\"pass\"}'::jsonb)) from public.ca_break_scorecards s where s.break_ended_at = $(hr -1)")"
expect "nor does a recorded failing hour presented as a pass" "${got%%|*}|$(state)" "22023|${before}"
for role in service_role authenticated anon; do
  got="$(attempt "select public.fn_ca_break_scorecard_recovered(null::public.ca_break_scorecards)" "$role")"
  expect "${role} may not call the recovery" "${got%%|*}|$(printf '%s' "$got" | grep -o 'permission denied for function fn_ca_break_scorecard_recovered' || true)|$(state)" \
    "42501|permission denied for function fn_ca_break_scorecard_recovered|${before}"
done

# The review's shapes: a fault notified by an explicit re-score of an old
# pass, and a fault whose episode a backfilled clean pass would have ended.
settle_hour; reset; passing -3 -2 -1 0; score -3 -2 -1; unthaw -3; score -3
expect "an old pass re-scored to a notified fail: the next pass recovers it" \
  "$(live)|$(recoveries)|$(owner_recovery "d.original_notification->'data'->>'resolves'")|$(guard)" "pass|1|[\"$(key_at -3)\"]|0|-"
settle_hour; reset; passing -2 -1 0; score -3 -2 -1
expect "a fault, then a backfilled clean pass: the next pass still recovers it" \
  "$(live)|$(recoveries)|$(owner_recovery "d.original_notification->'data'->>'resolves'")|$(guard)" "pass|1|[\"$(key_at -3)\"]|0|-"
settle_hour; reset; passing -2 0; score -2 -1; passing -1; score -1
expect "a notified hour re-graded to pass is still recovered" "$(scored -1)|$(live)|$(owner_recovery "d.original_notification->'data'->>'resolves'")" "pass|pass|[\"$(key_at -1)\"]"

# pass, pass: the pass after a recovered episode sends nothing
settle_hour; reset; passing -3 -1 0; score -3 -2 -1
psql -c "select public.fn_ca_break_scorecard_recovered(s) from public.ca_break_scorecards s where s.break_ended_at = $(hr -1)" >/dev/null
expect "the pass at -1h recovered the fault of -2h (as its hourly job would have)" "$(recoveries)" "1"
expect "pass, pass: the next pass sends nothing" "$(live)|$(recoveries)|$(guard)" "pass|1|0|-"
settle_hour; reset; passing -2 -1 0; score -2 -1
expect "pass, pass, pass with nothing notified sends nothing" "$(live)|$(recoveries)|$(guard)" "pass|0|0|-"
settle_hour; reset; passing -3 0; score -3
psql -c "update public.ca_incident_recipients set active = false" >/dev/null
score -2 -1
psql -c "update public.ca_incident_recipients set active = true" >/dev/null
expect "failures no route was told about: no notice, and their pass sends nothing" "$(firing_faults)|$(live)|$(recoveries)|$(guard)" "0|pass|0|0|-"

# The 34 production receipts' shape: notified before 2026-09-28. They stay with the task.
settle_hour; reset; passing -2 -1 0; score -3
psql -c "update public.operational_notification_destinations set captured_at = '2026-09-20 12:00+00'" >/dev/null
score -2 -1
expect "a fault notified before 2026-09-28 is left to the task: no recovery, no record, still firing" \
  "$(live)|$(recoveries)|$(guard)|$(firing_faults)|$(account 0 open)" "pass|0|0|-|1|[]"
expect "and the audit leaves it too" "$(audit)|$(audit_rows)" "0|0|-"

# every route that was told gets its own recovery, and no other route
settle_hour; reset
psql -c "insert into public.ca_incident_recipients(user_id) values ('${OTHER}')" >/dev/null
passing -3 0; score -3 -2 -1
psql -c "update public.ca_incident_recipients set active = false where user_id = '${OTHER}';
         insert into public.ca_incident_recipients(user_id) values ('${THIRD}')" >/dev/null
expect "two routes, each told of both failures" "$(live)|$(recoveries)" "pass|2"
expect "the owner account's recovery reaches the task only" "$(owner_personal)|$(owner_recovery "d.original_notification->'data'->>'resolves'")" "0|[\"$(key_at -2)\", \"$(key_at -1)\"]"
expect "the other account, told of both, gets its recovery in its inbox, although it is no longer an active recipient" \
  "$(val "select count(*)||'|'||min(data->>'resolves') from public.notifications where user_id='${OTHER}' and type='engine_break_recovered'")" \
  "1|[\"$(key_at -2)\", \"$(key_at -1)\"]"
expect "an account made a recipient after the failures gets nothing" "$(val "select count(*) from public.notifications where user_id='${THIRD}'")" "0"

# A delivery error never costs the pass: held for the task, recovered on the same key.
settle_hour; reset; passing -3 0; score -3 -2 -1
hook refuse notifications "new.type = 'engine_break_recovered'" "raise exception 'probe: delivery refused';"
expect "with the recovery's delivery refused, the pass is still recorded" "$(live)|$(scored 0)|$(recoveries)" "pass|pass|0"
expect "the pass row says which faults are open and why" "$(open_why 0)" "${OWNER}:[\"$(key_at -2)\", \"$(key_at -1)\"]:delivery failed"
expect "ONE NotifiedFaultWithoutRecovery is firing for the task" "$(guard)" "1|firing|warning|${TASK}|open:<hour>:<id>"
expect "it names the open faults and why" \
  "$(val "select (payload->'open'->0->>'unresolved')||'|'||split_part(payload->'open'->0->>'why', ':', 1) from public.operational_alert_events where source='break-scorecard-recovery-guard'")" \
  "[\"$(key_at -2)\", \"$(key_at -1)\"]|delivery failed"
G="$(guard_key)"
expect "a re-run while it is still refused keeps that one identity" "$(live)|$(guard)|$(val "select delivery_count from public.operational_alert_events where event_key='${G}'")" "pass|1|firing|warning|${TASK}|open:<hour>:<id>|2"
unhook refuse notifications
expect "repaired, the next run sends the recovery" "$(live)|$(recoveries)|$(owner_recovery "d.original_notification->'data'->>'resolves'")" "pass|1|[\"$(key_at -2)\", \"$(key_at -1)\"]"
expect "and the record gets its recovery on the same key, addressed to the task" \
  "$(guard)|$(val "select payload->>'resolves' from public.operational_alert_events where event_key='${G}:resolved'")" "2|resolved|info|${TASK}|open:<hour>:<id>:resolved|${G}"
expect "after which nothing more is recorded" "$(live)|$(guard)" "pass|2|resolved|info|${TASK}|open:<hour>:<id>:resolved"

# A recovery the delivery path silently discards is held for the task too.
settle_hour; reset; passing -3 0; score -3 -2 -1
hook discard notifications "new.type = 'engine_break_recovered'" "return null;"
expect "a discarded recovery: the pass is kept, the fault is open, the task holds it" \
  "$(live)|$(recoveries)|$(open_why 0)|$(guard)" "pass|0|${OWNER}:[\"$(key_at -2)\", \"$(key_at -1)\"]:the recovery written for this route reached neither notifications nor operational_notification_destinations|1|firing|warning|${TASK}|open:<hour>:<id>"
expect "the audit reports the same faults for the task" "$(audit)|$(audit_rows)" "1|1|firing|${TASK}|2"
# ... and if even that record is refused, the pass is still kept and the audit sees it.
psql -c "delete from public.operational_alert_events where source in ('break-scorecard-recovery-guard', 'engine-break-recovery-audit')" >/dev/null
hook drop_guard operational_alert_events "new.source = 'break-scorecard-recovery-guard'" "return null;"
live >/dev/null
expect "a double fault keeps the pass and says so in the pass row" \
  "$(scored 0)|$(guard)|$(account 0 record_error | sed 's/:[0-9T]*:[0-9a-f]*$/:<id>/')" "pass|0|-|the store did not keep open:<id>"
grep -q 'WARNING:  engine break recovery at .* not recorded for the task' "${workdir}/live.err" \
  && pass "and warns in the job's log" || fail "a double fault raised no WARNING"
expect "the audit, which does not depend on that record, reports it" "$(audit)|$(audit_rows)" "1|1|firing|${TASK}|2"
unhook drop_guard operational_alert_events; unhook discard notifications

# A recovery whose receipt is left pending is held for the task until the receipt lands.
settle_hour; reset; passing -3 0; score -3 -2 -1
hook no_receipt operational_alert_events "new.source = 'owner-operational-notifications' and new.status = 'resolved'" "raise exception 'probe: receipt refused';"
expect "a recovery delivered with its receipt left pending: the pass is kept, the task holds it" \
  "$(live)|$(recoveries)|$(owner_recovery "coalesce(d.inbox_event_id::text, 'pending')")|$(open_why 0)|$(guard)" \
  "pass|1|pending|${OWNER}:[\"$(key_at -2)\", \"$(key_at -1)\"]:its recovery reached the task's destination but no resolved receipt was recorded|1|firing|warning|${TASK}|open:<hour>:<id>"
expect "the audit reports it" "$(audit)|$(audit_rows)" "1|1|firing|${TASK}|2"
unhook no_receipt operational_alert_events
psql -c "set role service_role; select public.fn_retry_owner_notification_destination(d.notification_id) from public.operational_notification_destinations d where d.original_notification->>'type' = 'engine_break_recovered'" >/dev/null
G="$(guard_key)"
expect "once the task's retry records the receipt, the next run sends nothing and the record recovers" \
  "$(owner_recovery "e.status")|$(live)|$(recoveries)|$(guard)|$(val "select count(*) from public.operational_alert_events where event_key='${G}:resolved'")" "resolved|pass|1|2|resolved|info|${TASK}|open:<hour>:<id>:resolved|1"
expect "and the audit records its own recovery on its key" "$(audit)|$(audit_rows)" "0|2|resolved|${TASK}|resolves true"

# An error anywhere on the recovery path is caught by the recorder and kept.
settle_hour; reset; passing -3 0; score -3 -2 -1
psql -c "create or replace function public.fn_ca_break_scorecard_recovered(p_row public.ca_break_scorecards) returns jsonb
           language plpgsql security definer set search_path to 'public', 'pg_temp' as \$x\$ begin raise exception 'probe: recovery crashed'; end \$x\$" >/dev/null
expect "a crashing recovery never costs the pass, and the pass row keeps the error" "$(live)|$(scored 0)|$(account 0 error)" "pass|pass|P0001: probe: recovery crashed"
psql -c "do \$u\$ begin execute (select def from public.probe_recovered); end \$u\$;" >/dev/null
expect "restored, the recovery is sent by the next run" "$(fn_md5 "$RCV")|$(live)|$(recoveries)" "$(val "select md5(def) from public.probe_recovered")|pass|1"

# Keys are UTC from any session.
settle_hour; reset; passing -3
chicago "select 1 from public.fn_ca_record_break_scorecard($(hr -2))" >/dev/null
expect "a failing hour scored from America/Chicago is keyed in UTC" "$(fault_keys)" "$(key_at -2)"
passing 0
got="$(chicago "select to_char(break_ended_at at time zone 'UTC', 'YYYY-MM-DD HH24:00:00+00')||'|'||verdict from public.fn_ca_record_break_scorecard()")"
[[ "${got%%|*}" == "$H0" ]] || could_not_run "the hour turned during the proof (scored ${got%%|*}, laid out ${H0})"
expect "a pass recorded from America/Chicago names this hour and the fault in UTC" \
  "${got#*|}|$(owner_recovery "d.original_notification->'data'->>'key'")|$(owner_recovery "d.original_notification->'data'->>'resolves'")" \
  "pass|$(val "select 'break-recovered:' || to_char($(hr 0) at time zone 'UTC', 'YYYYMMDD\"T\"HH24MI')")|[\"$(key_at -2)\"]"

# service_role may still run the hourly path through the recorder.
settle_hour; reset; passing -3 0; score -3 -2 -1
expect "service_role running the hourly path through the recorder sends the recovery" \
  "$(psql -t -A -c "set role service_role; select verdict from public.fn_ca_record_break_scorecard()")|$(recoveries)" "pass|1"

# The audit reads what this code cannot: the pre-image recorder, and a job
# that passes the recorder an hour.
settle_hour; reset; passing -3 0; score -3 -2 -1
psql -c "do \$u\$ begin execute (select def from public.probe_pre_recorder); end \$u\$;" >/dev/null
expect "necessity: with the pre-image recorder the same pass sends nothing" "$(fn_md5 "$REC")|$(live)|$(recoveries)|$(guard)" "${PRE_RECORDER}|pass|0|0|-"
expect "the audit waits out the job's settle before it calls a pass overdue" "$(audit '5 minutes')|$(audit_rows)" "0|0|-"
expect "then reports both faults for the task, and prints no account id" \
  "$(audit)|$(audit_rows)|$(grep -c 'notified to the owner account' "${workdir}/audit.out")|$(grep -c "${OWNER}" "${workdir}/audit.out" || true)" "1|1|firing|${TASK}|2|2|0"
A="$(val "select event_key from public.operational_alert_events where source='engine-break-recovery-audit'")"
expect "a second audit keeps its identity" "$(audit)|$(audit_rows)|$(val "select delivery_count from public.operational_alert_events where event_key='${A}'")" "1|1|firing|${TASK}|2|2"
psql -c "create table public.probe_runs as select * from cron.job_run_details; delete from cron.job_run_details;
         insert into cron.job_run_details(jobid, command, status, start_time, end_time) values (244, 'SELECT public.fn_ca_record_break_scorecard()', 'succeeded', clock_timestamp(), clock_timestamp())" >/dev/null
expect "once pg_cron has purged that run, the pass is known by its own hour: still reported, same identity" \
  "$(audit)|$(audit_rows)|$(val "select delivery_count from public.operational_alert_events where event_key='${A}'")" "1|1|firing|${TASK}|2|3"
psql -c "delete from cron.job_run_details; insert into cron.job_run_details select * from public.probe_runs; drop table public.probe_runs" >/dev/null
psql -c "do \$u\$ begin execute (select def from public.probe_recorder); end \$u\$;" >/dev/null
expect "restored, the next run sends the recovery" "$(live)|$(recoveries)" "pass|1"
expect "and the audit records its recovery on the same key" "$(audit)|$(audit_rows)|$(val "select count(*) from public.operational_alert_events where event_key='${A}:resolved'")" "0|2|resolved|${TASK}|resolves true|1"
settle_hour; reset; passing -3 0; score -3 -2 -1
expect "a job passing the recorder this hour sends nothing" \
  "$(job_run "select verdict from public.fn_ca_record_break_scorecard(date_trunc('hour', now()))")|$(recoveries)" "pass|0"
expect "and the audit reports it" "$(audit)|$(audit_rows)" "1|1|firing|${TASK}|2"
settle_hour; reset; passing -4 -1; score -4 -3 -2
expect "a job changed to score the hour before sends nothing" \
  "$(job_run "select verdict from public.fn_ca_record_break_scorecard(date_trunc('hour', now()) - interval '1 hour')")|$(recoveries)" "pass|0"
expect "and the audit reports it too" "$(audit)|$(audit_rows)" "1|1|firing|${TASK}|2"
settle_hour; reset; passing -3; score -3 -2
expect "the hourly job fails this hour, then an explicit re-score inside the hour passes it" "$(live)|$(passing 0; score 0; scored 0)" "fail|pass"
expect "that re-score is not the hourly job's pass: the audit waits for it" "$(audit)|$(audit_rows)" "0|0|-"
settle_hour; reset; passing -1; score -2 -1
expect "nor is an explicit pass of a later hour" "$(scored -1)|$(audit)|$(audit_rows)" "pass|0|0|-"
psql -c "create table public.probe_runs as select * from cron.job_run_details; delete from cron.job_run_details" >/dev/null
expect "with no run of the hourly job in pg_cron's log the audit cannot tell, and says so" "$(audit)|$(grep -c 'COULD NOT TELL' "${workdir}/audit.out")" "3|1"
psql -c "insert into cron.job_run_details select * from public.probe_runs; drop table public.probe_runs" >/dev/null

# For the owner account only a resolved receipt addressed to the task recovers
# a fault. A classifier that would not file the recovery with the task: it is
# not written at all (never his inbox or phone) and the fault is held open.
settle_hour; reset; passing -3 0; score -3 -2 -1
psql -c "do \$c\$ begin
           execute replace((select def from public.probe_classifier_now), 'FUNCTION public.fn_is_owner_operational_notification(', 'FUNCTION public.probe_classifier_copy(');
         end \$c\$;
         create or replace function public.fn_is_owner_operational_notification(p_user uuid, p_type text, p_title text, p_data jsonb)
           returns boolean language sql immutable parallel safe set search_path = pg_catalog, public
           as \$f\$ select p_type is distinct from 'engine_break_recovered' and public.probe_classifier_copy(p_user, p_type, p_title, p_data) \$f\$" >/dev/null
expect "a classifier that would not file the recovery with the task: nothing reaches his inbox or the task, the pass is kept, the task holds it" \
  "$(live)|$(owner_personal)|$(recoveries)|$(open_why 0)|$(guard)" \
  "pass|0|0|${OWNER}:[\"$(key_at -2)\", \"$(key_at -1)\"]:not sent|1|firing|warning|${TASK}|open:<hour>:<id>"
expect "the audit reports it" "$(audit)|$(audit_rows)" "1|1|firing|${TASK}|2"
psql -c "do \$c\$ begin execute (select def from public.probe_classifier_now); end \$c\$; drop function public.probe_classifier_copy(uuid, text, text, jsonb)" >/dev/null
expect "restored, the next run files it with the task and both records recover" \
  "$(live)|$(owner_personal)|$(recoveries)|$(guard | cut -d'|' -f1,2)|$(audit)|$(audit_rows | cut -d'|' -f1,2)" "pass|0|1|2|resolved|0|2|resolved"
# ... and a recovery that reached his personal inbox is no recovery: held open,
# never sent again into that inbox.
settle_hour; reset; passing -3 0; score -3 -2 -1
psql_as supabase_admin -c "set session_replication_role = replica;
  insert into public.notifications(user_id, type, title, message, data) values ('${OWNER}', 'engine_break_recovered', 'Engine Break Recovered', 'leaked',
    jsonb_build_object('key', 'probe-leak', 'resolves', jsonb_build_array('$(key_at -2)', '$(key_at -1)')))" >/dev/null
expect "a recovery in the owner account's personal inbox recovers nothing and is not sent again" \
  "$(live)|$(owner_personal)|$(recoveries)|$(open_why 0)|$(guard | cut -d'|' -f1,2)" \
  "pass|1|1|${OWNER}:[\"$(key_at -2)\", \"$(key_at -1)\"]:its recovery reached the owner account's personal inbox, not the task|1|firing"
expect "the audit reports it" "$(audit)|$(audit_rows)" "1|1|firing|${TASK}|2"
psql -c "delete from public.notifications where user_id = '${OWNER}' and data->>'key' = 'probe-leak'" >/dev/null
expect "once that row is gone the next run files the recovery with the task and both records recover" \
  "$(live)|$(recoveries)|$(guard | cut -d'|' -f1,2)|$(audit)|$(audit_rows | cut -d'|' -f1,2)" "pass|1|2|resolved|0|2|resolved"

# A lock held on the delivery path gives up after lock_timeout (5 s), well
# under the hourly job's statement timeout: the pass is kept and held.
settle_hour; reset; passing -3 0; score -3 -2 -1
psql -c "begin; lock table public.notifications in exclusive mode; select pg_sleep(40); commit;" >/dev/null 2>&1 &
locker=$!
for _ in $(seq 1 50); do
  [[ "$(val "select count(*) from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'notifications' and l.mode = 'ExclusiveLock' and l.granted")" == 1 ]] && break; sleep 0.2
done
started=$SECONDS
got="$(PGOPTIONS='-c statement_timeout=20s' live)"
expect "with notifications locked, the hourly call (statement timeout 20 s) returns within 15 s and keeps its pass" "${got}|$(scored 0)|$(( SECONDS - started < 15 ))" "pass|pass|1"
expect "its lock wait (55P03) is held for the task" "$(open_why 0)|$(account 0 open | grep -o 55P03 | head -1)|$(guard | cut -d'|' -f1,2)" \
  "${OWNER}:[\"$(key_at -2)\", \"$(key_at -1)\"]:delivery failed|55P03|1|firing"
val "select pg_terminate_backend(l.pid) from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'notifications' and l.mode = 'ExclusiveLock' and l.granted" >/dev/null
wait "$locker" 2>/dev/null || true
expect "released, the next run sends the recovery and the record recovers" "$(live)|$(recoveries)|$(guard | cut -d'|' -f1,2)" "pass|1|2|resolved"

# the migration refuses a second run
if psql -f "$migration" >"${workdir}/second.log" 2>&1; then
  fail "a second run of the migration was accepted"
else
  grep -q "BREAK_SCORECARD_RECORDER_SOURCE_OR_AUTHORITY_CHANGED" "${workdir}/second.log" \
    && pass "a second run is refused by its pre-image guard" \
    || { cat "${workdir}/second.log"; fail "a second run failed for an unexpected reason"; }
fi

finished=1
if [[ -s "${workdir}/could-not-run" ]]; then
  echo "RESULT: could not run - $(head -1 "${workdir}/could-not-run")"
  exit 2
fi
if [[ -s "${workdir}/failures" ]]; then
  echo "RESULT: $(wc -l <"${workdir}/failures") assertion(s) failed"
  exit 1
fi
echo "RESULT: red before, green after - all assertions passed"
