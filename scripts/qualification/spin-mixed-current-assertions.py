"""Independent integer-valued cash oracle for the declared zero-fee model only."""
import json
from decimal import Decimal

TID='10000000-0000-4000-8000-000000000001'
WIN='00000000-0000-4000-8000-000000000003'
CLUB='70000000-0000-4000-8000-000000000001'
USERS=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',WIN]

def load(here, name):
    raw = (here / (name + '.stdout')).read_text()
    if any(marker in raw for marker in ('ERROR:', 'FATAL:', 'PANIC:')):
        raise AssertionError('SQL failure in independent observation: ' + name)
    stderr = here / (name + '.stderr')
    if stderr.exists() and any(marker in stderr.read_text() for marker in ('ERROR:', 'FATAL:', 'PANIC:')):
        raise AssertionError('SQL failure in independent observation stderr: ' + name)
    def constant(value):
        raise ValueError('nonfinite JSON constant: ' + value)
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate JSON key: ' + key)
            result[key] = value
        return result
    return [json.loads(line, parse_float=Decimal, parse_constant=constant, object_pairs_hook=unique)
            for line in raw.splitlines() if line.lstrip().startswith('{')]

def validate(here):
    before,=load(here,'independent_before')
    committed,=load(here,'independent_committed')
    replay_rows=load(here,'independent_replay')
    assert len(replay_rows)==2
    replay,=[row for row in replay_rows if 'receipt' in row]
    restored,=[row for row in replay_rows if row.get('stage')=='replay_timezone_restored']
    assert replay['timezone']=='Pacific/Honolulu'
    assert restored=={'stage':'replay_timezone_restored','pid':replay['pid'],
                     'backend_start':replay['backend_start'],'timezone':'Pacific/Honolulu'}
    after,=load(here,'independent_after_replay')
    consumer=load(here,'terminal_consumer')
    identity,= [x for x in consumer if x.get('stage')=='consumer_backend']
    precommit,= [x for x in consumer if x.get('stage')=='precommit']
    same_replay,= [x for x in consumer if x.get('stage')=='committed_replay']
    assert len({x['pid'] for x in [before,identity,committed,replay,after]})==5
    assert all(x['backend_start'] is not None for x in [before,identity,committed,replay,after])
    assert len({x['backend_start'] for x in [before,identity,committed,replay,after]})==5
    assert all(x['user']==x['session_user']=='postgres' for x in [before,committed,after])
    assert replay['timezone']=='Pacific/Honolulu'
    assert replay['user']=='service_role' and replay['session_user']=='postgres'
    assert before['state']==precommit['before']
    assert precommit['after']==same_replay['state']==committed['state']==after['state']
    assert committed['estate']==after['estate']
    assert replay['receipt']==precommit['receipt']
    b=before['estate']; a=committed['estate']
    assert len(b['club_members'])==len(a['club_members'])==3
    assert {(r['club_id'],r['user_id']):r['chip_balance'] for r in b['club_members']}=={(CLUB,u):90 for u in USERS}
    assert {(r['club_id'],r['user_id']):r['chip_balance'] for r in a['club_members']}=={(CLUB,u):(110 if u==WIN else 90) for u in USERS}
    assert a['wallets']==b['wallets']==[]
    assert len(a['clubs'])==len(b['clubs'])==1
    # Existing table-close trigger recalculates cash-table count and stamps updated_at.
    # Require its exact transaction stamp; every other club field is unchanged.
    assert {k:v for k,v in a['clubs'][0].items() if k!='updated_at'}=={k:v for k,v in b['clubs'][0].items() if k!='updated_at'}
    assert a['clubs'][0]['updated_at']==precommit['receipt']['settled_at']
    assert a['clubs'][0]['table_count']==b['clubs'][0]['table_count']==0
    assert all(a['clubs'][0][k]==0 for k in ['chip_treasury','chip_pool','total_rake'])
    assert a['spin_bonus_pools']==b['spin_bonus_pools'] and len(a['spin_bonus_pools'])==1
    assert a['spin_bonus_pools'][0]['balance']==10
    assert a['spin_reserve_ledger']==b['spin_reserve_ledger'] and len(a['spin_reserve_ledger'])==2
    assert len(b['tournament_escrow'])==len(a['tournament_escrow'])==1
    assert b['tournament_escrow'][0]['prize_balance']==20 and b['tournament_escrow'][0]['prize_out']==0
    escrow=a['tournament_escrow'][0]
    assert escrow['prize_balance']==0 and escrow['prize_out']==20 and escrow['fee_balance']==escrow['bounty_balance']==0
    assert escrow['closed_at'] and escrow['terminal_closed_at']
    assert sum(r['chip_balance'] for r in a['club_members'])+a['spin_bonus_pools'][0]['balance']+escrow['prize_balance']==300
    assert b['tournament_payouts']==b['tournament_obligations']==b['wallet_credit_idempotency']==b['tournament_terminal_settlements']==[]
    payout,=a['tournament_payouts'];obligation,=a['tournament_obligations'];credit,=a['wallet_credit_idempotency'];terminal,=a['tournament_terminal_settlements']
    assert payout['user_id']==obligation['user_id']==credit['user_id']==WIN
    assert payout['tournament_id']==obligation['tournament_id']==terminal['tournament_id']==TID
    assert payout['amount']==obligation['amount_owed']==obligation['amount_paid']==credit['amount']==terminal['cash_payout_total']==20
    assert terminal['cash_payout_count']==1 and terminal['winner_id']==WIN and terminal['completed_at']
    assert credit['key']==payout['idempotency_key'] and credit['key'].startswith('tourney:'+TID+':obl:')
    assert obligation['settled_at'] and obligation['kind']=='place' and obligation['place']==payout['position']==1
    old={r['id']:r for r in b['chip_ledger']}; new={r['id']:r for r in a['chip_ledger']}
    assert len(old)==5 and len(new)==6 and all(new[k]==v for k,v in old.items())
    leg,=[r for k,r in new.items() if k not in old]
    assert leg['from_type']=='prize_liability' and leg['from_entity_id']==TID and leg['to_type']=='player_wallet' and leg['to_entity_id']==WIN
    assert leg['amount']==20 and leg['category']=='tournament_prize' and leg['status']=='posted' and leg['club_id']==CLUB and leg['tournament_id']==TID
    assert leg['row_hash'] and leg['chain_seq']>0
    assert len(b['wallet_transactions'])==3 and len(a['wallet_transactions'])==4
    credits=[r for r in a['wallet_transactions'] if r['type']=='credit'];assert len(credits)==1
    assert credits[0]['amount']==20 and credits[0]['balance_after']==110 and credits[0]['user_id']==WIN and credits[0]['related_entity_id']==TID
    assert sorted((r['user_id'],r['amount']) for r in a['wallet_transactions'] if r['type']=='debit')==[(u,10) for u in USERS]
    assert len(committed['state']['ca_spin_mixed_basis_v1'])==len(committed['state']['ca_spin_mixed_completion_v1'])==1
    assert committed['state']['ca_spin_mixed_dispatch_v1']==[]
    recognition,=a['accounting_tournament_fee_recognitions']
    assert b['accounting_tournament_fee_recognitions']==[]
    assert recognition['tournament_id']==TID and recognition['status']=='cancelled' and recognition['net_rake']==0
    assert recognition['bank_club_id']==CLUB and recognition['bank_journal_id'] is None and recognition['union_wallet_transaction_id'] is None
    assert recognition['recognized_at']==terminal['settled_at']
    assert terminal['accounting_state']=='cancelled' and terminal['receipt_version']==2
    for name in ['accounting_tournament_fee_batches','accounting_tournament_fee_sources','accounting_tournament_recognized_sources','accounting_routed_settlement_runs','accounting_period_recompute_requests']:
        assert a[name]==b[name]==[]
    return {'distinct_backends':5,'committed_wallets':[90,90,110],'reserve':10,'prize_escrow':0,'total_cash_chips':300,'single_payout':20,'single_wallet_credit':True,'single_new_ledger_leg':True,'exact_full_state_replay':True,'exact_whole_cash_estate_replay':True,'cross_timezone_replay':True,'caller_timezone_restored':True,'fee_bearing_qualification':False,'full_financial_qualification':False,'historical_qualification':False,'current_target_qualified':False,'incident_closed':False}
