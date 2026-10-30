#!/usr/bin/env python3
"""Actual PG17 admission/entry installation proof in a private socket-only cluster.

This entry qualifies the lock admission, exact four entry-point rewrites, and
rollback. Funded cancellation is separately required; no new financial
concurrency is admitted by the candidate.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import selectors
import subprocess
import sys
import time
sys.dont_write_bytecode = True
from satellite_qualifier_fixture import module

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT/'scripts/ci/fixtures/tournament-cancellation-lane'
MIGRATION = ROOT/'supabase/migrations/20261030004352_tournament_cancellation_keeps_unrelated_hands_in_their_own_l.sql'
EVENT = 'aa000000-0000-4000-8000-000000000001'
OTHER = 'aa000000-0000-4000-8000-000000000002'
G = "hashtextextended('ca:tournament-terminal-settlement:v1',0)"
F = "hashtextextended('ca:tournament-finish-lane:v1',0)"
B = "hashtextextended('ca:hand-settlement-barrier:v1',0)"
def event_key(event): return "hashtextextended('ca:tournament-terminal-settlement:v1:"+event+"',0)"
def admit(event=EVENT): return "SELECT smarter_private.cancellation_lane('"+event+"');"

class Session:
    def __init__(self,e,db):
        self.e=e
        self.p=subprocess.Popen([str(e.pg/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-h',str(e.socket),'-p',e.port,'-U','postgres','-d',db],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=e.env,bufsize=0)
        self.buffer=b''
    def send(self,sql):
        self.p.stdin.write((sql+"\nSELECT 'CANCEL_LANE_END';\n").encode());self.p.stdin.flush()
    def read(self,timeout=12):
        deadline=time.monotonic()+timeout;lines=[]
        with selectors.DefaultSelector() as selector:
            selector.register(self.p.stdout,selectors.EVENT_READ)
            while time.monotonic()<deadline:
                while b'\n' in self.buffer:
                    line,self.buffer=self.buffer.split(b'\n',1)
                    if line==b'CANCEL_LANE_END':return b'\n'.join(lines).decode()
                    lines.append(line)
                if not selector.select(max(0,deadline-time.monotonic())):break
                chunk=os.read(self.p.stdout.fileno(),65536)
                if not chunk:raise RuntimeError(b'\n'.join(lines).decode())
                self.buffer+=chunk
        raise TimeoutError('private PostgreSQL session did not reach its marker')
    def query(self,sql):self.send(sql);return self.read()
    def close(self):
        if self.p.poll() is None:
            self.p.stdin.write(b'ROLLBACK;\n\\q\n');self.p.stdin.flush()
            self.p.wait(timeout=10)
        self.p.stdin.close();self.p.stdout.close()

def held(key,mode):
    return "EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND objsubid=1 AND granted AND mode='"+mode+"' AND classid=(("+key+">>32)&4294967295)::oid AND objid=("+key+"&4294967295)::oid)"
def refuse(sql,message):
    state="55P03" if message.endswith("BUSY") else "22004" if message=="Tournament id is required" else "55000"
    return "DO $probe$ DECLARE refused boolean:=false; BEGIN BEGIN "+sql.replace("SELECT ","PERFORM ")+" EXCEPTION WHEN OTHERS THEN IF SQLSTATE<>'"+state+"' OR SQLERRM NOT LIKE '%"+message+"%' THEN RAISE; END IF; refused:=true; END; IF NOT refused THEN RAISE EXCEPTION 'expected refusal missing'; END IF; END $probe$;"

def run_admission(e,db):
    sessions=[];cases=[]
    def session():
        s=Session(e,db);sessions.append(s);return s
    def case(name,sql):
        e.sql(db,sql,label=name);cases.append(name)
    a=session();b=session();c=session()
    try:
        a.query('BEGIN; SELECT pg_advisory_xact_lock_shared('+G+');')
        b.send("BEGIN; SET LOCAL application_name='cancellation_before'; SELECT public.fn_ca_lock_settlement_lane_global();")
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            _,out,_=e.sql(db,"SELECT count(*) FROM pg_stat_activity WHERE application_name='cancellation_before' AND wait_event='advisory';",label='before-wait')
            if out.strip()=='1':break
            time.sleep(.02)
        else:raise AssertionError('baseline global cancellation did not queue')
        # A later unrelated hand cannot enter shared G while cancellation waits.
        assert c.query('SELECT pg_try_advisory_xact_lock_shared('+G+');').strip()=='f'
        a.query('ROLLBACK;');b.read();b.query('ROLLBACK;');cases.append('before-exclusive-global-convoy')
        e.sql(db,file=MIGRATION,label='install-exact-candidate')
        proof=next(line[len('-- @live-proof: '):] for line in MIGRATION.read_text().splitlines() if line.startswith('-- @live-proof: '))
        _,proof_result,_=e.sql(db,'SELECT '+proof+';',label='exact-live-proof-predicate')
        assert proof_result.strip()=='t'

        _,out,_=e.sql(db,"SELECT md5(pg_get_functiondef('smarter_private.cancellation_lane(uuid)'::regprocedure));",label='helper-postimage')
        e.report['helper_definition_md5']=out.strip()
        a.query('BEGIN; SELECT pg_advisory_xact_lock_shared('+G+');')
        b.query('BEGIN;'+refuse(admit(),'CANCELLATION_GLOBAL_LANE_BUSY'))
        assert c.query('SELECT pg_try_advisory_xact_lock_shared('+G+');').strip()=='t'
        assert b.query('SELECT '+held(G,'ExclusiveLock')+';').strip()=='f'
        b.query('ROLLBACK;');a.query('ROLLBACK;');cases.append('after-busy-cancellation-refused-with-unrelated-reader-progress')
        a.query('BEGIN; SELECT pg_advisory_xact_lock_shared('+G+');')
        for owner in ['public.atomic_cancel_tournament','public.fn_poker_diamond_tournament_cancel']:
            b.query('BEGIN;'+refuse("SELECT "+owner+"('"+EVENT+"',NULL);",'CANCELLATION_GLOBAL_LANE_BUSY'))
            assert c.query('SELECT pg_try_advisory_xact_lock_shared('+G+');').strip()=='t'
            assert b.query('SELECT '+held(G,'ExclusiveLock')+';').strip()=='f'
            b.query('ROLLBACK;');cases.append(owner+'-busy-before-event-row-or-payment')
        a.query('ROLLBACK;')
        b.query('BEGIN;'+admit())
        assert b.query('SELECT '+held(G,'ExclusiveLock')+' AND '+held(B,'ExclusiveLock')+';').strip()=='t'
        assert c.query('SELECT pg_try_advisory_xact_lock_shared('+G+');').strip()=='f'
        b.query('SELECT public.fn_ca_lock_settlement_lane_global();')
        b.query('ROLLBACK;');cases.append('free-admission-preserves-original-global-and-barrier-exclusion')
        case('forged-marker-refused',"BEGIN;SELECT set_config('ca.finish_lane_tournament','"+EVENT+"',true);"+refuse(admit(),'CANCELLATION_FINISH_AUTHORITY_INCOMPLETE')+'ROLLBACK;')
        case('foreign-marker-without-event-lock-refused',"BEGIN;SELECT pg_advisory_xact_lock_shared("+G+");SELECT pg_advisory_xact_lock("+F+");SELECT set_config('ca.finish_lane_tournament','"+OTHER+"',true);"+refuse(admit(),'CANCELLATION_EVENT_AUTHORITY_INCOMPLETE')+'ROLLBACK;')
        case('bank-scope-cannot-upgrade-finish',"BEGIN;SELECT pg_advisory_xact_lock_shared("+G+");SELECT pg_advisory_xact_lock_shared("+F+");SELECT pg_advisory_xact_lock("+event_key(EVENT)+");SELECT set_config('ca.finish_lane_tournament','"+EVENT+"',true);SELECT set_config('ca.finish_lane_scope','foreign-bank',true);"+refuse(admit(),'CANCELLATION_FINISH_AUTHORITY_INCOMPLETE')+'ROLLBACK;')
        a.query('BEGIN;SELECT pg_advisory_xact_lock_shared('+B+');')
        b.query('BEGIN;'+refuse(admit(),'CANCELLATION_BARRIER_BUSY'))
        assert b.query('SELECT '+held(G,'ExclusiveLock')+';').strip()=='f'
        assert c.query('SELECT pg_try_advisory_xact_lock_shared('+G+');').strip()=='t'
        b.query('ROLLBACK;');a.query('ROLLBACK;');cases.append('barrier-contention-rolls-back-partial-global-lock')
        case('null-refused',refuse('PERFORM smarter_private.cancellation_lane(NULL);','Tournament id is required'))
        case('atomic-null-input-refused',refuse('SELECT public.atomic_cancel_tournament(NULL,NULL);','Tournament id is required'))
        case('diamond-null-input-refused',refuse('SELECT public.fn_poker_diamond_tournament_cancel(NULL,NULL);','Tournament id is required'))
        case('partial-global-refused','BEGIN;SELECT pg_advisory_xact_lock('+G+');'+refuse(admit(),'CANCELLATION_GLOBAL_AUTHORITY_INCOMPLETE')+'ROLLBACK;')
        case('existing-global-batch-preserved','BEGIN;SELECT public.fn_ca_lock_settlement_lane_global();'+admit()+admit(OTHER)+"DO $$ BEGIN IF COALESCE(current_setting('ca.finish_lane_tournament',true),'')<>'' THEN RAISE EXCEPTION 'global batch marker invented'; END IF; END $$;ROLLBACK;")
        b.query('BEGIN;SELECT pg_advisory_xact_lock_shared('+G+');SELECT pg_advisory_xact_lock('+F+');SELECT pg_advisory_xact_lock('+event_key(EVENT)+");SELECT set_config('ca.finish_lane_tournament','"+EVENT+"',true);"+admit())
        assert b.query('SELECT '+held(G,'ShareLock')+' AND '+held(F,'ExclusiveLock')+' AND '+held(event_key(EVENT),'ExclusiveLock')+' AND NOT '+held(G,'ExclusiveLock')+' AND NOT '+held(B,'ExclusiveLock')+';').strip()=='t'
        assert c.query('SELECT pg_try_advisory_xact_lock_shared('+G+');').strip()=='t'
        assert c.query('SELECT pg_try_advisory_xact_lock_shared('+F+');').strip()=='f'
        assert c.query('SELECT pg_try_advisory_xact_lock('+event_key(EVENT)+');').strip()=='f'
        b.query('ROLLBACK;');cases.append('existing-finish-retains-shared-global-and-exclusive-finish-event')
        case('same-event-marker-without-finish-refused','BEGIN;SELECT pg_advisory_xact_lock_shared('+G+');SELECT pg_advisory_xact_lock('+event_key(EVENT)+");SELECT set_config('ca.finish_lane_tournament','"+EVENT+"',true);"+refuse(admit(),'CANCELLATION_FINISH_AUTHORITY_INCOMPLETE')+'ROLLBACK;')
        case('same-event-shared-finish-refused','BEGIN;SELECT pg_advisory_xact_lock_shared('+G+');SELECT pg_advisory_xact_lock_shared('+F+');SELECT pg_advisory_xact_lock('+event_key(EVENT)+");SELECT set_config('ca.finish_lane_tournament','"+EVENT+"',true);"+refuse(admit(),'CANCELLATION_FINISH_AUTHORITY_INCOMPLETE')+'ROLLBACK;')
        e.sql(db,'CREATE TABLE cancellation_native_row(id integer PRIMARY KEY, value integer);INSERT INTO cancellation_native_row VALUES(1,0);',label='prelocked-row-fixture')
        a.query('BEGIN;SELECT pg_advisory_xact_lock_shared('+G+');SELECT pg_advisory_xact_lock_shared('+F+');')
        # Model caller's already-owned row with a real row, then verify all
        # admission locks acquired in its failed subtransaction are released.
        b.query('BEGIN;SELECT 1 FROM cancellation_native_row WHERE id=1 FOR UPDATE;')
        a.send('UPDATE cancellation_native_row SET value=value+1 WHERE id=1;')
        b.query(refuse(admit(),'CANCELLATION_GLOBAL_LANE_BUSY'))
        assert b.query('SELECT '+held(G,'ShareLock')+';').strip()=='f'
        b.query('ROLLBACK;');a.read();a.query('ROLLBACK;');cases.append('prelocked-row-global-contention-refuses-with-rollback')
        case('helper-owner-only',"DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid='smarter_private.cancellation_lane(uuid)'::regprocedure AND a.grantee<>'postgres'::regrole) THEN RAISE EXCEPTION 'helper exposed'; END IF;END $$;")
        return cases
    finally:
        for s in sessions:s.close()

def run_existing_sweep(e,db):
    target='d3000000-0000-4000-8000-000000000003'
    table='d5000000-0000-4000-8000-000000000002'
    # A separate zero-fee entry is charged through the real admission door.
    # Only the unstarted Spin seating/time scene is synthetic; no balance,
    # entitlement, escrow or fee record is fabricated or changed.
    setup="""BEGIN;SET LOCAL session_replication_role=replica;
