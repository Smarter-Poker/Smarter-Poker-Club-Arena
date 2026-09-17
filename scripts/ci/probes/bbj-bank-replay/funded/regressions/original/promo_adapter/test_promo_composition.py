"""UNRUN protected-only finite callback/uncertainty wiring tests.

Explicit modeled doubles below do not validate the financial oracle or database.
Actual original Psql, nested loader, installed fixture and case remain mandatory.
"""
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import binding
import case_module as adapter

PHASES = ['opening:BEFORE','opening:FIRST-POSITIVE','opening:STABLE',
          'promo:FIRST-PROMO-POSITIVE','promo:STABLE-PROMO']


class Probe:
    label = 'modeled_preseed'
    def __init__(self, fail_cleanup=False):
        self.calls = []
        self.fail_cleanup = fail_cleanup
    def sql(self, command):
        self.calls.append(command)
        if self.fail_cleanup and command == 'ROLLBACK':
            raise RuntimeError('modeled cleanup failure')
    def close(self):
        self.calls.append('close')


def exercise(mode):
    pins = binding.load(HERE/'SOURCE-PINS.json')
    operation = binding.load(HERE/'OPERATION.json')
    authorization = {**operation,'opening_operation_id':'27c0c291-0a7f-412d-8ecf-89e9ad7d61fe'}
    observed = {'seed':0,'opening':0,'promo':0,'phases':[]}
    probe = Probe(mode == 'cleanup_failure')
    supporting = binding.load(Path(pins['backup_packet'])/'FINGERPRINT-CONTRACT.json')['new_supporting_relations']
    raw = {'public.'+name:[] for name in supporting}
    raw.update({name:[] for name in ('auth.users','public.clubs','public.chip_ledger','public.ca_account_snapshots','public.ca_currency_meter')})
    funding = {'status':'PASS_IMPLEMENTED_SUBSET','cleanup_errors':[], 'modeled_funding_marker':object()}
    opening = SimpleNamespace(CASE='MODELED_ORIGINAL_OPENING',__file__=str(Path(pins['author_packet'])/'case_module.py'))
    def seed():
        observed['seed'] += 1
    def open_case(case, connect, seed_once, driver, auth, combined, metadata):
        observed['opening'] += 1
        seed_once()
        if mode == 'double_seed':
            seed_once()
        for _ in range(3):
            combined()
        if mode == 'opening_failure':
            return {'status':'FAIL','cleanup_errors':[]}
        return funding
    def promo_case(case, connect, seed_once, driver, auth, combined, metadata, actual_opening, actual_funding):
        observed['promo'] += 1
        assert actual_opening is opening and actual_funding is funding
        assert auth['packet_sha256'] == pins['promo_integrity_sha256']
        assert auth['move_operation'] == operation['move_operation'] and auth['move_reason'] == operation['move_reason']
        assert auth['opening_operation_id'] == authorization['opening_operation_id']
        assert auth['case'] == binding.CASE and auth['fresh_fixture'] is True
        for _ in range(1 if mode == 'missing_phase' else 3 if mode == 'extra_phase' else 2):
            combined()
        if mode == 'uncertain_commit':
            return {'status':'UNCERTAIN','effects_committed':None,'original_failure':'modeled response loss'}
        if mode == 'promo_failure':
            return {'status':'FAIL','original_failure':'modeled case failure'}
        return {'status':'PASS_IMPLEMENTED_SUBSET'}
    opening.execute_prepared_case = open_case
    promo = SimpleNamespace(capture=lambda _: {'raw':raw},read=lambda _: {'new_supporting_relations':supporting},execute_prepared_case=promo_case)
    def combined(phase):
        observed['phases'].append(phase)
        return {'exit':0,'single_request':True}
    with patch.object(adapter,'verify_binding',lambda *a:None), patch.object(adapter,'parent_modules',lambda:(None,None,opening,None)), patch.object(adapter,'promo_module',lambda:promo):
        result = adapter.execute_prepared_case(binding.CASE,lambda *a:probe,seed,None,authorization,combined,lambda _: {},binding.CASE.lower(),'123')
    assert probe.calls == ['ROLLBACK','SELECT pg_advisory_unlock_all()','close']
    if mode == 'success':
        assert result['status'] == 'PASS_IMPLEMENTED_SUBSET'
        assert observed == {'seed':1,'opening':1,'promo':1,'phases':PHASES}
        assert result['funding_result'] is funding
    else:
        assert result['status'] == 'FAIL'
        if mode in ('opening_failure','double_seed','cleanup_failure'):
            assert observed['promo'] == 0
        if mode == 'uncertain_commit':
            assert result['promo_result']['status'] == 'UNCERTAIN' and result['promo_result']['effects_committed'] is None
    assert observed['seed'] <= 1 and observed['opening'] <= 1 and observed['promo'] <= 1
    return {'mode':mode,'passed':True,'observed':observed}


def main():
    checks = [exercise(mode) for mode in ('success','opening_failure','double_seed','promo_failure','uncertain_commit','missing_phase','extra_phase','cleanup_failure')]
    try:
        binding.verify_binding(binding.load(HERE/'AUTHORIZATION-TEMPLATE.json'))
    except RuntimeError as exc:
        assert 'inert adapter' in str(exc)
    else:
        raise AssertionError('False template admitted')
    print(json.dumps({'status':'PASS_MODELED_WIRING_ONLY','checks':checks,'native_calls':0,
                      'financial_oracle_validated':False,'native_execution_authorized':False}))


if __name__ == '__main__':
    main()
