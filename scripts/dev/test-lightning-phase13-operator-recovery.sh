#!/usr/bin/env bash
# The original 20-section qualification remains intact; then qualify the
# forward-only worker-off guard over that same real-chain database.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
# Qualify the live-index maintenance settings in an isolated cluster before
# the unchanged original operator/worker chain. Existing accounting shard 3
# invokes this owner for every relevant migration and server change.
python3 "$root/scripts/ci/test-lightning-live-index-maintenance.py"
# Exact current operator body: uncertain hold outcome and foreign-hold CAS regression.
python3 -B "$root/scripts/dev/test-lightning-release-hold-outcome.py"
port=${LIGHTNING_P13_PORT:-55564}
log=$(mktemp "${TMPDIR:-/tmp}/lp13-recovery.XXXXXX")
fixture=''
cleanup() {
  if [ -n "$fixture" ]; then
    "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$fixture"
  fi
  rm -f "$log"
}
trap cleanup EXIT
LIGHTNING_P13_KEEP=1 bash "$root/scripts/dev/test-lightning-phase13-rollout-drain.sh" | tee "$log"
fixture=$(sed -n 's/^kept //p' "$log")
[ -d "$fixture/data" ] || { echo 'FAIL: missing qualified fixture'; exit 1; }
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -w -o "-k $fixture/socket -p $port -h '' -c wal_level=logical" start >/dev/null
PSQL=("$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p "$port" -d postgres)
"${PSQL[@]}" <<'SQL'
BEGIN;
DO $$
DECLARE g uuid; players uuid[]; hand uuid; r jsonb;
BEGIN
 g := harness.lc('worker off before');
 players := harness.idle(g,false,4) || harness.idle(g,true,2);
 hand := harness.dealt(g,players);
 PERFORM harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"form"}'),'fixture form');
 r := harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}'),'before allows unsafe off');
 IF harness.hstate(hand) <> 'dealing' OR public.fn_lightning_config(g)->>'worker_mode' <> 'off' THEN RAISE EXCEPTION 'FAIL preimage witness'; END IF;
 RAISE NOTICE 'REPRODUCED: worker off admitted with a real hand dealing';
