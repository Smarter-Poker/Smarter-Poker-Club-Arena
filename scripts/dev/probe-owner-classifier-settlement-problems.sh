#!/usr/bin/env bash
# =============================================================================
#  THE OWNER CLASSIFIER COVERS SETTLEMENT PROBLEM AND PUSH-OFF NOTICES - PROOF
# =============================================================================
#
# Red before, green after, against a throwaway PostgreSQL cluster on a unix
# socket. Never against production.
#
# supabase/migrations/20260928171444_the_owner_classifier_covers_settlement_problems_and_push_off.sql
# makes fn_is_owner_operational_notification classify, for the owner account
# only, smarter-poker-workers' weekly auto-settlement problem notices (type
# 'settlement': one of three titles, ASCII case and whitespace folded, or the
# route's marker in the data) and World Hub push-health's 'Push Notifications
# Are Off' (type 'system', folded the same way), and preserves the owner's
# existing rows of those kinds in the Production Alerts store. The database is
# production as it stands: store-only delivery's fixture
# (scripts/dev/fixtures/owner-inbox-store-only/, production before
# 20260927235053) plus this proof's own (the production push mirror and the
# tables it reads), the owner's history written through production's write
# path, then the REAL store-only migration. On it this proves:
#
#   REFUSED   without store-only delivery, naming each missing piece.
#   RED       with store-only delivery and without this migration, a
#             settlement problem notice and a 'Push Notifications Are Off' to
#             the owner land in his personal inbox and are mirrored to
#             push_outbox (the defect), and the held cleanup's candidate set
#             leaves them there.
#   NECESSITY the classifier alone leaves those originals with no store copy;
#             captured from an America/Chicago session they would not be
#             provable in the cleanup's UTC proof; with the whitespace class
#             written as a plain literal, a writer session with
#             standard_conforming_strings off is not classified; without its
#             SET LOCAL standard_conforming_strings = on, an installer session
#             with it off cannot install; without the SHARE lock, a
#             service_role writer whose transaction is open across the install
#             commits after it and leaves a personal row with no destination.
#   REFUSALS  a partial store-only install; a changed classifier source or
#             ACL; a changed intake; an index holding the classifier's answer;
#             a notification writer holding its lock past lock_timeout; a
#             second run. Each changes nothing.
#   GREEN     installed from an America/Chicago session: the post-image, with
#             owner, ACL, settings, IMMUTABLE and PARALLEL SAFE kept; every
#             @live-proof true; every existing owner row of these kinds
#             preserved with its destination and task receipt, proven the way
#             the held cleanup proves it; no notification or push_outbox row
#             changed; each kind written to the owner (marked as the route now
#             writes it, unmarked as it once did, case- and space-folded, the
#             marker under another title, from a session with
#             standard_conforming_strings off, the push-off notice as written
#             and folded) routed with no personal row and no push, a marked one
#             filed under its alertname and severity; his business settlement
#             notices, near misses (a non-ASCII case fold, a foreign marker,
#             another type, 'Push Notifications Are Offline') and other
#             recipients unchanged; anon and authenticated refused by the
#             authority trigger; the owner no longer reads the preserved rows;
#             the detector records a capture bypass and the push mirror does
#             not push it.
#   LOCK      a writer open when the install starts, and one that starts while
#             it waits, are both waited for: the first is preserved with the
#             rest, the second meets the new classifier and is store-only.
#   ORDER     the documented order (this, then the held cleanup
#             20260928000622) leaves no owner-operational row. The other order
#             (the cleanup first) installs, from a session with
#             standard_conforming_strings off, preserves the rows, records the
#             ones left for the fleet task and leaves @live-proof 3 false, and a
#             new marked notice is then delivered store-only. With the
#             cleanup's file (in this tree, or named by
#             OWNER_INBOX_CLEANUP_MIGRATION) both orders run it; without it the
#             documented order rests on the cleanup's per-row proof, asserted
#             in GREEN, and the other order on a stand-in for its removal.
#
# Exit 0 proven, 1 failed, 2 could not run (missing toolchain, store-only
# delivery absent from this tree, or a fixture that no longer matches
# production). Could not run is a failure, never a pass or a skip.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
store_only_fixture="${repo_dir}/scripts/dev/fixtures/owner-inbox-store-only"
fixture_dir="${repo_dir}/scripts/dev/fixtures/owner-classifier-settlement-problems"
store_only="${repo_dir}/supabase/migrations/20260927235053_owner_operational_notifications_are_delivered_to_the_operati.sql"
migration="${repo_dir}/supabase/migrations/20260928171444_the_owner_classifier_covers_settlement_problems_and_push_off.sql"
cleanup_migration="${OWNER_INBOX_CLEANUP_MIGRATION:-${repo_dir}/supabase/migrations/20260928000622_owner_inbox_keeps_no_operational_original.sql}"
OWNER='47965354-0e56-43ef-931c-ddaab82af765'
TASK='01a09b86-5ba8-7290-8657-1041f13dd3ca'
OTHER='22222222-2222-4222-8222-222222222222'
UNION_ID='aaaaaaaa-0000-4000-8000-000000000001'
NEEDS='Weekly player P&L needs review'
FAILED='Weekly player P&L failed'
RULE='Union rule violation detected'
PUSH_OFF='Push Notifications Are Off'
# The route's business titles carry an emoji and a dash; spelled as escapes
# so this file stays ASCII.
COMMISSION="U&'\\+01F4B0 Commission Received \\2014 Period #7'"
COMPLETE="U&'\\+01F4CA Settlement Complete \\2014 Club One Period #7'"

# md5(pg_get_functiondef(...)) read from production kuklfnapbkmacvwxktbh on
# 2026-09-28 (UTC), and the post-image this migration installs.
PRE_CLASSIFIER=8c2c62359d92dcbd3b3621a762b981ca
POST_CLASSIFIER=30553a82783e28037aa884c85f203808
CLASSIFIER='public.fn_is_owner_operational_notification(uuid,text,text,jsonb)'
declare -A VERBATIM=(
  ["public.fn_capture_owner_notification_destination()"]=765a320465a49f71c26c4b747d61f1fd
  ["public.fn_capture_owner_notification_history(integer)"]=cc71da2cd06381b3b460f9213f6e46bf
  ["public.fn_try_record_owner_notification(uuid)"]=bbc44eb76b74576906f55e9ae370a508
  ["public.fn_record_operational_alert(text,text,text,text,text,jsonb)"]=36601e205494e8768f5a1dce09f4a186
  ["public.fn_mirror_notification_to_push_outbox()"]=37d724277900f53d00db14fb3c5cd04d
  ["${CLASSIFIER}"]=${PRE_CLASSIFIER}
)
# md5(pg_get_triggerdef(...)) of every trigger on public.notifications, production 2026-09-28.
declare -A TRIGGERS=(
  [trg_accounting_push_after_delivery]=2ce80f9915a35b649c9eded776f03998
  [trg_mirror_notification_to_push_outbox]=206ea59a0a1349939f1a3ecf49b16811
  [trg_notification_fill_action_url]=72688390c99eefdc341985ab662365e1
  [trg_sync_notification_read_state]=d51939b27ff75f7b3ab366c9e4b50050
  [zz_capture_owner_notification_destination]=8b00a08f6ae0865c65fbec76cb29c582
)

