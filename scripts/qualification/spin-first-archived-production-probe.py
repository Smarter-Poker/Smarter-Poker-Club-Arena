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
BANK=C.load("archive_bank_observer",ROOT/"scripts/qualification/spin-first-archived-bank-observer.py")



PROBE='scripts/qualification/fixtures/archived-spin/first-production-rollback-probe.sql'
PROBE_SHA = "12d7f7e671f586f62a71f59b1488460f9d075f6c2802ba574e82af50ac9a681a"
OPERATION='341f02a3-4655-420c-b43b-3930b6d9ad8f'


def validate_fee_capture(d):
    fields={'kind','operation','event','transaction_id','rake_record_id','sqlstate','message','context',
        'owner_md5','invoker_role','auth_role','before','after'}
    require(isinstance(d,dict) and set(d)==fields,'fee capture diagnostic inventory differs')
    require(d['kind']=='separate_original_capture_refusal' and d['operation']==OPERATION and d['event']==C.EVENT
        and d['rake_record_id']=='6d13847d-cbe2-473c-94e5-34dad1ce3efb'
        and d['sqlstate']=='23514' and d['message']=='cash_commission_earning_club_not_observed'
        and d['owner_md5']=='b7e0c1cae9d65b9a0b3560dc3280991a'
        and d['invoker_role']==d['auth_role']=='service_role','fee capture original owner/refusal differs')
    require(isinstance(d['transaction_id'],str) and re.fullmatch(r'[1-9][0-9]{0,19}',d['transaction_id'])
        and int(d['transaction_id'])<2**64,'fee capture transaction identity malformed')
    require(isinstance(d['context'],str) and len(d['context'])<=16384
        and 'fn_ca_capture_tournament_fee_from_recorded_evidence' in d['context']
        and 'fn_accounting_earning_contract' in d['context'],'fee capture actual context absent')
    require(d['before']==d['after']=={'batches':[],'sources':[]},'fee capture provisional writes survived')
    return d


def parse_abort(raw,R,A,transport="native"):
    require(transport in ("native","management"),"unknown probe transport")
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
        and detail['same_operation_response_and_nonbank_replay_unchanged'] is True
        and detail['transaction_will_abort_now'] is True
        and detail['sequence_rollback_claimed'] is False
        and detail['production_settlement_complete'] is False,'probe abort identity/scope differs')
    # Validate the actual original notice separately; intentional PZ002 remains
    # required above rather than being hidden from an error-free validator.
    notices='\n'.join(line for line in raw.splitlines() if 'NOTICE:' in line)
    fee=validate_fee_capture(detail['fee_capture_diagnostic'])
    admitted=detail['inside']['smarter_private.spin_archived_first_admission']
    require(isinstance(admitted,list) and len(admitted)==1 and type(admitted[0].get('admitted_xid')) is int
        and str(admitted[0]['admitted_xid'])==fee['transaction_id'],'capture and canonical admission xid differ')
    BANK.validate_history(detail['bank_observations'],fee['transaction_id'],detail['before'][BANK.RELATION],detail['inside'][BANK.RELATION],detail['replay_state'][BANK.RELATION])
    require({k:v for k,v in detail['inside'].items() if k!=BANK.RELATION}=={k:v for k,v in detail['replay_state'].items() if k!=BANK.RELATION},'nonbank replay differs')
    if transport=='native': A.validate_fee_notice(notices)
    else: require(not notices,'management transport unexpectedly carried NOTICE; inspect original transport')
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
        'sequence_rollback_claimed','production_settlement_complete','fee_capture_diagnostic','bank_observations'},'bank fault detail fields differ')
    fee=validate_fee_capture(d['fee_capture_diagnostic'])
    require(fee['transaction_id']==d['transaction_id'],'bank/capture transaction differs')
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
    BANK.validate_own_fault(d['bank_observations'],d['transaction_id'],d['before'],d['inside'])
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