END $$;
ROLLBACK;
CREATE PUBLICATION supabase_realtime;
-- Production owns these doors as postgres; local initdb owns as its OS user.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF; END $$;
ALTER FUNCTION public.fn_lightning_operator_control(uuid,text,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_lightning_operator_state(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_lightning_operator_cluster_row(uuid,timestamp with time zone) OWNER TO postgres;
SELECT prosecdef,proconfig,pg_get_userbyid(proowner),proacl::text FROM pg_proc WHERE oid IN ('public.fn_lightning_operator_control(uuid,text,text,jsonb)'::regprocedure,'public.fn_lightning_operator_state(uuid)'::regprocedure);
SQL
# The serving checkpointed thaw's exact preimage, from its immutable migration.
"${PSQL[@]}" <<'SQL'
CREATE TABLE public.engine_maintenance_thaws (freeze_started_at timestamptz PRIMARY KEY, thawed_at timestamptz DEFAULT now(), frozen_seconds numeric NOT NULL, shifted jsonb NOT NULL, thawed_by text, contract_version integer);
SQL
python3 - "$root" "$fixture/thaw.sql" <<'PYTHON'
import re,sys
from pathlib import Path
s=(Path(sys.argv[1])/'supabase/migrations/20260908032311_reconnect_allowance_survives_maintenance.sql').read_text()
reconnect=re.search(r'CREATE OR REPLACE FUNCTION public.fn_thaw_reconnect_states.*?\$\$\s*;',s,re.S).group()
f=re.search(r'CREATE OR REPLACE FUNCTION public.fn_thaw_platform\(.*?\$function\$\s*;',s,re.S).group().replace('FUNCTION public.fn_thaw_platform(', 'FUNCTION public.fn_thaw_platform_checkpointed(')
Path(sys.argv[2]).write_text(reconnect+'\n'+f+'\nALTER FUNCTION public.fn_thaw_platform_checkpointed(timestamptz,numeric,text) OWNER TO postgres;\nREVOKE ALL ON FUNCTION public.fn_thaw_platform_checkpointed(timestamptz,numeric,text) FROM PUBLIC,anon,authenticated,service_role;')
PYTHON
"${PSQL[@]}" -f "$fixture/thaw.sql"
python3 - "$root" "$fixture/thaw-targets.sql" <<'PYTHON'
import re,sys
from pathlib import Path
s=(Path(sys.argv[1])/'scripts/ci/fixtures/phase-three-current-thaw-authority.sql').read_text()
functions=[]
for name in ['fn_snapshot_maintenance_thaw_targets','fn_credit_maintenance_thaw_targets']:
 f=re.search(r'CREATE OR REPLACE FUNCTION public.'+name+r'\(.*?\$function\$\s*;',s,re.S).group()
 functions.append(f+'\nALTER FUNCTION public.'+name+'(timestamptz,numeric) OWNER TO postgres;\nREVOKE ALL ON FUNCTION public.'+name+'(timestamptz,numeric) FROM PUBLIC,anon,authenticated,service_role;')
Path(sys.argv[2]).write_text('CREATE TABLE public.engine_maintenance_thaw_targets(freeze_started_at timestamptz, step text,target_id uuid,credited_seconds numeric DEFAULT 0,PRIMARY KEY(freeze_started_at,step,target_id));\n'+'\n'.join(functions))
PYTHON
"${PSQL[@]}" -f "$fixture/thaw-targets.sql"

"${PSQL[@]}" <<'SQL'
BEGIN;
DO $$
DECLARE g uuid; f timestamptz := clock_timestamp(); deadline timestamptz; keys jsonb;
BEGIN
 g := harness.lc('drain thaw before'); PERFORM harness.must(harness.ctl('admin',g,'drain'),'before drain');
 SELECT deadline_at INTO deadline FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL;
 SELECT jsonb_object_agg(k,0) INTO keys FROM unnest(ARRAY['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until','reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at','cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at','cluster_break_eligible_since','cluster_move_expires_at','reconnect_presence','reconnect_snapshots']) k;
 INSERT INTO public.engine_maintenance_thaws(freeze_started_at,frozen_seconds,shifted) VALUES(f,300,keys);
 PERFORM public.fn_thaw_platform_checkpointed(f,300,'before witness');
 IF (SELECT deadline_at FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL) IS DISTINCT FROM deadline THEN RAISE EXCEPTION 'FAIL unexpected preimage thaw'; END IF;
 RAISE NOTICE 'REPRODUCED: completed thaw leaves the active drain deadline unshifted';
END $$;
ROLLBACK;
SQL
migration="$root/supabase/migrations/20261011155910_lightning_worker_off_requires_completed_drain.sql"
"${PSQL[@]}" -f "$migration"
"${PSQL[@]}" <<'SQL'
DO $$
DECLARE g uuid; players uuid[]; hand uuid; before jsonb; money text; r jsonb; req uuid := gen_random_uuid();
BEGIN
 g := harness.lc('worker off guarded');
 players := harness.idle(g,false,4) || harness.idle(g,true,2);
 hand := harness.dealt(g,players);
 PERFORM harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"form"}'),'fixture form');
 before := harness.stacks(g); money := harness.money(g);
 r := harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}');
 PERFORM harness.refused(r,'CLUSTER_BUSY','worker off while dealt');
 IF r->>'reason' <> 'drain_before_worker_off' OR harness.hstate(hand) <> 'dealing' OR harness.stacks(g) IS DISTINCT FROM before OR harness.money(g) IS DISTINCT FROM money OR public.fn_lightning_config(g)->>'worker_mode' <> 'form' THEN RAISE EXCEPTION 'FAIL guarded transition: %',r; END IF;
 PERFORM harness.must(harness.ctl('admin',g,'drain'),'drain');
 PERFORM harness.refused(harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}'),'CLUSTER_BUSY','off during drain');
 PERFORM harness.finish(g,hand,players[1]);
 PERFORM public.fn_cash_cluster_lightning_drive(g);
 IF harness.mode(g) <> 'must_move' OR harness.open_sessions(g) <> 0 THEN RAISE EXCEPTION 'FAIL incomplete real drain'; END IF;
 before := harness.stacks(g); money := harness.money(g);
 r := harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}','drained worker off',req),'off after real drain');
 IF r#>>'{before,worker_mode}' <> 'form' OR r#>>'{after,worker_mode}' <> 'off' OR harness.stacks(g) IS DISTINCT FROM before OR harness.money(g) IS DISTINCT FROM money THEN RAISE EXCEPTION 'FAIL receipts or money: %',r; END IF;
 r := harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}','drained worker off',req);
 IF (r->>'replayed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL request replay'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='cash_cluster_events') THEN RAISE EXCEPTION 'FAIL event publication'; END IF;
