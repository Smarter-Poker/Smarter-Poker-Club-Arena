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
    detail={'operation':P.OPERATION,'event':P.C.EVENT,'same_operation_replay_unchanged':True,'transaction_will_abort_now':True,
        'sequence_rollback_claimed':False,'production_settlement_complete':False,'response':c['first_response'],
        'before':dict(before['rows'],**c['accounts_before']),'inside':dict(c['inside']['rows'],**c['accounts_after'])}
    raw=NOTICE+'\nERROR:  PZ002: FIRST_ARCHIVED_ROLLBACK_PROVED:'+P.OPERATION+'\nDETAIL:  '+json.dumps(detail)+'\n'
    p={'observer':101,'worker':102}
    return copy.deepcopy({'execution':c['execution'],'event':P.C.EVENT,'passed':True,'cleanup_verified':True,'financial_qualified':False,'production_qualified':False,
        'sequence_rollback_claimed':False,'probe_sha256':P.PROBE_SHA,'environment':{'max_locks':1024,'max_connections':8},'backend_pids':p,
        'before':before,'after':copy.deepcopy(before),'detail':detail,'original_probe_output':raw,'clients':[{'backend_pid':v,'client_exit':0} for v in p.values()],
        'backend_cleanup':{'backends':0,'locks':0},'backend_cleanup_observations':[{'backends':0,'locks':0}],
        'verifier_client':{'client_exit':0},'cleanup_transcript':'original','transcripts':{k:'original' for k in p}})

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
