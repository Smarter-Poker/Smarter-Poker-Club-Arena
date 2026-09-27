"""Malformed-output controls only. Synthetic envelopes do not prove settlement."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC=importlib.util.spec_from_file_location('first_archived_oracle',Path(__file__).with_name('spin-first-archived.py'))
A=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(A)
EXECUTION='00000000-0000-4000-8000-000000000001'
WINNER='aef849b8-2906-4dc0-b108-251710e76d3c'
CLUB='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
NOTICE='NOTICE:  00000: pre-cutover fee 6d13847d-cbe2-473c-94e5-34dad1ce3efb left uncaptured: cash_commission_earning_club_not_observed (23514)\n'


def envelopes():
    custody={'accounting_version':3,'tournament_id':A.EVENT,'status':'fee_custody_unresolved','player_result':'final',
        'payable':False,'accounting_complete':False,'resolution':None,'current_held_amount':24,'held_amount':24,
        'source_fingerprint':'bfb56dac635bc7a238383d785ea88f35','source_count':1,
        'reason':'tournament_fee_sources_require_reconciliation','custody_store':'tournament_escrow',
        'recognized_source_count':0,'bank_amount':0,'banked_at':None,'bank_receipt_id':None,'obligation_id':EXECUTION}
    response={'ok':True,'tournament_id':A.EVENT,'winner_id':WINNER,'status':'COMPLETED','winner_amount':200,
        'cash_payout_total':200,'bounty_payout_total':0,'receipt_version':3,'fully_settled':False,
        'accounting_complete':False,'accounting_state':'fee_custody_unresolved','rake':{
        'amount':24,'destination':'tournament_escrow','attributed':False,'attributed_users':0,
        'settled_at':None,'attributed_at':None,'accounting':custody}}
    roster=[{'user_id':u,'id':i,'tournament_id':A.EVENT,'club_id':CLUB,'position':p,'prize':v}
        for u,i,p,v in [(WINNER,'06377b59-94e6-4663-9fc0-5dba12675b9d',1,200),
        ('036f0b55-c601-4d09-982a-5294cf4ea15d','bcab2749-47c7-4617-9d72-9e56de4eb616',2,0),
        ('72f2fedb-a5f9-4d10-b147-d92e18102d3f','1350d845-cdf8-41ad-86bf-abf2f2460cab',3,0)]]
    before={k:[] for k in ['public.club_members','public.clubs','public.unions','public.union_wallets','public.spin_bonus_pools']}
    before['public.club_members']=[{'user_id':WINNER,'club_id':CLUB,'chip_balance':10,'promo_balance':7},
        {'user_id':WINNER,'club_id':'other-club','chip_balance':20,'promo_balance':0}]
    before['public.spin_bonus_pools']=[{'id':'reserve','balance':1000,'total_drawn':500}]
    after=copy.deepcopy(before);after['public.club_members'][0]['chip_balance']+=200
    state={'wallet_delta':200,'players':roster,'escrow':{'prize_balance':0,'bounty_balance':0,'fee_balance':24,'closed_at':None},
        'terminal':{'tournament_id':A.EVENT,'winner_id':WINNER,'receipt_version':3,'accounting_state':'fee_custody_unresolved','cash_payout_count':1,'cash_payout_total':200,'rake_amount':24,'rake_destination':'tournament_escrow','escrow_closed_at':None},'accounts_before':before,'accounts_after':after,
        'custody_obligations':[{'id':EXECUTION,'tournament_id':A.EVENT,'amount':24,'source_fingerprint':custody['source_fingerprint'],'reason':custody['reason']}],
        'recognition_count':0,'recognized_source_count':0,'rake_settlement_count':0}
    seats=[{'id':str(i),'table_id':'6eaddeaf-1511-4265-bb38-37811ae82ad9','stack':900 if i==1 else 0,'left_at':None if i==1 else 'original','status':'playing','leave_pending':False,'is_sitting_out':False,'is_away':False,'sit_out_at':None,'scheduled_leave_hands':None} for i in (1,2,3)]
    closed=copy.deepcopy(seats)
    for row in closed:row.update(left_at=row['left_at'] or 'terminal',status='left')
    state.update(reserve_before=[{'id':'reserve','amount':276}],reserve_after=[{'id':'reserve','amount':276}],
        ledger_before=[{'id':'original','amount':100}],ledger_after=[{'id':'original','amount':100},
        {'id':'prize','amount':200,'tournament_id':A.EVENT,'club_id':CLUB,'category':'tournament_prize','from_type':'prize_liability','from_entity_id':A.EVENT,'to_type':'player_wallet','to_entity_id':WINNER}],
        seats_before=seats,seats_after=closed,history_count=0,atomic_commit_count=0,
        primary_table={'id':'6eaddeaf-1511-4265-bb38-37811ae82ad9','tournament_id':A.EVENT,'status':'closed','lifecycle':'closed','current_players':0})
    values=[{'stage':'first_archived_terminal_before_rollback','event':A.EVENT,'response':response},
        dict(state,stage='first_archived_state_before_rollback'),
        {'stage':'first_archived_after_rollback','economic_rows_unchanged':True,'admission_absent':True,'terminal_absent':True,'lease_absent':True}]
    for value in values:value.update(execution=EXECUTION,financial_qualified=False,production_qualified=False)
    return values


class FirstArchivedOracleTests(unittest.TestCase):
    def check(self, values, stderr=NOTICE, receipt_change=None):
        with tempfile.TemporaryDirectory() as name:
            work=Path(name)
            funding={'stage':'first_original_funding_observation','execution':EXECUTION,'event':A.EVENT,'actual':{},'expected':{}}
            (work/'archive_funding_observation.stdout').write_text(json.dumps(funding)+'\n')
            negative={'execution':EXECUTION,'stage':'first_archived_negative_cases','anon_denied':True,'authenticated_denied':True,'wrong_source_denied':True,'null_operation_denied':True,'actual_competing_lease_denied':True,'economic_rows_unchanged':True,'service_acl_wrong_jwt_denied':True,'abi_authority_immutable':True,'actual_freeze_denied':True,'financial_qualified':False,'production_qualified':False}
            (work/'archive_negative_cases.stdout').write_text(json.dumps(negative)+'\n')
            (work/'archive_negative_cases.stderr').write_text('')
            drift={'execution':EXECUTION,'stage':'first_archived_preimage_drift','changed_parent_refused':True,'whole_rows_unchanged_inside_and_after':True,'financial_qualified':False,'production_qualified':False}
            (work/'archive_preimage_drift.stdout').write_text(json.dumps(drift)+'\n')
            (work/'archive_preimage_drift.stderr').write_text('')
            atomic={'execution':EXECUTION,'stage':'first_archived_atomic_failures','late_failure_after_real_credit':True,'deferred_admission_requires_terminal':True,'whole_rows_unchanged_inside_and_after':True,'sequence_rollback_claimed':False,'financial_qualified':False,'production_qualified':False}
            (work/'archive_atomic_failures.stdout').write_text(json.dumps(atomic)+'\n')
            (work/'archive_atomic_failures.stderr').write_text(NOTICE)
            (work/'archive_connected_rollback.stdout').write_text('\n'.join(map(json.dumps,values))+'\n')
            (work/'archive_connected_rollback.stderr').write_text(stderr)
            if receipt_change:
                name,key,value=receipt_change
                path=work/(name+'.stdout'); receipt=json.loads(path.read_text());receipt[key]=value
                path.write_text(json.dumps(receipt)+'\n')
            spec=importlib.util.spec_from_file_location('concurrency_control_envelope',Path(__file__).with_name('test_first_archived_concurrency.py'))
            control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
            (work/'archive_concurrency_commit.stdout').write_text(json.dumps(control.valid())+'\n')
            (work/'archive_concurrency_commit.stderr').write_text('')
            return A.validate_outputs(Path(__file__).resolve().parents[2],work,EXECUTION,A.EVENT)

    def test_protocol_shape_pass_is_not_financial_qualification(self):
        result=self.check(envelopes())
        self.assertTrue(result['diagnostic_passed'])
        self.assertIs(result['financial_qualified'],False)
        self.assertIs(result['committed_terminal_qualified'],True)
        self.assertIs(result['production_qualified'],False)

    def test_malformed_financial_observations_refuse(self):
        mutations=[
            lambda v:v[1]['reserve_after'][0].update(amount=0),
            lambda v:v[1]['ledger_after'][0].update(amount=99),
            lambda v:v[1]['ledger_after'][1].update(amount=900),
            lambda v:v[1]['ledger_after'][1].update(to_entity_id='other'),
            lambda v:v[1].update(history_count=1),
            lambda v:v[1].update(atomic_commit_count=1),
            lambda v:v[1]['seats_after'][0].update(left_at=None),
            lambda v:v[1]['seats_after'][0].update(stack=0),
            lambda v:v[1]['seats_after'][1].update(left_at='rewritten'),
            lambda v:v[1]['primary_table'].update(status='running'),
            lambda v:v[1]['players'].append(copy.deepcopy(v[1]['players'][0])),
            lambda v:v[1]['players'][0].update(id='wrong'),
            lambda v:v[1]['players'][0].update(tournament_id='wrong'),
            lambda v:v[1]['players'][0].update(club_id='wrong'),
            lambda v:v[1]['escrow'].update(fee_balance=0),
            lambda v:v[1]['escrow'].update(prize_balance=False),
            lambda v:v[1]['accounts_after']['public.club_members'][1].update(chip_balance=21),
            lambda v:v[1]['accounts_after']['public.club_members'][0].update(promo_balance=8),
            lambda v:v[1]['accounts_after']['public.spin_bonus_pools'][0].update(balance=1200),
            lambda v:v[1]['accounts_after']['public.club_members'].append(copy.deepcopy(v[1]['accounts_after']['public.club_members'][0])),
            lambda v:v[0]['response']['rake']['accounting'].update(bank_amount=24),
            lambda v:v[0]['response']['rake']['accounting'].update(source_fingerprint='wrong'),
            lambda v:v[0]['response']['rake']['accounting'].update(payable=0),
            lambda v:v[1].update(recognized_source_count=1),
            lambda v:v[1].update(recognition_count=False),
            lambda v:v[1]['terminal'].clear(),
            lambda v:v[1]['custody_obligations'].clear(),
            lambda v:v[1]['custody_obligations'][0].update(id='wrong'),
            lambda v:v[2].update(economic_rows_unchanged=False),
            lambda v:v[0].update(financial_qualified=True),
            lambda v:v.append(copy.deepcopy(v[1])),
        ]
        for index,mutate in enumerate(mutations):
            with self.subTest(index=index):
                values=envelopes();mutate(values)
                with self.assertRaises((ValueError,KeyError,TypeError)):self.check(values)

    def test_false_fault_or_caller_receipts_refuse(self):
        for name,key,value in [
            ('archive_negative_cases','service_acl_wrong_jwt_denied',False),
            ('archive_negative_cases','actual_freeze_denied',False),
            ('archive_negative_cases','actual_competing_lease_denied',1),
            ('archive_atomic_failures','late_failure_after_real_credit',False),
            ('archive_atomic_failures','deferred_admission_requires_terminal',False),
            ('archive_atomic_failures','sequence_rollback_claimed',True),
            ('archive_preimage_drift','changed_parent_refused',False),
            ('archive_preimage_drift','whole_rows_unchanged_inside_and_after',False)]:
            with self.subTest(name=name,key=key):
                with self.assertRaises(ValueError):self.check(envelopes(),receipt_change=(name,key,value))

    def test_missing_or_wrong_caught_dependency_is_not_fee_proof(self):
        for stderr in ['',NOTICE.replace('(23514)','(42P01)'),NOTICE+'NOTICE:  00000: missing fixture (42883)\n',NOTICE+'WARNING: unrelated fixture incomplete\n']:
            with self.subTest(stderr=stderr):
                with self.assertRaises(ValueError):self.check(envelopes(),stderr)


if __name__=='__main__':unittest.main()