END $$;
SQL
"${PSQL[@]}" <<'SQL'
ALTER TABLE public.table_seats ADD COLUMN IF NOT EXISTS sit_out_at timestamptz;
CREATE TABLE IF NOT EXISTS public.table_waitlist(id uuid PRIMARY KEY,hold_expires_at timestamptz);
CREATE TABLE IF NOT EXISTS public.tournaments(id uuid PRIMARY KEY);
ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS addon_period_ends_at timestamptz, ADD COLUMN IF NOT EXISTS level_started_at timestamptz, ADD COLUMN IF NOT EXISTS on_break boolean, ADD COLUMN IF NOT EXISTS status text;
CREATE TABLE IF NOT EXISTS public.chip_transactions(id uuid PRIMARY KEY,reversible_until timestamptz);
CREATE TABLE IF NOT EXISTS public.tournament_bounty_awards(id uuid PRIMARY KEY,reveal_deadline_at timestamptz);
CREATE TABLE IF NOT EXISTS public.tournament_players(id uuid PRIMARY KEY,rebuy_prompt_until timestamptz);
ALTER TABLE public.cash_player_session ADD COLUMN IF NOT EXISTS stay_last_tick_at timestamptz, ADD COLUMN IF NOT EXISTS stay_running boolean;
CREATE TABLE IF NOT EXISTS public.cash_rejoin_constraints(id uuid PRIMARY KEY,expires_at timestamptz);
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS bomb_pot_next_due_at timestamptz, ADD COLUMN IF NOT EXISTS break_eligible_since timestamptz;
ALTER TABLE public.cash_seat_moves ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE TABLE IF NOT EXISTS public.engine_presence_parked(table_id uuid PRIMARY KEY,disconnect_states jsonb,parked_at timestamptz);
CREATE TABLE IF NOT EXISTS public.hand_state_snapshots(id uuid PRIMARY KEY,disconnect_states jsonb,is_complete boolean,updated_at timestamptz);
DO $$
DECLARE g uuid; f timestamptz := clock_timestamp(); deadline timestamptz; r jsonb; keys jsonb;
BEGIN
 g := harness.lc('drain deadline freeze');
 PERFORM harness.must(harness.ctl('admin',g,'drain'),'deadline drain');
 SELECT deadline_at INTO deadline FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL;
 -- Other thaw steps are outside this narrow fixture and already have their keys.
 SELECT jsonb_object_agg(k,0) INTO keys FROM unnest(ARRAY['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until','reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at','cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at','cluster_break_eligible_since','cluster_move_expires_at','reconnect_presence','reconnect_snapshots']) k;
 INSERT INTO public.engine_maintenance_thaws(freeze_started_at,frozen_seconds,shifted) VALUES(f,300,keys);
 PERFORM public.fn_snapshot_maintenance_thaw_targets(f,300);
 r := public.fn_thaw_platform_checkpointed(f,300,'isolated lightning deadline');
 IF (r->>'complete')::boolean IS DISTINCT FROM true OR (SELECT deadline_at FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL) IS DISTINCT FROM deadline+interval '300 seconds' THEN RAISE EXCEPTION 'FAIL thaw did not restore deadline: %',r; END IF;
 r := public.fn_thaw_platform_checkpointed(f,300,'repeat');
 IF r->>'reason' <> 'already_thawed' OR (SELECT deadline_at FROM public.lightning_cluster_drain WHERE cluster_id=g AND completed_at IS NULL) IS DISTINCT FROM deadline+interval '300 seconds' OR harness.evn(g,'lightning_drain_deadline_thawed') <> 1 THEN RAISE EXCEPTION 'FAIL duplicate thaw shifted again or emitted twice'; END IF;
