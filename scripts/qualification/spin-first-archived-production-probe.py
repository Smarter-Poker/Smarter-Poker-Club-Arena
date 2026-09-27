"""Exact aborting production-probe rehearsal in the existing isolated provider.
Runs only inside the existing allocator; never owns a cluster or production target.
"""
from decimal import Decimal
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



PROBE='scripts/qualification/fixtures/archived-spin/first-production-rollback-probe.sql'
PROBE_SHA='920c57efc0484aa78c6815f01b16a7098ebdfe79f54c6c78b31956169c19bf6d'
OPERATION='341f02a3-4655-420c-b43b-3930b6d9ad8f'


def parse_abort(raw,R,A):
    errors=re.findall(r'ERROR:  ([A-Z0-9]{5}): ([^\n]+)',raw)
    require(errors==[('PZ002','FIRST_ARCHIVED_ROLLBACK_PROVED:'+OPERATION)],'probe did not intentionally abort exactly once')
    require(not re.search(r'(?:WARNING|FATAL|PANIC):',raw),'probe unexpected diagnostics')
    details=re.findall(r'^DETAIL:\s+(.*)$',raw,re.M)
    require(len(details)==1,'probe DETAIL missing or duplicated')
    def unique(pairs):
        result={}
        for key,value in pairs:
            require(key not in result,'duplicate probe detail key')
            result[key]=value
        return result
    def nonfinite(value):
        raise ValueError('nonfinite probe detail number: '+value)
    detail=json.loads(details[0],parse_float=Decimal,parse_constant=nonfinite,object_pairs_hook=unique)
    require(detail['operation']==OPERATION and detail['event']==C.EVENT
        and detail['same_operation_replay_unchanged'] is True
        and detail['transaction_will_abort_now'] is True
        and detail['sequence_rollback_claimed'] is False
        and detail['production_settlement_complete'] is False,'probe abort identity/scope differs')
    # Validate the actual original notice separately; intentional PZ002 remains
    # required above rather than being hidden from an error-free validator.
    notices='\n'.join(line for line in raw.splitlines() if 'NOTICE:' in line)
    A.validate_fee_notice(notices)
    return detail


def run(args,e,sessions,deadline,R,A):
    database='qual_spin_expiry_'+args.execution.replace('-','')
    def new(name):
        client=R.Session(args.psql,database,'archive_probe_'+name+'_'+args.execution,deadline)
        sessions.append((name,client));client.pid=client.json('SELECT to_jsonb(pg_backend_pid());');return client
    observer=new('observer')
    env=observer.json("SELECT jsonb_build_object('database',current_database(),'user',current_user,'session_user',session_user,'port',current_setting('port'),'address',inet_server_addr(),'max_locks',current_setting('max_locks_per_transaction')::int,'max_connections',current_setting('max_connections')::int,'version',current_setting('server_version_num')::int,'others',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));")
    R.require_private_endpoint(env,database);e['environment']=env
    worker=new('worker')
    require(env['max_locks']==1024 and env['max_connections']==8,'probe isolated capacity differs')
    original=(ROOT/C.PROBE).read_text()
    setup="SET timezone='UTC';\n"+original[original.index('CREATE FUNCTION pg_temp.archive_financial_snapshot()'):original.index('CREATE TEMP TABLE archive_before')]
    observer.no_errors(observer.command(setup+'\n'+C.SEQUENCE_SQL))
    snapshot="SELECT jsonb_build_object('rows',pg_temp.archive_financial_snapshot(),'sequences',pg_temp.archive_sequence_state());"
    e['backend_pids']={n:c.pid for n,c in sessions};e['before']=observer.json(snapshot)
    require(not e['before']['rows']['smarter_private.spin_archived_first_admission'],'probe requires unadmitted source')
    source=(ROOT/PROBE).read_bytes();require(hashlib.sha256(source).hexdigest()==PROBE_SHA,'exact probe source changed')
    e['probe_sha256']=PROBE_SHA;e['original_probe_output']=worker.command(source.decode())
    e['detail']=parse_abort(e['original_probe_output'],R,A)
    worker.no_errors(worker.command('ROLLBACK;'))
    e['after']=observer.json(snapshot)
    require(e['after']['rows']==e['before']['rows'],'aborted production probe left durable rows')
    e['passed']=True


