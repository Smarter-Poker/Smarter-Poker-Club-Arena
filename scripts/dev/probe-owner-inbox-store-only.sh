#!/usr/bin/env bash
# =============================================================================
#  OWNER-OPERATIONAL NOTIFICATIONS ARE DELIVERED TO THE TASK ONLY - LIVE PROOF
# =============================================================================
#
# Red before, green after, against a throwaway PostgreSQL cluster on a unix
# socket. Never against production.
#
# supabase/migrations/20260927235053_owner_operational_notifications_are_delivered_to_the_operati.sql
# makes fn_capture_owner_notification_destination return NULL once it has
# captured and recorded an owner-operational original, so the owner's personal
# inbox (public.notifications) never receives operational content. Because a
# row the capture routes never reaches row-level security or a constraint, it
# checks the writer's authority first (zz_authorize_owner_operational_original)
# and routes only a row PostgreSQL would have accepted; and it moves the three
# database readers that treated the personal row as proof of delivery onto the
# routed original. The fixture is production as it stands before the migration:
# production's roles (postgres is not a superuser), default privileges,
# grants, policies, constraints and BEFORE INSERT triggers, and every function
# pinned to the md5 production returns. On it this proves:
#
#   RED   before the migration an operational notification to the owner
#         leaves a personal row (the defect). Row-level security refuses anon
#         and authenticated, and PostgreSQL refuses a row breaking NOT NULL, a
#         foreign key or the primary key - each with nothing stored.
#   GREEN after it: no personal row, one destination, one addressed receipt.
#         anon and authenticated are still refused with the same error, now by
#         the new trigger (whose function neither can EXECUTE), with nothing
#         stored; with that trigger disabled anon's row IS captured, so it is
#         necessary. A pg_write_all_data member is still refused; a member of
#         service_role that does not bypass row-level security (as
#         supabase_backup_admin is) is now refused. service_role, and a
#         postgres-owned SECURITY DEFINER producer called by anon or
#         authenticated, are routed. Every constraint case is still refused
#         with PostgreSQL's own error and nothing stored, and the capture
#         without its validity clause accepts them, so the clause is necessary.
#         Ordinary notifications, other recipients and the owner's ordinary
#         notices are untouched. The three readers (each pre-image shown to
#         fail), the guarantee-bank receipt states, the detector, and the
#         install's refusals of a changed authority, constraint set or trigger
#         order and of a second run.
#
# Exit 0 proven, 1 failed, 2 could not run (missing toolchain, or a fixture
# that no longer matches production).
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_dir="${repo_dir}/scripts/dev/fixtures/owner-inbox-store-only"
migration="${repo_dir}/supabase/migrations/20260927235053_owner_operational_notifications_are_delivered_to_the_operati.sql"
fragment="${repo_dir}/scripts/ci/schema-manifest.d/owner-inbox-store-only-delivery.json"
OWNER='47965354-0e56-43ef-931c-ddaab82af765'
TASK='01a09b86-5ba8-7290-8657-1041f13dd3ca'
OTHER='22222222-2222-4222-8222-222222222222'
CLUB_OWNER='33333333-3333-4333-8333-333333333333'

# md5(pg_get_functiondef(...)) read from production kuklfnapbkmacvwxktbh on
# 2026-09-27 (pre) and computed from the migration's own anchors (post).
declare -A PRE=(
  [capture]=765a320465a49f71c26c4b747d61f1fd
  [scorecard]=0de54de4eee0f2cfee9a5fd9e1e368ff
  [bank]=0882ecfbd9a19479f7d6666daab3ea6b
  [drill]=8b413171b63deabceaf13d15a2ff6ebf
)
declare -A POST=(
  [capture]=32a9105ef11b28dceac0fce11d71148f
  [scorecard]=1c240cddb84994e906a4eb09d7ca3323
  [bank]=71d3444dfb4ed7906cfefe5267de5b81
  [drill]=8bd6f37a4038209adaec7e2bbbdfd5e9
)
declare -A REG=(
  [capture]="public.fn_capture_owner_notification_destination()"
  [scorecard]="public.fn_ca_break_scorecard_push(public.ca_break_scorecards)"
  [bank]="public.fn_notify_guarantee_bank_short(uuid)"
  [drill]="public.fn_ca_alarm_drill()"
)
# The two functions and triggers the migration creates, as PostgreSQL prints
# them (md5 of pg_get_functiondef / pg_get_triggerdef).
AUTH_FN=7777ab6e22847595881843ebfacdcaad
AUTH_TRG=7f4ecd63db81d72271f9e25c09a8e69d
DET_FN=d648da8eb87a98e8074e91c8aca7c660
DET_TRG=2d1ee8300c484364c83db0496360b897
# The capture WITHOUT the validity clause: the post-image of this migration's
# previous revision, kept as capture-without-validity.sql beside the fixture.
NO_VALIDITY_CAPTURE=f35b8c2677dd42f5f8567406912a0497

