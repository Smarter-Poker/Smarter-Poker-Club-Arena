#!/usr/bin/env bash
# =============================================================================
#  THE OWNER'S PERSONAL INBOX KEEPS NO OPERATIONAL ORIGINAL - LIVE PROOF
# =============================================================================
#
# Red before, green after, against a throwaway PostgreSQL cluster on a unix
# socket. Never against production.
#
# supabase/migrations/20260928000622_owner_inbox_keeps_no_operational_original.sql
# removes the operational originals already sitting in the owner account's
# personal inbox (public.notifications), each only after proving it preserved
# in operational_notification_destinations and receipted for the Production
# Alerts task, and keeps each removed row exactly as it stood in
# owner_inbox_operational_removals. It may only run after store-only delivery
# (20260927235053). So this builds production as it stands BEFORE store-only
# delivery from scripts/dev/fixtures/owner-inbox-store-only/ (production's
# roles, default privileges, grants and policies; every function pinned to its
# production md5), writes the owner's history the way production wrote it,
# installs the REAL store-only migration, and then proves:
#
#   RED   before the cleanup the owner's personal inbox holds operational
#         originals (routing test 1 fails); the cleanup's @live-proof,
#         evaluated as scripts/ci/check-migrations-are-live.mjs evaluates it,
#         answers false (not an error) while it is held;
#   REFUSALS, each leaving every row of every table exactly as it was:
#         store-only delivery not installed, and each piece of it missing in
#         turn; a captured original, or the receipt's copy of it, that differs
#         in any of eleven fields (message, data, link, action_url, metadata,
#         title, created_at, type, actor_id, user_id, id); a receipt without
#         its copy and a destination without its original (NULLs that `<>`
#         would let through); a destination addressed to another recipient or
#         task (the table's CHECK dropped for the case); a pending receipt; a
#         receipt not addressed to the task, pointing at another row's
#         receipt, or from another source; a row with no destination; a row
#         push_outbox or accounting_invoice_deliveries references; a DELETE
#         that would reach further - a third foreign key into notifications
#         (CASCADE, SET NULL or NO ACTION), push_outbox's key changed to
#         CASCADE or moved to another column, a DELETE or TRUNCATE trigger, a
#         rule, a child table; a kept copy that is not the row as it stood; a
#         candidate re-typed inside its own transaction before its DELETE;
#   RACE  held between its proof and its DELETE, the cleanup makes a
#         mark-read find every candidate locked (FOR UPDATE) and a DELETE
#         trigger wait for it (its ROW EXCLUSIVE lock); removing a proven
#         row's destination, changing its receipt's copy, removing both in one
#         transaction (review round 3), or clearing the destination's receipt
#         meanwhile waits for it too (it holds what it proved FOR SHARE until
#         COMMIT); an operational row written past the capture meanwhile makes
#         it refuse, and so does a child table attached meanwhile (review
#         round 4) - with a copy of a candidate and a DELETE trigger that
#         would run inside its transaction, or, attached before it takes its
#         candidates, an edited copy - which it never reads or deletes;
#   IN FLIGHT a destination removed, or a receipt changed, by a session that
#         has not committed when the cleanup reaches it: the cleanup waits for
#         that session and refuses what it committed. And the proof counts
#         only rows the cleanup holds: while it waits at its receipt locks, a
#         destination the historical intake writes, or a receipt arriving
#         under the id a held destination names, is no proof; and a row
#         written past the capture while it waits there is left out of its
#         keep and its delete (the locked id set, not a predicate) and refused;
#   GREEN run from a session in America/Chicago: no operational original in
#         the owner's personal inbox; every removed row kept byte-for-byte
#         (read state included); the owner's ordinary notices, other
#         accounts' rows, destinations, receipts, push_outbox and invoice
#         deliveries unchanged; the migration's @live-proof true; the removal
#         record readable by service_role only, although the default
#         privileges granted it to everyone; a second run is refused.
#
# Exit 0 proven, 1 failed, 2 could not run (missing toolchain, store-only
# delivery absent from the tree, or a fixture that no longer matches
# production). Could not run is a failure, never a pass or a skip.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
store_only_fixture="${repo_dir}/scripts/dev/fixtures/owner-inbox-store-only"
fixture_dir="${repo_dir}/scripts/dev/fixtures/owner-inbox-cleanup"
store_only="${repo_dir}/supabase/migrations/20260927235053_owner_operational_notifications_are_delivered_to_the_operati.sql"
migration="${repo_dir}/supabase/migrations/20260928000622_owner_inbox_keeps_no_operational_original.sql"
fragment="${repo_dir}/scripts/ci/schema-manifest.d/owner-inbox-cleanup.json"
OWNER='47965354-0e56-43ef-931c-ddaab82af765'
OTHER='22222222-2222-4222-8222-222222222222'
TASK='01a09b86-5ba8-7290-8657-1041f13dd3ca'
# md5(pg_get_functiondef(fn_capture_owner_notification_destination())) in
# production before store-only delivery (read 2026-09-27).
PRE_CAPTURE='765a320465a49f71c26c4b747d61f1fd'

# Store-only delivery's migration and fixture ship with its own pull request,
# #5512. This cleanup refuses to run without store-only delivery, and its proof
# cannot be built without them: a tree lacking them is a pull request that was
# not stacked on #5512, and that fails here - it is never skipped (CLAUDE.md
# 10.86).
missing=()
for f in "${store_only_fixture}/roles.sql" "${store_only_fixture}/schema.sql" "$store_only"; do
  [[ -f "$f" ]] || missing+=("${f#"${repo_dir}/"}")
done
if [[ "${#missing[@]}" -gt 0 ]]; then
  echo "COULD NOT RUN: store-only delivery (Smarter-Poker/Smarter-Poker-Club-Arena#5512, migration 20260927235053) is not in this tree: missing ${missing[*]}. This cleanup runs only after it, so its pull request must be stacked on #5512's branch, or opened once #5512 is on main. Not a pass." >&2
  exit 2
fi
for f in "${fixture_dir}/schema.sql" "$migration" "$fragment"; do
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
port="${PROBE_PORT:-55442}"
cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
  as_db "${pg_bindir}/pg_ctl" -D "${workdir}/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

# The cluster's superuser is supabase_admin, as on Supabase, so that postgres
# can be what it is in production: not a superuser, bypassing row-level security.
as_db "${pg_bindir}/initdb" -D "${workdir}/data" -U supabase_admin --auth=trust >"${workdir}/initdb.log" 2>&1 \
  || { cat "${workdir}/initdb.log" >&2; echo "COULD NOT RUN: initdb failed" >&2; exit 2; }
as_db "${pg_bindir}/pg_ctl" -D "${workdir}/data" -w \
  -o "-k ${workdir} -p ${port} -c listen_addresses=''" -l "${workdir}/pg.log" start >/dev/null \
  || { cat "${workdir}/pg.log" >&2; echo "COULD NOT RUN: postgres did not start" >&2; exit 2; }
