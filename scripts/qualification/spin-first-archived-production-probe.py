"""Exact aborting production-probe rehearsal in the existing isolated provider.
Runs only inside the existing allocator; never owns a cluster or production target.
"""
from decimal import Decimal
import argparse
import copy
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
PROBE_SHA='b134486f027611bb40c44e75d346de1b9b4d5e1ca0c5d2b0709baf40839b7a8f'
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


BANK_FAULT_ANCHOR="  EXECUTE format('SET LOCAL ROLE %I',original_role);\n END LOOP;"
BANK_FAULT_INSERT="""  -- ISOLATED QUALIFICATION FAULT ONLY: derived bytes, never a production probe.
  IF phase=0 THEN
   UPDATE public.union_wallets SET rake_wallet=rake_wallet+1
    WHERE union_id='fade0000-0000-0000-0000-000000000001'::uuid;
   IF NOT FOUND THEN
    -- Synthetic fault row, created only inside the transaction being aborted.
    INSERT INTO public.union_wallets(id,union_id,chip_balance,rake_wallet,bbj_wallet,
      promo_wallet,insurance_wallet,spin_reserve_wallet)
    VALUES ('341f02a3-4655-420c-b43b-3930b6d9ad8f'::uuid,
      'fade0000-0000-0000-0000-000000000001'::uuid,0,1,0,0,0,0);
   END IF;
  END IF;
"""

def bank_fault_source(source):
    require(source.count(BANK_FAULT_ANCHOR)==1,'bank fault injection anchor differs')
    return source.replace(BANK_FAULT_ANCHOR,
        "  EXECUTE format('SET LOCAL ROLE %I',original_role);\n"+BANK_FAULT_INSERT+" END LOOP;",1)

def parse_bank_fault(raw,A):
    require(re.findall(r'ERROR:  ([A-Z0-9]{5}): ([^\n]+)',raw)==
        [('P0001','PROBE_BANK_OR_RESERVE_CHANGED: public.union_wallets')],
        'own bank fault did not refuse with original invariant')
    require(not re.search(r'(?:WARNING|FATAL|PANIC):',raw),'bank fault unexpected diagnostics')
    A.validate_fee_notice('\n'.join(line for line in raw.splitlines() if 'NOTICE:' in line))
    details=re.findall(r'^DETAIL:\s+(.*)$',raw,re.M)
    require(len(details)==1,'bank fault DETAIL missing or duplicated')
    def unique(pairs):
        result={}
        for key,value in pairs:
            require(key not in result,'duplicate bank fault detail key');result[key]=value
        return result
    def nonfinite(value):raise ValueError('nonfinite bank fault detail number: '+value)
    d=json.loads(details[0],parse_float=Decimal,parse_constant=nonfinite,object_pairs_hook=unique)
    require(set(d)=={'operation','event','transaction_id','isolation','relation','before','inside',
        'sequence_rollback_claimed','production_settlement_complete'},'bank fault detail fields differ')
    require(d['operation']==OPERATION and d['event']==C.EVENT and d['isolation']=='read committed'
        and d['relation']=='public.union_wallets' and d['sequence_rollback_claimed'] is False
        and d['production_settlement_complete'] is False,'bank fault identity/scope differs')
    require(isinstance(d['transaction_id'],str) and re.fullmatch(r'[1-9][0-9]{0,19}',d['transaction_id'])
        and int(d['transaction_id'])<2**64,'bank fault transaction identity malformed')
    require(isinstance(d['before'],list) and len(d['before']) in (0,1)
        and isinstance(d['inside'],list) and len(d['inside'])==1,'bank fault wallet cardinality differs')
    financial={'chip_balance','rake_wallet','bbj_wallet','promo_wallet','insurance_wallet','spin_reserve_wallet'}
    def exact_wallet(row):
        require(isinstance(row,dict) and set(row)==financial|{'id','union_id'}
            and row['union_id']=='fade0000-0000-0000-0000-000000000001'
            and all(type(row[k]) in (int,Decimal) for k in financial),'bank fault wallet projection differs')
    exact_wallet(d['inside'][0])
    if d['before']:
        row=d['before'][0];exact_wallet(row)
        require(row['id']=='059bb325-6eeb-4bbd-957d-3a82e755bb0c','bank fault original wallet differs')
        expected=copy.deepcopy(row);expected['rake_wallet']+=1
    else:
        expected=dict.fromkeys(financial,0)
        expected.update(id=OPERATION,union_id='fade0000-0000-0000-0000-000000000001',rake_wallet=1)
    require(d['inside']==[expected],'bank fault did not retain exact own update or synthetic insert')
    return d

