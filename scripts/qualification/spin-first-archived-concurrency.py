"""Bounded canonical first commit and concurrent replay in the existing allocation.

No allocator, production target, historical seed or replacement business owner.
"""
import argparse
from decimal import Decimal
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
SESSION='scripts/qualification/spin-expiry-business-races.py'
SESSION_SHA='619267d012bb64257d639006c133d03c95f16c7e243b334e6af661d5900b95c5'
MODULE='scripts/qualification/spin-first-archived.py'
PROBE='scripts/qualification/fixtures/archived-spin/first-connected-probe.sql'
SEQUENCES='scripts/qualification/fixtures/spin-history-retention/database-state.sql'
EVENT='2aa4cba1-506f-426b-a1ba-d8e22e018533'
WINNER='aef849b8-2906-4dc0-b108-251710e76d3c'
SOURCE='8a0eb326f88354ac1578729c5286615cfb1b7311c30e410c26e7f6ffb08aa3f5'
TABLE='6eaddeaf-1511-4265-bb38-37811ae82ad9'


def require(ok,message):
    if not ok: raise ValueError(message)


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result)
    return result


def restore(value):
    if isinstance(value,dict):
        if set(value)=={'$decimal'}: return Decimal(value['$decimal'])
        return {k:restore(v) for k,v in value.items()}
    if isinstance(value,list):return [restore(v) for v in value]
    return value


def validate_wait(wait,holder,waiter):
    require(wait['pid']==waiter and wait['wait_event_type']=='Lock' and wait['wait_event']=='advisory'
            and holder in wait['blockers'],'original advisory blocker absent')
    require(wait['same_owned_advisory_key'] is True,'advisory lock identity differs')


def validate_evidence(document,execution,archive):
    d=restore(document)
    require(d['execution']==execution and d['event']==EVENT and d['passed'] is True
            and d['cleanup_verified'] is True,'archive concurrency identity/result failed')
    require(d['financial_qualified'] is False and d['production_qualified'] is False,
            'archive concurrency qualification scope inflated')
    p=d['backend_pids'];require(set(p)=={'observer','first','same','different'} and len(set(p.values()))==4
            and all(type(v) is int and v>0 for v in p.values()),'archive caller identities differ')
    for name in ('same','different'):validate_wait(d['waits'][name],p['first'],p[name])
    require(d['commit_observed'] is True and d['deferred_checks_at_commit'] is True,'actual commit absent')
    require(d['first_response']==d['durable_response']==d['same_response'],'canonical replay receipt differs')
    require(d['different_sqlstate']=='40001' and d['different_message']=='ARCHIVED_SPIN_REPLAY_MISMATCH',
            'different-operation refusal differs')
    require(d['inside']==d['committed'] and d['committed']==d['same_inside']==d['after'],
            'durable/replayed whole state differs')
    before=d['before']['rows'];after=d['after']['rows']
    admissions=after['smarter_private.spin_archived_first_admission']
    require(len(admissions)==1 and admissions[0]['operation_id']==execution
            and admissions[0]['tournament_id']==EVENT and admissions[0]['source_sha256']==SOURCE,
            'single immutable admission differs')
    terminals=[r for r in after['public.tournament_terminal_settlements'] if r['tournament_id']==EVENT]
    require(len(terminals)==1 and terminals[0]['cash_payout_count']==1 and terminals[0]['cash_payout_total']==200
            and terminals[0]['accounting_state']=='fee_custody_unresolved','single terminal differs')
    custody=[r for r in after['public.accounting_tournament_fee_custody_obligations'] if r['tournament_id']==EVENT]
    require(len(custody)==1 and custody[0]['amount']==24,'single unresolved fee custody differs')
    response=d['durable_response']
    require(response['ok'] is True and response['fully_settled'] is False
            and response['accounting_complete'] is False and response['accounting_state']=='fee_custody_unresolved'
            and response['rake']['amount']==24 and response['rake']['destination']=='tournament_escrow'
            and response['rake']['attributed'] is False,'canonical accounting status differs')
    archive.validate_account_delta(d['accounts_before'],d['accounts_after'])
    scoped=lambda rows,name:[r for r in rows[name] if r.get('tournament_id')==EVENT]
    chairs=lambda rows:[r for r in rows['public.table_seats'] if r['table_id']==TABLE]
    archive.validate_journal_and_chairs({'reserve_before':scoped(before,'public.spin_reserve_ledger'),
        'reserve_after':scoped(after,'public.spin_reserve_ledger'),'ledger_before':scoped(before,'public.chip_ledger'),
        'ledger_after':scoped(after,'public.chip_ledger'),'seats_before':chairs(before),'seats_after':chairs(after),
        'history_count':len(scoped(after,'public.hand_history')),
        'atomic_commit_count':len([r for r in after['public.hand_atomic_commits'] if r['table_id']==TABLE]),
        'primary_table':next(r for r in after['public.tables'] if r['id']==TABLE)})
    require(len(d['clients'])==4 and all(type(c['client_exit']) is int and c['client_exit']==0 for c in d['clients']),
            'original clients cleanup differs')
    require(set(d['transcripts'])==set(p) and all(d['transcripts'].values()),'original transcripts absent')
    require({c['backend_pid'] for c in d['clients']}==set(p.values()) and d['backend_cleanup']=={'backends':0,'locks':0}
            and d['backend_cleanup_observations'][-1]==d['backend_cleanup']
            and type(d['verifier_client']['client_exit']) is int and d['verifier_client']['client_exit']==0
            and bool(d['cleanup_transcript']),'observed backend disposal absent')
    return {'committed_terminal_qualified':True,'concurrency_qualified':True,
            'financial_qualified':False,'production_qualified':False}