# Every other function the fixture copies from production, pinned to the md5
# of pg_get_functiondef production returned (read-only, 2026-09-28 UTC).
declare -A VERBATIM=(
  ["auth.uid()"]=ea3b41bf29e2ad573067939329aa088e
  ["public.fn_notification_action_url(text,jsonb,jsonb)"]=b9120a5238a41e1960da7ac244493dab
  ["public.fn_notification_fill_action_url()"]=75cf1f6fe863aa76a27bb7f6889f6b4f
  ["public.sync_notification_read_state()"]=c90c577563f3d7a4ac6cfe2ab75df629
  ["public.fn_raise_notification(uuid,text,text,text,text,jsonb)"]=087fdcb4d44e022ea8409b185ed164fa
  ["public.fn_record_operational_alert(text,text,text,text,text,jsonb)"]=36601e205494e8768f5a1dce09f4a186
  ["public.fn_record_operational_alerts(jsonb)"]=1ed60e92c3f7741793dd435bedb9538a
  ["public.fn_is_owner_operational_notification(uuid,text,text,jsonb)"]=8c2c62359d92dcbd3b3621a762b981ca
  ["public.fn_try_record_owner_notification(uuid)"]=bbc44eb76b74576906f55e9ae370a508
  ["public.fn_retry_owner_notification_destination(uuid)"]=a197386d748d4b7de06a2629c04aa340
  ["public.fn_notification_has_personal_destination(uuid,uuid)"]=37e7fd718e3bb0352fc384318e357142
  ["public.fn_capture_owner_notification_history(integer)"]=cc71da2cd06381b3b460f9213f6e46bf
)

for f in "${fixture_dir}/roles.sql" "${fixture_dir}/schema.sql" "${fixture_dir}/capture-without-validity.sql" "$migration" "$fragment"; do
  [[ -f "$f" ]] || { echo "COULD NOT RUN: missing $f" >&2; exit 2; }
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
port="${PROBE_PORT:-55441}"
cleanup() {
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

psql_as supabase_admin -f "${fixture_dir}/roles.sql" >/dev/null
# Two probe-only roles standing for the other writers that hold INSERT on
# notifications in production: a member of pg_write_all_data (production's has
# none), and a role that is a member of service_role without bypassing
# row-level security, as supabase_backup_admin is.
psql_as supabase_admin -c "create role probe_write_all_data; grant pg_write_all_data to probe_write_all_data;
  create role probe_backup_admin_like; grant service_role to probe_backup_admin_like;
  grant probe_write_all_data, probe_backup_admin_like to postgres;" >/dev/null
psql -f "${fixture_dir}/schema.sql" >/dev/null

# ----------------------------------------------------- FIXTURE = PRODUCTION --
fn_md5() { val "select md5(pg_get_functiondef('$1'::regprocedure))"; }
for k in capture scorecard bank drill; do
  got="$(fn_md5 "${REG[$k]}")"
  [[ "$got" == "${PRE[$k]}" ]] || could_not_run "fixture pre-image for $k is $got, production is ${PRE[$k]}"
done
for f in "${!VERBATIM[@]}"; do
  got="$(fn_md5 "$f")"
  [[ "$got" == "${VERBATIM[$f]}" ]] || could_not_run "fixture $f is $got, production is ${VERBATIM[$f]}"
done
echo "fixture: all four pre-images and ${#VERBATIM[@]} other functions equal production"

# Production's shape of public.notifications and its roles (read-only,
# 2026-09-28 UTC). MAINTAIN (m) does not exist before PostgreSQL 17.
maint() { if [[ "$(val "select current_setting('server_version_num')::int >= 170000")" == "t" ]]; then cat; else sed 's/m\//\//g'; fi; }
sorted_acl() { val "select string_agg(a::text, ',' order by a::text collate \"C\") from unnest(coalesce(($1)::aclitem[], '{}')) a"; }
shape_check() { # <what> <actual> <production>
  [[ "$2" == "$3" ]] || could_not_run "fixture $1 is '$2', production is '$3'"
}
shape_check "role attributes" \
  "$(val "select string_agg(rolname||':'||rolsuper||':'||rolbypassrls, ' ' order by rolname) from pg_roles where rolname in ('postgres','anon','authenticated','service_role')")" \
  "anon:false:false authenticated:false:false postgres:false:true service_role:false:true"
shape_check "notifications grants" \
  "$(sorted_acl "(select relacl from pg_class where oid='public.notifications'::regclass)")" \
  "$(printf 'anon=arwdxtm/postgres,authenticated=arwdxtm/postgres,postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres' | maint)"
for t in r f S; do
  shape_check "default privileges ($t)" \
    "$(val "select defaclacl::text from pg_default_acl where defaclrole='postgres'::regrole and defaclnamespace='public'::regnamespace and defaclobjtype='$t'")" \
    "$(case $t in
         r) printf '{postgres=arwdDxtm/postgres,anon=arwdxtm/postgres,authenticated=arwdxtm/postgres,service_role=arwdDxtm/postgres}' | maint ;;
         f) printf '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' ;;
         S) printf '{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}' ;;
       esac)"
