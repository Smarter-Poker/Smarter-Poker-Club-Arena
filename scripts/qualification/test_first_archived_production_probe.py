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

def valid():
    c=T.valid();before=copy.deepcopy(c['before']);before['rows'].update({'public.hand_history':[],'public.hand_atomic_commits':[]})
    bank=[{'id':'059bb325-6eeb-4bbd-957d-3a82e755bb0c','union_id':'fade0000-0000-0000-0000-000000000001','rake_wallet':24,'chip_balance':0,'bbj_wallet':0,'promo_wallet':0,'insurance_wallet':0,'spin_reserve_wallet':0}]
    before['rows']['public.union_wallets']=copy.deepcopy(bank)
    c['accounts_before']['public.union_wallets']=copy.deepcopy(bank)
    c['accounts_after']['public.union_wallets']=copy.deepcopy(bank)
    detail={'operation':P.OPERATION,'event':P.C.EVENT,'same_operation_replay_unchanged':True,'transaction_will_abort_now':True,
        'sequence_rollback_claimed':False,'production_settlement_complete':False,'response':c['first_response'],
        'before':dict(before['rows'],**c['accounts_before']),'inside':dict(c['inside']['rows'],**c['accounts_after'])}
    raw=NOTICE+'\nERROR:  PZ002: FIRST_ARCHIVED_ROLLBACK_PROVED:'+P.OPERATION+'\nDETAIL:  '+json.dumps(detail)+'\n'
    p={'observer':101,'worker':102}
    result=copy.deepcopy({'execution':c['execution'],'event':P.C.EVENT,'passed':True,'cleanup_verified':True,'financial_qualified':False,'production_qualified':False,
        'sequence_rollback_claimed':False,'probe_sha256':P.PROBE_SHA,'environment':{'max_locks':1024,'max_connections':8},'backend_pids':p,
        'before':before,'after':copy.deepcopy(before),'detail':detail,'original_probe_output':raw,'clients':[{'backend_pid':v,'client_exit':0} for v in p.values()],
        'backend_cleanup':{'backends':0,'locks':0},'backend_cleanup_observations':[{'backends':0,'locks':0}],
        'verifier_client':{'client_exit':0},'cleanup_transcript':'original','transcripts':{k:'original' for k in p}})
    source=(P.ROOT/P.PROBE).read_text();derived=P.bank_fault_source(source)
    bank_before=[{'id':'059bb325-6eeb-4bbd-957d-3a82e755bb0c','union_id':'fade0000-0000-0000-0000-000000000001','rake_wallet':24,'chip_balance':0,'bbj_wallet':0,'promo_wallet':0,'insurance_wallet':0,'spin_reserve_wallet':0}]
    bank_inside=copy.deepcopy(bank_before);bank_inside[0]['rake_wallet']+=1
    diagnostic={'operation':P.OPERATION,'event':P.C.EVENT,'transaction_id':'10001','isolation':'read committed',
        'relation':'public.union_wallets','before':bank_before,'inside':bank_inside,
        'sequence_rollback_claimed':False,'production_settlement_complete':False}
    fault_raw=NOTICE+'\nERROR:  P0001: PROBE_BANK_OR_RESERVE_CHANGED: public.union_wallets\nDETAIL:  '+json.dumps(diagnostic)+'\n'
    result['bank_fault']={'kind':'isolated-derived-own-bank-mutation','production_sql':False,'base_probe_sha256':P.PROBE_SHA,
        'derived_source':derived,'derived_sha256':P.hashlib.sha256(derived.encode()).hexdigest(),'before':copy.deepcopy(before),'after':copy.deepcopy(before),
        'original_output':fault_raw,'detail':diagnostic,'rollback_output':'true','transaction_status':{'transaction_id':'10001','status':'aborted'}}
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

    def test_injection_is_only_after_canonical_call_and_role_restoration(self):
        source=(P.ROOT/P.PROBE).read_text();derived=P.bank_fault_source(source)
        self.assertEqual(derived.replace(P.BANK_FAULT_INSERT,''),source)
        self.assertGreater(derived.index(P.BANK_FAULT_INSERT),derived.index('SET CONSTRAINTS ALL IMMEDIATE;'))
        self.assertEqual(derived.count(P.BANK_FAULT_INSERT),1)
        with self.assertRaises(ValueError):P.bank_fault_source(source.replace(P.BANK_FAULT_ANCHOR,''))