missing=()
for f in "${store_only_fixture}/roles.sql" "${store_only_fixture}/schema.sql" "$store_only"; do
  [[ -f "$f" ]] || missing+=("${f#"${repo_dir}/"}")
done
if [[ "${#missing[@]}" -gt 0 ]]; then
  echo "COULD NOT RUN: store-only delivery (Smarter-Poker/Smarter-Poker-Club-Arena#5512, migration 20260927235053) is not in this tree: missing ${missing[*]}. This migration requires it, so its pull request is stacked on #5512's branch. Not a pass." >&2
  exit 2
fi
for f in "${fixture_dir}/schema.sql" "$migration"; do
  [[ -f "$f" ]] || { echo "COULD NOT RUN: missing ${f#"${repo_dir}/"}" >&2; exit 2; }
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
cleanup() {
  as_db "${pg_bindir}/pg_ctl" -D "${workdir}/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

# The cluster's superuser is supabase_admin, as on Supabase, so that postgres
# can be what it is in production: not a superuser, bypassing row-level security.
# UTF8 as in production, whatever the runner's locale: the route's business
# titles carry an emoji.
as_db "${pg_bindir}/initdb" -D "${workdir}/data" -U supabase_admin --auth=trust -E UTF8 --locale=C \
  >"${workdir}/initdb.log" 2>&1 \
  || { cat "${workdir}/initdb.log" >&2; echo "COULD NOT RUN: initdb failed" >&2; exit 2; }
as_db "${pg_bindir}/pg_ctl" -D "${workdir}/data" -w \
  -o "-k ${workdir} -p ${port} -c listen_addresses=''" -l "${workdir}/pg.log" start >/dev/null \
  || { cat "${workdir}/pg.log" >&2; echo "COULD NOT RUN: postgres did not start" >&2; exit 2; }
# Production's sessions (PostgREST, pg_cron) run in UTC; the installer's may not.
export PGTZ=UTC
# DB names the database every helper below talks to: postgres, or one of the
# copies the LOCK and ORDER scenarios take of it.
DB=postgres
psql_as() { local user="$1"; shift; "${pg_bindir}/psql" -X -q -h "${workdir}" -p "${port}" -U "$user" -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
psql() { psql_as postgres "$@"; }
val() { psql -t -A -c "$1"; }

failures=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures + 1)); }
expect() { # expect <label> <actual> <wanted>
  if [[ "$2" == "$3" ]]; then pass "$1 ($2)"; else fail "$1 (got '$2', wanted '$3')"; fi
}
could_not_run() { echo "COULD NOT RUN: $1" >&2; exit 2; }

psql_as supabase_admin -f "${store_only_fixture}/roles.sql" >/dev/null
psql -f "${store_only_fixture}/schema.sql" >/dev/null
psql -f "${fixture_dir}/schema.sql" >/dev/null

# ----------------------------------------------------- FIXTURE = PRODUCTION --
fn_md5() { val "select md5(pg_get_functiondef('$1'::regprocedure))"; }
for f in "${!VERBATIM[@]}"; do
  got="$(fn_md5 "$f")"
  [[ "$got" == "${VERBATIM[$f]}" ]] || could_not_run "fixture $f is $got, production is ${VERBATIM[$f]}"
done
for t in "${!TRIGGERS[@]}"; do
  got="$(val "select md5(pg_get_triggerdef(oid)) from pg_trigger where tgrelid='public.notifications'::regclass and tgname='$t'")"
  [[ "$got" == "${TRIGGERS[$t]}" ]] || could_not_run "fixture trigger $t is '$got', production is ${TRIGGERS[$t]}"
done
[[ "$(val "select count(*) from pg_trigger where tgrelid='public.notifications'::regclass and not tgisinternal")" == "${#TRIGGERS[@]}" ]] \
  || could_not_run "the fixture's notifications triggers are not production's ${#TRIGGERS[@]}"
echo "fixture: ${#VERBATIM[@]} functions and every notifications trigger equal production (before store-only delivery)"

# The guard re-checks every store-only @live-proof, verbatim: a change to
# either migration that breaks the link fails here.
n=0
while IFS= read -r proof; do
  n=$((n + 1))
  grep -qF "  IF ${proof} IS NOT TRUE THEN" "$migration" || fail "the guard does not re-check store-only @live-proof ${n}: ${proof}"
done < <(sed -n 's/^-- @live-proof: \(.*\)$/\1/p' "$store_only")
expect "the guard re-checks every store-only @live-proof, verbatim" \
  "$(grep -c '^  IF (SELECT .* IS NOT TRUE THEN$' "$migration")" "$n"
# check-migrations-applied reads schema-manifest fragments for new objects;
# this migration replaces one function and creates nothing, so it needs none.
expect "the migration creates no function, table, view or trigger (no schema-manifest fragment is needed)" \
  "$(grep -cE '^CREATE (FUNCTION|TABLE|VIEW|TRIGGER|CONSTRAINT TRIGGER|INDEX|UNIQUE INDEX)' "$migration" || true)" "0"
mapfile -t PROOFS < <(sed -n 's/^-- @live-proof: \(.*\)$/\1/p' "$migration")
expect "the migration declares its three @live-proof expressions" "${#PROOFS[@]}" "3"
proof() { val "select coalesce((select (${PROOFS[$(($1 - 1))]}))::text, 'null')"; }
proofs() { echo "$(proof 1)|$(proof 2)|$(proof 3)"; }

# ---------------------------------------------------------------- helpers ----
psql <<'SQL' >/dev/null
-- Every row of every table, as one digest: a refusal must leave it as it was.
create function public.probe_every_row() returns text language plpgsql as $$
declare t regclass; v text; acc text := '';
begin
  for t in select c.oid::regclass from pg_class c join pg_namespace s on s.oid = c.relnamespace
            where c.relkind in ('r','p') and s.nspname not in ('pg_catalog','information_schema')
              and s.nspname not like 'pg\_toast%' order by s.nspname, c.relname loop
    execute format('select md5(coalesce(string_agg(to_jsonb(x)::text, %L order by to_jsonb(x)::text), %L)) from only %s x', ',', '', t) into v;
    acc := acc || t::text || '=' || v || ';';
  end loop;
  return md5(acc);