FEE_CALL="    PERFORM public.fn_ca_capture_tournament_fee_from_recorded_evidence('6d13847d-cbe2-473c-94e5-34dad1ce3efb'::uuid);"
CANONICAL_CALL='   response:=public.fn_complete_first_archived_spin(operation,source_sha);'

def protocol_source(source,kind,key):
    require(source.count(FEE_CALL)==source.count(CANONICAL_CALL)==1,'protocol source anchors differ')
    require(type(key) is int and 0<key<2**31,'protocol barrier key malformed')
    if kind=='lock_restoration':
        return source.replace(CANONICAL_CALL,'   PERFORM pg_advisory_xact_lock(570271,'+str(key)+');\n'+CANONICAL_CALL,1)
    require(kind in ('unexpected_success','wrong_error'),'protocol case unknown')
    replacement='    PERFORM 1;' if kind=='unexpected_success' else '    PERFORM public.fn_archived_fee_protocol_missing();'
    derived=source.replace(FEE_CALL,replacement,1)
    require(derived.count("BEGIN;\nSET LOCAL statement_timeout='20s';")==1,'protocol outer begin differs')
    return derived.replace("BEGIN;\nSET LOCAL statement_timeout='20s';", "BEGIN;\nSELECT jsonb_build_object('protocol_transaction_id',pg_current_xact_id()::text);\nSET LOCAL statement_timeout='20s';",1)

def protocol_error(raw,kind):
    expected=('PZ004','PROBE_FEE_CAPTURE_UNEXPECTED_SUCCESS') if kind=='unexpected_success' else ('42883','function public.fn_archived_fee_protocol_missing() does not exist')
    require(re.findall(r'ERROR:  ([A-Z0-9]{5}): ([^\n]+)',raw)==[expected],'protocol unexpected failure')
    require(not re.search(r'(?:NOTICE|WARNING|FATAL|PANIC):',raw),'protocol unexpected diagnostic')
    lines=[line for line in raw.splitlines() if line.startswith('{')]
    require(len(lines)==1,'protocol transaction marker missing/duplicated')
    marker=json.loads(lines[0]);require(set(marker)=={'protocol_transaction_id'},'protocol marker fields differ')
    xid=marker['protocol_transaction_id']
    require(isinstance(xid,str) and re.fullmatch(r'[1-9][0-9]{0,19}',xid) and int(xid)<2**64,'protocol xid malformed')
    return xid

def validate_financial_detail(detail,observer_rows,archive):
    before=detail['before'];inside=detail['inside'];account_keys=('public.club_members','public.clubs','public.unions','public.union_wallets','public.spin_bonus_pools')
    archive.validate_account_delta({k:before[k] for k in account_keys},{k:inside[k] for k in account_keys},bank_observations=detail['bank_observations'])
    terminal=inside['public.tournament_terminal_settlements'][0]
    archive.validate_journal_and_chairs({'reserve_before':before['public.spin_reserve_ledger'],'reserve_after':inside['public.spin_reserve_ledger'],
        'ledger_before':before['public.chip_ledger'],'ledger_after':inside['public.chip_ledger'],'seats_before':before['public.table_seats'],'seats_after':inside['public.table_seats'],
        'history_count':sum(r.get('tournament_id')==C.EVENT or r.get('table_id')==C.TABLE for r in observer_rows['public.hand_history']),'atomic_commit_count':sum(r.get('table_id')==C.TABLE for r in observer_rows['public.hand_atomic_commits']),'terminal':terminal,'primary_table':inside['public.tables'][0]})
    require(detail['response']['ok'] is True and detail['response']['fully_settled'] is False
        and detail['response']['rake']['accounting']['held_amount']==24,'probe financial receipt differs')