# Every captured original in production was rendered in UTC; write history the same way.
export PGTZ=UTC
psql_as() { local user="$1"; shift; "${pg_bindir}/psql" -X -q -h "${workdir}" -p "${port}" -U "$user" -d postgres -v ON_ERROR_STOP=1 "$@"; }
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
fn_md5() { val "select md5(pg_get_functiondef('$1'::regprocedure))"; }
capture_md5() { fn_md5 'public.fn_capture_owner_notification_destination()'; }
got="$(capture_md5)"
[[ "$got" == "$PRE_CAPTURE" ]] || could_not_run "fixture capture is $got, production before store-only delivery was $PRE_CAPTURE"
echo "fixture: production before store-only delivery (capture ${PRE_CAPTURE})"

# The cleanup's guard re-checks every @live-proof of store-only delivery,
# verbatim; a change to either migration that breaks the link fails here.
n=0
while IFS= read -r proof; do
  n=$((n + 1))
  grep -qF "  IF ${proof} IS NOT TRUE THEN" "$migration" || fail "the cleanup's guard does not re-check store-only @live-proof ${n}: ${proof}"
done < <(sed -n 's/^-- @live-proof: \(.*\)$/\1/p' "$store_only")
expect "the cleanup's guard re-checks every store-only @live-proof, verbatim" \
  "$(grep -c '^  IF (SELECT .* IS NOT TRUE THEN$' "$migration")" "$n"