end $$;
-- The held cleanup's per-row proof (20260928000622, header 6), over its
-- candidate set: every owner-operational row in the owner's inbox. Run in UTC.
create function public.probe_cleanup_proof() returns text language sql as $$
  select format('proven %s, no destination %s, pending receipt %s, foreign receipt %s, content differs %s',
    count(*) filter (where cause = 'proven'), count(*) filter (where cause = 'no destination'),
    count(*) filter (where cause = 'pending receipt'), count(*) filter (where cause = 'foreign receipt'),
    count(*) filter (where cause = 'content differs'))
  from (select case
      when d.notification_id is null then 'no destination'
      when d.inbox_event_id is null then 'pending receipt'
      when e.source is distinct from 'owner-operational-notifications'
        or e.event_key is distinct from n.id::text
        or e.payload->>'target_task_id' is distinct from '01a09b86-5ba8-7290-8657-1041f13dd3ca' then 'foreign receipt'
      when (d.original_notification - array['read','is_read','read_at','updated_at'])
             is distinct from (to_jsonb(n) - array['read','is_read','read_at','updated_at'])
        or ((e.payload->'original_notification') - array['read','is_read','read_at','updated_at'])
             is distinct from (to_jsonb(n) - array['read','is_read','read_at','updated_at']) then 'content differs'
      else 'proven' end as cause
    from public.notifications n
    left join public.operational_notification_destinations d
      on d.notification_id = n.id and d.recipient_user_id = n.user_id
     and d.target_task_id = '01a09b86-5ba8-7290-8657-1041f13dd3ca'
    left join public.operational_alert_events e on e.id = d.inbox_event_id
   where n.user_id = '47965354-0e56-43ef-931c-ddaab82af765'
     and public.fn_is_owner_operational_notification(n.user_id, n.type, n.title, n.data)) x
$$;
SQL
state() { val "select public.probe_every_row() || ' ' || md5(pg_get_functiondef('${CLASSIFIER}'::regprocedure))"; }
# attempt <sql>: runs <sql> (it sets its own role) as one implicit transaction
# and prints "ok", or "<SQLSTATE>|<message>|<PL/pgSQL function that raised, or ->".
attempt() {
  local out
  if out="$(psql -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "ok"; return; fi
  local code msg fn
  code="$(printf '%s\n' "$out" | sed -n 's/^.*ERROR:  \([0-9A-Z]\{5\}\): .*$/\1/p' | head -1)"
  msg="$(printf '%s\n' "$out" | sed -n 's/^.*ERROR:  [0-9A-Z]\{5\}: \(.*\)$/\1/p' | head -1)"
  fn="$(printf '%s\n' "$out" | grep -o 'PL/pgSQL function [a-z_]*(' | head -1 | sed 's/^PL\/pgSQL function \(.*\)($/\1/' || true)"
  echo "${code}|${msg}|${fn:--}"
}
refused() { # refused <label> <sql> <expected attempt result>: refused, and nothing stored
  local before got
  before="$(state)"
  got="$(attempt "$2")"
  if [[ "$got" == "$3" && "$before" == "$(state)" ]]; then pass "$1 (${got%%|*}, nothing stored)"
  elif [[ "$got" == "$3" ]]; then fail "$1 (refused as expected, but something was stored)"
  else fail "$1 (got '$got', wanted '$3')"; fi
}
install_refused() { # <label> <setup sql> <undo sql> <error>: refused for that reason, nothing changed
  local before out
  [[ -z "$2" ]] || psql -c "$2" >/dev/null
  before="$(state)"
  if out="$(psql -f "$migration" 2>&1)"; then fail "$1: the migration applied"; [[ -z "$3" ]] || psql -c "$3" >/dev/null; return; fi
  if [[ "$out" != *"$4"* ]]; then fail "$1: refused for another reason: $(printf '%s\n' "$out" | grep -m1 ERROR || true)"
  elif [[ "$before" == "$(state)" ]]; then pass "$1 (refused: $4; nothing changed)"
  else fail "$1: the refusal changed something"; fi
  [[ -z "$3" ]] || psql -c "$3" >/dev/null
}
# The route's rows, as smarter-poker-workers writes them (service-role key,
# notifyUnionSettlementProblem): data {union_id, union_name, ...flags}, and
# since its marker (branch 51901eb) {component, alertname, severity} as well.
# The owner's production rows were written before the marker existed.
problem_data() { # problem_data <title> [marked]
  local base marker
  case "$1" in
    "$NEEDS") base="jsonb_build_object('union_id','${UNION_ID}','union_name','Union One','reason','imbalance','settlement_id','bbbbbbbb-0000-4000-8000-000000000001','needs_review',true)"
              marker="'UnionPlayerPnlNeedsReview','severity','warning'" ;;
    "$FAILED") base="jsonb_build_object('union_id','${UNION_ID}','union_name','Union One','error','[object Object]','failed',true)"
               marker="'UnionPlayerPnlFailed','severity','critical'" ;;
    "$RULE") base="jsonb_build_object('union_id','${UNION_ID}','union_name','Union One','violations',jsonb_build_array(jsonb_build_object('invariant','club_net_zero_sum','severity','critical','offenders',1)),'governance_check',true)"
             marker="'UnionRuleViolation','severity','critical'" ;;
  esac
  if [[ "${2:-}" == marked ]]; then echo "(${base} || jsonb_build_object('component','workers.auto-settlement','alertname',${marker}))"; else echo "$base"; fi
}
problem() { # problem <recipient> <title> <message> [marked]: one settlement problem notice, as the route writes it
  echo "set role service_role; insert into public.notifications(user_id,type,title,message,data,read) values ('$1','settlement','$2','$3',$(problem_data "$2" "${4:-}"),false)"
}
PUSH_OFF_SQL="'${PUSH_OFF}'"
push_off() { # push_off <recipient> <message> <data sql> [title sql]: World Hub push-health's staff notice
  echo "set role service_role; insert into public.notifications(user_id,type,title,message,action_url,link,data,read,is_read) values ('$1','system',${4:-$PUSH_OFF_SQL},'$2','/hub/settings/notifications','/hub/settings/notifications',$3,false,false)"
}
rows_titled() { val "select count(*) from public.notifications where user_id='$1' and message='$2'"; }
pushes_of() { val "select count(*) from public.push_outbox p join public.notifications n on n.id=p.related_entity_id where n.message='$1'"; }
receipted() { # destinations of an original with that message, and their task receipt
  val "select count(*) from public.operational_notification_destinations d join public.operational_alert_events e on e.id=d.inbox_event_id where d.original_notification->>'message'='$1' and e.source='owner-operational-notifications' and e.event_key=d.notification_id::text and e.payload->>'target_task_id'='${TASK}'"
}
new_kinds="user_id='${OWNER}' and ((type='settlement' and title in ('${NEEDS}','${FAILED}','${RULE}')) or (type='system' and title='${PUSH_OFF}'))"
preserved_new_kinds() { # the owner's rows of these kinds with their destination and task receipt
  val "select count(*) from public.notifications n join public.operational_notification_destinations d on d.notification_id=n.id and d.recipient_user_id=n.user_id and d.target_task_id='${TASK}' join public.operational_alert_events e on e.id=d.inbox_event_id and e.source='owner-operational-notifications' and e.event_key=n.id::text and e.payload->>'target_task_id'='${TASK}' where n.${new_kinds}"
}
left_after_cleanup() { # the install's record of rows left after the cleanup: status|severity|rows|ids|task
  val "select coalesce(string_agg(e.status||'|'||e.severity||'|'||(e.payload->>'rows')||'|'||jsonb_array_length(e.payload->'notification_ids')||'|'||(e.payload->>'target_task_id'), ' ; '), 'none') from public.operational_alert_events e where e.source='owner-inbox-routing-guard' and e.alertname='OwnerOperationalOriginalsLeftAfterCleanup'"
}
share_waiting="select count(*) from pg_locks l where l.locktype='relation' and l.mode='ShareLock' and not l.granted and l.database=(select oid from pg_database where datname=current_database()) and l.relation='public.notifications'::regclass"
wait_for() { # wait_for <label> <sql> <value>: polls <sql> in $DB, up to 10 s, until it returns <value>
  local i=0
  until [[ "$(val "$2")" == "$3" ]]; do
    i=$((i + 1)); if (( i > 200 )); then fail "$1 (timed out)"; return 0; fi
    sleep 0.05
  done
}
# race_writer <message> <until> <end>: in the background, a service_role
# transaction in $DB writes the owner a settlement problem notice, as the route
# does, and stays open until <until> - 'waiting': the install waits for its
# lock; 'queued': the install and a later writer both wait; 'gave-up': the
# install waited and gave up; 'installed': the new classifier is committed -
# then ends with <end> (commit or rollback). It returns once the notice is
# written: the writer takes advisory lock 4242 only after its INSERT.
race_writer() {
  psql >"${workdir}/writer-${DB}.log" 2>&1 <<SQL &
begin;
$(problem "$OWNER" "$FAILED" "$1");
reset role;
select pg_advisory_xact_lock(4242);
do \$w\$
declare i integer := 0; v_share boolean; v_row boolean; v_seen boolean := false; v_done text := 'timed out';
begin
  while i < 400 loop
    i := i + 1;
    select count(*) > 0 into v_share from pg_locks l
     where l.locktype = 'relation' and l.mode = 'ShareLock' and not l.granted
       and l.database = (select oid from pg_database where datname = current_database())
       and l.relation = 'public.notifications'::regclass;
    select count(*) > 0 into v_row from pg_locks l
     where l.locktype = 'relation' and l.mode = 'RowExclusiveLock' and not l.granted
       and l.database = (select oid from pg_database where datname = current_database())
       and l.relation = 'public.notifications'::regclass;
    if '$2' = 'waiting' and v_share then v_done := 'saw the install waiting'; exit; end if;
    if '$2' = 'queued' and v_share and v_row then v_done := 'saw the install and a later writer waiting'; exit; end if;
    if '$2' = 'gave-up' then
      if v_share then v_seen := true; elsif v_seen then v_done := 'saw the install give up'; exit; end if;
    end if;
    if '$2' = 'installed' and (select position('push notifications are off' in prosrc) > 0 from pg_proc
                                where oid = '${CLASSIFIER}'::regprocedure) then
      v_done := 'saw the new classifier committed'; exit;
    end if;
    perform pg_sleep(0.05);
  end loop;
  raise notice 'writer: %', v_done;
end \$w\$;
$3;
SQL
  writer=$!
  wait_for "the ${DB} writer wrote its notice" \
    "select count(*) from pg_locks where locktype='advisory' and objid=4242 and granted and database=(select oid from pg_database where datname=current_database())" "1"
}
# writer_said: waits for the writer (in this shell: a subshell cannot wait for
# it) and prints what it saw.
writer_said() { wait "$writer" || true; said="$(grep -o 'writer: .*' "${workdir}/writer-${DB}.log" | head -1 || true)"; }