def validate_evidence(document,execution,archive):
    d=C.restore(document)
    require(d['execution']==execution and d['event']==C.EVENT and d['passed'] is True
        and d['cleanup_verified'] is True and d['financial_qualified'] is False
        and d['production_qualified'] is False and d['sequence_rollback_claimed'] is False,'probe identity/result scope differs')
    require(d['probe_sha256']==PROBE_SHA,'probe bytes differ')
    require(d['environment']['max_locks']==1024 and d['environment']['max_connections']==8,'probe observed capacity differs')
    R=C.load('probe_retained_json',ROOT/C.SESSION)
    detail=parse_abort(d['original_probe_output'],R,archive)
    require(detail==d['detail'],'probe structured detail changed')
    require(d['before']['rows']==d['after']['rows'],'probe durable rows changed')
    for phase in ('before','after'):require(set(d[phase]['sequences'])==set(C.SEQUENCES),'probe exact sequence observation missing')
    before=detail['before'];inside=detail['inside'];account_keys=('public.club_members','public.clubs','public.unions','public.union_wallets','public.spin_bonus_pools')
    archive.validate_account_delta({k:before[k] for k in account_keys},{k:inside[k] for k in account_keys})
    terminal=inside['public.tournament_terminal_settlements'][0]
    archive.validate_journal_and_chairs({'reserve_before':before['public.spin_reserve_ledger'],'reserve_after':inside['public.spin_reserve_ledger'],
        'ledger_before':before['public.chip_ledger'],'ledger_after':inside['public.chip_ledger'],'seats_before':before['public.table_seats'],'seats_after':inside['public.table_seats'],
        'history_count':sum(r.get('tournament_id')==C.EVENT or r.get('table_id')==C.TABLE for r in d['before']['rows']['public.hand_history']),'atomic_commit_count':sum(r.get('table_id')==C.TABLE for r in d['before']['rows']['public.hand_atomic_commits']),'terminal':terminal,'primary_table':inside['public.tables'][0]})
    require(detail['response']['ok'] is True and detail['response']['fully_settled'] is False
        and detail['response']['rake']['accounting']['held_amount']==24,'probe financial receipt differs')
    p=d['backend_pids'];require(set(p)=={'observer','worker'} and len(set(p.values()))==2 and all(type(v) is int and v>0 for v in p.values()),'probe original backend identity differs')
    require(len(d['clients'])==2 and {c['backend_pid'] for c in d['clients']}==set(p.values())
        and all(type(c['client_exit']) is int and c['client_exit']==0 for c in d['clients']),'probe client cleanup differs')
    require(d['backend_cleanup']=={'backends':0,'locks':0} and d['backend_cleanup_observations'][-1]=={'backends':0,'locks':0}
        and type(d['verifier_client']['client_exit']) is int and d['verifier_client']['client_exit']==0 and d['cleanup_transcript']
        and set(d['transcripts'])==set(p) and all(d['transcripts'].values()),'probe actual disposal absent')
    return {'production_probe_rehearsed':True,'financial_qualified':False,'production_qualified':False,'sequence_rollback_claimed':False}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--psql',type=Path,required=True);parser.add_argument('--execution',required=True);args=parser.parse_args()
    require(args.psql.is_absolute() and args.psql.is_file(),'absolute qualified psql required')
    require(hashlib.sha256((ROOT/C.SESSION).read_bytes()).hexdigest()==C.SESSION_SHA,'existing Session owner changed')
    R=C.load('archive_probe_existing_session',ROOT/C.SESSION);A=C.load('archive_probe_financial_oracle',ROOT/C.MODULE);R.canonical_uuid(args.execution)
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
            for name in ('worker',):
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
            require(len(sessions)==2,'original caller inventory incomplete')
            verifier=R.Session(args.psql,'qual_spin_expiry_'+args.execution.replace('-',''),'archive_probe_cleanup_'+args.execution,deadline)
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