expect "the schema-manifest fragment promises exactly the tables this migration creates" \
  "$(grep -o '"owner_[a-z_]*"' "$fragment" | tr -d '"' | sort | paste -sd' ')" \
  "$(sed -n 's/^CREATE TABLE public\.\([a-z_]*\) (.*$/\1/p' "$migration" | sort | paste -sd' ')"

owner_op="user_id='${OWNER}' and public.fn_is_owner_operational_notification(user_id,type,title,data)"
owner_rows() { val "select count(*) from public.notifications where ${owner_op}"; }
# Every row of every table, as one digest, and whether the removal record
# exists. A refusal must leave it exactly as it was.
psql <<'SQL' >/dev/null
create function public.probe_every_row() returns text language plpgsql as $$
declare t regclass; v text; acc text := '';
begin
  for t in select c.oid::regclass from pg_class c join pg_namespace s on s.oid = c.relnamespace
            where c.relkind in ('r','p') and s.nspname not in ('pg_catalog','information_schema')
              and s.nspname not like 'pg\_toast%' order by s.nspname, c.relname loop
    execute format('select md5(coalesce(string_agg(to_jsonb(x)::text, %L order by to_jsonb(x)::text), %L)) from only %s x', ',', '', t) into v;
    acc := acc || t::text || '=' || v || ';';
  end loop;
  return md5(acc) || ' ' || coalesce(to_regclass('public.owner_inbox_operational_removals')::text, 'no removal record');
end $$;
SQL
state() { val "select public.probe_every_row()"; }
# Every refusal and race runs the cleanup's own text with its final COMMIT
# replaced by ROLLBACK. A refusal raises before either, so it is the same test;
# a cleanup that wrongly applies is reported without destroying the history
# the later cases need, so a pre-fix run prints every result. Only GREEN runs
# the text as it is.
rolled_back="${workdir}/cleanup-rolled-back.sql"
sed 's/^COMMIT;$/ROLLBACK;/' "$migration" >"$rolled_back"
[[ "$(grep -c '^ROLLBACK;$' "$rolled_back")" == "1" ]] || could_not_run "cannot build the rolled-back variant of the cleanup"
refused() { # refused <label> <error text wanted>
  local before after out
  before="$(state)"
  if out="$(psql -f "$rolled_back" 2>&1)"; then
    fail "$1: the migration applied (wanted a refusal naming $2)"
    return
  fi
  if [[ "$out" != *"$2"* ]]; then
    fail "$1: refused for another reason: $(printf '%s\n' "$out" | grep -m1 ERROR || true)"
    return
  fi
  after="$(state)"
  if [[ "$before" != "$after" ]]; then fail "$1: the refusal changed rows"; return; fi
  pass "$1 (refused: $2; nothing changed)"
}
unproven() { # unproven <label> <no destination> <pending> <foreign receipt> <content differs>
  refused "$1" "OWNER_INBOX_CLEANUP_UNPROVEN: 1 of 7 owner operational rows are not proven preserved (no destination $2, pending receipt $3, receipt not the row's own task receipt $4, content differs $5)"
}
# The cleanup's @live-proof, evaluated exactly as check-migrations-are-live.mjs
# evaluates it: while the cleanup is held it must answer false, not fail.
held_live_proof() { # held_live_proof <when>
  local proof out k=0
  while IFS= read -r proof; do
    k=$((k + 1))
    out="$(val "select coalesce((select (${proof}))::text, 'null')" 2>&1)" || true
    expect "@live-proof ${k} while held, $1: an answer, not an error" "$out" "false"
  done < <(sed -n 's/^-- @live-proof: \(.*\)$/\1/p' "$migration")
  [[ "$k" -ge 1 ]] || fail "the migration declares no @live-proof"
}

# ------------------------------------------------------------- HISTORY -------
# Production's history, written the way production wrote it: through
# fn_raise_notification under the pre-image capture, which captured and
# receipted each operational original and still wrote the personal row.
psql <<SQL >/dev/null
select public.fn_raise_notification('${OWNER}','financial_incident','Ledger drift','probe','/hub/club-arena/financial-incidents','{"severity":"critical"}');
select public.fn_raise_notification('${OWNER}','engine_break_failed','Break failed','probe',null,'{"key":"probe-break"}');
select public.fn_raise_notification('${OWNER}','guarantee_bank_short','Guarantee bank short','probe',null,'{"bank_entity_id":"33333333-3333-4333-8333-333333333333"}');
select public.fn_raise_notification('${OWNER}','estate_digest','Estate digest','probe');
select public.fn_raise_notification('${OWNER}','system','Push Health Alert','probe');
select public.fn_raise_notification('${OWNER}','system','Horse Fleet Alert: stalled','probe');
select public.fn_raise_notification('${OWNER}','system','Engine alert','probe',null,'{"component":"club-arena-engine","alertname":"EngineDown","severity":"critical"}');
-- the owner read two of them afterwards: only read state differs from the capture
update public.notifications set read=true, is_read=true, read_at=now(), updated_at=now()
 where user_id='${OWNER}' and type in ('estate_digest','engine_break_failed');
-- the owner's ordinary notices, one of them an invoice with both references
select public.fn_raise_notification('${OWNER}','welcome','Welcome','probe');
select public.fn_raise_notification('${OWNER}','financial_digest','Financial digest','probe');
select public.fn_raise_notification('${OWNER}','accounting_invoice','Invoice ready','probe');
insert into public.accounting_invoice_deliveries(invoice_id, recipient_id, message_id, notification_id)
  select gen_random_uuid(), user_id, gen_random_uuid(), id from public.notifications
   where user_id='${OWNER}' and type='accounting_invoice';
insert into public.push_outbox(recipient_user_id, title, body, event, related_entity_id, accounting_notification_id)
  select user_id, title, 'probe', 'accounting_invoice', id, id from public.notifications
   where user_id='${OWNER}' and type='accounting_invoice';
-- another account receives the same operational types and keeps them
select public.fn_raise_notification('${OTHER}','financial_incident','Ledger drift','probe');
select public.fn_raise_notification('${OTHER}','system','Push Health Alert','probe');
SQL
expect "history: every owner operational original captured" \
  "$(val "select count(*) from public.notifications n join public.operational_notification_destinations d on d.notification_id=n.id where n.${owner_op}")" "7"
expect "history: every one receipted for the task" \
  "$(val "select count(*) from public.operational_alert_events where source='owner-operational-notifications' and payload->>'target_task_id'='${TASK}'")" "7"
expect "history: every captured original rendered in UTC" \
  "$(val "select count(*) from public.operational_notification_destinations where original_notification->>'created_at' like '%+00:00'")" "7"

# ---------------------------------------------------------------- RED --------
red="$(owner_rows)"
if [[ "$red" == "7" ]]; then
  echo "RED   before the cleanup the owner's personal inbox holds 7 operational originals: routing test 1 fails"
else
  echo "FAIL  red phase did not reproduce the defect (owner operational rows: $red)"
  exit 1
fi
held_live_proof "before store-only delivery"

# ------------------------------------------- STORE-ONLY DELIVERY REQUIRED ----
refused "store-only delivery not installed" \
  "OWNER_INBOX_CLEANUP_NEEDS_STORE_ONLY_DELIVERY: capture, break scorecard reader, guarantee bank reader, alarm drill reader, authority trigger, detector trigger missing"

psql -c "create table public.probe_images as
  select k, 'pre'::text as image, pg_get_functiondef(r::regprocedure) as def
    from (values ('capture','public.fn_capture_owner_notification_destination()'),
                 ('break scorecard reader','public.fn_ca_break_scorecard_push(public.ca_break_scorecards)'),
                 ('guarantee bank reader','public.fn_notify_guarantee_bank_short(uuid)'),
                 ('alarm drill reader','public.fn_ca_alarm_drill()')) v(k, r);" >/dev/null
psql -f "$store_only" >"${workdir}/store-only.log" 2>&1 || { cat "${workdir}/store-only.log"; echo "FAIL  the store-only migration did not apply"; exit 1; }
psql -c "insert into public.probe_images
  select k, 'post', pg_get_functiondef(r::regprocedure)
    from (values ('capture','public.fn_capture_owner_notification_destination()'),
                 ('break scorecard reader','public.fn_ca_break_scorecard_push(public.ca_break_scorecards)'),
                 ('guarantee bank reader','public.fn_notify_guarantee_bank_short(uuid)'),
                 ('alarm drill reader','public.fn_ca_alarm_drill()')) v(k, r);" >/dev/null
use_image() { psql -c "do \$u\$ begin execute (select def from public.probe_images where k='$1' and image='$2'); end \$u\$;" >/dev/null; }
pass "the real store-only migration applied to that history"
n=0
while IFS= read -r proof; do
  n=$((n + 1))
  expect "store-only @live-proof ${n}" "$(val "select coalesce((select (${proof}))::text, 'null')")" "true"
done < <(sed -n 's/^-- @live-proof: \(.*\)$/\1/p' "$store_only")
psql -c "select public.fn_raise_notification('${OWNER}','financial_incident','Routed only','probe')" >/dev/null
expect "a new operational notice after store-only delivery writes no personal row" "$(owner_rows)" "7"

# Each piece of store-only delivery, missing in turn.
for k in capture "break scorecard reader" "guarantee bank reader" "alarm drill reader"; do
  use_image "$k" pre
  refused "store-only $k back at its pre-image" "OWNER_INBOX_CLEANUP_NEEDS_STORE_ONLY_DELIVERY: $k missing"
  use_image "$k" post
done
for piece in "capture trigger:zz_capture_owner_notification_destination" \
             "authority trigger:zz_authorize_owner_operational_original" \
             "detector trigger:zz_owner_operational_original_reached_personal_inbox"; do
  psql -c "alter table public.notifications disable trigger ${piece#*:}" >/dev/null
  refused "store-only ${piece%%:*} disabled" "OWNER_INBOX_CLEANUP_NEEDS_STORE_ONLY_DELIVERY: ${piece%%:*} missing"
  psql -c "alter table public.notifications enable trigger ${piece#*:}" >/dev/null
done

# --------------------------------------------------- PRESERVATION REFUSALS ---
one_id="$(val "select id from public.notifications where ${owner_op} and type='financial_incident'")"
other_id="$(val "select id from public.notifications where ${owner_op} and type='estate_digest'")"
psql -c "create table public.probe_saved_destination as select * from public.operational_notification_destinations where notification_id='${one_id}';
         create table public.probe_saved_receipt as select * from public.operational_alert_events where id=(select inbox_event_id from public.probe_saved_destination);" >/dev/null
restore() {
  psql -c "update public.operational_notification_destinations d set original_notification=s.original_notification, inbox_event_id=s.inbox_event_id from public.probe_saved_destination s where d.notification_id=s.notification_id;
           update public.operational_alert_events e set payload=s.payload from public.probe_saved_receipt s where e.id=s.id;" >/dev/null
}
# The same, after a race that may have removed them outright (a cleanup that
# does not hold its proof lets the second session do so).
restore_store() {
  psql -c "insert into public.operational_alert_events select * from public.probe_saved_receipt s where not exists (select 1 from public.operational_alert_events e where e.id=s.id);
           insert into public.operational_notification_destinations select * from public.probe_saved_destination s where not exists (select 1 from public.operational_notification_destinations d where d.notification_id=s.notification_id);" >/dev/null
  restore
}
one_receipt="$(val "select inbox_event_id from public.probe_saved_destination")"
other_receipt="$(val "select inbox_event_id from public.operational_notification_destinations where notification_id='${other_id}'")"
# A well-formed value that is not the row's: every column the row has, apart
# from its read state, must match.
edited_value() {
  case "$1" in
    data|metadata) echo "'{\"edited\": true}'::jsonb" ;;
    created_at) echo "to_jsonb('2026-01-01T00:00:00+00:00'::text)" ;;
    type) echo "to_jsonb('welcome'::text)" ;;
    actor_id|user_id) echo "to_jsonb('${OTHER}'::text)" ;;
    id) echo "to_jsonb('${other_id}'::text)" ;;
    *) echo "to_jsonb('Edited'::text)" ;;
  esac
}
for field in message data link action_url metadata title created_at type actor_id user_id id; do
  edited="$(edited_value "$field")"
  psql -c "update public.operational_notification_destinations set original_notification=jsonb_set(original_notification,'{${field}}',${edited}) where notification_id='${one_id}'" >/dev/null
  unproven "a captured original whose ${field} differs" 0 0 0 1
  restore
  psql -c "update public.operational_alert_events set payload=jsonb_set(payload,'{original_notification,${field}}',${edited}) where id=(select inbox_event_id from public.probe_saved_destination)" >/dev/null
  unproven "a receipt whose copy of the original differs in ${field}" 0 0 0 1
  restore