CREATE TABLE IF NOT EXISTS public.spin_fill_policy(id boolean PRIMARY KEY DEFAULT true,unfilled_timeout_minutes integer NOT NULL DEFAULT 30,updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.spin_fill_policy(id,unfilled_timeout_minutes) VALUES(true,30) ON CONFLICT(id) DO UPDATE SET unfilled_timeout_minutes=30;
INSERT INTO public.tournaments(id,name,buy_in_amount,buy_in_fee,starting_chips,start_time,status,current_players,max_players,current_level,club_id,prize_pool,total_rake,bounty_pool,entry_contract_locked,is_rebuy,is_reentry,rebuy_levels,late_reg_levels,late_reg_mins)
VALUES('d3000000-0000-4000-8000-000000000003','Cancellation zero fee paid entry',100,0,1000,now()+interval '1 day','REGISTERING',0,3,1,'d2000000-0000-4000-8000-000000000002',0,0,0,false,false,false,0,0,0);
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"d4000000-0000-4000-8000-000000000001"}',true);
SET LOCAL ROLE authenticated;
SELECT public.fn_register_for_tournament_request('d3000000-0000-4000-8000-000000000003','d4000000-0000-4000-8000-000000000009');
RESET ROLE;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id='d3000000-0000-4000-8000-000000000003' AND prize_balance=100 AND fee_balance=0) THEN RAISE EXCEPTION 'zero-fee paid entry did not fund100'; END IF;END $$;
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET variant='spin' WHERE id='d3000000-0000-4000-8000-000000000003';
INSERT INTO public.tables(id,name,tournament_id,status,lifecycle,current_players,game_type,club_id,seat_game_scope,seat_admission_key)
VALUES('d5000000-0000-4000-8000-000000000002','Isolated cancellation sweep','d3000000-0000-4000-8000-000000000003','waiting','live',1,'tournament','d2000000-0000-4000-8000-000000000002','table:d5000000-0000-4000-8000-000000000002','tournament:d3000000-0000-4000-8000-000000000003');
INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,left_at,leave_pending,is_sitting_out,is_away,club_id,active_game_scope,active_parent_key,joined_at)
SELECT ('d6000000-0000-4000-8000-00000000000'||(row_number() OVER(ORDER BY user_id)+1)::text)::uuid,'d5000000-0000-4000-8000-000000000002',row_number() OVER(ORDER BY user_id),user_id,1000,'active',NULL,false,false,false,club_id,'table:d5000000-0000-4000-8000-000000000002','tournament:d3000000-0000-4000-8000-000000000003',now()-interval '31 minutes'
FROM public.tournament_players WHERE tournament_id='d3000000-0000-4000-8000-000000000003';
COMMIT;"""
    setup_file=e.output/'synthetic-unstarted-sweep-scene.sql'
    setup_file.write_text(setup)
    e.sql(db,file=setup_file,label='synthetic-unstarted-sweep-scene-only')
    sweep=json.loads((DATA/'sweep.json').read_text())
    assert hashlib.md5(sweep['definition'].encode()).hexdigest()==sweep['definition_md5']
    e.sql(db,sweep['definition']+';',label='exact-existing-sweep-caller')
    a=Session(e,db);b=Session(e,db);c=Session(e,db)
    try:
        a.query('BEGIN;SELECT pg_advisory_xact_lock_shared('+G+');')
        b.query("BEGIN;SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true),set_config('request.jwt.claim.role','service_role',true);")
        result=json.loads(b.query('SELECT public.fn_spin_expire_unfilled(50);').strip())
        assert result['expired']==1 and result['failed']==0 and result['tournament_ids']==[target],result
        assert b.query('SELECT '+held(G,'ShareLock')+' AND '+held(F,'ExclusiveLock')+' AND '+held(event_key(target),'ExclusiveLock')+' AND NOT '+held(G,'ExclusiveLock')+' AND NOT '+held(B,'ExclusiveLock')+';').strip()=='t'
        assert c.query('SELECT pg_try_advisory_xact_lock_shared('+G+');').strip()=='t'
        assert c.query('SELECT pg_try_advisory_xact_lock_shared('+F+');').strip()=='f'
        assert c.query('SELECT pg_try_advisory_xact_lock('+event_key(target)+');').strip()=='f'
        assert b.query("SELECT total_refunded=100 AND fees_reversed=0 AND refund_line_count=1 FROM public.tournament_cancellation_receipts WHERE tournament_id='"+target+"';").strip()=='t'
        b.query('ROLLBACK;');a.query('ROLLBACK;')
        e.report['existing_sweep']={'status':'passed','definition_md5':sweep['definition_md5'],'result':result,'refund':100,'fees_reversed':0,'unrelated_reader_progress':True,'finish_and_same_event_excluded':True}
    finally:
        for s in (a,b,c):s.close()

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--evidence',type=Path,required=True);p.add_argument('--work-root',type=Path,required=True)
    p.add_argument('--admission-only',action='store_true')
    p.add_argument('--socket-root',type=Path,required=True);p.add_argument('--pg-bin',type=Path,required=True)
    args=p.parse_args();out=args.evidence.resolve();out.mkdir(parents=True,exist_ok=False)
    args.work_root.mkdir(parents=True,exist_ok=True);args.socket_root.mkdir(parents=True,exist_ok=True)
    native=module(ROOT/'scripts/ci/test-mtt-unlimited.py','cancel_native_owner')
    e=native.Execution(ROOT,out,args.pg_bin.resolve(),args.work_root.resolve(),600,socket_parent=args.socket_root.resolve())
    e.report['scope']='admission and exact installation; funded cancellation qualification remains separate'
    try:
        foundation=module(ROOT/'scripts/ci/satellite_qualifier_fixture.py','cancel_catalog').compose(ROOT)
        (out/'foundation.sql').write_text(foundation['sql']+foundation['entry_sql'])
        e.report['source_sha256']=foundation['source_sha256']
        own_inputs=[Path(__file__),MIGRATION,*DATA.glob('*.json'),DATA/'admission.sql',ROOT/'scripts/ci/probes/satellite-cancel-current-native.sql']
        e.report['source_sha256'].update({str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in own_inputs})
        e.start();db=e.database();e.sql(db,file=out/'foundation.sql',label='retained-real-financial-catalog',seconds=180)
        dependency=ROOT/'scripts/ci/fixtures/satellite-qualifiers/entry-club-cancellation-cash-read.sql'
        e.sql(db,file=dependency,label='retained-cancellation-cash-read-dependency')
        e.report['source_sha256'][str(dependency.relative_to(ROOT))]=hashlib.sha256(dependency.read_bytes()).hexdigest()
        rows=json.loads((DATA/'preimages.json').read_text())+json.loads((DATA/'accounting-dependencies.json').read_text())
        setup="SET check_function_bodies=off;CREATE SCHEMA IF NOT EXISTS smarter_private;CREATE TABLE IF NOT EXISTS public.ca_operator_tournament_operations(op_id uuid,tournament_id uuid,actor_id uuid,reason text,review_snapshot jsonb,amount numeric,asset text,approval_id uuid,state text,result jsonb,created_at timestamptz,completed_at timestamptz);"
        for row in rows:
            assert hashlib.md5(row['definition'].encode()).hexdigest()==row['definition_md5']
            sig='public.'+row['signature'];setup+=row['definition']+';REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;'
            if 'service_role=X/' in row['proacl']:setup+='GRANT EXECUTE ON FUNCTION '+sig+' TO service_role;'
        (out/'current-catalog.sql').write_text(setup);e.sql(db,file=out/'current-catalog.sql',label='exact-installed-entry-dependencies')
        doctrine=json.loads((DATA/'doctrine.json').read_text())
        assert hashlib.md5(doctrine['definition'].encode()).hexdigest()==doctrine['definition_md5']
        e.sql(db,doctrine['definition']+';REVOKE ALL ON FUNCTION public.fn_ca_settlement_lane_doctrine() FROM PUBLIC,anon,authenticated,service_role;GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_lane_doctrine() TO service_role;',label='actual-installed-lane-doctrine')
        _,baseline,_=e.sql(db,'SELECT public.fn_ca_settlement_lane_doctrine();',label='actual-doctrine-before-cancellation-admission')
        e.report['doctrine_before']=json.loads(baseline.strip())
        e.report['native']=run_admission(e,db)
        candidate = ROOT/'supabase/migrations/20261030142407_a_free_diamond_registration_closes_as_zero_disposition.sql'
        e.report['source_sha256'][str(candidate.relative_to(ROOT))]=hashlib.sha256(candidate.read_bytes()).hexdigest()
        e.sql(db,file=candidate,label='free-diamond-disposition-install')
        _,definition,_=e.sql(db,"SELECT pg_get_functiondef('public.fn_poker_diamond_tournament_cancel(uuid,uuid)'::regprocedure);",label='free-diamond-disposition-installed-source')
        begin=definition.index("      -- A free entry releases zero custody")
        end=definition.index("      IF COALESCE((v_refund->>'idempotent')",begin)
        branch=definition[begin:end]
        assert branch.count('CONTINUE;')==1
        # Run the installed original-result classification in native PostgreSQL.
        # The unchanged real funded cancellation suite below separately qualifies
        # charge/refund/receipt rails; no financial helper is mocked here.
        for label,result,expected_zero,expected_paid in [
            ('free',{'free_entry':True,'fully_settled':True,'paid':0,'ledger_id':None,'obligation_id':None,'journal_id':None},1,0),
            ('paid',{'fully_settled':True,'paid':20,'ledger_id':1},0,1),
        ]:
            payload=json.dumps(result).replace("'","''")
            sql="DO $classify$ DECLARE v_refund jsonb:='"+payload+"'::jsonb;v_player record;v_zero_refund_registration_ids uuid[]:=ARRAY[]::uuid[];paid integer:=0;BEGIN FOR v_player IN SELECT 'a0000000-0000-4000-8000-000000000001'::uuid id LOOP "+branch+" paid:=paid+1;END LOOP;IF cardinality(v_zero_refund_registration_ids)<>"+str(expected_zero)+" OR paid<>"+str(expected_paid)+" THEN RAISE EXCEPTION 'wrong disposition';END IF;END $classify$;"
            e.sql(db,sql,label='installed-'+label+'-classification')
        for label,result in [
            ('nonzero',{'free_entry':True,'fully_settled':True,'paid':1}),
            ('missing-total',{'free_entry':True,'fully_settled':True}),
            ('unsettled',{'free_entry':True,'fully_settled':False,'paid':0}),
            ('unexpected-ledger',{'free_entry':True,'fully_settled':True,'paid':0,'ledger_id':1}),
        ]:
            payload=json.dumps(result).replace("'","''")
            sql="DO $invalid$ DECLARE v_refund jsonb:='"+payload+"'::jsonb;v_player record;v_zero_refund_registration_ids uuid[]:=ARRAY[]::uuid[];refused boolean:=false;BEGIN BEGIN FOR v_player IN SELECT 'a0000000-0000-4000-8000-000000000001'::uuid id LOOP "+branch+" END LOOP;EXCEPTION WHEN SQLSTATE 'P0404' THEN refused:=true;END;IF NOT refused THEN RAISE EXCEPTION 'invalid free result accepted';END IF;END $invalid$;"
            e.sql(db,sql,label='installed-free-'+label+'-refused')
        e.report['free_disposition_cases']=6

        _,verdict,_=e.sql(db,"SELECT public.fn_ca_settlement_lane_doctrine();",label='actual-doctrine-after-cancellation-admission')
        e.report['doctrine']=json.loads(verdict.strip())
        assert e.report['doctrine']['violations']==e.report['doctrine_before']['violations']
        assert not any(v['rule']=='f_named_only_by_finish_helpers' for v in e.report['doctrine']['violations'])
        # A name-only exemption would hide future writers. Actual catalog mutations
        # must each restore the F finding; rollback keeps the candidate unchanged.
        helper=(DATA/'admission.sql').read_text()
        for name,mutation in [
            ('helper-body-drift',helper.replace('BEGIN','BEGIN\n -- changed body',1)),
            ('helper-acl-drift','GRANT EXECUTE ON FUNCTION smarter_private.cancellation_lane(uuid) TO service_role;'),
            ('other-f-reader',"CREATE FUNCTION smarter_private.other_f_reader() RETURNS bigint LANGUAGE sql AS $$ SELECT "+F+" $$;"),
        ]:
            _,bad,_=e.sql(db,'BEGIN;'+mutation+'SELECT public.fn_ca_settlement_lane_doctrine();ROLLBACK;',label=name)
            assert any(v['rule']=='f_named_only_by_finish_helpers' for v in json.loads(bad.strip())['violations']),name
        e.report['doctrine_negative_cases']=3
        if args.admission_only:
            e.report['scope']='admission and exact installation only; funded evidence retained separately'
            e.report['status']='passed';e.report['passed']=True
            return
        probe=(ROOT/'scripts/ci/probes/satellite-cancel-current-native.sql').read_text()
        assert probe.count('ON COMMIT DROP;')==1
        probe=probe.replace('ON COMMIT DROP;','ON COMMIT PRESERVE ROWS;')
        assert probe.count('-- @FINAL_DEAL_RUNTIME@')==1 and probe.count('ROLLBACK;')==1
        # The historical fixed list includes a retired satellite authorization
        # table. Compare every actual public/auth table instead: no fabricated
        # relation and no missing-table success fallback.
        probe,count=re.subn(r"FOREACH r IN ARRAY ARRAY\[.*?\] LOOP", "FOR r IN SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth') AND c.relkind IN ('r','p') ORDER BY 1 LOOP",probe,count=1,flags=re.S)
        assert count==1
        probe=probe.replace("FROM public.%I x',r)","FROM %s x',r)").replace('all 26','all actual')
        # The retained probe predates the active-seat scope constraint. Supply
        # the same table-derived scope in its explicitly synthetic opening;
        # all actual charges/refunds still execute with their real triggers.
        probe=probe.replace('UPDATE public.tournament_players SET status=',"UPDATE public.tables SET seat_game_scope='table:'||id::text,seat_admission_key='tournament:'||tournament_id::text WHERE id='d5000000-0000-4000-8000-000000000001';\nUPDATE public.tournament_players SET status=",1)
        before='leave_pending,is_sitting_out,is_away,club_id)'
        assert probe.count(before)==1
        probe=probe.replace(before,'leave_pending,is_sitting_out,is_away,active_game_scope,active_parent_key,club_id)')
        before="'d1000000-0000-4000-8000-000000000002',1000,'active',NULL,false,false,false,"
        assert probe.count(before)==1
        probe=probe.replace(before,before+"'table:d5000000-0000-4000-8000-000000000001','tournament:d3000000-0000-4000-8000-000000000001',")
        started="""