# ---------------------------------------------------------------- HISTORY ----
# The owner's inbox as production wrote it before store-only delivery: the
# route's three problem notices (2 failed, 1 rule violation, as in production),
# the 2026-08-19 'Push Notifications Are Off' (data SQL NULL, as in
# production), an operational row the capture recorded when it was written,
# and his and others' ordinary notices.
for sql in "$(problem "$OWNER" "$FAILED" 'history failed 1')" "$(problem "$OWNER" "$RULE" 'history rule 1')" \
           "$(problem "$OWNER" "$FAILED" 'history failed 2')" "$(push_off "$OWNER" 'history push off' NULL)" \
           "$(problem "$OTHER" "$FAILED" 'history other failed')" "$(push_off "$OTHER" 'history other push off' "'{\"_push\":\"none\"}'")"; do
  psql -c "$sql" >/dev/null
done
psql <<SQL >/dev/null
set role service_role;
insert into public.notifications(user_id,type,title,message,data,read) values
  ('${OWNER}','settlement',${COMPLETE},'history settlement complete',
   jsonb_build_object('club_id','cccccccc-0000-4000-8000-000000000001','period_id','dddddddd-0000-4000-8000-000000000001','total_rake',10),false),
  ('${OTHER}','settlement',${COMMISSION},'history other commission',
   jsonb_build_object('club_id','cccccccc-0000-4000-8000-000000000001','period_number',7,'commission',1.5),false);
select public.fn_raise_notification('${OWNER}','financial_incident','Captured when written','history captured');
reset role;
-- the dispatcher delivered the history's pushes
update public.push_outbox set status='sent', sent_at=now();
SQL
expect "history: the owner's problem notices and push-off reached his inbox and his phone's queue" \
  "$(val "select count(*) from public.notifications where ${new_kinds}")|$(val "select count(*) from public.push_outbox where recipient_user_id='${OWNER}' and event in ('settlement','system')")" "4|5"
expect "history: the owner's push-off row has SQL NULL data, as production's does" \
  "$(val "select count(*) from public.notifications where message='history push off' and data is null")" "1"

# ------------------------------------------------ REFUSED WITHOUT STORE-ONLY --
install_refused "without store-only delivery the migration is refused, naming each missing piece" "" "" \
  "OWNER_CLASSIFIER_NEEDS_STORE_ONLY_DELIVERY: capture, break scorecard reader, guarantee bank reader, alarm drill reader, authority trigger, detector trigger missing"

psql -f "$store_only" >"${workdir}/store-only.log" 2>&1 || { cat "${workdir}/store-only.log"; could_not_run "store-only delivery (20260927235053) did not install on the fixture"; }
pass "store-only delivery (20260927235053) installed, its install checks included"

# ---------------------------------------------------------------- RED --------
psql -c "$(problem "$OWNER" "$NEEDS" 'red needs review')" >/dev/null
psql -c "$(push_off "$OWNER" 'red push off' "'{}'")" >/dev/null
red="$(rows_titled "$OWNER" 'red needs review')|$(pushes_of 'red needs review')|$(rows_titled "$OWNER" 'red push off')|$(pushes_of 'red push off')|$(val "select count(*) from public.notifications where ${new_kinds} and public.fn_is_owner_operational_notification(user_id,type,title,data)")"
if [[ "$red" == "1|1|1|1|0" ]]; then
  echo "RED   with store-only delivery and without this migration, the owner's settlement problem notice and 'Push Notifications Are Off' each reached his personal inbox and push_outbox, and none of his 6 rows of these kinds is operational (the held cleanup leaves them): the defect reproduces"