done
# NULL on one side: '<>' would answer NULL and the row would pass as proven.
psql -c "update public.operational_alert_events set payload=payload-'original_notification' where id=(select inbox_event_id from public.probe_saved_destination)" >/dev/null
unproven "a receipt whose payload lacks its copy of the original (NULL)" 0 0 0 1
restore
psql -c "alter table public.operational_notification_destinations alter column original_notification drop not null;
         update public.operational_notification_destinations set original_notification=null where notification_id='${one_id}'" >/dev/null
unproven "a destination whose original is NULL (its NOT NULL dropped)" 0 0 0 1
restore
psql -c "alter table public.operational_notification_destinations alter column original_notification set not null" >/dev/null
# The destination table's own CHECKs keep recipient and task fixed; with one
# dropped, the cleanup still finds no destination for the owner and the task.
for col in "recipient_user_id:recipient:${OTHER}:${OWNER}" "target_task_id:task:99999999-9999-4999-8999-999999999999:${TASK}"; do
  IFS=: read -r c what wrong right <<<"$col"
  psql -c "alter table public.operational_notification_destinations drop constraint operational_notification_destinations_${c}_check;
           update public.operational_notification_destinations set ${c}='${wrong}' where notification_id='${one_id}'" >/dev/null
  unproven "a destination addressed to another ${what} (its CHECK dropped)" 1 0 0 0
  psql -c "update public.operational_notification_destinations set ${c}='${right}' where notification_id='${one_id}';
           alter table public.operational_notification_destinations add constraint operational_notification_destinations_${c}_check check (${c}='${right}'::uuid)" >/dev/null
done
psql -c "update public.operational_notification_destinations set inbox_event_id=null where notification_id='${one_id}'" >/dev/null
unproven "a pending receipt" 0 1 0 0
restore
psql -c "update public.operational_alert_events set payload=payload-'target_task_id' where id=(select inbox_event_id from public.probe_saved_destination)" >/dev/null
unproven "a receipt not addressed to the task" 0 0 1 0
restore
psql -c "update public.operational_notification_destinations set inbox_event_id=(select inbox_event_id from public.operational_notification_destinations where notification_id='${other_id}') where notification_id='${one_id}'" >/dev/null
unproven "a destination pointing at another row's receipt" 0 0 1 0
restore
psql -c "insert into public.operational_alert_events(source,event_key,alertname,status,severity,payload)
           select 'probe-other-source',event_key,alertname,status,severity,payload from public.probe_saved_receipt;
         update public.operational_notification_destinations set inbox_event_id=(select id from public.operational_alert_events where source='probe-other-source') where notification_id='${one_id}'" >/dev/null
unproven "a destination pointing at a copy of its receipt from another source" 0 0 1 0
restore
psql -c "delete from public.operational_alert_events where source='probe-other-source'" >/dev/null

psql <<SQL >/dev/null
alter table public.notifications disable trigger zz_capture_owner_notification_destination;
insert into public.notifications(user_id,type,title,message) values ('${OWNER}','financial_incident','Never captured','probe');
alter table public.notifications enable trigger zz_capture_owner_notification_destination;
SQL
refused "a row with no destination" "OWNER_INBOX_CLEANUP_UNPROVEN: 1 of 8 owner operational rows are not proven preserved (no destination 1, pending receipt 0, receipt not the row's own task receipt 0, content differs 0)"
psql -c "delete from public.notifications where title='Never captured'" >/dev/null

psql -c "insert into public.push_outbox(recipient_user_id,title,body,event,related_entity_id,accounting_notification_id) values ('${OWNER}','probe','probe','accounting_invoice','${one_id}','${one_id}')" >/dev/null
refused "a row push_outbox references" "OWNER_INBOX_CLEANUP_REFERENCED"
psql -c "delete from public.push_outbox where accounting_notification_id='${one_id}'" >/dev/null
psql -c "insert into public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id) values (gen_random_uuid(),'${OWNER}',gen_random_uuid(),'${one_id}')" >/dev/null
refused "a row accounting_invoice_deliveries references" "OWNER_INBOX_CLEANUP_REFERENCED"
psql -c "delete from public.accounting_invoice_deliveries where notification_id='${one_id}'" >/dev/null

