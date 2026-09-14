"""Positive bounty entry funding followed by an add-on on unchanged bounty rails."""
from pathlib import Path
import json

FIXTURE=Path(__file__).parent/'fixtures/tournament-bounty-addon-funding'
EVENT='c3000000-0000-4000-8000-000000000001'


def verify(q,setup,call,state,check):
    setup('addon','funded_pko_addon',before_register=
          "UPDATE tournaments SET is_bounty=true,is_pko=true,bounty_amount=5 WHERE id='%s';"%EVENT)
    q((FIXTURE/'installed.sql').read_text())
    manifest=json.loads((FIXTURE/'source-manifest.json').read_text())
    expected={x['signature']:x['body_md5'] for x in manifest['functions']}
    actual=json.loads(q("SELECT jsonb_object_agg(oid::regprocedure::text,md5(prosrc)) FROM pg_proc WHERE oid IN ("+
                        ','.join("'%s'::regprocedure"%sig for sig in expected)+");"))
    assert actual==expected,(actual,expected)

    def bounty_state():
        return json.loads(q("""SELECT jsonb_build_object(
          'pool',(SELECT bounty_pool FROM tournaments),
          'escrow',(SELECT bounty_balance FROM tournament_escrow),
          'in',(SELECT bounty_in FROM tournament_escrow),
          'head',(SELECT current_bounty FROM tournament_players),
          'refund_bounty',(SELECT sum(refund_bounty) FROM tournament_refund_entitlements),
          'obligations',(SELECT count(*) FROM tournament_bounty_obligations),
          'payouts',(SELECT count(*) FROM tournament_bounties));"""))

    before=state()
    rails=bounty_state()
    assert {k:before[k] for k in ['wallets','pool','fee','gross','prize','fee_escrow']}==dict(
        wallets=1800,pool=175,fee=20,gross=200,prize=175,fee_escrow=20),before
    assert rails==dict(pool=5,escrow=5,**{'in':5},head=5,refund_bounty=5,obligations=0,payouts=0),rails
    result=json.loads(q(call('addon')))
    assert result.get('success') is True,result
    after=state()
    expected_after=dict(wallets=1785,pool=190,fee=20,gross=215,prize=190,fee_escrow=20,
                        journal=2,wallet_receipts=2,entitlements=2,operations=2,purchase_keys=1,
                        stack=600,roster=600,rebuys=0,addon=True,candidate_states=None,wakes=1)
    assert {k:after[k] for k in expected_after}==expected_after,(after,expected_after)
    assert bounty_state()==rails
    assert after['joined']==before['joined']
    split=json.loads(q("SELECT jsonb_build_object('gross',gross,'prize',refund_prize,'bounty',refund_bounty,'fee',refund_fee) FROM tournament_refund_entitlements WHERE gross=15;"))
    assert split==dict(gross=15,prize=15,bounty=0,fee=0),split
    replay=json.loads(q(call('addon','another-client-token')))
    assert replay==result and state()==after and bounty_state()==rails,(result,replay)
    check('real funded PKO entry and add-on conserve prize, bounty and fee rails; replay preserves the bounty head')