def validate_protocol(cases,execution,A,R,backend_pids,initial_rows):
    require(isinstance(cases,list) and [c['kind'] for c in cases]==['lock_restoration','unexpected_success','wrong_error'],'protocol case inventory differs')
    key=int(uuid.UUID(execution))%2147483646+1;source=(ROOT/PROBE).read_text()
    previous_rows=initial_rows
    for c in cases:
        require(c['before']['rows']==previous_rows,'protocol starting custody differs')
        previous_rows=c['after']['rows']
        derived=protocol_source(source,c['kind'],key)
        require(c['production_sql'] is False and c['base_probe_sha256']==PROBE_SHA and c['derived_source']==derived
            and c['derived_sha256']==hashlib.sha256(derived.encode()).hexdigest(),'protocol derived source differs')
        require(c['before']['rows']==c['after']['rows'],'protocol durable state changed')
        for phase in ('before','after'):require(set(c[phase]['sequences'])==set(C.SEQUENCES),'protocol sequences missing')
        require(c['rollback_output']=='true','protocol rollback marker missing')
        if c['kind']=='lock_restoration':
            detail=parse_abort(c['original_output'],R,A);xid=detail['fee_capture_diagnostic']['transaction_id']
            require(detail==c['detail'],'protocol retained detail differs')
            validate_financial_detail(detail,c['before']['rows'],A)
            wait=c['wait'];require(type(wait['worker']) is int and type(wait['holder']) is int and wait['worker']!=wait['holder']
                and wait['blockers']==[wait['holder']] and wait['waiting'] is True and wait['held'] is True
                and wait['key']==key and wait['worker']==backend_pids['worker'] and wait['holder']==backend_pids['observer'],'protocol actual barrier absent')
            require(c['lock_probe']=={'rake_rows':1,'fee_lock':True} and type(c['lock_probe']['rake_rows']) is int
                and c['lock_probe']['fee_lock'] is True and c['barrier_release'] is True,'nested diagnostic retained original locks')
        else:xid=protocol_error(c['original_output'],c['kind'])
        require(c['transaction_status']=={'transaction_id':xid,'status':'aborted'},'protocol xid not aborted')
    return True

def run_protocol(args,e,worker,observer,snapshot,source,R,A,deadline):
    key=int(uuid.UUID(args.execution))%2147483646+1;e['fee_protocol']=[]
    require(observer.json("SELECT to_jsonb(to_regprocedure('public.fn_archived_fee_protocol_missing()') IS NULL);") is True,'protocol missing function unexpectedly exists')
    for kind in ('lock_restoration','unexpected_success','wrong_error'):
        derived=protocol_source(source,kind,key)
        c={'kind':kind,'production_sql':False,'base_probe_sha256':PROBE_SHA,'derived_source':derived,
            'derived_sha256':hashlib.sha256(derived.encode()).hexdigest(),'before':observer.json(snapshot)};e['fee_protocol'].append(c)
        if kind=='lock_restoration':
            observer.no_errors(observer.command('SELECT pg_advisory_lock(570271,'+str(key)+');'));e['protocol_barrier_key']=key
            worker.start(derived)
            while time.monotonic()<deadline:
                wait=observer.json("SELECT jsonb_build_object('worker',"+str(worker.pid)+",'holder',pg_backend_pid(),'key',"+str(key)+",'blockers',to_jsonb(pg_blocking_pids("+str(worker.pid)+")),'waiting',EXISTS(SELECT 1 FROM pg_locks WHERE pid="+str(worker.pid)+" AND locktype='advisory' AND classid=570271 AND objid="+str(key)+" AND objsubid=2 AND NOT granted),'held',EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=570271 AND objid="+str(key)+" AND objsubid=2 AND granted));")
                if wait['waiting'] and wait['held'] and wait['blockers']==[observer.pid]:break
                if worker.poll() is not None:raise ValueError('worker finished before diagnostic barrier')
                time.sleep(0.01)
            else:raise TimeoutError('diagnostic barrier deadline')
            c['wait']=wait
            observer.no_errors(observer.command('BEGIN;'))
            c['lock_probe']=observer.json("WITH locked AS MATERIALIZED(SELECT id FROM public.rake_records WHERE id='6d13847d-cbe2-473c-94e5-34dad1ce3efb'::uuid FOR UPDATE NOWAIT) SELECT jsonb_build_object('rake_rows',(SELECT count(*) FROM locked),'fee_lock',pg_try_advisory_xact_lock(hashtextextended('accounting_tournament_fee:6d13847d-cbe2-473c-94e5-34dad1ce3efb',0)));")
            observer.no_errors(observer.command('ROLLBACK;'))
            c['barrier_release']=observer.json('SELECT to_jsonb(pg_advisory_unlock(570271,'+str(key)+'));');e.pop('protocol_barrier_key',None)
            c['original_output']=worker.wait();c['detail']=parse_abort(c['original_output'],R,A)
            xid=c['detail']['fee_capture_diagnostic']['transaction_id']
        else:
            c['original_output']=worker.command(derived);xid=protocol_error(c['original_output'],kind)
        c['rollback_output']=worker.command('ROLLBACK; SELECT to_jsonb(pg_current_xact_id_if_assigned() IS NULL);')
        c['after']=observer.json(snapshot)
        c['transaction_status']=observer.json("SELECT jsonb_build_object('transaction_id','"+xid+"','status',pg_xact_status('"+xid+"'::xid8));")
    validate_protocol(e['fee_protocol'],args.execution,A,R,e['backend_pids'],e['bank_fault']['after']['rows'])