else
  echo "FAIL  red phase did not reproduce the defect (personal|push|personal|push|classified: $red)"
  exit 1
fi

# The database as RED left it, copied for the scenarios that need their own:
# the install racing writers, with and without its lock, and the cleanup first.
for copy in lockwait nolock orderb; do
  DB=template1 psql -c "create database ${copy} template postgres" >/dev/null
done

# ---------------------------------------------------------------- NECESSITY --
classifier_sql="$(sed -n '/^CREATE OR REPLACE FUNCTION public.fn_is_owner_operational_notification($/,/^\$body\$;$/p' "$migration")"
if [[ -z "$classifier_sql" ]]; then
  fail "the migration defines no classifier, so there is nothing to show necessary"
else
expect "necessity: the classifier alone would leave the owner's 6 rows of these kinds with no store copy (the cleanup refuses them)" \
  "$(psql -t -A <<SQL
begin;
${classifier_sql}
select public.probe_cleanup_proof();
rollback;
SQL
)" "proven 1, no destination 6, pending receipt 0, foreign receipt 0, content differs 0"
expect "necessity: captured from an America/Chicago session, their originals would not be provable in the cleanup's UTC proof" \
  "$(psql -t -A <<SQL
begin;
${classifier_sql}
set local timezone = 'America/Chicago';
do \$c\$ begin perform public.fn_capture_owner_notification_history(200); end \$c\$;
set local timezone = 'UTC';
select public.probe_cleanup_proof();
rollback;
SQL
)" "proven 1, no destination 0, pending receipt 0, foreign receipt 0, content differs 6"
# The same classifier with its whitespace class a plain '...' literal: a SQL
# function body is lexed in the calling session.
e_class="E'[\\\\t\\\\n\\\\v\\\\f\\\\r ]+'"
plain_class="'[\\t\\n\\v\\f\\r ]+'"
plain_sql="${classifier_sql//"$e_class"/"$plain_class"}"
if [[ "$plain_sql" == "$classifier_sql" ]]; then
  fail "the classifier does not write its whitespace class as ${e_class}"
else
  expect "necessity: with the whitespace class a plain literal, a writer session with standard_conforming_strings off is not classified (its notice reaches the inbox)" \
    "$(psql -t -A <<SQL
set client_min_messages = error;
begin;
${plain_sql}
set local standard_conforming_strings = off;
$(problem "$OWNER" "$NEEDS" 'necessity scs off' | sed 's/^set role service_role; //');
select count(*) from public.notifications where message='necessity scs off';
rollback;
SQL
)" "1"
fi
fi
# Without its SET LOCAL standard_conforming_strings = on, an installer session
# with it off cannot parse the install proof's U&'' literal (rolled back).
before="$(state)"
without_scs="$(grep -v '^SET LOCAL standard_conforming_strings = on;$' "$migration" | sed '/^BEGIN;$/d; /^COMMIT;$/d')"
if [[ "$without_scs" == "$(sed '/^BEGIN;$/d; /^COMMIT;$/d' "$migration")" ]]; then
  fail "the migration does not SET LOCAL standard_conforming_strings = on"
else
  expect "necessity: without SET LOCAL standard_conforming_strings = on, an installer session with it off cannot install (refusal|state)" \
    "$(printf 'begin;\n%s\nrollback;\n' "$without_scs" | PGOPTIONS='-c standard_conforming_strings=off' psql 2>&1 | grep -o 'unsafe use of string constant with Unicode escapes' | head -1)|$([[ "$before" == "$(state)" ]] && echo unchanged || echo changed)" \
    "unsafe use of string constant with Unicode escapes|unchanged"
fi
# Without its SHARE lock (the review's reproduction, in the copy nolock): a
# service_role writer whose transaction is open when the install starts, and
# commits once the new classifier is committed, keeps a personal row that no
# destination holds - the state @live-proof 2 and the cleanup refuse.
DB=nolock
without_lock="${workdir}/without-lock.sql"
grep -v '^LOCK TABLE public.notifications IN SHARE MODE;$' "$migration" >"$without_lock" || true
if cmp -s "$without_lock" "$migration"; then
  fail "the migration takes no SHARE lock on notifications"
else
  race_writer 'race without the lock' installed commit
  psql -f "$without_lock" >"${workdir}/without-lock.log" 2>&1 \
    || { cat "${workdir}/without-lock.log"; fail "the variant without the lock did not install"; }
  writer_said
  expect "necessity: without the SHARE lock, a writer open across the install commits after it and leaves a personal row with no destination (writer|personal rows|destinations|@live-proof 2)" \
    "${said}|$(rows_titled "$OWNER" 'race without the lock')|$(val "select count(*) from public.operational_notification_destinations d join public.notifications n on n.id=d.notification_id where n.message='race without the lock'")|$(proof 2)" \
    "writer: saw the new classifier committed|1|0|false"
fi
DB=postgres

# ------------------------------------------------------- INSTALL REFUSALS ----
psql -c "create table public.probe_images as
  select k, pg_get_functiondef(r::regprocedure) as def
    from (values ('classifier','${CLASSIFIER}'),
                 ('history','public.fn_capture_owner_notification_history(integer)')) v(k, r);" >/dev/null
restore() { psql -c "do \$u\$ begin execute (select def from public.probe_images where k='$1'); end \$u\$;" >/dev/null; }
install_refused "a partial store-only install (its detector disabled) is refused" \
  "alter table public.notifications disable trigger zz_owner_operational_original_reached_personal_inbox" \
  "alter table public.notifications enable trigger zz_owner_operational_original_reached_personal_inbox" \
  "OWNER_CLASSIFIER_NEEDS_STORE_ONLY_DELIVERY: detector trigger missing"
install_refused "a changed classifier source is refused" \
  "$(printf '%s\n' "$(val "select def from public.probe_images where k='classifier'")" | sed 's/),false);$/), false);/')" \
  "" "OWNER_CLASSIFIER_SOURCE_OR_AUTHORITY_CHANGED"
restore classifier
install_refused "a changed classifier ACL (EXECUTE granted to PUBLIC) is refused" \
  "grant execute on function ${CLASSIFIER} to public" "revoke execute on function ${CLASSIFIER} from public" \
  "OWNER_CLASSIFIER_SOURCE_OR_AUTHORITY_CHANGED"
install_refused "a changed history intake is refused" \
  "$(printf '%s\n' "$(val "select def from public.probe_images where k='history'")" | sed 's/LIMIT p_limit$/LIMIT p_limit /')" \
  "" "OWNER_NOTIFICATION_INTAKE_CHANGED"
restore history
install_refused "an index holding the classifier's answer is refused" \
  "create index probe_owner_operational on public.notifications (id) where public.fn_is_owner_operational_notification(user_id,type,title,data)" \
  "drop index public.probe_owner_operational" "OWNER_CLASSIFIER_HAS_STORED_DEPENDENTS: index probe_owner_operational"