done
shape_check "notifications row-level security" \
  "$(val "select relrowsecurity::text||' '||relforcerowsecurity::text from pg_class where oid='public.notifications'::regclass")" "true false"
shape_check "notifications policies" \
  "$(val "select string_agg(concat_ws('|', polname, polcmd, polpermissive::text, (select string_agg(r::regrole::text, ',' order by r::regrole::text collate \"C\") from unnest(polroles) r), pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)), E'\n' order by polname) from pg_policy where polrelid='public.notifications'::regclass")" \
  "$(printf '%s\n' \
      'Service role inserts|a|true|service_role|true' \
      'Users can delete own notifications|d|true|-|(( SELECT auth.uid() AS uid) = user_id)' \
      'Users can update own notifications|w|true|-|(( SELECT auth.uid() AS uid) = user_id)' \
      'Users can view own notifications|r|true|-|(( SELECT auth.uid() AS uid) = user_id)' \
      'messenger_no_anonymous_notification_content|r|false|anon|false' \
      'personal_notification_destination|r|false|authenticated|fn_notification_has_personal_destination(id, user_id)')"
shape_check "notifications constraints" \
  "$(val "select string_agg(s, '; ' order by s collate \"C\") from (select concat_ws(' ', c.contype, (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a where a.attrelid=c.conrelid and a.attnum=any(c.conkey)), case when c.contype='f' then (c.confrelid='public.profiles'::regclass)::text end, case when c.contype='f' then (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a where a.attrelid=c.confrelid and a.attnum=any(c.confkey)) end, case when c.contype='f' then c.confdeltype::text end) as s from pg_constraint c where c.conrelid='public.notifications'::regclass and c.contype<>'t') x")" \
  "f actor_id true id a; f user_id true id c; p id"
shape_check "notifications unique indexes" \
  "$(val "select md5(string_agg(s, E'\n' order by s collate \"C\")) from (select pg_get_indexdef(i.indexrelid) as s from pg_index i where i.indrelid='public.notifications'::regclass and i.indisunique and not i.indisprimary) x")" \
  "43e3e177384d2fbf24b6bc30b928b867"
shape_check "notifications BEFORE INSERT triggers, in firing order" \
  "$(val "select string_agg(pg_get_triggerdef(oid), E'\n' order by tgname) from pg_trigger where tgrelid='public.notifications'::regclass and not tgisinternal and (tgtype & 7)=7")" \
  "$(printf '%s\n' \
      'CREATE TRIGGER trg_notification_fill_action_url BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION fn_notification_fill_action_url()' \
      'CREATE TRIGGER trg_sync_notification_read_state BEFORE INSERT OR UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION sync_notification_read_state()' \
      'CREATE TRIGGER zz_capture_owner_notification_destination BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION fn_capture_owner_notification_destination()')"
echo "fixture: roles, default privileges, grants, policies, constraints and BEFORE INSERT triggers equal production"

# The CI gate check-migrations-applied reads this fragment: it must promise
# exactly the functions this migration creates.
expect "the schema-manifest fragment promises exactly the functions this migration creates" \
  "$(grep -o '"fn_[a-z_]*"' "$fragment" | tr -d '"' | sort | paste -sd' ')" \
  "$(sed -n 's/^CREATE FUNCTION public\.\(fn_[a-z_]*\)(.*$/\1/p' "$migration" | sort | paste -sd' ')"

# ---------------------------------------------------------------- helpers ----
owner_rows() { val "select count(*) from public.notifications where user_id='${OWNER}' and public.fn_is_owner_operational_notification(user_id,type,title,data)"; }
# Everything a refused INSERT could have left behind, as one digest.
state() {
  val "select md5(concat_ws('|',
    (select coalesce(string_agg(to_jsonb(n)::text, ',' order by n.id), '') from public.notifications n),
    (select coalesce(string_agg(to_jsonb(d)::text, ',' order by d.notification_id), '') from public.operational_notification_destinations d),
    (select coalesce(string_agg(to_jsonb(e)::text, ',' order by e.id), '') from public.operational_alert_events e),
    (select coalesce(string_agg(p.id::text, ',' order by p.id), '') from public.profiles p)))"
}
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
# refused <label> <sql> <expected attempt result>: refused as expected, and
# nothing at all was stored.
refused() {
  local before after got
  before="$(state)"
  got="$(attempt "$2")"
  after="$(state)"
  if [[ "$got" == "$3" && "$before" == "$after" ]]; then
    pass "$1 (${got%%|*}, nothing stored)"
  elif [[ "$got" == "$3" ]]; then
    fail "$1 (refused as expected, but something was stored)"
  else
    fail "$1 (got '$got', wanted '$3')"
  fi
}
receipted() { # receipted <title>: destinations with that original title and their task receipt
  val "select count(*) from public.operational_notification_destinations d join public.operational_alert_events e on e.id=d.inbox_event_id where d.original_notification->>'title'='$1' and e.source='owner-operational-notifications' and e.event_key=d.notification_id::text and e.payload->>'target_task_id'='${TASK}'"
}
routed() { # routed <label> <sql> <title>: accepted, no personal row, one receipted destination
  local got
  got="$(attempt "$2")"
  expect "$1" "${got}|$(val "select count(*) from public.notifications where title='$3'")|$(receipted "$3")" "ok|0|1"
}
as_anon="set role anon;"
as_authenticated="select set_config('request.jwt.claims', '{\"sub\":\"${OWNER}\",\"role\":\"authenticated\"}', false); set role authenticated;"
ins() { # ins <title> [extra columns] [extra values]: an owner financial_incident
  echo "insert into public.notifications(user_id,type,title,message${2:+,$2}) values ('${OWNER}','financial_incident','$1','probe'${3:+,$3})"
}
RLS="42501|new row violates row-level security policy for table \"notifications\""
NOT_NULL() { echo "23502|null value in column \"$1\" of relation \"$2\" violates not-null constraint"; }
FK() { echo "23503|insert or update on table \"notifications\" violates foreign key constraint \"$1\""; }
PK="23505|duplicate key value violates unique constraint \"notifications_pkey\"|-"
UNKNOWN_ACTOR='44444444-4444-4444-8444-444444444444'

# ---------------------------------------------------------------- RED --------
psql -c "select public.fn_raise_notification('${OWNER}','financial_incident','Red probe','before the migration')" >/dev/null
red="$(owner_rows)"
if [[ "$red" == "1" ]]; then
  echo "RED   before the migration an operational notification wrote the owner's personal row (1 row): the defect reproduces"
else
  echo "FAIL  red phase did not reproduce the defect (owner operational rows: $red)"
  exit 1
fi
psql -c "insert into public.notifications(user_id,type,title) values ('${OWNER}','welcome','Ordinary owner notice')" >/dev/null
ORDINARY_ID="$(val "select id from public.notifications where title='Ordinary owner notice'")"

# What production does today with the writers and rows the new clauses are about.
refused "before: anon writing an owner-operational row is refused by row-level security" \
  "${as_anon} $(ins 'Anon before')" "${RLS}|-"
refused "before: authenticated (as the owner) writing one is refused by row-level security" \
  "${as_authenticated} $(ins 'Authenticated before')" "${RLS}|-"
refused "before: a member of pg_write_all_data is refused by row-level security" \
  "set role probe_write_all_data; $(ins 'Write-all before')" "${RLS}|-"
expect "before: a service_role member that does not bypass row-level security is admitted by \"Service role inserts\"" \
  "$(attempt "set role probe_backup_admin_like; $(ins 'Backup-like before')")" "ok"
refused "before: a NULL title is refused (NOT NULL)" \
  "insert into public.notifications(user_id,type,title) values ('${OWNER}','financial_incident',NULL)" "$(NOT_NULL title notifications)|-"
refused "before: an unknown actor is refused (foreign key)" \
  "$(ins 'Unknown actor before' actor_id "'${UNKNOWN_ACTOR}'")" "$(FK notifications_actor_id_fkey)|-"
refused "before: an id already in notifications is refused (primary key)" \
  "$(ins 'Duplicate before' id "'${ORDINARY_ID}'")" "${PK}"
refused "before: a recipient with no profile is refused (foreign key)" \
  "delete from public.profiles where id='${OWNER}'; $(ins 'No profile before')" "$(FK fk_notifications_user_id_profiles)|-"
refused "before: a NULL type is refused (NOT NULL)" \
  "insert into public.notifications(user_id,type,title) values ('${OWNER}',NULL,'Null type before')" "$(NOT_NULL type notifications)|-"
refused "before: a NULL id is refused, by the capture's own destination insert" \
  "$(ins 'Null id before' id NULL)" "$(NOT_NULL notification_id operational_notification_destinations)|fn_capture_owner_notification_destination"

psql -c "delete from public.notifications; delete from public.operational_notification_destinations; delete from public.operational_alert_events;" >/dev/null

# Keep every pre-image so each change can be shown necessary below.
psql -c "create table public.probe_images as
  select k, 'pre'::text as image, pg_get_functiondef(r::regprocedure) as def
    from (values ('capture','public.fn_capture_owner_notification_destination()'),
                 ('scorecard','public.fn_ca_break_scorecard_push(public.ca_break_scorecards)'),
                 ('bank','public.fn_notify_guarantee_bank_short(uuid)'),
                 ('drill','public.fn_ca_alarm_drill()')) v(k, r);" >/dev/null
use_image() { psql -c "do \$u\$ begin execute (select def from public.probe_images where k='$1' and image='$2'); end \$u\$;" >/dev/null; }

# ------------------------------------------------------- INSTALL REFUSALS ----
# The install refuses a database it was not written for, and changes nothing.
install_refused() { # <label> <setup sql> <undo sql> <error>
  local before out
  psql -c "$2" >/dev/null
  before="$(state)|$(fn_md5 "${REG[capture]}")"
  if out="$(psql -f "$migration" 2>&1)"; then fail "$1: the migration applied"; psql -c "$3" >/dev/null; return; fi
  if [[ "$out" != *"$4"* ]]; then fail "$1: refused for another reason: $(printf '%s\n' "$out" | grep -m1 ERROR || true)"; psql -c "$3" >/dev/null; return; fi
  [[ "$before" == "$(state)|$(fn_md5 "${REG[capture]}")" ]] && pass "$1 (refused: $4; nothing changed)" || fail "$1: the refusal changed something"
  psql -c "$3" >/dev/null
}
install_refused "install refused: notifications gains a CHECK the validity clause does not know" \
  "alter table public.notifications add constraint probe_title_length check (length(title) < 500)" \
  "alter table public.notifications drop constraint probe_title_length" "NOTIFICATIONS_CONSTRAINTS_CHANGED"
install_refused "install refused: an INSERT policy admits authenticated" \
  "create policy probe_users_insert on public.notifications for insert to authenticated with check (user_id = (select auth.uid()))" \
  "drop policy probe_users_insert on public.notifications" "NOTIFICATIONS_INSERT_AUTHORITY_CHANGED"
install_refused "install refused: a BEFORE INSERT trigger would fire between the authority check and the capture" \
  "create function public.probe_passthrough() returns trigger language plpgsql as \$\$ begin return new; end \$\$;
   create trigger zz_b_probe before insert on public.notifications for each row execute function public.probe_passthrough()" \
  "drop trigger zz_b_probe on public.notifications; drop function public.probe_passthrough()" "OWNER_AUTHORITY_NOT_NEXT_TO_CAPTURE"

# ---------------------------------------------------------------- APPLY ------
psql -f "$migration" >"${workdir}/apply.log" 2>&1 || { cat "${workdir}/apply.log"; echo "FAIL  migration did not apply"; exit 1; }
psql -c "insert into public.probe_images
  select k, 'post', pg_get_functiondef(r::regprocedure)
    from (values ('capture','public.fn_capture_owner_notification_destination()'),
                 ('scorecard','public.fn_ca_break_scorecard_push(public.ca_break_scorecards)'),
                 ('bank','public.fn_notify_guarantee_bank_short(uuid)'),
                 ('drill','public.fn_ca_alarm_drill()')) v(k, r);" >/dev/null
pass "migration applied to the production pre-images, its install checks included"
for k in capture scorecard bank drill; do
  expect "$k post-image md5" "$(fn_md5 "${REG[$k]}")" "${POST[$k]}"
done
expect "authority function md5" "$(fn_md5 'public.fn_authorize_owner_operational_original()')" "$AUTH_FN"
expect "authority trigger md5" "$(val "select md5(pg_get_triggerdef(oid)) from pg_trigger where tgname='zz_authorize_owner_operational_original'")" "$AUTH_TRG"
expect "detector function md5" "$(fn_md5 'public.fn_owner_operational_original_reached_personal_inbox()')" "$DET_FN"
expect "detector trigger md5" "$(val "select md5(pg_get_triggerdef(oid)) from pg_trigger where tgname='zz_owner_operational_original_reached_personal_inbox'")" "$DET_TRG"
expect "BEFORE INSERT order: normalize, normalize, authority, capture" \
  "$(val "select string_agg(tgname, ',' order by tgname) from pg_trigger where tgrelid='public.notifications'::regclass and not tgisinternal and (tgtype & 7)=7")" \
  "trg_notification_fill_action_url,trg_sync_notification_read_state,zz_authorize_owner_operational_original,zz_capture_owner_notification_destination"
expect "the authority function is SECURITY INVOKER and nobody but its owner may EXECUTE it" \
  "$(val "select prosecdef::text||' '||proacl::text||' '||has_function_privilege('anon',oid,'EXECUTE')::text||' '||has_function_privilege('authenticated',oid,'EXECUTE')::text||' '||has_function_privilege('service_role',oid,'EXECUTE')::text from pg_proc where oid='public.fn_authorize_owner_operational_original()'::regprocedure")" \
  "false {postgres=X/postgres} false false false"
n=0
while IFS= read -r proof; do
  n=$((n + 1))
  expect "@live-proof ${n}" "$(val "select coalesce((select (${proof}))::text, 'null')")" "true"
done < <(sed -n 's/^-- @live-proof: \(.*\)$/\1/p' "$migration")
[[ "$n" -ge 1 ]] || fail "the migration declares no @live-proof"

# ---------------------------------------------------------------- GREEN ------
psql -c "select public.fn_raise_notification('${OWNER}','financial_incident','Green probe','after the migration')" >/dev/null
expect "owner operational notification writes no personal row" "$(owner_rows)" "0"
expect "its original is captured once" "$(val "select count(*) from public.operational_notification_destinations where original_notification->>'title'='Green probe'")" "1"
expect "its receipt is recorded, addressed to the fleet task" "$(val "select count(*) from public.operational_notification_destinations d join public.operational_alert_events e on e.id=d.inbox_event_id where d.original_notification->>'title'='Green probe' and e.source='owner-operational-notifications' and e.payload->>'target_task_id'='${TASK}'")" "1"
expect "a redirected INSERT ... RETURNING returns no row" "$(val "with x as (insert into public.notifications(user_id,type,title) values ('${OWNER}','estate_digest','Returning probe') returning id) select count(*) from x")" "0"

psql -c "select public.fn_raise_notification('${OWNER}','system','Push Health Alert','routed system title')" >/dev/null
expect "owner Push Health Alert is routed" "$(owner_rows)" "0"
psql -c "select public.fn_raise_notification('${OWNER}','system','Welcome to Club Arena','ordinary')" >/dev/null
expect "owner ordinary system notice stays in the inbox" "$(val "select count(*) from public.notifications where user_id='${OWNER}' and title='Welcome to Club Arena'")" "1"
psql -c "select public.fn_raise_notification('${OWNER}','accounting_invoice','Invoice','ordinary business notice')" >/dev/null
expect "owner invoice stays in the inbox" "$(val "select count(*) from public.notifications where user_id='${OWNER}' and type='accounting_invoice'")" "1"
psql -c "select public.fn_raise_notification('${OTHER}','financial_incident','Other recipient','not the owner')" >/dev/null
expect "another recipient keeps its operational notification" "$(val "select count(*) from public.notifications where user_id='${OTHER}'")" "1"
ORDINARY_ID="$(val "select id from public.notifications where title='Welcome to Club Arena'")"

# authority: who may write an owner-operational row
AUTH_REFUSAL="${RLS}|fn_authorize_owner_operational_original"
refused "anon writing an owner-operational row is refused with row-level security's error, by the new trigger" \
  "${as_anon} $(ins 'Anon after')" "${AUTH_REFUSAL}"
refused "authenticated (as the owner) writing one is refused the same way" \
  "${as_authenticated} $(ins 'Authenticated after')" "${AUTH_REFUSAL}"
refused "a member of pg_write_all_data is still refused, now by the EXECUTE check on the trigger's WHEN" \
  "set role probe_write_all_data; $(ins 'Write-all after')" "42501|permission denied for function fn_is_owner_operational_notification|-"
refused "a service_role member that does not bypass row-level security is now refused (stricter, never looser)" \
  "set role probe_backup_admin_like; $(ins 'Backup-like after')" "${AUTH_REFUSAL}"
routed "service_role writing one is routed (no personal row, one receipted destination)" \
  "set role service_role; $(ins 'Service role after')" "Service role after"
psql <<SQL >/dev/null
create function public.probe_definer_producer(p_title text) returns void
  language plpgsql security definer set search_path = public as \$\$
begin
  insert into public.notifications(user_id, type, title, message)
  values ('${OWNER}', 'financial_incident', p_title, 'postgres-owned SECURITY DEFINER producer');
end \$\$;
revoke all on function public.probe_definer_producer(text) from public, anon, authenticated, service_role;
grant execute on function public.probe_definer_producer(text) to anon, authenticated;
SQL
routed "a postgres-owned SECURITY DEFINER producer called by anon is routed" \
  "${as_anon} select public.probe_definer_producer('Definer called by anon')" "Definer called by anon"
routed "a postgres-owned SECURITY DEFINER producer called by authenticated is routed" \
  "${as_authenticated} select public.probe_definer_producer('Definer called by authenticated')" "Definer called by authenticated"
psql -c "drop function public.probe_definer_producer(text)" >/dev/null
psql -c "alter table public.notifications disable trigger zz_authorize_owner_operational_original" >/dev/null
got="$(attempt "${as_anon} $(ins 'Injected with the authority trigger disabled')")"
expect "necessity: with zz_authorize_owner_operational_original disabled, anon's row IS stored and receipted for the task" \
  "${got}|$(receipted 'Injected with the authority trigger disabled')" "ok|1"
psql <<'SQL' >/dev/null
create temp table probe_injected as
  select notification_id, inbox_event_id from public.operational_notification_destinations
   where original_notification->>'title'='Injected with the authority trigger disabled';
delete from public.operational_notification_destinations where notification_id in (select notification_id from probe_injected);
delete from public.operational_alert_events where id in (select inbox_event_id from probe_injected);
alter table public.notifications enable trigger zz_authorize_owner_operational_original;
SQL
refused "with the trigger enabled again anon is refused again" "${as_anon} $(ins 'Anon again')" "${AUTH_REFUSAL}"

# validity: only a row PostgreSQL would have accepted is routed
refused "a NULL title is refused with PostgreSQL's own NOT NULL error" \
  "insert into public.notifications(user_id,type,title) values ('${OWNER}','financial_incident',NULL)" "$(NOT_NULL title notifications)|-"
refused "an unknown actor is refused with PostgreSQL's own foreign-key error" \
  "$(ins 'Unknown actor after' actor_id "'${UNKNOWN_ACTOR}'")" "$(FK notifications_actor_id_fkey)|-"
refused "an id already in notifications is refused with PostgreSQL's own primary-key error" \
  "$(ins 'Duplicate after' id "'${ORDINARY_ID}'")" "${PK}"
refused "a recipient with no profile is refused with PostgreSQL's own foreign-key error" \
  "delete from public.profiles where id='${OWNER}'; $(ins 'No profile after')" "$(FK fk_notifications_user_id_profiles)|-"
refused "a NULL type is refused with PostgreSQL's own NOT NULL error (the classifier already excludes it)" \
  "insert into public.notifications(user_id,type,title) values ('${OWNER}',NULL,'Null type after')" "$(NOT_NULL type notifications)|-"
refused "a NULL id is refused with PostgreSQL's own NOT NULL error on notifications" \
  "$(ins 'Null id after' id NULL)" "$(NOT_NULL id notifications)|-"
routed "an actor that exists is routed" "$(ins 'Known actor after' actor_id "'${OTHER}'")" "Known actor after"

# necessity: the capture without its validity clause accepts what PostgreSQL refuses
psql -f "${fixture_dir}/capture-without-validity.sql" >/dev/null
expect "the capture without its validity clause is the previous revision's post-image" "$(fn_md5 "${REG[capture]}")" "$NO_VALIDITY_CAPTURE"
accepted() { # accepted <label> <statements>: inside a rolled-back transaction, no error and a destination stored
  expect "$1" "$(attempt "begin; $2; do \$c\$ begin if (select count(*) from public.operational_notification_destinations where original_notification->>'message'='necessity') <> 1 then raise exception 'not captured'; end if; end \$c\$; rollback;")" "ok"
}
accepted "necessity: without it a NULL title is accepted and captured" \
  "insert into public.notifications(user_id,type,title,message) values ('${OWNER}','financial_incident',NULL,'necessity')"
accepted "necessity: without it an unknown actor is accepted and captured" \
  "insert into public.notifications(user_id,type,title,message,actor_id) values ('${OWNER}','financial_incident','Unknown actor','necessity','${UNKNOWN_ACTOR}')"
accepted "necessity: without it an id already in notifications is accepted and captured" \
  "insert into public.notifications(id,user_id,type,title,message) values ('${ORDINARY_ID}','${OWNER}','financial_incident','Duplicate','necessity')"
accepted "necessity: without it a recipient with no profile is accepted and captured" \
  "delete from public.profiles where id='${OWNER}'; insert into public.notifications(user_id,type,title,message) values ('${OWNER}','financial_incident','No profile','necessity')"
expect "necessity: without it a NULL id is refused by the destination insert, not with notifications' own error" \
  "$(attempt "$(ins 'Null id' id NULL)")" "$(NOT_NULL notification_id operational_notification_destinations)|fn_capture_owner_notification_destination"
use_image capture post
expect "restored post-image capture" "$(fn_md5 "${REG[capture]}")" "${POST[capture]}"

# break scorecard: rescoring the same break records it once
psql -c "insert into public.ca_incident_recipients(user_id) values ('${OWNER}');
         insert into public.ca_break_scorecards(break_ended_at, break_started_at, verdict, detail)
         values ('2026-09-27 21:00:00+00','2026-09-27 20:55:00+00','fail','{\"reasons\":[\"thaw_did_not_run\"]}');" >/dev/null
rescore_twice() {
  psql -c "delete from public.operational_notification_destinations where original_notification->>'type'='engine_break_failed'" >/dev/null
  for i in 1 2; do
    psql -c "select public.fn_ca_break_scorecard_push(s) from public.ca_break_scorecards s" >/dev/null
  done
  val "select count(*) from public.operational_notification_destinations where original_notification->>'type'='engine_break_failed'"
}
expect "break alert is routed once across two rescorings" "$(rescore_twice)" "1"
expect "break alert writes no personal row" "$(owner_rows)" "0"
use_image scorecard pre
expect "necessity: the pre-image scorecard repeats a routed break alert" "$(rescore_twice)" "2"
use_image scorecard post
expect "restored post-image scorecard routes it once again" "$(rescore_twice)" "1"

# guarantee bank: a routed copy is outstanding until the task picks its receipt up
psql -c "insert into public.unions(id,name,owner_id) values ('aaaaaaaa-0000-4000-8000-000000000001','Union One','${OWNER}');
         insert into public.union_wallets(union_id,chip_balance) values ('aaaaaaaa-0000-4000-8000-000000000001',10);
         insert into public.clubs(id,union_id,name,owner_id) values ('cccccccc-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','Club One','${CLUB_OWNER}');
         insert into public.tournaments(club_id,guaranteed_prize,prize_pool,status) values ('cccccccc-0000-4000-8000-000000000001',500,0,'REGISTERING');" >/dev/null
shortfall() { psql -c "select public.fn_notify_guarantee_bank_short('cccccccc-0000-4000-8000-000000000001')" >/dev/null; }
routed_bank() { val "select count(*) from public.operational_notification_destinations where original_notification->>'type'='guarantee_bank_short'"; }
newest_bank_receipt() { # newest_bank_receipt <investigation_status>
  psql -c "update public.operational_alert_events e set investigation_status='$1' from public.operational_notification_destinations d where d.inbox_event_id=e.id and d.notification_id=(select notification_id from public.operational_notification_destinations where original_notification->>'type'='guarantee_bank_short' order by captured_at desc, notification_id desc limit 1)" >/dev/null
}
shortfall; shortfall
expect "owner shortfall is routed once while its receipt is 'new'" "$(routed_bank)" "1"
expect "the club owner keeps one personal shortfall notice" "$(val "select count(*) from public.notifications where user_id='${CLUB_OWNER}' and type='guarantee_bank_short'")" "1"
newest_bank_receipt investigating; shortfall
expect "once the task picks the receipt up ('investigating') the next shortfall is recorded" "$(routed_bank)" "2"
shortfall
expect "the newer receipt, still 'new', holds it outstanding again" "$(routed_bank)" "2"
newest_bank_receipt verified_fixed; shortfall
expect "a receipt the task closed ('verified_fixed') lets the next shortfall be recorded" "$(routed_bank)" "3"
psql -c "update public.operational_notification_destinations set inbox_event_id=null where notification_id=(select notification_id from public.operational_notification_destinations where original_notification->>'type'='guarantee_bank_short' order by captured_at desc, notification_id desc limit 1)" >/dev/null
shortfall
expect "a pending receipt (none recorded yet) holds it outstanding too" "$(routed_bank)" "3"
expect "shortfalls write no owner personal row" "$(owner_rows)" "0"
bank_twice() {
  psql -c "delete from public.operational_notification_destinations where original_notification->>'type'='guarantee_bank_short'" >/dev/null
  shortfall; shortfall
  routed_bank
}
use_image bank pre
expect "necessity: the pre-image bank reader repeats a routed shortfall" "$(bank_twice)" "2"
use_image bank post
expect "restored post-image bank reader routes it once again" "$(bank_twice)" "1"

# alarm drill arm 4 on a routed original
# Arm 4 counts ANY financial_incident row of the last five seconds, so clear the
# earlier probe rows first: only the drill's own raise may satisfy it.
drill_arm4() {
  psql -c "delete from public.notifications where type='financial_incident'" >/dev/null
  val "select (r->>'pass')||'|'||coalesce(r->>'note','') from jsonb_array_elements(public.fn_ca_alarm_drill()->'results') r where r->>'check'='raise_scope_and_notify'"
}
expect "alarm drill arm 4 passes on a routed original" "$(drill_arm4)" "true|"
use_image drill pre
expect "necessity: the pre-image drill reports the routed raise as silent" "$(drill_arm4)" "false|raise did not notify"
use_image drill post
expect "restored post-image drill passes arm 4 again" "$(drill_arm4)" "true|"

# detector: an owner-operational row that reaches the inbox is recorded
psql -c "alter table public.notifications disable trigger zz_capture_owner_notification_destination;
         select public.fn_raise_notification('${OWNER}','financial_attestation','Bypass probe','capture disabled');
         alter table public.notifications enable trigger zz_capture_owner_notification_destination;" >/dev/null
expect "with the capture disabled the row reaches the inbox" "$(val "select count(*) from public.notifications where title='Bypass probe'")" "1"
expect "the detector records it for the fleet task" "$(val "select count(*) from public.operational_alert_events e join public.notifications n on e.event_key=n.id::text where n.title='Bypass probe' and e.source='owner-inbox-routing-guard' and e.alertname='OwnerOperationalOriginalReachedPersonalInbox' and e.payload->>'target_task_id'='${TASK}'")" "1"
expect "the detector does not fire for ordinary rows" "$(val "select count(*) from public.operational_alert_events where source='owner-inbox-routing-guard'")" "1"

# the migration refuses a second run
if psql -f "$migration" >"${workdir}/second.log" 2>&1; then
  fail "a second run of the migration was accepted"
else
  grep -q "OWNER_CAPTURE_SOURCE_OR_AUTHORITY_CHANGED" "${workdir}/second.log" \
    && pass "a second run is refused by its pre-image guard" \
    || { cat "${workdir}/second.log"; fail "a second run failed for an unexpected reason"; }
fi

if (( failures > 0 )); then
  echo "RESULT: ${failures} assertion(s) failed"
  exit 1
fi
echo "RESULT: red before, green after - all assertions passed"