def lease_time_control_sql(source):
    parts=re.findall(r"-- BEGIN LEASE TIME REFUSAL\n(.*?)-- END LEASE TIME REFUSAL",source,re.S)
    require(len(parts)==1,'lease time predicate source missing/duplicated')
    predicate=parts[0].strip().replace('transaction_timestamp()', 'started_at')
    return """WITH bounds AS (SELECT '2026-09-27T12:00:00Z'::timestamptz started_at,
      '2026-09-27T12:00:01Z'::timestamptz inside_observed_at),
    cases(ord,name,acquired,heartbeat,expected_refusal) AS (VALUES
      (1,'equal',0,0,false),(2,'separate_clock_calls',1,2,false),
      (3,'missing_acquired',NULL,2,true),(4,'missing_heartbeat',1,NULL,true),
      (5,'reversed',2,1,true),(6,'before_transaction',-1,2,true),
      (7,'after_observation',1,1000001,true)),
    actual AS (SELECT *,jsonb_build_object('acquired_at',started_at+acquired*interval '1 microsecond',
      'heartbeat_at',started_at+heartbeat*interval '1 microsecond') lease FROM cases CROSS JOIN bounds)
    SELECT jsonb_agg(jsonb_build_object('case',name,'refused',("""+predicate+"""),
      'expected_refusal',expected_refusal,'old_equality_refused',
      lease->'heartbeat_at' IS DISTINCT FROM lease->'acquired_at') ORDER BY ord) FROM actual;"""


def validate_lease_time_controls(c):
    expected=[('equal',False,False),('separate_clock_calls',False,True),
      ('missing_acquired',True,True),('missing_heartbeat',True,True),
      ('reversed',True,True),('before_transaction',True,True),('after_observation',True,True)]
    require(isinstance(c,dict) and set(c)=={'base_probe_sha256','derived_sql','derived_sha256','observed'},'lease controls inventory differs')
    sql=lease_time_control_sql((ROOT/PROBE).read_text())
    require(c['base_probe_sha256']==PROBE_SHA and c['derived_sql']==sql
      and c['derived_sha256']==hashlib.sha256(sql.encode()).hexdigest(),'lease control source differs')
    require(isinstance(c['observed'],list) and len(c['observed'])==len(expected),'lease controls missing')
    for row,(name,refused,old_refused) in zip(c['observed'],expected):
        require(set(row)=={'case','refused','expected_refusal','old_equality_refused'} and row['case']==name
          and row['refused'] is refused and row['expected_refusal'] is refused
          and row['old_equality_refused'] is old_refused,'lease timestamp regression differs')