END $$;
SQL
"${PSQL[@]}" <<'SQL'
DO $$
DECLARE t record; r jsonb; deadline timestamptz;
BEGIN
 SELECT freeze_started_at INTO t FROM public.engine_maintenance_thaws WHERE thawed_by IS DISTINCT FROM 'before witness' ORDER BY freeze_started_at DESC LIMIT 1;
 -- Mirror the real v3 wrapper marking the initial step's captured targets.
 UPDATE public.engine_maintenance_thaw_targets SET credited_seconds=300 WHERE freeze_started_at=t.freeze_started_at AND step='lightning_drain_deadline_at';
 UPDATE public.engine_maintenance_thaws SET shifted=shifted||'{"_targets_snapshotted":true}' WHERE freeze_started_at=t.freeze_started_at;
 CREATE TEMP TABLE tail_before AS SELECT id,deadline_at FROM public.lightning_cluster_drain WHERE id IN (SELECT target_id FROM public.engine_maintenance_thaw_targets WHERE freeze_started_at=t.freeze_started_at);
 r:=public.fn_credit_maintenance_thaw_targets(t.freeze_started_at,312);
 IF (r->>'complete')::boolean IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM tail_before b JOIN public.lightning_cluster_drain d USING(id) WHERE d.deadline_at IS DISTINCT FROM b.deadline_at+interval '12 seconds') THEN RAISE EXCEPTION 'FAIL tail credit: %',r; END IF;
 r:=public.fn_credit_maintenance_thaw_targets(t.freeze_started_at,312);
 IF EXISTS(SELECT 1 FROM tail_before b JOIN public.lightning_cluster_drain d USING(id) WHERE d.deadline_at IS DISTINCT FROM b.deadline_at+interval '12 seconds') THEN RAISE EXCEPTION 'FAIL tail credit replay'; END IF;
END $$;
SQL
"${PSQL[@]}" -f "$migration"
python3 - "$migration" "$fixture/forward-proofs.sql" <<'PYTHON'
import sys
from pathlib import Path
proofs=[line.split('-- @live-proof: ',1)[1] for line in Path(sys.argv[1]).read_text().splitlines() if line.startswith('-- @live-proof: ')]
assert len(proofs)==6
Path(sys.argv[2]).write_text('\n'.join("DO $$ BEGIN IF ("+expr+") IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL forward live proof "+str(n)+"'; END IF; END $$;" for n,expr in enumerate(proofs,1)))
PYTHON
"${PSQL[@]}" -f "$fixture/forward-proofs.sql"
"${PSQL[@]}" -c "DELETE FROM harness.lp8 WHERE phase='own'" -f "$fixture/own-proofs-eval.sql" -f "$fixture/own-proofs.sql"
echo 'PASS: worker off refuses before completed drain, preserves dealt hands and stacks, admits after real settlement and MUST MOVE, receipts expose mode, request replay, publication, idempotent frozen-deadline restoration, prior proofs and exact reapplication'
# Qualify the calibrated-window control on the same real retained chain.
"${PSQL[@]}" <<'SQL'
BEGIN;
DO $$ DECLARE g uuid; BEGIN
 g:=harness.lc('shadow window before');
 PERFORM harness.refused(harness.ctl('admin',g,'set_shadow_window','{"shadow_window_ms":60000}'),'INVALID_ACTION','missing window door');
 RAISE NOTICE 'REPRODUCED: the operator cannot shorten a five-minute shadow window';
