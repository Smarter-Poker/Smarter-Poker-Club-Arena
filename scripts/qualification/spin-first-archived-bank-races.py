"""Synthetic union-wallet scenarios in the existing provider Session lifecycle.
No allocator, HOME change, network target, historical seed or production access.
"""
import copy
import hashlib
import json
import re
import time
from decimal import Decimal

REL='public.union_wallets'
UNION='fade0000-0000-0000-0000-000000000001'
ROW='341f02a3-4655-420c-b43b-3930b6d9ad8f'
OPKEY="hashtextextended('archived-spin-first-operation:2aa4cba1-506f-426b-a1ba-d8e22e018533',0)"
REPLAY_KEY="hashtextextended('archived-spin-first-bank-replay-observation',0)"
SUCCESS=('external_commit','external_replay_blocked','external_after_observation')
EXTERNAL=(*SUCCESS,'offset_external')
BARRIERS=('external_commit','external_replay_blocked','offset_external')
KINDS=('external_commit','external_replay_blocked','own_parent','own_child','own_noop','offset_external','own_replay_parent','own_replay_child','external_after_observation')

def require(value,message):
    if not value:raise ValueError(message)

def derived_source(source,kind,P):
    require(kind in KINDS,'unknown bank scenario')
    if kind in ('external_commit','external_after_observation'):return source
    if kind=='external_replay_blocked':
        anchor="  PERFORM set_config('request.jwt.claims',"
        require(source.count(anchor)==1,'replay barrier anchor differs')
        return source.replace(anchor,"  IF phase=1 THEN PERFORM pg_advisory_xact_lock("+REPLAY_KEY+"); END IF;\n"+anchor,1)
    update="UPDATE public.union_wallets SET rake_wallet=rake_wallet"+('' if kind=='own_noop' else '-1' if kind=='offset_external' else '+1')+" WHERE id='"+ROW+"'::uuid;"
    if kind in ('own_child','own_replay_child'):update="BEGIN "+update+" EXCEPTION WHEN division_by_zero THEN RAISE; END;"
    injection="  -- ISOLATED OWN-WRITE FAULT; not production source.\n  IF phase="+("1" if kind.startswith("own_replay_") else "0")+" THEN "+update+" END IF;\n"
    require(source.count(P.BANK_FAULT_ANCHOR)==1,'bank race source anchor differs')
    return source.replace(P.BANK_FAULT_ANCHOR,"  EXECUTE format('SET LOCAL ROLE %I',original_role);\n"+injection+' END LOOP;',1)

def parse_fault(raw,P,A):
    require(re.findall(r'ERROR:  ([A-Z0-9]{5}): ([^\n]+)',raw)==[('P0001','PROBE_BANK_OR_RESERVE_CHANGED: public.union_wallets')],'bank fault did not refuse')
    require(not re.search(r'(?:WARNING|FATAL|PANIC):',raw),'unexpected bank diagnostics')
    A.validate_fee_notice('\n'.join(l for l in raw.splitlines() if 'NOTICE:' in l))
    parts=re.findall(r'^DETAIL:\s+(.*)$',raw,re.M);require(len(parts)==1,'bank fault detail absent/duplicated')
    def unique(pairs):
        d={}
        for k,v in pairs:require(k not in d,'duplicate bank diagnostic');d[k]=v
        return d
    def bad(value):raise ValueError('nonfinite bank diagnostic '+value)
    d=json.loads(parts[0],parse_float=Decimal,object_pairs_hook=unique,parse_constant=bad)
    require(set(d)=={'operation','event','transaction_id','isolation','relation','before','inside','bank_observations','fee_capture_diagnostic','sequence_rollback_claimed','production_settlement_complete'},'bank refusal fields differ')
    require(d['operation']==P.OPERATION and d['event']==P.C.EVENT and d['isolation']=='read committed'
        and d['relation']==REL and d['sequence_rollback_claimed'] is False and d['production_settlement_complete'] is False,'bank refusal scope differs')
    fee=P.validate_fee_capture(d['fee_capture_diagnostic']);require(fee['transaction_id']==d['transaction_id'],'fault xid differs')
    h=d['bank_observations'];require(len(h) in (2,3),'own fault did not occur after a canonical call')
    require([r['projection'] for r in h[-2]['rows']]==d['before'] and [r['projection'] for r in h[-1]['rows']]==d['inside'],'bank fault row/version separation')
    require(len(d['before'])==len(d['inside'])==1,'bank scenario row missing')
    P.BANK.validate_own_fault(h,d['transaction_id'],d['before'],d['inside'])
    return d