def run(args,e,sessions,deadline,R,A):
    database='qual_spin_expiry_'+args.execution.replace('-','')
    def new(name):
        client=R.Session(args.psql,database,'archive_probe_'+name+'_'+args.execution,deadline)
        sessions.append((name,client));client.pid=client.json('SELECT to_jsonb(pg_backend_pid());');return client
    observer=new('observer')
    env=observer.json("SELECT jsonb_build_object('database',current_database(),'user',current_user,'session_user',session_user,'port',current_setting('port'),'address',inet_server_addr(),'max_locks',current_setting('max_locks_per_transaction')::int,'max_connections',current_setting('max_connections')::int,'version',current_setting('server_version_num')::int,'others',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));")
    R.require_private_endpoint(env,database);e['environment']=env
    worker=new('worker')
    external=new('external') if args.bank_races else None
    e['synthetic_bank_variant']=args.bank_races
    require(env['max_locks']==1024 and env['max_connections']==8,'probe isolated capacity differs')
    original=(ROOT/C.PROBE).read_text()
    setup="SET timezone='UTC';\n"+original[original.index('CREATE FUNCTION pg_temp.archive_financial_snapshot()'):original.index('CREATE TEMP TABLE archive_before')]
    observer.no_errors(observer.command(setup+'\n'+C.SEQUENCE_SQL))
    snapshot="SELECT jsonb_build_object('rows',pg_temp.archive_financial_snapshot(),'sequences',pg_temp.archive_sequence_state());"
    e['backend_pids']={n:c.pid for n,c in sessions};e['before']=observer.json(snapshot)
    require(not e['before']['rows']['smarter_private.spin_archived_first_admission'],'probe requires unadmitted source')
    source=(ROOT/PROBE).read_bytes();require(hashlib.sha256(source).hexdigest()==PROBE_SHA,'exact probe source changed')
    time_sql=lease_time_control_sql(source.decode())
    e['lease_time_controls']={'base_probe_sha256':PROBE_SHA,'derived_sql':time_sql,
        'derived_sha256':hashlib.sha256(time_sql.encode()).hexdigest(),'observed':observer.json(time_sql)}
    validate_lease_time_controls(e['lease_time_controls'])
    e['probe_sha256']=PROBE_SHA;e['original_probe_output']=worker.command(source.decode())
    e['detail']=parse_abort(e['original_probe_output'],R,A)
    worker.no_errors(worker.command('ROLLBACK;'))
    probe_xid=e['detail']['fee_capture_diagnostic']['transaction_id']
    e['probe_transaction_status']=observer.json("SELECT jsonb_build_object('transaction_id','"+probe_xid+"','status',pg_xact_status('"+probe_xid+"'::xid8));")
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
    run_protocol(args,e,worker,observer,snapshot,source.decode(),R,A,deadline)
    if args.bank_races:
        races=C.load('archive_bank_races',ROOT/'scripts/qualification/spin-first-archived-bank-races.py')
        races.run(args,e,worker,observer,external,snapshot,source.decode(),type('ProbeAPI',(),dict(globals())),A,R,deadline)
    e['passed']=True