END $$;
ROLLBACK;
SQL
shadow_migration="$root/supabase/migrations/20261012040746_lightning_shadow_calibration_window_control.sql"
"${PSQL[@]}" -f "$shadow_migration"
"${PSQL[@]}" <<'SQL'
DO $$
DECLARE g uuid; r jsonb; req uuid:=gen_random_uuid(); money text; stacks jsonb; n bigint;
BEGIN
 g:=harness.lc('shadow calibration window');
 money:=harness.money(g); stacks:=harness.stacks(g);
 PERFORM harness.refused(harness.ctl('stranger',g,'set_shadow_window','{"shadow_window_ms":60000}'),'NOT_AUTHORIZED','window outsider');
 PERFORM harness.refused(harness.ctl('admin',g,'set_shadow_window','{"shadow_window_ms":60000}',''),'REASON_REQUIRED','window reason');
 FOR r IN SELECT value FROM jsonb_array_elements('[{}, {"shadow_window_ms":"60000"}, {"shadow_window_ms":null}, {"shadow_window_ms":59999}, {"shadow_window_ms":60000.5}, {"shadow_window_ms":3600001}, {"shadow_window_ms":1e99}]') LOOP
   PERFORM harness.refused(harness.ctl('admin',g,'set_shadow_window',r),'INVALID_ARGS','window invalid');
 END LOOP;
 PERFORM harness.refused(harness.ctl('admin',g,'set_shadow_window','{"shadow_window_ms":60000}'),'CLUSTER_BUSY','window live pool');
 PERFORM harness.must(harness.ctl('admin',g,'drain'),'window drain');
 PERFORM public.fn_cash_cluster_lightning_drive(g);
 IF harness.mode(g)<>'must_move' THEN RAISE EXCEPTION 'FAIL window drain'; END IF;
 PERFORM harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}'),'window worker off');
 r:=harness.must(harness.ctl('admin',g,'set_shadow_window','{"shadow_window_ms":60000}','private calibration',req),'window set');
 IF public.fn_lightning_config(g)->>'shadow_window_ms'<>'60000' OR r#>>'{detail,shadow_window_ms}'<>'60000'
    OR (SELECT args->>'shadow_window_ms' FROM public.lightning_operator_request WHERE request_id=req)<>'60000'
    OR NOT EXISTS(SELECT 1 FROM public.cash_cluster_events WHERE game_id=g AND kind='operator_set_shadow_window' AND request_id=req)
 THEN RAISE EXCEPTION 'FAIL persisted audited window: %',r; END IF;
 SELECT count(*) INTO n FROM public.cash_cluster_events WHERE game_id=g AND kind='operator_set_shadow_window';
 r:=harness.ctl('admin',g,'set_shadow_window','{"shadow_window_ms":60000}','private calibration',req);
 IF (r->>'replayed')::boolean IS DISTINCT FROM true OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id=g AND kind='operator_set_shadow_window')<>n THEN RAISE EXCEPTION 'FAIL window replay'; END IF;
 PERFORM harness.already(harness.ctl('admin',g,'set_shadow_window','{"shadow_window_ms":60000}'),'window unchanged');
 PERFORM harness.must(harness.ctl('admin',g,'set_shadow_window','{"shadow_window_ms":3600000}'),'window upper bound');
 PERFORM harness.must(harness.ctl('admin',g,'set_shadow_window','{"shadow_window_ms":60000}'),'window restore calibration');
 PERFORM harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"shadow"}'),'window shadow worker');
 PERFORM harness.refused(harness.ctl('admin',g,'set_shadow_window','{"shadow_window_ms":120000}'),'CLUSTER_BUSY','window running worker');
 IF harness.money(g) IS DISTINCT FROM money OR harness.stacks(g) IS DISTINCT FROM stacks THEN RAISE EXCEPTION 'FAIL window moved money or stacks'; END IF;