def run(args,e,sessions,deadline,R,A):
    database='qual_spin_expiry_'+args.execution.replace('-','')
    def new(name):
        session=R.Session(args.psql,database,'archive_'+name+'_'+args.execution,deadline)
        sessions.append((name,session));session.pid=session.json('SELECT to_jsonb(pg_backend_pid());')
        return session
    observer=new('observer')
    environment=observer.json("SELECT jsonb_build_object('database',current_database(),'user',current_user,"
        "'session_user',session_user,'port',current_setting('port'),'address',inet_server_addr(),"
        "'version',current_setting('server_version_num')::int,'others',(SELECT count(*) FROM pg_stat_activity "
        "WHERE datname=current_database() AND pid<>pg_backend_pid()));")
    R.require_private_endpoint(environment,database);e['environment']=environment
    probe=(ROOT/PROBE).read_text();setup=probe[probe.index('CREATE FUNCTION pg_temp.archive_financial_snapshot()'):probe.index('CREATE TEMP TABLE archive_before')]
    setup="SET timezone='UTC';\n"+setup+'\n'+(ROOT/SEQUENCES).read_text()
    observer.no_errors(observer.command(setup))
    first,same,different=new('first'),new('same'),new('different')
    for client in (first,same,different):client.no_errors(client.command(setup))
    e['backend_pids']={name:s.pid for name,s in sessions}
    snapshot="SELECT jsonb_build_object('rows',pg_temp.archive_financial_snapshot(),'sequences',pg_temp.retention_sequence_state());"
    accounts='SELECT pg_temp.archive_account_snapshot(pg_temp.archive_financial_snapshot());'
    e['before']=observer.json(snapshot);e['accounts_before']=observer.json(accounts)
    require(not e['before']['rows']['smarter_private.spin_archived_first_admission'],'first commit needs original unadmitted preimage')
    def begin(client):
        client.begin(service_role=True)
        client.no_errors(client.command("SET LOCAL request.headers='{\"x-smarter-data-actor\":\"service\",\"x-smarter-data-protocol\":\"1\"}';"
            "SET LOCAL request.method='POST'; SET LOCAL request.path='/rpc/fn_complete_first_archived_spin';"
            "SELECT smarter_private.fn_smarter_data_api_pre_request();"))
    call=lambda operation:"SELECT public.fn_complete_first_archived_spin('"+operation+"','"+SOURCE+"');"
    begin(first)
    first.no_errors(first.command("DO $$ BEGIN IF transaction_timestamp()<'2026-09-21T07:00:00Z'::timestamptz OR transaction_timestamp()>='2026-09-28T07:00:00Z'::timestamptz THEN RAISE EXCEPTION 'ARCHIVE_RECOGNITION_PERIOD_CAPTURE_EXPIRED'; END IF; END $$;"))
    raw=first.command(call(args.execution));first.no_errors(raw)
    notices=re.findall(r'NOTICE:  00000: (.*)',raw)
    require(notices==['pre-cutover fee 6d13847d-cbe2-473c-94e5-34dad1ce3efb left uncaptured: cash_commission_earning_club_not_observed (23514)'],
            'first actual fee notice differs')
    lines=[line for line in raw.splitlines() if line.startswith('{')]
    require(len(lines)==1,'first canonical response absent');e['first_response']=R.exact_json(lines[0])
    # Observation changes caller role only, never forces deferred constraints early.
    first.no_errors(first.command('RESET ROLE;'));e['inside']=first.json(snapshot)
    first.no_errors(first.command('SET LOCAL ROLE service_role;'))
    begin(same);begin(different)
    same.start(call(args.execution));different.start(call(str(uuid.uuid5(uuid.UUID(args.execution),'different-operation'))))
    e['waits']={}
    while len(e['waits'])<2 and time.monotonic()<deadline:
        for name,client in (('same',same),('different',different)):
            if name in e['waits']:continue
            require(client.poll() is None,'caller completed before owning commit')
            value=observer.json("SELECT jsonb_build_object('pid',pid,'wait_event_type',wait_event_type,'wait_event',wait_event,"
                "'blockers',pg_blocking_pids(pid),'same_owned_advisory_key',EXISTS(SELECT 1 FROM pg_locks w JOIN pg_locks h "
                "ON h.locktype=w.locktype AND h.database IS NOT DISTINCT FROM w.database AND h.classid=w.classid AND h.objid=w.objid "
                "AND h.objsubid=w.objsubid WHERE w.pid="+str(client.pid)+" AND h.pid="+str(first.pid)+
                " AND w.locktype='advisory' AND NOT w.granted AND h.granted)) FROM pg_stat_activity WHERE pid="+str(client.pid)+";")
            if value and value['wait_event']=='advisory' and first.pid in value['blockers']:
                validate_wait(value,first.pid,client.pid);e['waits'][name]=value
        if len(e['waits'])<2:time.sleep(.01)
    require(len(e['waits'])==2,'both owned advisory waits not observed')
    first.no_errors(first.command('COMMIT;'));e['commit_observed']=True;e['deferred_checks_at_commit']=True
    e['committed']=observer.json(snapshot);e['accounts_after']=observer.json(accounts)
    e['durable_response']=observer.json("SELECT public.fn_ca_tournament_terminal_receipt('"+EVENT+"','"+WINNER+"');")
    raw=same.wait();same.no_errors(raw);e['same_response']=R.exact_json(raw)
    same.no_errors(same.command('SET CONSTRAINTS ALL IMMEDIATE; RESET ROLE;'));e['same_inside']=same.json(snapshot)
    same.no_errors(same.command('COMMIT;'))
    raw=different.wait()
    errors=re.findall(r'ERROR:  ([A-Z0-9]{5}): ([^\n]+)',raw)
    require(errors==[('40001','ARCHIVED_SPIN_REPLAY_MISMATCH')] and not any(token in raw for token in ('FATAL:','PANIC:','WARNING:','NOTICE:')),'different caller actual refusal differs: '+raw)
    e['different_sqlstate'],e['different_message']=errors[0]
    different.no_errors(different.command('ROLLBACK;'));e['after']=observer.json(snapshot)
    e['passed']=True


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--psql',type=Path,required=True)
    parser.add_argument('--execution',required=True);args=parser.parse_args()
    require(args.psql.is_absolute() and args.psql.is_file(),'absolute qualified psql required')
    require(hashlib.sha256((ROOT/SESSION).read_bytes()).hexdigest()==SESSION_SHA,'existing Session owner changed')
    R=load('archive_existing_session',ROOT/SESSION);A=load('archive_financial_oracle',ROOT/MODULE);R.canonical_uuid(args.execution)
    e={'execution':args.execution,'event':EVENT,'passed':False,'cleanup_verified':False,
       'financial_qualified':False,'production_qualified':False,'work_deadline_seconds':20,'cleanup_deadline_seconds':5}
    sessions=[]
    try:run(args,e,sessions,time.monotonic()+20,R,A)
    except BaseException as error:e['failure']={'type':type(error).__name__,'message':str(error)}
    finally:
        deadline=time.monotonic()+5;e['clients']=[]
        for name,session in reversed(sessions):
            try:e['clients'].append(session.close(deadline))
            except BaseException as error:e['clients'].append({'backend_pid':session.pid,'cleanup_error':str(error)})
        e['transcripts']={name:bytes(s.raw).decode('utf-8',errors='replace') for name,s in sessions}
        verifier=None
        try:
            require(len(sessions)==4 and all(c.get('client_exit')==0 and 'cleanup_error' not in c for c in e['clients']),'original cleanup failed')
            verifier=R.Session(args.psql,'qual_spin_expiry_'+args.execution.replace('-',''),'archive_cleanup_'+args.execution,deadline)
            verifier.pid=verifier.json('SELECT to_jsonb(pg_backend_pid());')
            R.observe_backend_cleanup(verifier,','.join(str(s.pid) for _,s in sessions),deadline,e);e['cleanup_verified']=True
        except BaseException as error:e['cleanup_failure']=str(error)
        finally:
            if verifier:
                e['cleanup_transcript']=bytes(verifier.raw).decode('utf-8',errors='replace')
                try:
                    e['verifier_client']=verifier.close(deadline)
                    require(e['verifier_client']['client_exit']==0,'verifier cleanup failed')
                except BaseException as error:e['cleanup_verified']=False;e['verifier_cleanup_error']=str(error)
    if 'failure' not in e:
        try:e['qualification']=validate_evidence(e,args.execution,A)
        except BaseException as error:e['failure']={'type':type(error).__name__,'message':str(error)}
    print(json.dumps(e,default=R.evidence_value,allow_nan=False))
    return 0 if e['passed'] and e['cleanup_verified'] and 'failure' not in e else 1


if __name__=='__main__':raise SystemExit(main())