def validate_evidence(document,execution,archive,*,bank_races=False):
    d=C.restore(document)
    require(d['execution']==execution and d['event']==C.EVENT and d['passed'] is True
        and d['cleanup_verified'] is True and d['financial_qualified'] is False
        and d['production_qualified'] is False and d['sequence_rollback_claimed'] is False,'probe identity/result scope differs')
    require(d['probe_sha256']==PROBE_SHA,'probe bytes differ')
    require(d['environment']['max_locks']==1024 and d['environment']['max_connections']==8,'probe observed capacity differs')
    R=C.load('probe_retained_json',ROOT/C.SESSION)
    validate_lease_time_controls(d['lease_time_controls'])
    detail=parse_abort(d['original_probe_output'],R,archive)
    require(detail==d['detail'],'probe structured detail changed')
    require(d['probe_transaction_status']=={'transaction_id':detail['fee_capture_diagnostic']['transaction_id'],'status':'aborted'},'probe xid not durably aborted')
    require(d['before']['rows']==d['after']['rows'],'probe durable rows changed')
    for phase in ('before','after'):require(set(d[phase]['sequences'])==set(C.SEQUENCES),'probe exact sequence observation missing')
    validate_financial_detail(detail,d['before']['rows'],archive)
    validate_bank_fault(d['bank_fault'],archive)
    validate_protocol(d['fee_protocol'],execution,archive,R,d['backend_pids'],d['bank_fault']['after']['rows'])
    require(d['bank_fault']['before']['rows']==d['after']['rows'],'fault baseline differs from original aborted probe')
    require(d.get('synthetic_bank_variant',False) is bank_races,'bank variant identity differs')
    if bank_races:
        races=C.load('retained_bank_races',ROOT/'scripts/qualification/spin-first-archived-bank-races.py')
        races.validate(d['bank_races'],execution,type('ProbeAPI',(),dict(globals())),archive,R)
        require(d['bank_races']['original_before']['rows']==d['fee_protocol'][-1]['after']['rows'],'bank overlay baseline differs')
        require(d['bank_races']['pids']==d['backend_pids'],'bank race backend inventory differs')
    else:require('bank_races' not in d,'ordinary image contains synthetic bank races')
    names={'observer','worker','external'} if bank_races else {'observer','worker'}
    p=d['backend_pids'];require(set(p)==names and len(set(p.values()))==len(names) and all(type(v) is int and v>0 for v in p.values()),'probe original backend identity differs')
    require(len(d['clients'])==len(names) and {c['backend_pid'] for c in d['clients']}==set(p.values())
        and all(type(c['client_exit']) is int and c['client_exit']==0 for c in d['clients']),'probe client cleanup differs')
    require(d['backend_cleanup']=={'backends':0,'locks':0} and d['backend_cleanup_observations'][-1]=={'backends':0,'locks':0}
        and type(d['verifier_client']['client_exit']) is int and d['verifier_client']['client_exit']==0 and d['cleanup_transcript']
        and set(d['transcripts'])==set(p) and all(d['transcripts'].values()),'probe actual disposal absent')
    return {'production_probe_rehearsed':True,'own_bank_fault_diagnostic_rehearsed':True,'financial_qualified':False,'production_qualified':False,'sequence_rollback_claimed':False}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--psql',type=Path,required=True);parser.add_argument('--execution',required=True);parser.add_argument('--bank-races',action='store_true');args=parser.parse_args()
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
            if 'protocol_barrier_key' in e and 'observer' in owned:
                holder=owned['observer'];holder.deadline=deadline
                try:
                    holder.command('ROLLBACK; SELECT pg_advisory_unlock(570271,'+str(e['protocol_barrier_key'])+');')
                except BaseException as error:e['fault_cleanup']['barrier_error']=str(error)
            if e.get('mvcc_operation_barrier') and 'observer' in owned:
                holder=owned['observer'];holder.deadline=deadline
                try:holder.command("ROLLBACK; SELECT pg_advisory_unlock("+e["mvcc_operation_barrier"]+");")
                except BaseException as error:e['fault_cleanup']['mvcc_barrier_error']=str(error)
            for name in ('external','worker'):
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
            require(len(sessions)==(3 if args.bank_races else 2),'original caller inventory incomplete')
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
        try:e['qualification']=validate_evidence(e,args.execution,A,bank_races=args.bank_races)
        except BaseException as error:e['failure']={'type':type(error).__name__,'message':str(error)}
    print(json.dumps(e,default=R.evidence_value,allow_nan=False))
    return 0 if e['passed'] and e['cleanup_verified'] and 'failure' not in e else 1


if __name__=='__main__':raise SystemExit(main())