expect "the pre-images are back after the refusals" "$(fn_md5 "$CLASSIFIER")|$(fn_md5 'public.fn_capture_owner_notification_history(integer)')" \
  "${PRE_CLASSIFIER}|${VERBATIM["public.fn_capture_owner_notification_history(integer)"]}"
# A writer holding notifications past the install's 3 s lock_timeout.
before="$(state)"
race_writer 'writer past the lock timeout' gave-up rollback
if out="$(psql -f "$migration" 2>&1)"; then refusal="applied"
elif [[ "$out" == *"canceling statement due to lock timeout"* ]]; then refusal="refused: lock timeout"
else refusal="$(printf '%s\n' "$out" | grep -m1 ERROR || echo failed)"; fi
writer_said
expect "a notification writer holding its lock past lock_timeout refuses the install, and nothing changes (install|writer|state)" \
  "${refusal}|${said}|$([[ "$before" == "$(state)" ]] && echo unchanged || echo changed)" \
  "refused: lock timeout|writer: saw the install give up|unchanged"

# ---------------------------------------------------------------- APPLY ------
psql -c "create table public.probe_before as select id, to_jsonb(n) as row from public.notifications n;
         create table public.probe_push_before as select to_jsonb(p) as row from public.push_outbox p;" >/dev/null
PGTZ=America/Chicago psql -f "$migration" >"${workdir}/apply.log" 2>&1 \
  || { cat "${workdir}/apply.log"; echo "FAIL  migration did not apply"; exit 1; }
pass "migration applied from an America/Chicago session, its install checks included"
expect "it reports the owner's 6 existing rows of these kinds preserved" \
  "$(grep -o 'owner classifier: [0-9]* existing owner row(s)' "${workdir}/apply.log")" "owner classifier: 6 existing owner row(s)"
expect "classifier post-image md5" "$(fn_md5 "$CLASSIFIER")" "$POST_CLASSIFIER"
expect "classifier keeps its owner, ACL, settings, IMMUTABLE, PARALLEL SAFE and SECURITY INVOKER" \
  "$(val "select pg_get_userbyid(proowner)||' '||proacl::text||' '||proconfig::text||' '||provolatile::text||proparallel::text||' '||prosecdef::text from pg_proc where oid='${CLASSIFIER}'::regprocedure")" \
  'postgres {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres} {"search_path=pg_catalog, public"} is false'
expect "every @live-proof holds, the cleanup not yet installed (1|2|3)" "$(proofs)" "true|true|true"

# ---------------------------------------------------------------- GREEN ------
expect "each existing owner row of these kinds has its destination and its task receipt" "$(preserved_new_kinds)" "6"
expect "the held cleanup's per-row proof holds for every owner-operational row, these included" \
  "$(val "select public.probe_cleanup_proof()")" "proven 7, no destination 0, pending receipt 0, foreign receipt 0, content differs 0"
expect "their receipts are what the capture records: alertname type:title, firing, warning, the complete original" \
  "$(val "select string_agg(distinct e.alertname||'|'||e.status||'|'||e.severity||'|'||(e.payload->'original_notification' = d.original_notification)::text||'|'||(e.payload ? 'captured_at')::text, ' ; ') from public.operational_notification_destinations d join public.operational_alert_events e on e.id=d.inbox_event_id join public.notifications n on n.id=d.notification_id where n.${new_kinds}")" \
  "settlement:Union rule violation detected|firing|warning|true|true ; settlement:Weekly player P&L failed|firing|warning|true|true ; settlement:Weekly player P&L needs review|firing|warning|true|true ; system:Push Notifications Are Off|firing|warning|true|true"
expect "no notification row was modified or deleted" \
  "$(val "select count(*)||'|'||count(*) filter (where b.row = to_jsonb(n)) from public.probe_before b left join public.notifications n on n.id=b.id")|$(val "select count(*) from public.notifications")" \
  "$(val "select count(*)||'|'||count(*) from public.probe_before")|$(val "select count(*) from public.probe_before")"
expect "no push_outbox row was written or changed" \
  "$(val "select md5(string_agg(to_jsonb(p)::text, ',' order by to_jsonb(p)::text)) from public.push_outbox p")" \
  "$(val "select md5(string_agg(row::text, ',' order by row::text)) from public.probe_push_before")"
expect "only the owner's rows of these kinds were captured (other recipients and business notices: none)" \
  "$(val "select count(*) from public.operational_notification_destinations d join public.notifications n on n.id=d.notification_id where not (n.${new_kinds}) and n.type <> 'financial_incident'")" "0"
expect "installed before the cleanup, it records nothing as left behind" "$(left_after_cleanup)" "none"

pushes_before="$(val "select count(*) from public.push_outbox")"
routed() { # routed <label> <sql>: no personal row, one receipted destination, no push
  psql -c "$2" >/dev/null
  expect "green: $1 is delivered to the task only (personal rows|receipted destinations|pushes)" \
    "$(val "select count(*) from public.notifications where message='green $1'")|$(receipted "green $1")|$(val "select count(*) from public.push_outbox")" "0|1|${pushes_before}"
}
for title in "$NEEDS" "$FAILED" "$RULE"; do
  routed "marked ${title}" "$(problem "$OWNER" "$title" "green marked ${title}" marked)"
done
expect "a marked notice is filed under its alertname and severity" \
  "$(val "select string_agg(e.alertname||'|'||e.severity, ' ; ' order by e.alertname) from public.operational_notification_destinations d join public.operational_alert_events e on e.id=d.inbox_event_id where d.original_notification->>'message' like 'green marked %'")" \
  "UnionPlayerPnlFailed|critical ; UnionPlayerPnlNeedsReview|warning ; UnionRuleViolation|critical"
routed "unmarked ${RULE}" "$(problem "$OWNER" "$RULE" "green unmarked ${RULE}")"
routed "a case- and space-folded title" \
  "set role service_role; insert into public.notifications(user_id,type,title,message,data) values ('${OWNER}','settlement',E' WEEKLY  player P&L\\tFAILED ','green a case- and space-folded title','{}')"
routed "the marker under another title" \
  "set role service_role; insert into public.notifications(user_id,type,title,message,data) values ('${OWNER}','settlement','Weekly settlement parked','green the marker under another title',jsonb_build_object('component','workers.auto-settlement','alertname','UnionPlayerPnlNeedsReview','severity','warning'))"
routed "a writer with standard_conforming_strings off" \
  "set standard_conforming_strings = off; $(problem "$OWNER" "$NEEDS" 'green a writer with standard_conforming_strings off')"
routed "Push Notifications Are Off" "$(push_off "$OWNER" 'green Push Notifications Are Off' "'{\"_push\":\"none\"}'")"
routed "a folded Push Notifications Are Off" \
  "$(push_off "$OWNER" 'green a folded Push Notifications Are Off' "'{}'" "E' push  NOTIFICATIONS are\\tOFF '")"
routed "a folded Push Notifications Are Off with data NULL, from a writer with standard_conforming_strings off" \
  "set standard_conforming_strings = off; $(push_off "$OWNER" 'green a folded Push Notifications Are Off with data NULL, from a writer with standard_conforming_strings off' NULL "'PUSH NOTIFICATIONS ARE OFF'")"

