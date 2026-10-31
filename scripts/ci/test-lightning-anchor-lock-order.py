#!/usr/bin/env python3
"""Actual socket-only Lightning formation/physical settlement concurrency regression."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / 'supabase/migrations/20261031122201_lightning_settlement_locks_anchors_in_formation_order.sql'
BEFORE = ROOT / 'scripts/ci/fixtures/lightning-anchor-order-settle-before.sql'
OUT = ROOT / 'work/lightning-anchor-order'
OUT.mkdir(parents=True, exist_ok=True)
source = (ROOT / 'supabase/migrations/20261025000729_lightning_hands_reach_the_stats_facts_and_the_collusion_scan.sql').read_text()
validator = re.search(r'CREATE FUNCTION public\.fn_lightning_hand_stats_facts\(.*?\$function\$;', source, re.S).group()
setup = 'ALTER TABLE public.lightning_hand_player ADD COLUMN IF NOT EXISTS showed boolean;\n' + validator + '\n' + BEFORE.read_text() + r"""
DO $$BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)<>'c9cece954b567607c11d7a1016f4eaa2' THEN RAISE EXCEPTION 'native preimage differs from installed source';END IF;
END$$;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA harness;
-- Fixture construction only: assign anchors opposite to player UUID order
-- before conversion creates any pool references. Every hand still forms and
-- settles through the maintained real financial doors.
DO $fixture$
DECLARE b text;
BEGIN
 SELECT pg_get_functiondef('harness.cluster(text)'::regprocedure) INTO b;
 b:=replace(b,'  PERFORM public.fx9_convert(v_g);',$inject$
  UPDATE public.table_seats ts SET id=q.new_id
  FROM (SELECT ts0.id, (substr(v_g::text,1,24) || lpad(row_number() OVER (ORDER BY ts0.user_id DESC)::text,12,'0'))::uuid new_id
        FROM public.table_seats ts0 JOIN public.tables t0 ON t0.id=ts0.table_id WHERE t0.cluster_id=v_g) q
  WHERE ts.id=q.id;
  PERFORM public.fx9_convert(v_g);
$inject$);
 EXECUTE b;