def validate_bank_fault(f,A):
    require(f['kind']=='isolated-derived-own-bank-mutation' and f['production_sql'] is False
        and f['base_probe_sha256']==PROBE_SHA,'bank fault source identity differs')
    source=(ROOT/PROBE).read_bytes();require(hashlib.sha256(source).hexdigest()==PROBE_SHA,'bank fault base probe drift')
    derived=bank_fault_source(source.decode())
    require(f['derived_source']==derived and f['derived_sha256']==hashlib.sha256(derived.encode()).hexdigest(),
        'derived fault source changed')
    d=parse_bank_fault(f['original_output'],A);require(d==f['detail'],'bank fault retained detail differs')
    observed=f['before']['rows']['public.union_wallets']
    require(isinstance(observed,list) and len(observed) in (0,1),'bank fault independent wallet cardinality differs')
    projection=[{k:v for k,v in row.items() if k in ('id','user_id','club_id','union_id')
        or re.search(r'(balance|treasury|wallet|chip_pool|locked_chips|held_chips|credit_|diamonds|total_deposited|total_drawn|seeded_amount|surplus_returned|seed_returned_amount)',k)} for row in observed]
    require(d['before']==projection,'bank fault diagnostic before differs from independent wallet')
    require(f['before']['rows']==f['after']['rows'],'bank fault left durable rows')
    require(f['transaction_status']=={'transaction_id':d['transaction_id'],'status':'aborted'},'bank fault actual transaction not aborted')
    require(f['rollback_output']=='true',
        'bank fault post-rollback unassigned transaction marker absent/failed')
    for phase in ('before','after'):require(set(f[phase]['sequences'])==set(C.SEQUENCES),'bank fault sequence observation missing')
    return d


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
    # A separately labelled derived local fault proves strict bank equality
    # still refuses our own money mutation and reports its original values.
    # This never modifies or executes a production target.
    fault={'kind':'isolated-derived-own-bank-mutation','production_sql':False,
        'base_probe_sha256':PROBE_SHA,'before':observer.json(snapshot)}
    derived=bank_fault_source(source.decode());fault['derived_source']=derived
    fault['derived_sha256']=hashlib.sha256(derived.encode()).hexdigest()
    e['bank_fault']=fault;fault['original_output']=worker.command(derived)
    fault['detail']=parse_bank_fault(fault['original_output'],A)
    fault['rollback_output']=worker.command('ROLLBACK; SELECT to_jsonb(pg_current_xact_id_if_assigned() IS NULL);')
    worker.no_errors(fault['rollback_output'])
    fault['after']=observer.json(snapshot)
    xid=fault['detail']['transaction_id']
    fault['transaction_status']=observer.json("SELECT jsonb_build_object('transaction_id','"+xid+"','status',pg_xact_status('"+xid+"'::xid8));")
    validate_bank_fault(fault,A)
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
    validate_bank_fault(d['bank_fault'],archive)
    require(d['bank_fault']['before']['rows']==d['after']['rows'],'fault baseline differs from original aborted probe')
    p=d['backend_pids'];require(set(p)=={'observer','worker'} and len(set(p.values()))==2 and all(type(v) is int and v>0 for v in p.values()),'probe original backend identity differs')
    require(len(d['clients'])==2 and {c['backend_pid'] for c in d['clients']}==set(p.values())
        and all(type(c['client_exit']) is int and c['client_exit']==0 for c in d['clients']),'probe client cleanup differs')
    require(d['backend_cleanup']=={'backends':0,'locks':0} and d['backend_cleanup_observations'][-1]=={'backends':0,'locks':0}
        and type(d['verifier_client']['client_exit']) is int and d['verifier_client']['client_exit']==0 and d['cleanup_transcript']
        and set(d['transcripts'])==set(p) and all(d['transcripts'].values()),'probe actual disposal absent')
    return {'production_probe_rehearsed':True,'own_bank_fault_diagnostic_rehearsed':True,'financial_qualified':False,'production_qualified':False,'sequence_rollback_claimed':False}

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