ordinary() { # ordinary <label> <recipient> <type> <title sql> <message> <pushes wanted> [data sql]
  psql -c "set role service_role; insert into public.notifications(user_id,type,title,message,data,read) values ('$2','$3',$4,'$5',${7:-'{}'::jsonb},false)" >/dev/null
  expect "$1 (personal rows|destinations|pushes)" \
    "$(rows_titled "$2" "$5")|$(val "select count(*) from public.operational_notification_destinations where original_notification->>'message'='$5'")|$(pushes_of "$5")" "1|0|$6"
}
ordinary "unchanged: the owner's Commission Received" "$OWNER" settlement "$COMMISSION" 'green commission' 1
ordinary "unchanged: the owner's Settlement Complete" "$OWNER" settlement "$COMPLETE" 'green complete' 1
ordinary "unchanged: the owner's Cash-Out Request (Club Arena NotificationService)" "$OWNER" settlement "'Cash-Out Request'" 'green cash-out' 1
ordinary "not classified: a problem title and marker under type system" "$OWNER" system "'${FAILED}'" 'green system failed' 1 \
  "jsonb_build_object('component','workers.auto-settlement','alertname','UnionPlayerPnlFailed')"
ordinary "not classified: a title the route does not write" "$OWNER" settlement "'Weekly player P&L settled'" 'green settled' 1
ordinary "not classified: a non-ASCII case fold (only ASCII folds, as in the World Hub mirror)" \
  "$OWNER" settlement "U&'WEEKLY PLAYER P&L FA\\0130LED'" 'green non-ascii fold' 1
ordinary "not classified: the route's component with an alertname that is not a problem" "$OWNER" settlement "$COMPLETE" 'green foreign alertname' 1 \
  "jsonb_build_object('component','workers.auto-settlement','alertname','UnionSettlementComplete')"
ordinary "not classified: a problem alertname from another component" "$OWNER" settlement "$COMPLETE" 'green foreign component' 1 \
  "jsonb_build_object('component','workers.other','alertname','UnionPlayerPnlFailed')"
ordinary "not classified: a near miss of the push-off title" "$OWNER" system "'Push Notifications Are Offline'" 'green push offline' 1
ordinary "not classified: the push-off title under type settlement" "$OWNER" settlement "'${PUSH_OFF}'" 'green settlement push off' 1
psql -c "$(problem "$OTHER" "$FAILED" 'green other failed' marked)" >/dev/null
expect "unchanged: another recipient's settlement problem notice (personal rows|destinations|pushes)" \
  "$(rows_titled "$OTHER" 'green other failed')|$(val "select count(*) from public.operational_notification_destinations where original_notification->>'message'='green other failed'")|$(pushes_of 'green other failed')" "1|0|1"
psql -c "$(push_off "$OTHER" 'green other push off' "'{\"_push\":\"none\"}'")" >/dev/null
expect "unchanged: another recipient's 'Push Notifications Are Off' (personal rows|destinations|pushes)" \
  "$(rows_titled "$OTHER" 'green other push off')|$(val "select count(*) from public.operational_notification_destinations where original_notification->>'message'='green other push off'")|$(pushes_of 'green other push off')" "1|0|0"
psql -c "$(push_off "$OTHER" 'green other folded push off' NULL "E'push notifications  ARE OFF\\t'")" >/dev/null
expect "unchanged: another recipient's folded push-off with data NULL (personal rows|destinations|pushes)" \
  "$(rows_titled "$OTHER" 'green other folded push off')|$(val "select count(*) from public.operational_notification_destinations where original_notification->>'message'='green other folded push off'")|$(pushes_of 'green other folded push off')" "1|0|1"

# authority: the store-only authority trigger covers these kinds now
AUTH_REFUSAL="42501|new row violates row-level security policy for table \"notifications\"|fn_authorize_owner_operational_original"
as_anon="set role anon;"
as_owner="select set_config('request.jwt.claims', '{\"sub\":\"${OWNER}\",\"role\":\"authenticated\"}', false); set role authenticated;"
refused "anon writing the owner a settlement problem notice is refused by the authority trigger" \
  "${as_anon} insert into public.notifications(user_id,type,title,message) values ('${OWNER}','settlement','${FAILED}','anon')" "$AUTH_REFUSAL"
refused "authenticated (as the owner) writing himself 'Push Notifications Are Off' is refused the same way" \
  "${as_owner} insert into public.notifications(user_id,type,title,message) values ('${OWNER}','system','${PUSH_OFF}','owner')" "$AUTH_REFUSAL"
refused "authenticated (as the owner) writing himself a folded push-off is refused the same way" \
  "${as_owner} insert into public.notifications(user_id,type,title,message) values ('${OWNER}','system','push notifications are OFF','owner')" "$AUTH_REFUSAL"

# visibility: the preserved rows are masked for the owner until the cleanup removes them
expect "the owner no longer reads a preserved row, through the table or personal_notifications" \
  "$(psql -t -A -c "${as_owner} select (select count(*) from public.notifications n where n.${new_kinds})||'|'||(select count(*) from public.personal_notifications n where n.${new_kinds})" | tail -1)" "0|0"
expect "the owner still reads his business settlement notices" \
  "$(psql -t -A -c "${as_owner} select count(*) from public.personal_notifications where message in ('history settlement complete','green commission','green complete','green cash-out')" | tail -1)" "4"

# detection: a settlement problem notice that bypasses the capture is recorded, and not pushed
psql -c "alter table public.notifications disable trigger zz_capture_owner_notification_destination;
         $(problem "$OWNER" "$RULE" 'bypass rule' | sed 's/^set role service_role; //');
         alter table public.notifications enable trigger zz_capture_owner_notification_destination;" >/dev/null
expect "with the capture disabled the notice reaches the inbox, the detector records it for the task, and it is not pushed" \
  "$(rows_titled "$OWNER" 'bypass rule')|$(val "select count(*) from public.operational_alert_events e join public.notifications n on e.event_key=n.id::text where n.message='bypass rule' and e.source='owner-inbox-routing-guard' and e.alertname='OwnerOperationalOriginalReachedPersonalInbox' and e.payload->>'target_task_id'='${TASK}'")|$(pushes_of 'bypass rule')" "1|1|0"
psql -c "delete from public.operational_alert_events where source='owner-inbox-routing-guard';
         delete from public.notifications where message='bypass rule';" >/dev/null

# the migration refuses a second run
if psql -f "$migration" >"${workdir}/second.log" 2>&1; then
  fail "a second run of the migration was accepted"
else
  grep -q "OWNER_CLASSIFIER_SOURCE_OR_AUTHORITY_CHANGED" "${workdir}/second.log" \
    && pass "a second run is refused by its pre-image guard" \
    || { cat "${workdir}/second.log"; fail "a second run failed for an unexpected reason"; }
fi