END $fixture$;
CREATE TABLE harness.lock_case(k text PRIMARY KEY,game uuid,hand_id uuid,request_id uuid,results jsonb,ids uuid[]);
CREATE FUNCTION harness.lock_case(k text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE g uuid;ids uuid[];f jsonb;h uuid;
BEGIN
 g:=harness.cluster('anchor order '||k);
 IF to_regprocedure('public.fn_lightning_cash_clock_at_settlement()') IS NOT NULL THEN
  UPDATE public.tables SET is_private=true,union_id=NULL WHERE cluster_id=g;
  UPDATE public.cash_player_session SET scope_type='table',scope_id=table_id,
    stay_remaining_ms=600000,stay_running=false,stay_last_tick_at='2000-01-01Z' WHERE cluster_id=g;
  UPDATE public.table_seats ts SET occupancy_id=coalesce(occupancy_id,gen_random_uuid())
    FROM public.tables t WHERE t.id=ts.table_id AND t.cluster_id=g;
 END IF;
 SELECT array_agg(player_id ORDER BY player_id) INTO ids FROM (
  SELECT player_id FROM public.lightning_pool_session WHERE cluster_id=g AND exited_at IS NULL ORDER BY player_id LIMIT 2) q;
 f:=harness.form(g,ids);h:=(f->>'hand_id')::uuid;PERFORM harness.deal((f->>'instance_id')::uuid);
 INSERT INTO harness.lock_case VALUES(k,g,h,gen_random_uuid(),harness.results(h,jsonb_build_object(ids[1]::text,jsonb_build_object('d',1,'c',2),ids[2]::text,jsonb_build_object('d',-1,'c',2))),ids);
 IF (SELECT array_agg(ps.player_id ORDER BY ps.anchor_seat_id) FROM public.lightning_pool_session ps
     WHERE ps.cluster_id=g AND ps.player_id=ANY(ids)) IS NOT DISTINCT FROM ids THEN
  RAISE EXCEPTION 'fixture does not oppose anchor and player order';
 END IF;
END $$;
-- Pause after the first REAL anchor lock, without changing that lock query.
CREATE FUNCTION harness.anchor_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('harness.anchor_gate',true)='on'
    AND (SELECT count(*) FROM lightning_settlement_marker WHERE txid=NEW.txid)=1 THEN
  PERFORM pg_advisory_lock(19231,1);PERFORM pg_advisory_unlock(19231,1);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER anchor_test_gate AFTER INSERT ON lightning_settlement_marker FOR EACH ROW EXECUTE FUNCTION harness.anchor_gate();
CREATE FUNCTION harness.lock_race(k text,expect_cycle boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE conn text:='host='||current_setting('unix_socket_directories')||' port='||current_setting('port')||' dbname='||current_database();
 c record;r jsonb;m jsonb;err text;deadline timestamptz;spid integer;mpid integer;cycle boolean;
BEGIN
 SELECT * INTO STRICT c FROM harness.lock_case WHERE lock_case.k=lock_race.k;
 PERFORM harness.dblink_connect('lock_settle',conn);PERFORM harness.dblink_connect('lock_form',conn);
 PERFORM harness.dblink_exec('lock_settle','SET application_name=''anchor_settler'';SET harness.anchor_gate=''on'';SET deadlock_timeout=''200ms'';SET statement_timeout=''10s''');
 PERFORM harness.dblink_exec('lock_form','SET application_name=''anchor_formation'';SET deadlock_timeout=''200ms'';SET statement_timeout=''10s''');
 SELECT pid INTO spid FROM (SELECT * FROM harness.dblink('lock_settle','SELECT pg_backend_pid()') AS x(pid integer)) x;
 SELECT pid INTO mpid FROM (SELECT * FROM harness.dblink('lock_form','SELECT pg_backend_pid()') AS x(pid integer)) x;
 PERFORM pg_advisory_lock(19231,1);
 PERFORM harness.dblink_send_query('lock_settle',format('SELECT harness.settle(%L,%L,%L::jsonb,0,0)',c.hand_id,c.request_id,c.results));
 deadline:=clock_timestamp()+interval '5 seconds';
 LOOP
  PERFORM pg_stat_clear_snapshot();
  EXIT WHEN EXISTS(SELECT FROM pg_stat_activity WHERE pid=spid AND wait_event='advisory');
  IF clock_timestamp()>deadline THEN RAISE EXCEPTION 'first real anchor lock not witnessed';END IF;
  PERFORM pg_sleep(.01);
 END LOOP;
 -- The actual formation barrier locks the same stale candidate set before
 -- revalidating reservations. A stale plan must wait/refuse, never deadlock.
 PERFORM harness.dblink_send_query('lock_form',format('SELECT public.fn_lightning_form_hand(%L,%L::uuid[],p_target_size=>2::smallint,p_max_size=>2::smallint,p_matcher_version=>''p6s-matcher'',p_request_id=>gen_random_uuid())',c.game,c.ids));
 deadline:=clock_timestamp()+interval '5 seconds';
 LOOP
  PERFORM pg_stat_clear_snapshot();
  EXIT WHEN spid=ANY(pg_blocking_pids(mpid));
  IF clock_timestamp()>deadline THEN RAISE EXCEPTION 'actual formation did not wait on original settlement';END IF;
  PERFORM pg_sleep(.01);
 END LOOP;
 PERFORM pg_advisory_unlock(19231,1);
 SELECT answer INTO r FROM harness.dblink_get_result('lock_settle',false) AS x(answer jsonb);
 err:=harness.dblink_error_message('lock_settle');
 SELECT answer INTO m FROM harness.dblink_get_result('lock_form',false) AS x(answer jsonb);
 cycle:=coalesce(err LIKE '%deadlock detected%',false) OR m->>'sqlstate'='40P01';
 PERFORM harness.dblink_disconnect('lock_settle');PERFORM harness.dblink_disconnect('lock_form');
 IF expect_cycle THEN
  IF cycle IS NOT TRUE THEN RAISE EXCEPTION 'baseline did not reproduce cycle: settle%, form%, error%',r,m,err;END IF;
 ELSE
  IF cycle IS TRUE OR r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'candidate cycle/settlement failure: settle%,form%,error%',r,m,err;END IF;
  IF m IS NULL OR (coalesce((m->>'formed')::boolean,false) IS NOT TRUE AND m->>'reason' IS DISTINCT FROM 'insufficient_legal_candidates') THEN RAISE EXCEPTION 'candidate formation did not finish its real boundary: %',m;END IF;
  IF (SELECT count(*) FROM hand_atomic_commits WHERE hand_id=(r->>'hand_history_id')::uuid)<>1 THEN RAISE EXCEPTION 'not one physical commit';END IF;
  r:=harness.settle(c.hand_id,c.request_id,c.results,0,0);
  IF r->>'replay' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'duplicate request not original receipt';END IF;
 END IF;
END $$;
CREATE TABLE harness.lock_metadata AS SELECT proowner,proacl,prosecdef,proconfig,provolatile,proparallel FROM pg_proc WHERE oid='public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure;
SELECT harness.lock_case('before');
SELECT harness.lock_case('after');
"""
setup += r"""
BEGIN;
SELECT harness.settle(hand_id,request_id,results,0,0) FROM harness.lock_case WHERE k='after';
SELECT jsonb_agg(jsonb_build_object('id',ts.id,'stack',ts.stack) ORDER BY ts.id) AS snapshot
 FROM public.table_seats ts JOIN public.tables t ON t.id=ts.table_id
 WHERE t.cluster_id=(SELECT game FROM harness.lock_case WHERE k='after') \gset expected_
ROLLBACK;
CREATE TABLE harness.lock_expected(anchors jsonb);
INSERT INTO harness.lock_expected VALUES(:'expected_snapshot'::jsonb);
"""
# Cases must commit before independent backends can read them.
setup += "SELECT harness.lock_race('before',true);\n\\echo 'PASS anchor: original production settlement and actual formation reproduce 40P01'\n"
setup += '\\i ' + str(MIG) + '\n'
setup += "SELECT harness.lock_race('after',false);\n\\echo 'PASS anchor: seat-ordered settlement and actual formation finish without cycle, one physical commit and exact replay'\n"
setup += r"""
DO $$BEGIN
 IF (SELECT anchors FROM harness.lock_expected) IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('id',ts.id,'stack',ts.stack) ORDER BY ts.id) FROM public.table_seats ts JOIN public.tables t ON t.id=ts.table_id WHERE t.cluster_id=(SELECT game FROM harness.lock_case WHERE k='after')) THEN RAISE EXCEPTION 'concurrent money differs from original serial rollback';END IF;
 IF (SELECT to_jsonb(m) FROM harness.lock_metadata m) IS DISTINCT FROM (SELECT jsonb_build_object('proowner',proowner,'proacl',proacl,'prosecdef',prosecdef,'proconfig',proconfig,'provolatile',provolatile,'proparallel',proparallel) FROM pg_proc WHERE oid='public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure) THEN RAISE EXCEPTION 'function metadata changed';END IF;
 IF has_function_privilege('anon','public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)','EXECUTE')
 OR has_function_privilege('authenticated','public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'settlement ACL changed';END IF;
END$$;
\echo 'PASS anchor: service identity and restrictive RPC access preserved'
"""
socket = os.environ.get('LIGHTNING_ZERO_PAYER_SOCKET')
with tempfile.TemporaryDirectory(prefix='anchor-order-', dir=os.environ.get('TMPDIR', str(ROOT/'work'))) as work:
    follow = Path(work)/'followup.sql'
    follow.write_text(setup)
    if socket:
        command = [str(Path(os.environ['PG_BIN'])/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                   '-h', socket, '-p', os.environ['LIGHTNING_ZERO_PAYER_PORT'], '-d', 'postgres', '-f', str(follow)]
        env = dict(os.environ)
    else:
        command = ['bash', str(ROOT/'scripts/dev/test-lightning-phase6-settlement.sh')]
        env = dict(os.environ, LIGHTNING_P6S_FOLLOWUP_SQL=str(follow))
    result = subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    (OUT/'native.log').write_text(result.stdout)
    print(result.stdout[-10000:])
    passed = result.returncode == 0 and result.stdout.count('PASS anchor:') == 3
    (OUT/'RESULTS.json').write_text(json.dumps({'passed': passed, 'exit_code': result.returncode,
        'sections': result.stdout.count('PASS anchor:'), 'migration_sha256': hashlib.sha256(MIG.read_bytes()).hexdigest(),
        'production_mutations': False}, indent=2)+'\n')
    if not passed:
        raise SystemExit(result.returncode or 1)