DO $started_refusal$
DECLARE before_state text:=pg_temp.cancel_financial_fingerprint(); refused boolean:=false;
BEGIN
 BEGIN
  UPDATE public.tournaments SET started_at=clock_timestamp()
   WHERE id='d3000000-0000-4000-8000-000000000002';
  PERFORM public.atomic_cancel_tournament('d3000000-0000-4000-8000-000000000002',NULL);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM<>'Tournament has started or committed awards; resume or settle it instead of cancelling' THEN RAISE; END IF;
  refused:=true;
 END;
 IF NOT refused OR before_state IS DISTINCT FROM pg_temp.cancel_financial_fingerprint() THEN
  RAISE EXCEPTION 'started target refusal changed financial state';
 END IF;
END $started_refusal$;
"""
        seam='CREATE FUNCTION pg_temp.refuse_last_cancellation_receipt()'
        assert probe.count(seam)==1
        probe=probe.replace(seam,started+seam)
        # Source settlement and target cancellation are different requests.
        # Commit only this isolated synthetic setup; cancellation remains in
        # its own rollback, and Execution destroys the entire private cluster.
        boundary='-- Witness the final receipt insertion only after all genuine money writers.'
        assert probe.count(boundary)==1
        probe=probe.replace(boundary,"COMMIT;\nBEGIN;\nSELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true),set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claim.sub','',true);\n"+boundary)
        funded='BEGIN;\n'+probe.replace('-- @FINAL_DEAL_RUNTIME@','')
        (out/'funded-cancellation.sql').write_text(funded)
        e.sql(db,file=out/'funded-cancellation.sql',label='real-funded-cross-origin-cancellation-and-rollback',seconds=90)
        run_existing_sweep(e,db)
        e.report['scope']='nonblocking original exclusion, exact entry installation, retained real funded cancellation assertions'
        e.report['status']='passed';e.report['passed']=True
    finally:
        e.close();(out/'admission-report.json').write_text(json.dumps(e.report,indent=2)+'\n')
if __name__=='__main__':main()