# ---------------------------------------------------------------- LOCK -------
# In the copy lockwait: a writer open when the install starts, and a second
# that starts while the install waits for its lock. The install waits for the
# first and preserves its notice with the rest; the second waits for the
# install and then meets the new classifier.
DB=lockwait
race_writer 'race open before the install' queued commit
PGTZ=America/Chicago psql -f "$migration" >"${workdir}/lockwait.log" 2>&1 &
install=$!
wait_for "the install waits for its lock" "$share_waiting" "1"
psql -c "$(problem "$OWNER" "$FAILED" 'race written while the install waits')" >"${workdir}/queued.log" 2>&1 &
queued=$!
installed=0; wait "$install" || installed=$?
wait "$queued" || true
writer_said
[[ "$installed" == 0 ]] || { cat "${workdir}/lockwait.log"; fail "the install did not complete after waiting for its lock"; }
expect "with the lock, the install waits for the open writer and preserves its notice with the rest (writer|preserved|personal rows|receipted destinations)" \
  "${said}|$(grep -o 'owner classifier: [0-9]* existing owner row(s)' "${workdir}/lockwait.log")|$(rows_titled "$OWNER" 'race open before the install')|$(receipted 'race open before the install')" \
  "writer: saw the install and a later writer waiting|owner classifier: 7 existing owner row(s)|1|1"
expect "a writer that starts while the install waits meets the new classifier: delivered store-only (personal rows|receipted destinations)" \
  "$(rows_titled "$OWNER" 'race written while the install waits')|$(receipted 'race written while the install waits')" "0|1"
expect "every @live-proof holds after the race (1|2|3)" "$(proofs)" "true|true|true"
DB=postgres

# ---------------------------------------------------------------- ORDER ------
# The documented order: this, then the held cleanup.
if [[ -f "$cleanup_migration" ]]; then
  psql -c "create table public.probe_before_cleanup as select id, to_jsonb(n) as row from public.notifications n where ${new_kinds} or (user_id='${OWNER}' and type='financial_incident');" >/dev/null
  PGTZ=America/Chicago psql -f "$cleanup_migration" >"${workdir}/cleanup.log" 2>&1 \
    || { cat "${workdir}/cleanup.log"; fail "the held cleanup did not apply after this migration"; }
  expect "documented order: the held cleanup then leaves no owner-operational row, these kinds included" \
    "$(val "select count(*) from public.notifications where user_id='${OWNER}' and public.fn_is_owner_operational_notification(user_id,type,title,data)")" "0"
  expect "documented order: it kept every one of them, exactly as it stood" \
    "$(val "select count(*) from public.probe_before_cleanup b join public.owner_inbox_operational_removals r on r.notification_id=b.id and r.personal_row=b.row")" \
    "$(val "select count(*) from public.probe_before_cleanup")"
  expect "documented order: the owner's business and near-miss notices stay" \
    "$(val "select count(*) from public.notifications where user_id='${OWNER}' and message in ('history settlement complete','green commission','green complete','green cash-out','green system failed','green settled','green non-ascii fold','green foreign alertname','green foreign component','green push offline','green settlement push off')")" "11"
  expect "documented order: every @live-proof holds after the cleanup (1|2|3)" "$(proofs)" "true|true|true"
else
  echo "NOTE  documented order: the held cleanup 20260928000622 is not in this tree (set OWNER_INBOX_CLEANUP_MIGRATION to its file); its per-row proof was asserted in GREEN"
fi

# The other order, in the copy orderb: the cleanup first. It removes the
# owner-operational originals it knows and never runs again.
DB=orderb
if [[ -f "$cleanup_migration" ]]; then
  psql -f "$cleanup_migration" >"${workdir}/orderb-cleanup.log" 2>&1 \
    || { cat "${workdir}/orderb-cleanup.log"; fail "other order: the held cleanup did not install first"; }
  first="the held cleanup"
else
  psql <<SQL >/dev/null
begin;
create table public.owner_inbox_operational_removals(notification_id uuid primary key,
  removed_at timestamptz not null default clock_timestamp(), personal_row jsonb not null);
insert into public.owner_inbox_operational_removals(notification_id, personal_row)
  select n.id, to_jsonb(n) from only public.notifications n
   where n.user_id='${OWNER}' and public.fn_is_owner_operational_notification(n.user_id,n.type,n.title,n.data);
delete from only public.notifications n using public.owner_inbox_operational_removals r where r.notification_id = n.id;
commit;
SQL
  first="a stand-in for the held cleanup (its file is not in this tree)"
fi
expect "other order: ${first}, installed first, removed the one owner-operational original it knew and left these kinds (removed|these kinds|@live-proof 3)" \
  "$(val "select count(*) from public.owner_inbox_operational_removals")|$(val "select count(*) from public.notifications where ${new_kinds}")|$(proof 3)" "1|6|true"
psql -c "create table public.probe_before as select id, to_jsonb(n) as row from public.notifications n;" >/dev/null
PGTZ=America/Chicago PGOPTIONS='-c standard_conforming_strings=off' psql -f "$migration" >"${workdir}/orderb.log" 2>&1 \
  || { cat "${workdir}/orderb.log"; fail "other order: this migration did not install after the cleanup"; }
expect "other order: this installs anyway (from a session with standard_conforming_strings off) and preserves the owner's 6 rows of these kinds" \
  "$(grep -o 'owner classifier: [0-9]* existing owner row(s)' "${workdir}/orderb.log")|$(preserved_new_kinds)" "owner classifier: 6 existing owner row(s)|6"
expect "other order: no notification row was modified or deleted" \
  "$(val "select count(*)||'|'||count(*) filter (where b.row = to_jsonb(n)) from public.probe_before b left join public.notifications n on n.id=b.id")|$(val "select count(*) from public.notifications")" \
  "$(val "select count(*)||'|'||count(*) from public.probe_before")|$(val "select count(*) from public.probe_before")"
expect "other order: it warns that they stay with nothing to remove them" \
  "$(grep -o 'installed after the held cleanup 20260928000622, so [0-9]* owner-operational row(s) stay' "${workdir}/orderb.log")" \
  "installed after the held cleanup 20260928000622, so 6 owner-operational row(s) stay"
expect "other order: it records them for the fleet task (status|severity|rows|ids|target task)" "$(left_after_cleanup)" "firing|warning|6|6|${TASK}"
expect "other order: @live-proof 3 is false while they stay; 1 and 2 hold (1|2|3)" "$(proofs)" "true|true|false"
pushes_before="$(val "select count(*) from public.push_outbox")"
psql -c "$(problem "$OWNER" "$RULE" 'other order marked' marked)" >/dev/null
expect "other order: a new marked notice is then delivered store-only (personal rows|receipted destinations|pushes)" \
  "$(rows_titled "$OWNER" 'other order marked')|$(receipted 'other order marked')|$(val "select count(*) from public.push_outbox")" "0|1|${pushes_before}"
DB=postgres

if (( failures > 0 )); then
  echo "RESULT: ${failures} assertion(s) failed"
  exit 1
fi
echo "RESULT: red before, green after - all assertions passed"
