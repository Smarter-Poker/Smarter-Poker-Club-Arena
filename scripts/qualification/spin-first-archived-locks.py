"""Finite genuine maintenance, ABI and manager admission lock cases.
Runs only inside the existing allocator; never owns a cluster or production target.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
C_PATH=ROOT/'scripts/qualification/spin-first-archived-concurrency.py'
spec=importlib.util.spec_from_file_location('archive_concurrency_session_contract',C_PATH)
C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)
require=C.require


def wait_blocked(observer,holder,waiter,kind,deadline):
    while time.monotonic()<deadline:
        require(waiter.poll() is None,'financial caller finished before authority release')
        value=observer.json("SELECT jsonb_build_object('pid',pid,'wait_event_type',wait_event_type,'wait_event',wait_event,'blockers',pg_blocking_pids(pid),"
          "'locks',(SELECT coalesce(jsonb_agg(jsonb_build_object('locktype',locktype,'mode',mode,'granted',granted,'relation',relation::regclass::text,'classid',classid::bigint,'objid',objid::bigint,'objsubid',objsubid)), '[]') FROM pg_locks WHERE pid="+str(waiter.pid)+")) FROM pg_stat_activity WHERE pid="+str(waiter.pid)+";")
        if value and value['wait_event_type']=='Lock' and holder.pid in value['blockers']:
            value['holder_locks']=observer.json("SELECT coalesce(jsonb_agg(jsonb_build_object('locktype',locktype,'mode',mode,'granted',granted,'relation',relation::regclass::text,'classid',classid::bigint,'objid',objid::bigint,'objsubid',objsubid)), '[]') FROM pg_locks WHERE pid="+str(holder.pid)+";")
            if kind=='maintenance':
                require(value['wait_event']=='advisory' and any(l['locktype']=='advisory' and l['classid']==530090 and l['objid']==1 and l['objsubid']==2 and l['granted'] is False for l in value['locks']),'maintenance key differs')
                require(any(l['locktype']=='advisory' and l['classid']==530090 and l['objid']==1 and l['objsubid']==2 and l['granted'] is True and l['mode']=='ExclusiveLock' for l in value['holder_locks']),'maintenance holder exact key absent')
            else:
                relation='ca_mtt_admission_contract' if kind=='abi' else 'engine_tournament_leases'
                require(any(l['relation'] in (relation,'public.'+relation) for l in value['locks']),'blocked authority relation absent')
            return value
        time.sleep(.01)
    raise ValueError('authority blocker not observed')


def run(args,e,sessions,deadline,R,A):
    database='qual_spin_expiry_'+args.execution.replace('-','')
    def new(name):
        client=R.Session(args.psql,database,'archive_lock_'+name+'_'+args.execution,deadline)
        sessions.append((name,client));client.pid=client.json('SELECT to_jsonb(pg_backend_pid());');return client
    observer=new('observer')
    env=observer.json("SELECT jsonb_build_object('database',current_database(),'user',current_user,'session_user',session_user,'port',current_setting('port'),'address',inet_server_addr(),'max_locks',current_setting('max_locks_per_transaction')::int,'max_connections',current_setting('max_connections')::int,'version',current_setting('server_version_num')::int,'others',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));")
    R.require_private_endpoint(env,database);e['environment']=env
    require(env['max_locks']==1024 and env['max_connections']==8,'archive isolated lock capacity differs')
    probe=(ROOT/C.PROBE).read_text()
    setup="SET timezone='UTC';\n"+probe[probe.index('CREATE FUNCTION pg_temp.archive_financial_snapshot()'):probe.index('CREATE TEMP TABLE archive_before')]
    setup+='\n'+C.SEQUENCE_SQL
    holder=new('holder');worker=new('worker')
    for _,client in sessions:client.no_errors(client.command(setup))
    e['backend_pids']={n:c.pid for n,c in sessions}
    rows='SELECT pg_temp.archive_financial_snapshot();'
    snapshot="SELECT jsonb_build_object('rows',pg_temp.archive_financial_snapshot(),'sequences',pg_temp.archive_sequence_state());"
    e['before']=observer.json(snapshot)
    require(not e['before']['rows']['smarter_private.spin_archived_first_admission'],'lock cases require unadmitted first case')
    def service(client):
        client.begin(service_role=True)
        client.no_errors(client.command("SET LOCAL request.headers='{\"x-smarter-data-actor\":\"service\",\"x-smarter-data-protocol\":\"1\"}'; SET LOCAL request.method='POST'; SET LOCAL request.path='/rpc/fn_complete_first_archived_spin'; SELECT smarter_private.fn_smarter_data_api_pre_request();"))
        client.no_errors(client.command("DO $$ BEGIN IF transaction_timestamp()<'2026-10-05T07:00:00Z'::timestamptz OR transaction_timestamp()>='2026-10-12T07:00:00Z'::timestamptz THEN RAISE EXCEPTION 'ARCHIVE_RECOGNITION_PERIOD_CAPTURE_EXPIRED'; END IF; END $$;"))
    call="SELECT public.fn_complete_first_archived_spin('"+args.execution+"','"+C.SOURCE+"');"
    def inside_financial(raw):
        worker.no_errors(raw);A.validate_fee_notice(raw)
        response=R.exact_json(next(line for line in raw.splitlines() if line.startswith('{')))
        worker.no_errors(worker.command('SET CONSTRAINTS ALL IMMEDIATE; RESET ROLE;'))
        after=worker.json(rows);before=e['before']['rows']
        accounts=lambda client:client.json('SELECT pg_temp.archive_account_snapshot(pg_temp.archive_financial_snapshot());')
        accounts_before=accounts(observer);accounts_inside=accounts(worker)
        A.validate_account_delta(accounts_before,accounts_inside)
        A.validate_journal_and_chairs({'reserve_before':before['public.spin_reserve_ledger'],'reserve_after':after['public.spin_reserve_ledger'],
          'ledger_before':before['public.chip_ledger'],'ledger_after':after['public.chip_ledger'],'seats_before':before['public.table_seats'],'seats_after':after['public.table_seats'],
          'history_count':len(after['public.hand_history']),'atomic_commit_count':len(after['public.hand_atomic_commits']),
          'terminal':next(r for r in after['public.tournament_terminal_settlements'] if r['tournament_id']==C.EVENT),'primary_table':next(r for r in after['public.tables'] if r['id']==C.TABLE)})
        require(response['ok'] is True and response['winner_id']==C.WINNER and response['winner_amount']==200 and response['cash_payout_total']==200 and response['fully_settled'] is False and response['accounting_state']=='fee_custody_unresolved','lock case canonical outcome differs')
        custody=response['rake']['accounting'];stored=after['public.accounting_tournament_fee_custody_obligations']
        require(custody['held_amount']==24 and custody['current_held_amount']==24 and custody['bank_amount']==0 and custody['payable'] is False and custody['accounting_complete'] is False and custody['source_fingerprint']=='bfb56dac635bc7a238383d785ea88f35' and len(stored)==1 and stored[0]['id']==custody['obligation_id'] and stored[0]['amount']==24,'lock case exact fee custody differs')
        return {'response':response,'inside':after,'accounts_before':accounts_before,'accounts_inside':accounts_inside,'deferred_checked':True}
    e['cases']={}
    for kind,lock in [('maintenance','SELECT pg_advisory_xact_lock(530090,1);'),('abi','SELECT singleton FROM public.ca_mtt_admission_contract WHERE singleton FOR UPDATE;')]:
        holder.begin();holder.no_errors(holder.command(lock));service(worker);worker.start(call)
        wait=wait_blocked(observer,holder,worker,kind,deadline)
        require(observer.json(rows)==e['before']['rows'],'authority wait acquired state before authority')
        holder.no_errors(holder.command('ROLLBACK;'))
        result=inside_financial(worker.wait());result['wait']=wait
        worker.no_errors(worker.command('ROLLBACK;'))
        result['after']=observer.json(snapshot)
        require(result['after']['rows']==e['before']['rows'],'authority rollback left rows')
        e['cases'][kind]=result
    # Truthful isolated manager operational setup via the genuine claim owner.
    instance='isolated:archive-lock-manager:'+args.execution
    generation=str(uuid.uuid5(uuid.UUID(args.execution),'manager-lock-case'))
    service(holder)
    claim=holder.json("SELECT to_jsonb(c) FROM public.claim_tournament_lease_v2('"+C.EVENT+"','"+instance+"','isolated-lock-qualification','"+generation+"',30)c;")
    require(claim['granted'] is True and claim['lease_generation']==generation,'real isolated manager claim refused')
    holder.no_errors(holder.command('COMMIT;'))
    e['manager_setup']=observer.json(snapshot)
    lease=e['manager_setup']['rows']['public.engine_tournament_leases'];require(len(lease)==1,'isolated manager lease count differs')
    holder.begin(service_role=True)
    headers=json.dumps({'x-smarter-data-actor':'tournament-manager','x-smarter-data-protocol':'2','x-smarter-tournament-id':C.EVENT,'x-smarter-tournament-lease-generation':generation})
    holder.no_errors(holder.command("SET LOCAL request.headers='"+headers+"';SET LOCAL request.method='POST';SET LOCAL request.path='/rpc/fn_complete_tournament_terminal';SELECT smarter_private.fn_smarter_data_api_pre_request();"))
    service(worker);worker.start(call)
    wait=wait_blocked(observer,holder,worker,'manager',deadline)
    # This is the actual ordering assertion: manager already holds KEY SHARE and
    # must still obtain the finish lane while recovery waits for its lease.
    holder.no_errors(holder.command("SET LOCAL lock_timeout='3s';SELECT public.fn_ca_lock_settlement_lane_for_finish('"+C.EVENT+"');"))
    lane=holder.json("SELECT jsonb_build_object('scope',current_setting('ca.finish_lane_tournament',true),'held',EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock' AND objsubid=1 AND classid::bigint=((hashtextextended('ca:tournament-finish-lane:v1',0)>>32)&4294967295) AND objid::bigint=(hashtextextended('ca:tournament-finish-lane:v1',0)&4294967295)));")
    require(lane['scope']==C.EVENT and lane['held'] is True,'actual manager lane authority absent')
    manager_inside=observer.json(rows)
    require(manager_inside==e['manager_setup']['rows'],'competing recovery changed state while blocked')
    holder.no_errors(holder.command('COMMIT;'))
    raw=worker.wait();errors=re.findall(r'ERROR:  ([A-Z0-9]{5}): ([^\n]+)',raw)
    require(errors==[('40001','ARCHIVED_SPIN_COMPETING_OWNER')] and not re.search(r'(?:NOTICE|WARNING|FATAL|PANIC):',raw),'manager competitor returned wrong refusal: '+raw)
    worker.no_errors(worker.command('ROLLBACK;'))
    manager_after_refusal=observer.json(rows)
    require(manager_after_refusal==e['manager_setup']['rows'],'refused recovery mutated original manager lease/state')
    service(holder)
    claims=json.dumps([{'tournament_id':C.EVENT,'lease_generation':generation}])
    released=holder.json("SELECT to_jsonb(public.release_tournament_leases_v2('"+instance+"','"+claims+"'::jsonb));")
    require(released==1,'genuine manager release did not release exactly once')
    holder.no_errors(holder.command('COMMIT;'))
    e['manager']={'instance':instance,'generation':generation,'inside':manager_inside,'after_refusal':manager_after_refusal,'lane':lane,'wait':wait,'lease':lease,'claim':claim,'release_count':released,'refusal':list(errors[0])}
    e['after']=observer.json(snapshot)
    require(e['after']['rows']==e['before']['rows'],'operational manager cleanup left rows')
    e['passed']=True


def validate_evidence(document,execution,archive):
    d=C.restore(document)
    require(d['execution']==execution and d['event']==C.EVENT and d['passed'] is True
            and d['cleanup_verified'] is True and d['financial_qualified'] is False
            and d['production_qualified'] is False and d['sequence_rollback_claimed'] is False,'lock proof identity/result differs')
    require(d['environment']['max_locks']==1024 and d['environment']['max_connections']==8,'archive observed lock capacity differs')
    p=d['backend_pids'];require(set(p)=={'observer','holder','worker'} and len(set(p.values()))==3
            and all(type(v) is int and v>0 for v in p.values()),'lock proof backend identity differs')
    require(set(d['cases'])=={'maintenance','abi'},'lock case inventory differs')
    for kind,result in d['cases'].items():
        wait=result['wait'];require(wait['pid']==p['worker'] and p['holder'] in wait['blockers']
            and wait['wait_event_type']=='Lock','lock proof holder absent')
        if kind=='maintenance':
            match=lambda l:l['locktype']=='advisory' and l['classid']==530090 and l['objid']==1 and l['objsubid']==2
            require(wait['wait_event']=='advisory' and any(match(l) and l['granted'] is False for l in wait['locks'])
                and any(match(l) and l['granted'] is True and l['mode']=='ExclusiveLock' for l in wait['holder_locks']),'lock proof maintenance key differs')
        else:
            require(any(l['relation'] in ('ca_mtt_admission_contract','public.ca_mtt_admission_contract') for l in wait['locks']),'lock proof ABI relation absent')
        require(result['deferred_checked'] is True and result['after']['rows']==d['before']['rows'],'lock proof rollback or deferred check absent')
        archive.validate_account_delta(result['accounts_before'],result['accounts_inside'])
        before=d['before']['rows']; after=result['inside']
        archive.validate_journal_and_chairs({'reserve_before':before['public.spin_reserve_ledger'],'reserve_after':after['public.spin_reserve_ledger'],
            'ledger_before':before['public.chip_ledger'],'ledger_after':after['public.chip_ledger'],'seats_before':before['public.table_seats'],'seats_after':after['public.table_seats'],
            'history_count':len(after['public.hand_history']),'atomic_commit_count':len(after['public.hand_atomic_commits']),
            'terminal':next(r for r in after['public.tournament_terminal_settlements'] if r['tournament_id']==C.EVENT),
            'primary_table':next(r for r in after['public.tables'] if r['id']==C.TABLE)})
        require(result['response']['ok'] is True and result['response']['winner_amount']==200
            and result['response']['rake']['accounting']['held_amount']==24,'lock proof financial result differs')
    manager=d['manager'];require(manager['refusal']==['40001','ARCHIVED_SPIN_COMPETING_OWNER']
        and type(manager['release_count']) is int and manager['release_count']==1
        and manager['lease']==d['manager_setup']['rows']['public.engine_tournament_leases'],'lock proof manager owner differs')
    require(manager['inside']==d['manager_setup']['rows']==manager['after_refusal'],'lock proof manager exact state changed')
    require(manager['claim']['granted'] is True and manager['claim']['holder']==manager['instance']
        and manager['claim']['lease_generation']==manager['generation']
        and manager['instance']=='isolated:archive-lock-manager:'+execution
        and manager['generation']==str(uuid.uuid5(uuid.UUID(execution),'manager-lock-case')),'lock proof truthful manager claim differs')
    require(manager['lane']['scope']==C.EVENT and manager['lane']['held'] is True,'lock proof manager lane absent')
    wait=manager['wait'];require(wait['pid']==p['worker'] and p['holder'] in wait['blockers'] and wait['wait_event_type']=='Lock'
        and any(l['relation'] in ('engine_tournament_leases','public.engine_tournament_leases') for l in wait['locks']),'lock proof manager blocking lease absent')
    require(d['after']['rows']==d['before']['rows'],'lock proof left rows')
    require(len(d['clients'])==3 and {c['backend_pid'] for c in d['clients']}==set(p.values())
        and all(type(c['client_exit']) is int and c['client_exit']==0 for c in d['clients']), 'lock clients cleanup differs')
    require(d['backend_cleanup']=={'backends':0,'locks':0} and d['backend_cleanup_observations']
        and d['backend_cleanup_observations'][-1]=={'backends':0,'locks':0},'lock backend cleanup unproved')
    require(type(d['verifier_client']['client_exit']) is int and d['verifier_client']['client_exit']==0
        and d['cleanup_transcript'] and set(d['transcripts'])==set(p) and all(d['transcripts'].values()),'lock original transcript custody differs')
    return {'admission_lock_order_qualified':True,'financial_qualified':False,'production_qualified':False}


# Lifecycle deliberately remains the existing Session process owner; the
# allocator is responsible for cluster stop/disposal after this finite stage.
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--psql',type=Path,required=True);parser.add_argument('--execution',required=True);args=parser.parse_args()
    require(args.psql.is_absolute() and args.psql.is_file(),'absolute qualified psql required')
    require(hashlib.sha256((ROOT/C.SESSION).read_bytes()).hexdigest()==C.SESSION_SHA,'existing Session owner changed')
    R=C.load('archive_lock_existing_session',ROOT/C.SESSION);A=C.load('archive_lock_financial_oracle',ROOT/C.MODULE);R.canonical_uuid(args.execution)
    e={'execution':args.execution,'event':C.EVENT,'passed':False,'cleanup_verified':False,'financial_qualified':False,'production_qualified':False,'sequence_rollback_claimed':False}
    sessions=[]
    try:run(args,e,sessions,time.monotonic()+20,R,A)
    except BaseException as error:e['failure']={'type':type(error).__name__,'message':str(error)}
    finally:
        deadline=time.monotonic()+5;e['clients']=[]
        # On failure release this test's holder transaction first, then drain
        # the already-started worker response and explicitly roll it back.
        # This never retries a financial call or turns a failed run into a pass.
        if 'failure' in e:
            owned=dict(sessions);e['fault_cleanup']={}
            for name in ('holder','worker'):
                client=owned.get(name)
                if client is None:continue
                try:
                    client.deadline=deadline
                    if client.pending is not None:e['fault_cleanup'][name+'_pending']=client.wait()
                    e['fault_cleanup'][name+'_rollback']=client.command('ROLLBACK;')
                except BaseException as error:e['fault_cleanup'][name+'_error']=str(error)

        for name,session in reversed(sessions):
            try:e['clients'].append(session.close(deadline))
            except BaseException as error:e['clients'].append({'backend_pid':session.pid,'cleanup_error':str(error)})
        e['transcripts']={name:bytes(s.raw).decode('utf-8',errors='replace') for name,s in sessions}
        verifier=None
        try:
            require(len(sessions)==3,'original caller inventory incomplete')
            verifier=R.Session(args.psql,'qual_spin_expiry_'+args.execution.replace('-',''),'archive_lock_cleanup_'+args.execution,deadline)
            verifier.pid=verifier.json('SELECT to_jsonb(pg_backend_pid());');R.observe_backend_cleanup(verifier,','.join(str(s.pid) for _,s in sessions),deadline,e)
            e['cleanup_verified']=all(type(c.get('client_exit')) is int and c['client_exit']==0 and 'cleanup_error' not in c for c in e['clients'])
        except BaseException as error:e['cleanup_failure']=str(error)
        finally:
            if verifier:
                e['cleanup_transcript']=bytes(verifier.raw).decode('utf-8',errors='replace')
                try:e['verifier_client']=verifier.close(deadline);require(e['verifier_client']['client_exit']==0,'verifier cleanup failed')
                except BaseException as error:e['cleanup_verified']=False;e['verifier_cleanup_error']=str(error)
    if 'failure' not in e:
        try:e['qualification']=validate_evidence(e,args.execution,A)
        except BaseException as error:e['failure']={'type':type(error).__name__,'message':str(error)}
    print(json.dumps(e,default=R.evidence_value,allow_nan=False))
    return 0 if e['passed'] and e['cleanup_verified'] and 'failure' not in e else 1


if __name__=='__main__':raise SystemExit(main())