# ------------------------------------------ THE DELETE REACHES NOTHING ELSE ---
# Each of these, added to notifications before the install, lets the DELETE
# remove or rewrite rows elsewhere, or hides a reference from the reference
# check. The cleanup refuses and names it; every row stays as it was.
not_confined() { refused "$1" "OWNER_INBOX_CLEANUP_DELETE_NOT_CONFINED: $2"; }
keys() { echo "foreign keys into notifications (public.accounting_invoice_deliveries notification_id id a; $1)"; }
psql <<SQL >/dev/null
create table public.probe_refs(id bigserial primary key, notification_id uuid);
insert into public.probe_refs(notification_id) values ('${one_id}');
create table public.probe_log(id bigserial primary key, note text not null);
create function public.probe_note() returns trigger language plpgsql as \$\$
begin insert into public.probe_log(note) values (tg_name || ' ' || tg_op); return null; end \$\$;
SQL
for action in "cascade:c" "set null:n" "no action:a"; do
  psql -c "alter table public.probe_refs add constraint probe_refs_notification foreign key (notification_id) references public.notifications(id) on delete ${action%%:*}" >/dev/null
  not_confined "a third foreign key into notifications, ON DELETE ${action%%:*}, referencing a candidate" \
    "$(keys "public.probe_refs notification_id id ${action#*:}; public.push_outbox accounting_notification_id id a")"
  psql -c "alter table public.probe_refs drop constraint probe_refs_notification" >/dev/null
done
push_key() { psql -c "alter table public.push_outbox drop constraint push_outbox_accounting_notification_id_fkey;
  alter table public.push_outbox add constraint push_outbox_accounting_notification_id_fkey foreign key ($1) references public.notifications(id) $2" >/dev/null; }
push_key accounting_notification_id "on delete cascade"
not_confined "push_outbox's own foreign key changed to ON DELETE CASCADE" "$(keys "public.push_outbox accounting_notification_id id c")"
push_key related_entity_id ""
psql -c "insert into public.push_outbox(recipient_user_id,title,body,event,related_entity_id) values ('${OWNER}','probe','probe','probe','${one_id}')" >/dev/null
not_confined "push_outbox's foreign key moved to a column the reference check does not read" "$(keys "public.push_outbox related_entity_id id a")"
psql -c "delete from public.push_outbox where event='probe'" >/dev/null
push_key accounting_notification_id ""
psql -c "create trigger probe_note_delete after delete on public.notifications for each row execute function public.probe_note()" >/dev/null
not_confined "a DELETE trigger on notifications that writes elsewhere" "trigger probe_note_delete"
psql -c "drop trigger probe_note_delete on public.notifications;
         create trigger probe_note_truncate after truncate on public.notifications for each statement execute function public.probe_note()" >/dev/null
not_confined "a TRUNCATE trigger on notifications" "trigger probe_note_truncate"
psql -c "drop trigger probe_note_truncate on public.notifications;
         create rule probe_note_delete as on delete to public.notifications do also insert into public.probe_log(note) values ('rule DELETE')" >/dev/null
not_confined "a rule on notifications that writes elsewhere on DELETE" "rule probe_note_delete"
psql -c "drop rule probe_note_delete on public.notifications;
         create table public.probe_inbox_child () inherits (public.notifications)" >/dev/null
not_confined "a child table of notifications" "child table probe_inbox_child"
psql -c "alter table public.probe_refs add constraint probe_refs_notification foreign key (notification_id) references public.notifications(id) on delete cascade;
         create trigger probe_note_delete after delete on public.notifications for each row execute function public.probe_note();
         create rule probe_note_delete as on delete to public.notifications do also insert into public.probe_log(note) values ('rule DELETE')" >/dev/null
not_confined "all of them at once, each named" \
  "$(keys "public.probe_refs notification_id id c; public.push_outbox accounting_notification_id id a"), trigger probe_note_delete, rule probe_note_delete, child table probe_inbox_child"
psql -c "drop rule probe_note_delete on public.notifications; drop trigger probe_note_delete on public.notifications;
         drop table public.probe_inbox_child, public.probe_refs" >/dev/null
expect "refusals left the history as it was" "$(owner_rows)" "7"

# ------------------------------------------------- INSIDE THE CLEANUP ------
# The removal record exists only inside the cleanup's own transaction, so an
# event trigger (the cluster's superuser) gives it, as it is created, a BEFORE
# INSERT trigger running public.probe_on_keep(): a hook between the cleanup's
# proof and its DELETE that adds nothing to notifications. As it is created it
# also runs public.probe_on_create(): a hook after the guard, before the
# candidates are taken.
psql -c "create function public.probe_on_keep() returns trigger language plpgsql as \$\$ begin return new; end \$\$;
         create function public.probe_on_create() returns void language plpgsql as \$\$ begin end \$\$" >/dev/null
psql_as supabase_admin <<'SQL' >/dev/null
create function public.probe_instrument_keep() returns event_trigger language plpgsql as $$
begin
  if exists (select 1 from pg_event_trigger_ddl_commands() c
              where c.command_tag = 'CREATE TABLE' and c.object_identity = 'public.owner_inbox_operational_removals') then
    perform public.probe_on_create();
    create trigger probe_on_keep before insert on public.owner_inbox_operational_removals
      for each row execute function public.probe_on_keep();
  end if;
end $$;
create event trigger probe_instrument_keep on ddl_command_end when tag in ('CREATE TABLE')
  execute function public.probe_instrument_keep();
SQL
on_keep() { # on_keep <function options> <statements before RETURN NEW>
  psql -c "create or replace function public.probe_on_keep() returns trigger language plpgsql $1 as \$k\$ begin $2 return new; end \$k\$" >/dev/null
}
on_create() { psql -c "create or replace function public.probe_on_create() returns void language plpgsql $1 as \$c\$ begin $2 end \$c\$" >/dev/null; }
on_keep "" "if new.notification_id = '${one_id}' then new.personal_row := new.personal_row || '{\"probe\": \"not the row as it stood\"}'; end if;"
refused "a kept copy that is not the row as it stood: that row is not removed" "OWNER_INBOX_CLEANUP_INCOMPLETE: total 7 kept 7 removed 6"
# Changed inside the cleanup's own transaction before its DELETE, a candidate
# re-typed is no longer operational and is not removed either: only the
# counts see it.
on_keep "" "if new.notification_id = '${one_id}' then update public.notifications set type='welcome' where id=new.notification_id; end if;"
refused "a candidate re-typed inside the cleanup's own transaction before its DELETE: not removed, and the counts refuse" "OWNER_INBOX_CLEANUP_INCOMPLETE: total 7 kept 7 removed 6"

# RACE. The cleanup (its own text, with the final COMMIT replaced by ROLLBACK)
# is held inside its keep - after it locked and proved every candidate,
# before its DELETE - while a second session acts.
wait_for() { # wait_for <sql> <value> [polls, 400 = about 20 s]
  local i
  for i in $(seq 1 "${3:-400}"); do [[ "$(val "$1")" == "$2" ]] && return 0; sleep 0.05; done
  return 1
}
cleanup_waits="select count(*) from pg_stat_activity where application_name='probe_cleanup' and wait_event_type='Lock'"
unchanged() { [[ "$(state)" == "$race_before" ]] && echo unchanged || echo changed; }
race_variant="$rolled_back"
on_keep "set lock_timeout = 0" "perform pg_advisory_xact_lock_shared(771);"
psql -c "create table public.probe_flags(name text primary key)" >/dev/null
race() { # race <what the second session does meanwhile> [hold key, 771 = at its keep]; sets race_rc, the log in race.log
  local holder_pid cleanup_pid key="${2:-771}"
  PGAPPNAME=probe_holder psql -c "select pg_advisory_lock(${key}); do \$w\$ begin for i in 1..400 loop exit when exists (select 1 from public.probe_flags where name='release'); perform pg_sleep(0.05); end loop; end \$w\$; select pg_advisory_unlock(${key});" >/dev/null 2>&1 &
  holder_pid=$!
  wait_for "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='probe_holder' and l.locktype='advisory' and l.granted" 1 \
    || could_not_run "the lock holder never took its lock"
  PGAPPNAME=probe_cleanup psql -f "$race_variant" >"${workdir}/race.log" 2>&1 &
  cleanup_pid=$!
  if wait_for "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='probe_cleanup' and l.locktype='advisory' and not l.granted" 1; then
    "$1"
  else
    fail "race: the cleanup never reached its hold: $(grep -m1 ERROR "${workdir}/race.log" || echo 'no error')"
  fi
  psql -c "insert into public.probe_flags values ('release')" >/dev/null
  race_rc=0; wait "$cleanup_pid" || race_rc=$?
  wait "$holder_pid" || true
  psql -c "delete from public.probe_flags" >/dev/null
}
mark_read_and_add_trigger() {
  marked="$(val "with u as (update public.notifications set read=true where id in (select id from public.notifications where ${owner_op} and not coalesce(read,false) for update skip locked) returning 1) select count(*) from u")"
  late_trigger="$(psql -c "set lock_timeout='300ms'; create trigger probe_late_delete after delete on public.notifications for each row execute function public.probe_note()" 2>&1 && echo added || true)"
}
race_before="$(state)"
marked='not run'; late_trigger='not run'
race mark_read_and_add_trigger
expect "race: a mark-read racing the cleanup finds every candidate locked" "$marked" "0"
expect "race: a DELETE trigger added meanwhile waits for the cleanup" \
  "$([[ "$late_trigger" == *"canceling statement due to lock timeout"* ]] && echo waits || echo "did not wait: ${late_trigger}")" "waits"
expect "race: the cleanup proved, kept and removed all 7 and rolled back" \
  "${race_rc}|$(grep -o 'owner inbox: [0-9]* operational originals removed' "${workdir}/race.log" || echo 'no notice')" \
  "0|owner inbox: 7 operational originals removed"
psql -c "set client_min_messages = warning; drop trigger if exists probe_late_delete on public.notifications" >/dev/null
expect "race: nothing changed" "$(unchanged)" "unchanged"

# The store copies of a proven row, removed or changed by a second session
# while the cleanup holds its proof (review round 3: before, each went
# through, and the cleanup then removed the row and committed with its
# destination and receipt gone). It holds every destination and receipt it
# proved FOR SHARE until COMMIT, so each now waits for it (here 300 ms, then
# gives up) and the cleanup completes with every copy in place.
touch_store_copies() {
  local tries=(
    "delete from public.operational_notification_destinations where notification_id='${one_id}'"
    "update public.operational_alert_events set payload=payload-'original_notification' where id=${one_receipt}"
    "delete from public.operational_notification_destinations where notification_id='${one_id}'; delete from public.operational_alert_events where id=${one_receipt}"
    "update public.operational_notification_destinations set inbox_event_id=null where notification_id='${one_id}'")
  local i
  for i in 0 1 2 3; do
    touched[i]="$(psql -c "begin; set local lock_timeout='300ms'; ${tries[i]}; commit;" 2>&1 && echo 'went through' || true)"
  done
}
waits() { [[ "$1" == *"canceling statement due to lock timeout"* ]] && echo waits || echo "did not wait: $(printf '%s' "$1" | tr '\n' ' ')"; }
touched=('not run' 'not run' 'not run' 'not run')
race touch_store_copies
expect "race: removing a proven row's destination meanwhile waits for the cleanup" "$(waits "${touched[0]}")" "waits"
expect "race: changing its receipt's copy of the original meanwhile waits for the cleanup" "$(waits "${touched[1]}")" "waits"
expect "race: removing its destination and its receipt in one transaction meanwhile waits for the cleanup" "$(waits "${touched[2]}")" "waits"
expect "race: clearing its destination's receipt meanwhile waits for the cleanup" "$(waits "${touched[3]}")" "waits"
expect "race: the cleanup then proved, kept and removed all 7 and rolled back" \
  "${race_rc}|$(grep -o 'owner inbox: [0-9]* operational originals removed' "${workdir}/race.log" || echo 'no notice')" \
  "0|owner inbox: 7 operational originals removed"
restore_store
expect "race: nothing changed" "$(unchanged)" "unchanged"

# IN FLIGHT. The second session has changed a store copy, and not committed,
# when the cleanup reaches it: the cleanup waits for that session, proves what
# it committed, and refuses. (Before, it proved the copy being replaced.)
outcome() { # the cleanup's refusal, or what it did instead
  grep -m1 -o 'OWNER_INBOX_CLEANUP_[A-Z_]*: .*\|owner inbox: [0-9]* operational originals removed\|canceling statement due to lock timeout' "${workdir}/race.log" || echo 'no outcome'
}
inflight() { # inflight <label> <the change> <refusal wanted>
  local writer_pid cleanup_pid rc waited=no
  PGAPPNAME=probe_writer psql -c "begin; $2; do \$w\$ begin for i in 1..400 loop exit when exists (select 1 from public.probe_flags where name='commit'); perform pg_sleep(0.05); end loop; end \$w\$; commit;" >"${workdir}/writer.log" 2>&1 &
  writer_pid=$!
  wait_for "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='probe_writer' and l.locktype='transactionid' and l.granted" 1 \
    || could_not_run "the second session never made its change: $(cat "${workdir}/writer.log")"
  PGAPPNAME=probe_cleanup psql -f "$race_variant" >"${workdir}/race.log" 2>&1 &
  cleanup_pid=$!
  wait_for "$cleanup_waits" 1 100 && waited=yes
  psql -c "insert into public.probe_flags values ('commit')" >/dev/null
  rc=0; wait "$cleanup_pid" || rc=$?
  wait "$writer_pid" || true
  psql -c "delete from public.probe_flags" >/dev/null
  expect "in flight: $1: the cleanup waits for it, then refuses" "waits=${waited} exit=$([[ "$rc" == 0 ]] && echo 0 || echo refused) $(outcome)" "waits=yes exit=refused $3"
  restore_store
  expect "in flight: $1: nothing else changed" "$(unchanged)" "unchanged"
}
inflight "a proven row's destination removed" \
  "delete from public.operational_notification_destinations where notification_id='${one_id}'" \
  "OWNER_INBOX_CLEANUP_UNPROVEN: 1 of 7 owner operational rows are not proven preserved (no destination 1, pending receipt 0, receipt not the row's own task receipt 0, content differs 0)"
inflight "its receipt's copy of the original changed" \
  "update public.operational_alert_events set payload=jsonb_set(payload,'{original_notification,message}',to_jsonb('Edited'::text)) where id=${one_receipt}" \
  "OWNER_INBOX_CLEANUP_UNPROVEN: 1 of 7 owner operational rows are not proven preserved (no destination 0, pending receipt 0, receipt not the row's own task receipt 0, content differs 1)"

# HELD ONLY. The proof counts only the rows the cleanup holds. It is kept
# waiting at its receipt locks (a session holds one receipt FOR UPDATE), and
# meanwhile the historical intake captures and receipts an operational row
# that had no destination (written with the capture disabled), and the receipt
# a held destination names arrives under that id (the destinations' foreign
# key dropped for the case). Neither was held, so neither is proof, and the
# cleanup refuses both.
later="$(val "select max(id) + 1000000 from public.operational_alert_events")"
psql <<SQL >/dev/null
alter table public.notifications disable trigger zz_capture_owner_notification_destination;
insert into public.notifications(user_id,type,title,message) values ('${OWNER}','financial_incident','Never captured','probe');
alter table public.notifications enable trigger zz_capture_owner_notification_destination;
alter table public.operational_notification_destinations drop constraint operational_notification_destinations_inbox_event_id_fkey;
update public.operational_notification_destinations set inbox_event_id=${later} where notification_id='${other_id}';
SQL
hold_at_receipts() { # hold_at_receipts <what a second session does meanwhile>; sets held_waited, race_rc
  local blocker_pid cleanup_pid
  PGAPPNAME=probe_blocker psql -c "begin; select 1 from public.operational_alert_events where id=${one_receipt} for update; do \$w\$ begin for i in 1..400 loop exit when exists (select 1 from public.probe_flags where name='commit'); perform pg_sleep(0.05); end loop; end \$w\$; rollback;" >/dev/null 2>&1 &
  blocker_pid=$!
  wait_for "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='probe_blocker' and l.locktype='transactionid' and l.granted" 1 \
    || could_not_run "the receipt holder never took its lock"
  PGAPPNAME=probe_cleanup psql -f "$race_variant" >"${workdir}/race.log" 2>&1 &
  cleanup_pid=$!
  held_waited=no
  wait_for "$cleanup_waits" 1 100 && held_waited=yes
  "$1"
  psql -c "insert into public.probe_flags values ('commit')" >/dev/null
  race_rc=0; wait "$cleanup_pid" || race_rc=$?
  wait "$blocker_pid" || true
  psql -c "delete from public.probe_flags" >/dev/null
}
intake_and_late_receipt() {
  held_intake="$(val "select public.fn_capture_owner_notification_history(200)->>'inbox_receipts_recorded'")"
  psql -c "update public.operational_alert_events set id=${later} where id=${other_receipt}" >/dev/null
}
held_intake='not run'
hold_at_receipts intake_and_late_receipt
expect "held only: while the cleanup waits at its receipt locks, the intake captures and receipts a row that had no destination" \
  "waits=${held_waited} recorded=${held_intake}" "waits=yes recorded=1"
expect "held only: neither that destination nor a receipt arriving under a held destination's id is proof, and the cleanup refuses both" \
  "exit=$([[ "$race_rc" == 0 ]] && echo 0 || echo refused) $(outcome)" \
  "exit=refused OWNER_INBOX_CLEANUP_UNPROVEN: 2 of 8 owner operational rows are not proven preserved (no destination 1, pending receipt 0, receipt not the row's own task receipt 1, content differs 0)"
# Put everything back, the detector's record of the uncaptured row included.
psql <<SQL >/dev/null
update public.operational_alert_events set id=${other_receipt} where id=${later};
update public.operational_notification_destinations set inbox_event_id=${other_receipt} where notification_id='${other_id}';
delete from public.operational_alert_events where source='owner-inbox-routing-guard'
   and event_key in (select id::text from public.notifications where title='Never captured');
with gone as (delete from public.operational_notification_destinations d using public.notifications n
               where n.title='Never captured' and d.notification_id=n.id returning d.inbox_event_id)
delete from public.operational_alert_events e using gone where e.id=gone.inbox_event_id;
delete from public.notifications where title='Never captured';
alter table public.operational_notification_destinations add constraint operational_notification_destinations_inbox_event_id_fkey
  foreign key (inbox_event_id) references public.operational_alert_events(id);
SQL
expect "held only: nothing else changed" "$(unchanged)" "unchanged"

# A writer that bypasses the capture (replication mode fires no ordinary
# trigger) leaves an operational original the cleanup did not lock.
write_past_capture() {
  psql_as supabase_admin -c "set session_replication_role = replica; insert into public.notifications(user_id,type,title,message) values ('${OWNER}','financial_incident','Past the capture','probe')" >/dev/null
}
race write_past_capture
expect "race: an operational original written past the capture meanwhile is found, and the cleanup refuses" \
  "$([[ "$race_rc" != 0 ]] && echo refused || echo applied)|$(grep -o 'OWNER_INBOX_CLEANUP_INCOMPLETE: [a-z0-9 ]*' "${workdir}/race.log" || echo 'no refusal')" \
  "refused|OWNER_INBOX_CLEANUP_INCOMPLETE: total 7 kept 7 removed 7"
psql -c "delete from public.notifications where title='Past the capture'" >/dev/null
expect "race: nothing else changed" "$(unchanged)" "unchanged"
# The same writer while the cleanup waits at its receipt locks - after it
# took its ids, before its keep takes a snapshot. It keeps and removes exactly
# the rows it locked and proved, not whatever its predicate matches by then,
# and refuses the row left over.
hold_at_receipts write_past_capture
expect "held at its receipt locks: an operational original written past the capture meanwhile is left out of its keep and its delete, and it refuses" \
  "waits=${held_waited} exit=$([[ "$race_rc" == 0 ]] && echo 0 || echo refused) $(outcome)" \
  "waits=yes exit=refused OWNER_INBOX_CLEANUP_INCOMPLETE: total 7 kept 7 removed 7"
psql -c "delete from public.notifications where title='Past the capture'" >/dev/null
expect "held at its receipt locks: nothing else changed" "$(unchanged)" "unchanged"

# Attaching a child needs only SHARE UPDATE EXCLUSIVE, which the cleanup's
# lock does not block. Review round 4: a child attached while the cleanup is
# held at its keep, holding a copy of a candidate and a BEFORE DELETE trigger
# that removes that candidate's destination and receipt and re-types its copy
# - inside the cleanup's own transaction, where its FOR SHARE locks do not
# bind. The DELETE reached the child, the trigger ran, and the cleanup
# committed with the row unpreserved. It reads and deletes notifications ONLY:
# the trigger never runs, and the completeness check refuses the copy.
# (if exists below: a pre-fix run that never reaches the hold still prints
# every result.)
attach_child_with_a_trigger() {
  psql <<SQL >/dev/null
create function public.probe_child_delete() returns trigger language plpgsql as \$t\$
begin
  raise notice 'probe: a trigger of the child ran inside the cleanup';
  delete from public.operational_notification_destinations where notification_id=old.id;
  delete from public.operational_alert_events where id=${one_receipt};
  update public.probe_late_child set type='welcome' where id=old.id;
  return null;
end \$t\$;
create table public.probe_late_child () inherits (public.notifications);
create trigger probe_child_delete before delete on public.probe_late_child for each row execute function public.probe_child_delete();
insert into public.probe_late_child select * from only public.notifications where id='${one_id}';
SQL
}
race attach_child_with_a_trigger
expect "race: a child attached meanwhile with a copy of a candidate and a DELETE trigger is never reached: its trigger never runs, and the cleanup refuses the copy" \
  "exit=$([[ "$race_rc" == 0 ]] && echo 0 || echo refused) trigger=$(grep -c 'a trigger of the child ran' "${workdir}/race.log") $(outcome)" \
  "exit=refused trigger=0 OWNER_INBOX_CLEANUP_INCOMPLETE: total 7 kept 7 removed 7"
psql -c "set client_min_messages = warning; drop table if exists public.probe_late_child; drop function if exists public.probe_child_delete()" >/dev/null
expect "race: nothing else changed" "$(unchanged)" "unchanged"
# Held earlier, as it creates its removal record - after its guard, before it
# takes its candidates: a child attached then, holding an edited copy of a
# candidate, is never read - not locked, proven or kept - and the completeness
# check refuses the copy.
attach_child_with_an_edited_copy() {
  psql -c "create table public.probe_late_child () inherits (public.notifications);
           insert into public.probe_late_child select * from only public.notifications where id='${one_id}';
           update public.probe_late_child set message='Edited'" >/dev/null
}
on_create "set lock_timeout = 0" "perform pg_advisory_xact_lock_shared(772);"
race attach_child_with_an_edited_copy 772
on_create "" ""
expect "race: a child attached before the candidates are taken, holding an edited copy, is never read, and the cleanup refuses the copy" \
  "exit=$([[ "$race_rc" == 0 ]] && echo 0 || echo refused) $(outcome)" "exit=refused OWNER_INBOX_CLEANUP_INCOMPLETE: total 7 kept 7 removed 7"
psql -c "set client_min_messages = warning; drop table if exists public.probe_late_child" >/dev/null
expect "race: nothing else changed" "$(unchanged)" "unchanged"
psql_as supabase_admin -c "drop event trigger probe_instrument_keep; drop function public.probe_instrument_keep()" >/dev/null
psql -c "drop function public.probe_on_keep(), public.probe_on_create(); drop table public.probe_flags, public.probe_log; drop function public.probe_note()" >/dev/null

# ---------------------------------------------------------------- GREEN ------
held_live_proof "after store-only delivery"
psql <<'SQL' >/dev/null
create table public.probe_before as select n.id, n.user_id, to_jsonb(n) as row from public.notifications n;
create table public.probe_digest as select
  (select md5(string_agg(to_jsonb(d)::text, ',' order by d.notification_id)) from public.operational_notification_destinations d) as destinations,
  (select md5(string_agg(to_jsonb(e)::text, ',' order by e.id)) from public.operational_alert_events e) as receipts,
  (select md5(string_agg(to_jsonb(p)::text, ',' order by p.id)) from public.push_outbox p) as outbox,
  (select md5(string_agg(to_jsonb(a)::text, ',' order by a.invoice_id)) from public.accounting_invoice_deliveries a) as invoices;
SQL
# Run it from a session in America/Chicago, where to_jsonb renders every
# timestamp differently from the UTC the originals were captured in.
expect "the installing session is in America/Chicago" "$(PGTZ=America/Chicago val "show timezone")" "America/Chicago"
expect "in that session no row renders like its captured original" \
  "$(PGTZ=America/Chicago val "select count(*) from public.notifications n join public.operational_notification_destinations d on d.notification_id=n.id where (to_jsonb(n) - array['read','is_read','read_at','updated_at']) = (d.original_notification - array['read','is_read','read_at','updated_at'])")" "0"
PGTZ=America/Chicago psql -f "$migration" >"${workdir}/apply.log" 2>&1 || { cat "${workdir}/apply.log"; echo "FAIL  migration did not apply"; exit 1; }
pass "migration applied from America/Chicago: $(grep -o 'owner inbox: .*' "${workdir}/apply.log" || echo 'no notice')"

expect "no operational original left in the owner's personal inbox (routing test 1 passes)" "$(owner_rows)" "0"
expect "every removed row kept, keyed by its id" \
  "$(val "select count(*) from public.owner_inbox_operational_removals r join public.probe_before b on b.id=r.notification_id and b.row=r.personal_row where public.fn_is_owner_operational_notification((b.row->>'user_id')::uuid, b.row->>'type', b.row->>'title', b.row->'data')")" "7"
expect "nothing else kept" "$(val "select count(*) from public.owner_inbox_operational_removals")" "7"
expect "read state kept as the owner left it" \
  "$(val "select count(*) from public.owner_inbox_operational_removals where personal_row->>'read'='true' and personal_row->>'read_at' is not null")" "2"
expect "every other row untouched" \
  "$(val "select count(*) from public.probe_before b join public.notifications n on n.id=b.id and to_jsonb(n)=b.row")" \
  "$(val "select count(*) from public.probe_before where id not in (select notification_id from public.owner_inbox_operational_removals)")"
expect "the owner's ordinary notices remain (welcome, financial digest, invoice)" "$(val "select string_agg(type, ',' order by type) from public.notifications where user_id='${OWNER}'")" "accounting_invoice,financial_digest,welcome"
expect "the other account keeps its operational rows" "$(val "select count(*) from public.notifications where user_id='${OTHER}'")" "2"
expect "destinations unchanged" \
  "$(val "select (select md5(string_agg(to_jsonb(d)::text, ',' order by d.notification_id)) from public.operational_notification_destinations d) = destinations from public.probe_digest")" "t"
expect "receipts unchanged" \
  "$(val "select (select md5(string_agg(to_jsonb(e)::text, ',' order by e.id)) from public.operational_alert_events e) = receipts from public.probe_digest")" "t"
expect "push_outbox and invoice deliveries unchanged" \
  "$(val "select (select md5(string_agg(to_jsonb(p)::text, ',' order by p.id)) from public.push_outbox p) = outbox and (select md5(string_agg(to_jsonb(a)::text, ',' order by a.invoice_id)) from public.accounting_invoice_deliveries a) = invoices from public.probe_digest")" "t"

n=0
while IFS= read -r proof; do
  n=$((n + 1))
  expect "@live-proof ${n} once it ran" "$(val "select coalesce((select (${proof}))::text, 'null')")" "true"
done < <(sed -n 's/^-- @live-proof: \(.*\)$/\1/p' "$migration")
[[ "$n" -ge 1 ]] || fail "the migration declares no @live-proof"

expect "removal record: row level security on" \
  "$(val "select relrowsecurity from pg_class where oid='public.owner_inbox_operational_removals'::regclass")" "t"
expect "removal record: the default privileges granted it to anon, authenticated and service_role" \
  "$(val "select defaclacl::text like '%anon=arwd%' and defaclacl::text like '%authenticated=arwd%' and defaclacl::text like '%service_role=arwdD%' from pg_default_acl where defaclrole='postgres'::regrole and defaclnamespace='public'::regnamespace and defaclobjtype='r'")" "t"
expect "removal record: yet service_role only reads it, nobody writes it, anon and authenticated see nothing" \
  "$(val "select string_agg(r||':'||p||'='||has_table_privilege(r,'public.owner_inbox_operational_removals',p)::text, ' ' order by r, p)
          from unnest(array['anon','authenticated','service_role']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p")" \
  "anon:DELETE=false anon:INSERT=false anon:SELECT=false anon:TRUNCATE=false anon:UPDATE=false authenticated:DELETE=false authenticated:INSERT=false authenticated:SELECT=false authenticated:TRUNCATE=false authenticated:UPDATE=false service_role:DELETE=false service_role:INSERT=false service_role:SELECT=true service_role:TRUNCATE=false service_role:UPDATE=false"

psql -c "select public.fn_raise_notification('${OWNER}','estate_digest','After the cleanup','probe')" >/dev/null
expect "a later operational notice still reaches the task only" "$(owner_rows)" "0"

refused "a second run" "already exists"

if [[ "$failures" -eq 0 ]]; then
  echo "PROVEN: the owner's personal inbox keeps no operational original; each removed row is kept, and nothing else changes"
  exit 0
fi
echo "FAILED: ${failures} check(s)"
exit 1