def external_delta(before,after,writer,application):
    require(set(before)==set(after),'external fixture relation inventory differs')
    for name in before:
        if name not in (REL,'public.chip_ledger'):require(before[name]==after[name],'unrelated external fixture write: '+name)
    require(len(before[REL])==len(after[REL])==1,'external bank cardinality differs')
    expected=copy.deepcopy(before[REL][0]);expected['rake_wallet']+=1
    require(after[REL]==[expected],'external bank full-row mutation differs')
    old=before['public.chip_ledger'];new=after['public.chip_ledger']
    require(all(row in new for row in old),'external writer changed original journal')
    additions=[row for row in new if row not in old]
    require(len(new)==len(old)+1 and len(additions)==1,'external writer journal cardinality differs')
    leg=additions[0]
    expected={'from_type':'settlement_suspense','from_entity_id':None,'to_type':'union_wallet','to_entity_id':ROW,
        'to_label':'union_wallets.rake_wallet','amount':1,'category':'adjustment','club_id':None,'union_id':UNION,
        'tournament_id':None,'hand_id':None,'actor_service':application,
        'pre_to_balance':writer['before'],'post_to_balance':writer['after']}
    require(all(leg.get(k)==v and (type(leg[k]) in (int,Decimal) if type(v) is int else True) for k,v in expected.items()),'external synthetic journal provenance differs')
    return additions

def validate(e,execution,P,A,R):
    require(e['execution']==execution and e['synthetic_overlay'] is True and e['historical_fixture_claimed'] is False
        and e['production_qualified'] is False,'bank scenario scope differs')
    require(e['seed_before']==[] and len(e['seed_after'])==1,'synthetic bank seed inventory differs')
    seed=e['seed_after'][0];require(seed['id']==ROW and seed['union_id']==UNION and all(seed[k]==0 and type(seed[k]) in (int,Decimal) for k in P.BANK.FINANCIAL),'synthetic bank initial money differs')
    require([c['kind'] for c in e['cases']]==list(KINDS),'bank scenario inventory differs')
    require(e['original_rows_restored'] is False and e['cleanup_kind']=='existing_allocator_disposal' and e['sequence_rollback_claimed'] is False,'synthetic disposal scope differs')
    seed_expected=copy.deepcopy(e['original_before']['rows']);seed_expected[REL]=e['seed_after']
    require(e['original_before']['rows'][REL]==[] and e['after_seed']['rows']==seed_expected,'synthetic seed changed unrelated rows')
    previous=e['after_seed']['rows']
    postabort=P.C.load('bank_postabort_validator',P.ROOT/'scripts/qualification/spin-first-archived-postabort.py')
    expected_preimage,expected_funding=postabort.expected_original(P.ROOT)
    source=(P.ROOT/P.PROBE).read_text()
    for c in e['cases']:
        require(c['before']['rows']==previous,'synthetic case starting state differs')
        previous=c['after']['rows']
        derived=derived_source(source,c['kind'],P)
        require(c['base_sha256']==P.PROBE_SHA and c['derived_source']==derived and c['derived_sha256']==hashlib.sha256(derived.encode()).hexdigest(),'bank scenario source differs')
        require(c['expected_durable']['rows']==c['after']['rows'] and c['rollback_output']=='true','bank probe own durable mutation')
        for stage in ('before','expected_durable','after'):require(set(c[stage]['sequences'])==set(P.C.SEQUENCES),'bank scenario sequence observation missing')
        if c['kind'] in SUCCESS:
            d=P.parse_abort(c['original_output'],R,A);P.validate_financial_detail(d,c['before']['rows'],A)
            if c['kind']=='external_commit':
                require(P.BANK.validate_history(d['bank_observations'],d['fee_capture_diagnostic']['transaction_id'])==['external committed version','unchanged'],'external commit not observed in intended interval')
            else:require(all(v in ('unchanged','unchanged empty scope') for v in P.BANK.validate_history(d['bank_observations'],d['fee_capture_diagnostic']['transaction_id'])),'after-observation commit misrepresented')
            xid=d['fee_capture_diagnostic']['transaction_id']
            result=postabort.validate_receipt(d,c['postabort'],expected_preimage,expected_funding)
            require(result['bank_transition']==('external committed version' if c['kind'] in ('external_after_observation','external_replay_blocked') else 'unchanged'),'postabort bank interval differs')
        else:
            require('postabort' not in c,'failed probe cannot qualify postabort successful path')
            d=parse_fault(c['original_output'],P,A);xid=d['transaction_id'];before=d['before'][0];inside=d['inside'][0]
            require(before['id']==inside['id']==ROW,'fault row identity differs')
            expected=copy.deepcopy(before);expected['rake_wallet']+=0 if c['kind'] in ('own_noop','offset_external') else 1
            require(inside==expected,'own fault expected amount differs')
            require(len(d['bank_observations'])==(3 if c['kind'].startswith('own_replay_') else 2),'own fault interval differs')
            try:P.BANK.pair(d['bank_observations'][-2],d['bank_observations'][-1],xid)
            except ValueError:pass
            else:raise ValueError('own fault accepted by observer')
        require(c['transaction_status']=={'transaction_id':xid,'status':'aborted'},'bank probe xid not aborted')
        if c['kind'] in BARRIERS:
            wait=c['wait'];require(wait['worker']==e['pids']['worker'] and wait['holder']==e['pids']['observer']
                and wait['blockers']==[wait['holder']] and wait['waiting'] is True and wait['held'] is True,'bank race actual operation blocker absent')
            require(c['release'] is True,'bank operation barrier unreleased')
        if c['kind']=='external_replay_blocked':
            wait=c['external_wait']
            require(wait['pid']==e['pids']['external'] and wait['blockers']==[e['pids']['worker']]
                and wait['wait_event_type']=='Lock' and wait['wait_event']=='transactionid'
                and wait['worker_blockers']==[e['pids']['observer']]
                and wait['waiting_xids']==[xid],'external replay writer was not blocked by canonical bank owner')
        if c['kind'] in EXTERNAL:
            writer=c['writer'];require(writer['status']=='committed' and writer['transaction_id']!=xid and int(writer['transaction_id'])>int(xid),'external writer not actually committed/new')
            require(type(writer['before']) in (int,Decimal) and type(writer['after']) in (int,Decimal) and writer['after']==writer['before']+1,'external writer amount differs')
            additions=external_delta(c['before']['rows'],c['expected_durable']['rows'],writer,e['external_application'])
            require(writer['journal_additions']==additions and writer['inside_rows']==c['expected_durable']['rows'],'external committed source evidence differs')
        else:require(c['expected_durable']['rows']==c['before']['rows'],'own fault case retained external mutation')
    require(e['final_rows']==previous,'synthetic final custody differs')
    return True