END $$;
SQL
"${PSQL[@]}" -f "$shadow_migration"
echo 'PASS: audited calibration window, outsider/reason/type/bounds/live-worker refusals, real drain, one event under replay, unchanged money/stacks and exact migration reapplication'

# Missing integrity activation is reproduced before installing its forward correction.
"${PSQL[@]}" <<'SQL'
BEGIN;
DO $$ DECLARE g uuid; BEGIN
 g:=harness.lc('integrity before');
 PERFORM harness.refused(harness.ctl('admin',g,'set_integrity_telemetry','{"value":true}'),'INVALID_ACTION','missing integrity door');
 RAISE NOTICE 'REPRODUCED: integrity telemetry has no operator activation door';
END $$;
ROLLBACK;
SQL
integrity_migration="$root/supabase/migrations/20261012112753_lightning_integrity_telemetry_operator_control.sql"
"${PSQL[@]}" -f "$integrity_migration"
"${PSQL[@]}" <<'SQL'
DO $$
DECLARE g uuid; req uuid:=gen_random_uuid(); r jsonb; money text; stacks jsonb; players uuid[]; hand uuid; n bigint;
BEGIN
 g:=harness.lc('integrity calibration'); players:=harness.idle(g,false,4)||harness.idle(g,true,2); hand:=harness.dealt(g,players);
 money:=harness.money(g); stacks:=harness.stacks(g);
 PERFORM harness.refused(harness.ctl('stranger',g,'set_integrity_telemetry','{"value":true}'),'NOT_AUTHORIZED','integrity outsider');
 PERFORM harness.refused(harness.ctl('admin',g,'set_integrity_telemetry','{"value":true}',''),'REASON_REQUIRED','integrity reason');
 FOR r IN SELECT value FROM jsonb_array_elements('[{}, {"value":"true"}, {"value":null}, {"value":1}, {"value":{}}, {"value":[]}]') LOOP
  PERFORM harness.refused(harness.ctl('admin',g,'set_integrity_telemetry',r),'INVALID_ARGS','integrity type');
 END LOOP;
 PERFORM harness.refused(harness.ctl('admin',g,'set_integrity_telemetry','{"value":true}'),'CLUSTER_BUSY','integrity live');
 PERFORM harness.must(harness.ctl('admin',g,'drain'),'integrity drain');
 PERFORM harness.refused(harness.ctl('admin',g,'set_integrity_telemetry','{"value":true}'),'CLUSTER_BUSY','integrity draining');
 PERFORM harness.finish(g,hand,players[1]); PERFORM public.fn_cash_cluster_lightning_drive(g);
 IF harness.mode(g)<>'must_move' OR harness.open_sessions(g)<>0 THEN RAISE EXCEPTION 'FAIL integrity real drain'; END IF;
 PERFORM harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"shadow"}'),'integrity shadow');
 PERFORM harness.refused(harness.ctl('admin',g,'set_integrity_telemetry','{"value":true}'),'CLUSTER_BUSY','integrity worker');
 PERFORM harness.must(harness.ctl('admin',g,'set_worker_mode','{"mode":"off"}'),'integrity off');
 money:=harness.money(g); stacks:=harness.stacks(g);
 r:=harness.must(harness.ctl('admin',g,'set_integrity_telemetry','{"value":true}','integrity qualification',req),'integrity enable');
 IF (public.fn_lightning_config(g)->>'integrity_telemetry') IS DISTINCT FROM 'true' OR (r#>>'{before,integrity_telemetry}') IS DISTINCT FROM 'false' OR (r#>>'{after,integrity_telemetry}') IS DISTINCT FROM 'true' OR r#>>'{after,shadow_window_ms}' IS NULL
 OR (SELECT args->>'value' FROM public.lightning_operator_request WHERE request_id=req) IS DISTINCT FROM 'true'
 OR (public.fn_lightning_operator_cluster_row(g,now())#>>'{flags,integrity_telemetry}') IS DISTINCT FROM 'true'
 OR public.fn_lightning_operator_cluster_row(g,now())->>'shadow_window_ms' IS NULL THEN RAISE EXCEPTION 'FAIL integrity persistence/state/readmodel: %',r; END IF;
 SELECT count(*) INTO n FROM public.cash_cluster_events WHERE game_id=g AND kind='operator_set_integrity_telemetry';
 IF n<>1 THEN RAISE EXCEPTION 'FAIL integrity event count'; END IF;
 r:=harness.ctl('admin',g,'set_integrity_telemetry','{"value":true}','integrity qualification',req);
 IF (r->>'replayed')::boolean IS DISTINCT FROM true OR (SELECT count(*) FROM public.cash_cluster_events WHERE game_id=g AND kind='operator_set_integrity_telemetry')<>n THEN RAISE EXCEPTION 'FAIL integrity duplicate'; END IF;
 PERFORM harness.already(harness.ctl('admin',g,'set_integrity_telemetry','{"value":true}'),'integrity unchanged');
 PERFORM harness.must(harness.ctl('admin',g,'set_integrity_telemetry','{"value":false}'),'integrity disable');
 IF (public.fn_lightning_config(g)->>'integrity_telemetry') IS DISTINCT FROM 'false' OR harness.money(g) IS DISTINCT FROM money OR harness.stacks(g) IS DISTINCT FROM stacks THEN RAISE EXCEPTION 'FAIL integrity disable or money'; END IF;
END $$;
SQL
"${PSQL[@]}" -f "$integrity_migration"
echo 'PASS: missing integrity door reproduced; authenticated typed dark-cluster activation, real hand drain, running-worker refusal, persisted dashboard/receipt settings, one event under replay, unchanged money/stacks and exact three-function migration reapplication'

# Request UUID ownership must span Clusters, not only their individual row locks.
request_race() {
  python3 - "$pgbin/psql" "$fixture/socket" "$port" "$1" <<'PYTHON'
import json,subprocess,sys,time,uuid,selectors
psql,socket,port,stage=sys.argv[1:]
args=[psql,'-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-d','postgres']
def q(sql): return subprocess.check_output(args+['-c',sql],text=True).strip()
def ctl(caller,g,rid,value=True,reason='global request qualification'):
 return "SELECT harness.ctl('%s','%s','set_integrity_telemetry','{\"value\":%s}','%s','%s');"%(caller,g,str(value).lower(),reason,rid)
def dark():
 return q("DO $$ DECLARE g uuid:=harness.lc('global request qualification'); BEGIN PERFORM harness.must(harness.ctl('admin',g,'drain'),'race drain'); PERFORM public.fn_cash_cluster_lightning_drive(g); PERFORM harness.must(harness.ctl('admin',g,'set_worker_mode','{\"mode\":\"off\"}'),'race off'); INSERT INTO harness.p13(k,game) VALUES('request-race-'||g,g); END $$; SELECT game FROM harness.p13 WHERE k LIKE 'request-race-%' ORDER BY ctid DESC LIMIT 1;")
def one(same,rollback=False):
 g1=dark();g2=g1 if same else dark();rid=str(uuid.uuid4());label='request-race-'+rid
 money=[q("SELECT harness.money('%s'),harness.stacks('%s');"%(g,g)) for g in {g1,g2}]
 first=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 second=None
 try:
  first.stdin.write("SET application_name='%s-first'; BEGIN; %s\n"%(label,ctl('admin',g1,rid)));first.stdin.flush()
  readable=selectors.DefaultSelector();readable.register(first.stdout,selectors.EVENT_READ)
  if not readable.select(10): raise AssertionError('first request failed to return within test deadline')
  original=json.loads(first.stdout.readline());assert original['ok'] is True
  second=subprocess.Popen(args+['-c',"SET application_name='%s-second'; %s"%(label,ctl('admin',g2,rid))],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  if stage=='before':
   deadline=time.monotonic()+10
   while q("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='%s-second' AND wait_event_type='Lock');"%label)!='t':
    if second.poll() is not None: raise AssertionError('second backend finished before encountering the identity collision')
    if time.monotonic()>=deadline: raise AssertionError('second backend did not reach duplicate request lock')
    time.sleep(.01)
  else:
   out,err=second.communicate(timeout=10);assert second.returncode==0,err
   pending=json.loads(out);assert pending.get('code')=='REQUEST_IN_PROGRESS',pending
   assert pending.get('request_id')==rid
   assert q("SELECT count(*) FROM public.lightning_operator_request WHERE request_id='%s';"%rid)=='0'
   # Another operation has independent ownership and must remain usable.
   if not same:
    independent=json.loads(q("SELECT harness.ctl('admin','%s','set_shadow_window','{\"shadow_window_ms\":120000}');"%g2));assert independent['ok'] is True
  first.stdin.write(('ROLLBACK;' if rollback else 'COMMIT;')+'\n\\q\n');first.stdin.flush();first.communicate(timeout=10);assert first.returncode==0
  if stage=='before':
   out,err=second.communicate(timeout=10);assert second.returncode==0,err;assert json.loads(out)['ok'] is True
   assert q("SELECT count(*) FROM public.cash_cluster_events WHERE request_id='%s' AND kind='operator_set_integrity_telemetry';"%rid)=='2'
   assert q("SELECT count(*) FROM public.lightning_operator_request WHERE request_id='%s';"%rid)=='1'
   assert q("SELECT public.fn_lightning_config('%s')->>'integrity_telemetry';"%g2)=='true'
   print('REPRODUCED: two Clusters committed two changes/events under one global request UUID and only one receipt')
  else:
   retry=json.loads(q(ctl('owner' if same else 'admin',g2,rid,True if rollback else False,'authorized cross-operator replay' if same else 'global request qualification')))
   if rollback:
    assert retry.get('ok') is True and retry.get('replayed') is not True and retry['event_id']!=original['event_id'],retry
    assert q("SELECT public.fn_lightning_config('%s')->>'integrity_telemetry';"%g2)=='true'
   elif same:
    assert retry.get('replayed') is True and retry['event_id']==original['event_id'] and retry['after']==original['after'],retry
    assert q("SELECT args->>'value' FROM public.lightning_operator_request WHERE request_id='%s';"%rid)=='true'
    assert q("SELECT (e.payload->>'actor') IS NOT DISTINCT FROM r.actor::text FROM public.cash_cluster_events e JOIN public.lightning_operator_request r USING(request_id) WHERE r.request_id='%s';"%rid)=='t'
   else:
    assert retry.get('code')=='INVALID_ARGS',retry
    assert q("SELECT public.fn_lightning_config('%s')->>'integrity_telemetry';"%g2)=='false'
   assert q("SELECT count(*) FROM public.cash_cluster_events WHERE request_id='%s' AND kind='operator_set_integrity_telemetry';"%rid)=='1'
   assert q("SELECT count(*) FROM public.lightning_operator_request WHERE request_id='%s';"%rid)=='1'
   assert json.loads(q(ctl('stranger',g1,rid))).get('code')=='NOT_AUTHORIZED'
   assert [q("SELECT harness.money('%s'),harness.stacks('%s');"%(g,g)) for g in {g1,g2}]==money
   print('PASS: global request ownership, %s replay/conflict, authenticated receipt, independent operation, one event/receipt and unchanged money/stacks'%('rollback recovery' if rollback else 'same-Cluster authorized cross-operator' if same else 'cross-Cluster'))
 finally:
  for p in [first,second]:
   if p and p.poll() is None: p.kill();p.communicate()
one(False)
if stage=='after':
 one(True)
 one(True,rollback=True)
PYTHON
}
request_race before
request_migration="$root/supabase/migrations/20261012143829_lightning_operator_request_ownership_is_global.sql"
"${PSQL[@]}" -f "$request_migration"
request_race after
"${PSQL[@]}" -f "$request_migration"
echo 'PASS: exact global-request migration reapplication and original operator security configuration'

node --test "$root/scripts/ops/prepare-lightning-private-pilot.test.mjs"
