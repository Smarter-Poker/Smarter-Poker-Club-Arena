"""Malformed abort envelopes and durable readback controls; no native proof."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
HERE=Path(__file__).resolve().parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
P=load('probe_controls_runner',HERE/'spin-first-archived-production-probe.py')
T=load('probe_controls_concurrency',HERE/'test_first_archived_concurrency.py')
A=load('probe_controls_archive',HERE/'spin-first-archived.py')
NOTICE='NOTICE:  00000: pre-cutover fee 6d13847d-cbe2-473c-94e5-34dad1ce3efb left uncaptured: cash_commission_earning_club_not_observed (23514)'

def fee_diagnostic(xid='10000'):
    # Synthetic parser envelope, never an original native exception witness.
    return {'kind':'separate_original_capture_refusal','operation':P.OPERATION,'event':P.C.EVENT,
        'transaction_id':xid,'rake_record_id':'6d13847d-cbe2-473c-94e5-34dad1ce3efb',
        'sqlstate':'23514','message':'cash_commission_earning_club_not_observed',
        'context':'PL/pgSQL function fn_accounting_earning_contract at RAISE; fn_ca_capture_tournament_fee_from_recorded_evidence at assignment',
        'owner_md5':'b7e0c1cae9d65b9a0b3560dc3280991a','invoker_role':'service_role','auth_role':'service_role',
        'before':{'batches':[],'sources':[]},'after':{'batches':[],'sources':[]}}

def valid():
    c=T.valid();before=copy.deepcopy(c['before']);before['rows'].update({'public.hand_history':[],'public.hand_atomic_commits':[]})
    bank=[{'id':'059bb325-6eeb-4bbd-957d-3a82e755bb0c','union_id':'fade0000-0000-0000-0000-000000000001','rake_wallet':24,'chip_balance':0,'bbj_wallet':0,'promo_wallet':0,'insurance_wallet':0,'spin_reserve_wallet':0}]
    before['rows']['public.union_wallets']=copy.deepcopy(bank)
    c['accounts_before']['public.union_wallets']=copy.deepcopy(bank)
    c['accounts_after']['public.union_wallets']=copy.deepcopy(bank)
    c['inside']['rows']['smarter_private.spin_archived_first_admission'][0]['admitted_xid']=10000
    detail={'operation':P.OPERATION,'event':P.C.EVENT,'same_operation_response_and_nonbank_replay_unchanged':True,'transaction_will_abort_now':True,
        'sequence_rollback_claimed':False,'production_settlement_complete':False,'response':c['first_response'],
        'fee_capture_diagnostic':fee_diagnostic(),'before':dict(before['rows'],**c['accounts_before']),'inside':dict(c['inside']['rows'],**c['accounts_after'])}
    observation={'transaction_id':'10000','snapshot_xmax':'10001','isolation':'read committed','rows':[{'projection':copy.deepcopy(bank[0]),'xmin':'9999','full_xid':'9999','eligible':False,'status':None}]}
    detail['bank_observations']=[copy.deepcopy(observation) for _ in range(3)]
    detail['replay_state']=copy.deepcopy(detail['inside'])
    raw=NOTICE+'\nERROR:  PZ002: FIRST_ARCHIVED_ROLLBACK_PROVED:'+P.OPERATION+'\nDETAIL:  '+json.dumps(detail)+'\n'
    p={'observer':101,'worker':102}
    result=copy.deepcopy({'execution':c['execution'],'event':P.C.EVENT,'passed':True,'cleanup_verified':True,'financial_qualified':False,'production_qualified':False,
        'probe_transaction_status':{'transaction_id':'10000','status':'aborted'},'sequence_rollback_claimed':False,'probe_sha256':P.PROBE_SHA,'environment':{'max_locks':1024,'max_connections':8},'backend_pids':p,
        'before':before,'after':copy.deepcopy(before),'detail':detail,'original_probe_output':raw,'clients':[{'backend_pid':v,'client_exit':0} for v in p.values()],
        'backend_cleanup':{'backends':0,'locks':0},'backend_cleanup_observations':[{'backends':0,'locks':0}],
        'verifier_client':{'client_exit':0},'cleanup_transcript':'original','transcripts':{k:'original' for k in p}})
    source=(P.ROOT/P.PROBE).read_text();derived=P.bank_fault_source(source)
    bank_before=[{'id':'059bb325-6eeb-4bbd-957d-3a82e755bb0c','union_id':'fade0000-0000-0000-0000-000000000001','rake_wallet':24,'chip_balance':0,'bbj_wallet':0,'promo_wallet':0,'insurance_wallet':0,'spin_reserve_wallet':0}]
    bank_inside=copy.deepcopy(bank_before);bank_inside[0]['rake_wallet']+=1
    diagnostic={'operation':P.OPERATION,'event':P.C.EVENT,'transaction_id':'10001','isolation':'read committed',
        'fee_capture_diagnostic':fee_diagnostic('10001'),'relation':'public.union_wallets','before':bank_before,'inside':bank_inside,
        'sequence_rollback_claimed':False,'production_settlement_complete':False}
    diagnostic['bank_observations']=[{'transaction_id':'10001','snapshot_xmax':'10002','isolation':'read committed','rows':[{'projection':copy.deepcopy(row[0]),'xmin':xmin,'full_xid':xmin,'eligible':eligible,'status':status}]} for row,xmin,eligible,status in [(bank_before,'9999',False,None),(bank_inside,'10001',True,'in progress')]]
    fault_raw=NOTICE+'\nERROR:  P0001: PROBE_BANK_OR_RESERVE_CHANGED: public.union_wallets\nDETAIL:  '+json.dumps(diagnostic)+'\n'
    result['bank_fault']={'kind':'isolated-derived-own-bank-mutation','production_sql':False,'base_probe_sha256':P.PROBE_SHA,
        'derived_source':derived,'derived_sha256':P.hashlib.sha256(derived.encode()).hexdigest(),'before':copy.deepcopy(before),'after':copy.deepcopy(before),
        'original_output':fault_raw,'detail':diagnostic,'rollback_output':'true','transaction_status':{'transaction_id':'10001','status':'aborted'}}
    time_sql=P.lease_time_control_sql(source)
    result['lease_time_controls']={'base_probe_sha256':P.PROBE_SHA,'derived_sql':time_sql,
        'derived_sha256':P.hashlib.sha256(time_sql.encode()).hexdigest(),'observed':[
          {'case':name,'refused':refused,'expected_refusal':refused,'old_equality_refused':old}
          for name,refused,old in [('equal',False,False),('separate_clock_calls',False,True),
          ('missing_acquired',True,True),('missing_heartbeat',True,True),('reversed',True,True),
          ('before_transaction',True,True),('after_observation',True,True)]]}
    result['fee_protocol']=[]
    key=int(P.uuid.UUID(result['execution']))%2147483646+1
    for kind in ('lock_restoration','unexpected_success','wrong_error'):
        derived=P.protocol_source(source,kind,key)
        case={'kind':kind,'production_sql':False,'base_probe_sha256':P.PROBE_SHA,'derived_source':derived,
            'derived_sha256':P.hashlib.sha256(derived.encode()).hexdigest(),'before':copy.deepcopy(before),'after':copy.deepcopy(before),
            'rollback_output':'true','transaction_status':{'transaction_id':'10000','status':'aborted'}}
        if kind=='lock_restoration':
            case.update(original_output=raw,detail=copy.deepcopy(detail),wait={'worker':102,'holder':101,'key':key,'blockers':[101],'waiting':True,'held':True},lock_probe={'rake_rows':1,'fee_lock':True},barrier_release=True)
        else:
            error='PZ004: PROBE_FEE_CAPTURE_UNEXPECTED_SUCCESS' if kind=='unexpected_success' else '42883: function public.fn_archived_fee_protocol_missing() does not exist'
            case['original_output']='{"protocol_transaction_id":"10000"}\nERROR:  '+error+'\n'
        result['fee_protocol'].append(case)
    return result


class FirstArchivedProductionProbeTests(unittest.TestCase):
    def test_expected_abort_and_durable_rows(self):
        d=valid();self.assertTrue(P.validate_evidence(d,d['execution'],A)['production_probe_rehearsed'])
    def test_invalid_abort_or_durable_proof_refuses(self):
        changes=[lambda d:d.update(original_probe_output=d['original_probe_output'].replace('PZ002','PZ001')),
            lambda d:d.update(original_probe_output=d['original_probe_output'].replace(P.OPERATION,'00000000-0000-0000-0000-000000000000')),
            lambda d:d.update(original_probe_output=d['original_probe_output'].replace('DETAIL:','CONTEXT:')),
            lambda d:d.update(original_probe_output=d['original_probe_output']+'DETAIL: {}\n'),
            lambda d:d.update(original_probe_output=d['original_probe_output'].replace(NOTICE,'')),
            lambda d:d.update(original_probe_output=d['original_probe_output'].replace('DETAIL:  {','DETAIL:  {\"operation\":\"other\",',1)),
            lambda d:d.update(original_probe_output=''),lambda d:d.update(sequence_rollback_claimed=True),
            lambda d:d.update(financial_qualified=True),lambda d:d.update(probe_sha256='wrong'),
            lambda d:d['after']['rows'].update(changed=True),lambda d:d['detail'].update(event='other'),
            lambda d:d['clients'][0].update(client_exit=1),lambda d:d['backend_cleanup'].update(locks=1)]
        for i,change in enumerate(changes):
            d=valid();change(d)
            with self.subTest(i=i),self.assertRaises((ValueError,KeyError)):P.validate_evidence(d,d['execution'],A)

    def test_original_missing_diagnostic_is_not_accepted(self):
        original=NOTICE+'\nERROR:  P0001: PROBE_BANK_OR_RESERVE_CHANGED: public.union_wallets\nCONTEXT: original old probe\n'
        with self.assertRaisesRegex(ValueError,'DETAIL missing'):P.parse_bank_fault(original,A)

    def test_derived_fault_and_transaction_identity_refuse_tampering(self):
        changes=[lambda f:f.update(production_sql=True),lambda f:f.update(derived_sha256='wrong'),
            lambda f:f.update(derived_source=f['derived_source']+'SELECT 1;'),
            lambda f:f.update(original_output=f['original_output'].replace('P0001','PZ002')),
            lambda f:f.update(original_output=f['original_output']+'DETAIL: {}\n'),
            lambda f:f.update(original_output=f['original_output'].replace('DETAIL:  {','DETAIL:  {"event":"duplicate",',1)),
            lambda f:f.update(original_output=f['original_output'].replace(NOTICE,'')),
            lambda f:f['transaction_status'].update(status='committed'),
            lambda f:f['transaction_status'].update(transaction_id='10002'),
            lambda f:f['after']['rows'].update(changed=True),lambda f:f.update(rollback_output='ERROR: refused'),
            lambda f:f.update(rollback_output=''),lambda f:f.update(rollback_output='false'),
            lambda f:f.update(rollback_output='1'),lambda f:f.update(rollback_output='true\ntrue')]
        for i,change in enumerate(changes):
            d=valid();change(d['bank_fault'])
            with self.subTest(i=i),self.assertRaises((ValueError,KeyError)):P.validate_evidence(d,d['execution'],A)
        for key,value in [('transaction_id',True),('transaction_id','0'),('transaction_id','-1'),('isolation','repeatable read'),
            ('relation','public.clubs'),('sequence_rollback_claimed',True),('inside',[])]:
            d=valid();f=d['bank_fault'];f['detail'][key]=value
            f['original_output']=NOTICE+'\nERROR:  P0001: PROBE_BANK_OR_RESERVE_CHANGED: public.union_wallets\nDETAIL:  '+json.dumps(f['detail'])+'\n'
            with self.subTest(key=key),self.assertRaises(ValueError):P.validate_evidence(d,d['execution'],A)

    def test_absent_wallet_synthetic_insert_is_exact_and_rolled_back(self):
        d=valid();f=d['bank_fault']
        for phase in ('before','after'):f[phase]['rows']['public.union_wallets']=[]
        f['detail']['before']=[]
        row={k:0 for k in ('chip_balance','rake_wallet','bbj_wallet','promo_wallet','insurance_wallet','spin_reserve_wallet')}
        row.update(id=P.OPERATION,union_id='fade0000-0000-0000-0000-000000000001',rake_wallet=1)
        f['detail']['inside']=[row]
        f['detail']['bank_observations'][0]['rows']=[]
        f['detail']['bank_observations'][1]['rows'][0]['projection']=copy.deepcopy(row)
        def render(f):
            f['original_output']=NOTICE+'\nERROR:  P0001: PROBE_BANK_OR_RESERVE_CHANGED: public.union_wallets\nDETAIL:  '+json.dumps(f['detail'])+'\n'
        render(f);P.validate_bank_fault(f,A)
        changes=[lambda f:f['detail']['inside'][0].update(id='wrong'),
            lambda f:f['detail']['inside'][0].update(chip_balance=1),
            lambda f:f['detail']['inside'][0].update(rake_wallet=True),
            lambda f:f['detail']['inside'][0].pop('bbj_wallet'),
            lambda f:f['detail']['inside'].append(copy.deepcopy(row)),
            lambda f:f['after']['rows'].update(changed=True)]
        for i,change in enumerate(changes):
            altered=copy.deepcopy(f);change(altered);render(altered)
            with self.subTest(i=i),self.assertRaises(ValueError):P.validate_bank_fault(altered,A)

    def test_management_transport_retains_actual_structured_refusal(self):
        d=valid();raw=d['original_probe_output'].replace(NOTICE+'\n','')
        self.assertEqual(P.parse_abort(raw,None,A,transport='management'),d['detail'])
        with self.assertRaises(ValueError):P.parse_abort(raw,None,A,transport='native')
        with self.assertRaises(ValueError):P.parse_abort(d['original_probe_output'],None,A,transport='management')
        with self.assertRaises(ValueError):P.parse_abort(raw,None,A,transport='unknown')
        for key,value in [('sqlstate','PZ004'),('sqlstate','42P01'),('message','other'),('context',''),
            ('owner_md5','wrong'),('invoker_role','authenticated'),('transaction_id',True),('transaction_id','10002'),
            ('after',{'batches':[{'id':'provisional'}],'sources':[]})]:
            v=copy.deepcopy(d['detail']);v['fee_capture_diagnostic'][key]=value
            modified='ERROR:  PZ002: FIRST_ARCHIVED_ROLLBACK_PROVED:'+P.OPERATION+'\nDETAIL:  '+json.dumps(v)+'\n'
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):P.parse_abort(modified,None,A,transport='management')
        for error in ('PZ004: PROBE_FEE_CAPTURE_UNEXPECTED_SUCCESS','42P01: relation missing'):
            with self.assertRaises(ValueError):P.parse_abort('ERROR:  '+error+'\n',None,A,transport='management')

    def test_diagnostic_rejects_durable_commit_or_missing_structure(self):
        d=valid();d['probe_transaction_status']['status']='committed'
        with self.assertRaises(ValueError):P.validate_evidence(d,d['execution'],A)
        d=valid();del d['detail']['fee_capture_diagnostic']
        raw='ERROR:  PZ002: FIRST_ARCHIVED_ROLLBACK_PROVED:'+P.OPERATION+'\nDETAIL:  '+json.dumps(d['detail'])+'\n'
        with self.assertRaises((ValueError,KeyError)):P.parse_abort(raw,None,A,transport='management')

    def test_native_protocol_evidence_refuses_tampering(self):
        changes=[lambda d:d['fee_protocol'].pop(),
            lambda d:d['fee_protocol'][0]['lock_probe'].update(fee_lock=False),
            lambda d:d['fee_protocol'][0]['lock_probe'].update(rake_rows=True),
            lambda d:d['fee_protocol'][0]['wait'].update(worker=999),
            lambda d:d['fee_protocol'][0]['wait'].update(blockers=[]),
            lambda d:d['fee_protocol'][0].update(barrier_release=False),
            lambda d:d['fee_protocol'][1].update(derived_source='SELECT 1;'),
            lambda d:d['fee_protocol'][1].update(original_output=''),
            lambda d:d['fee_protocol'][2]['after']['rows'].update(changed=True),
            lambda d:d['fee_protocol'][2]['transaction_status'].update(status='committed')]
        for i,change in enumerate(changes):
            d=valid();change(d)
            with self.subTest(i=i),self.assertRaises((ValueError,KeyError)):P.validate_evidence(d,d['execution'],A)

    def test_lease_timestamp_controls_require_exact_native_results(self):
        c=valid()['lease_time_controls'];P.validate_lease_time_controls(c)
        for change in [lambda d:d['observed'].pop(),lambda d:d['observed'][1].update(refused=True),
            lambda d:d['observed'][2].update(refused=False),lambda d:d['observed'][0].update(refused=0),
            lambda d:d.update(derived_sql='SELECT true;'),lambda d:d.update(base_probe_sha256='wrong')]:
            altered=copy.deepcopy(c);change(altered)
            with self.assertRaises(ValueError):P.validate_lease_time_controls(altered)

    def test_injection_is_only_after_canonical_call_and_role_restoration(self):
        source=(P.ROOT/P.PROBE).read_text();derived=P.bank_fault_source(source)
        self.assertEqual(derived.replace(P.BANK_FAULT_INSERT,''),source)
        self.assertGreater(derived.index(P.BANK_FAULT_INSERT),derived.index('SET CONSTRAINTS ALL IMMEDIATE;'))
        self.assertEqual(derived.count(P.BANK_FAULT_INSERT),1)
        with self.assertRaises(ValueError):P.bank_fault_source(source.replace(P.BANK_FAULT_ANCHOR,''))