def run(args,parent,worker,observer,external,snapshot,source,P,A,R,deadline):
    e={'execution':args.execution,'synthetic_overlay':True,'historical_fixture_claimed':False,'production_qualified':False,
       'pids':{'worker':worker.pid,'observer':observer.pid,'external':external.pid},'cases':[],
       'original_before':observer.json(snapshot),'original_rows_restored':False,'cleanup_kind':'existing_allocator_disposal','sequence_rollback_claimed':False,
       'external_application':external.json("SELECT to_jsonb(current_setting('application_name'));")};parent['bank_races']=e
    scoped="SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY id),'[]'::jsonb) FROM public.union_wallets w WHERE union_id='"+UNION+"'::uuid;"
    e['seed_before']=observer.json(scoped);require(e['seed_before']==[],'authentic fixture no longer bank-empty; do not overwrite')
    observer.no_errors(observer.command("INSERT INTO public.union_wallets(id,union_id,chip_balance,rake_wallet,bbj_wallet,promo_wallet,insurance_wallet,spin_reserve_wallet) VALUES('"+ROW+"','"+UNION+"',0,0,0,0,0,0);"))
    e['seed_after']=observer.json(scoped);e['after_seed']=observer.json(snapshot)
    original=(P.ROOT/P.C.PROBE).read_text()
    setup="SET timezone='UTC';\n"+original[original.index('CREATE FUNCTION pg_temp.archive_financial_snapshot()'):original.index('CREATE TEMP TABLE archive_before')]
    external.no_errors(external.command(setup+'\n'+P.C.SEQUENCE_SQL))
    postabort=P.C.load('bank_postabort_runtime',P.ROOT/'scripts/qualification/spin-first-archived-postabort.py')
    expected_preimage,expected_funding=postabort.expected_original(P.ROOT)
    for kind in KINDS:
        c={'kind':kind,'base_sha256':P.PROBE_SHA,'derived_source':derived_source(source,kind,P),'before':observer.json(snapshot)}
        c['derived_sha256']=hashlib.sha256(c['derived_source'].encode()).hexdigest();e['cases'].append(c)
        c['expected_durable']=c['before']
        barrier=kind in BARRIERS
        barrier_key=REPLAY_KEY if kind=='external_replay_blocked' else OPKEY
        if barrier:
            observer.no_errors(observer.command('SELECT pg_advisory_lock('+barrier_key+');'));parent['mvcc_operation_barrier']=barrier_key
            worker.start(c['derived_source'])
            while time.monotonic()<deadline:
                wait=observer.json("SELECT jsonb_build_object('worker',"+str(worker.pid)+",'holder',pg_backend_pid(),'blockers',to_jsonb(pg_blocking_pids("+str(worker.pid)+")),'waiting',EXISTS(SELECT 1 FROM pg_locks WHERE pid="+str(worker.pid)+" AND locktype='advisory' AND objsubid=1 AND classid::bigint=((("+barrier_key+")>>32)&4294967295) AND objid::bigint=(("+barrier_key+")&4294967295) AND NOT granted),'held',EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND objsubid=1 AND classid::bigint=((("+barrier_key+")>>32)&4294967295) AND objid::bigint=(("+barrier_key+")&4294967295) AND granted));")
                if wait['waiting'] and wait['held'] and wait['blockers']==[observer.pid]:break
                if worker.poll() is not None:raise ValueError('probe returned before operation barrier')
                time.sleep(0.01)
            else:raise TimeoutError('bank race operation barrier deadline')
            c['wait']=wait
        def external_commit():
            external.no_errors(external.command('BEGIN;'))
            tx=external.json('SELECT to_jsonb(pg_current_xact_id()::text);')
            before=external.json("SELECT to_jsonb(rake_wallet) FROM public.union_wallets WHERE id='"+ROW+"';")
            update="UPDATE public.union_wallets SET rake_wallet=rake_wallet+1 WHERE id='"+ROW+"';"
            if kind=='external_replay_blocked':
                external.start(update)
                while time.monotonic()<deadline:
                    wait=observer.json("SELECT jsonb_build_object('pid',pid,'blockers',to_jsonb(pg_blocking_pids(pid)),'wait_event_type',wait_event_type,'wait_event',wait_event,'worker_blockers',to_jsonb(pg_blocking_pids("+str(worker.pid)+")),'waiting_xids',(SELECT coalesce(jsonb_agg(transactionid::text ORDER BY transactionid::text),'[]'::jsonb) FROM pg_locks WHERE pid="+str(external.pid)+" AND locktype='transactionid' AND NOT granted)) FROM pg_stat_activity WHERE pid="+str(external.pid)+";")
                    if wait['blockers']==[worker.pid] and wait['waiting_xids'] and wait['worker_blockers']==[observer.pid]:break
                    if external.poll() is not None:raise ValueError('external update did not wait for canonical bank owner')
                    time.sleep(0.01)
                else:raise TimeoutError('external bank ownership wait not observed')
                c['external_wait']=wait
                c['release']=observer.json('SELECT to_jsonb(pg_advisory_unlock('+barrier_key+'));');parent.pop('mvcc_operation_barrier',None)
                c['original_output']=worker.wait()
                external.no_errors(external.wait())
            else:external.no_errors(external.command(update))
            writer_inside=external.json(snapshot)['rows']
            external.no_errors(external.command('COMMIT;'))
            c['writer']={'transaction_id':tx,'before':before,'after':external.json("SELECT to_jsonb(rake_wallet) FROM public.union_wallets WHERE id='"+ROW+"';"),'status':observer.json("SELECT to_jsonb(pg_xact_status('"+tx+"'::xid8));")}
            c['expected_durable']=observer.json(snapshot)
            c['writer']['inside_rows']=writer_inside
            c['writer']['journal_additions']=external_delta(c['before']['rows'],c['expected_durable']['rows'],c['writer'],e['external_application'])
        if barrier:
            external_commit()
            if kind!='external_replay_blocked':
                c['release']=observer.json('SELECT to_jsonb(pg_advisory_unlock('+barrier_key+'));');parent.pop('mvcc_operation_barrier',None)
                c['original_output']=worker.wait()
        else:c['original_output']=worker.command(c['derived_source'])
        if kind=='external_after_observation':external_commit()
        d=P.parse_abort(c['original_output'],R,A) if kind in SUCCESS else parse_fault(c['original_output'],P,A)
        xid=d['fee_capture_diagnostic']['transaction_id'] if 'fee_capture_diagnostic' in d else d['transaction_id']
        c['rollback_output']=worker.command('ROLLBACK; SELECT to_jsonb(pg_current_xact_id_if_assigned() IS NULL);')
        c['after']=observer.json(snapshot);c['transaction_status']=observer.json("SELECT jsonb_build_object('transaction_id','"+xid+"','status',pg_xact_status('"+xid+"'::xid8));")
        if kind in SUCCESS:
            query=postabort.bind_query(d)
            raw=observer.command(query);observer.no_errors(raw)
            evidence=postabort.decode_json(raw.strip())
            result=postabort.validate(d,evidence,expected_preimage,expected_funding)
            c['postabort']={'query':query,'query_sha256':hashlib.sha256(query.encode()).hexdigest(),
                'original_output':raw,'evidence':evidence,'validation':result}
            postabort.validate_receipt(d,c['postabort'],expected_preimage,expected_funding)

    e['final_rows']=observer.json(snapshot)['rows']
    validate(e,args.execution,P,A,R)
