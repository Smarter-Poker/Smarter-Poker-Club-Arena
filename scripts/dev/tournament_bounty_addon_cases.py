"""Positive bounty entry funding followed by an add-on on unchanged bounty rails."""
from pathlib import Path
import json
import hashlib

FIXTURE=Path(__file__).parent/'fixtures/tournament-bounty-addon-funding'
EVENT='c3000000-0000-4000-8000-000000000001'


def verify(q,setup,call,state,check):
    for name,bounty in [('whole',5),('fractional_percent',1.5),('fractional_absolute',6.75)]:
        q('CHECKPOINT;')
        verify_amount(q,setup,call,state,check,name,bounty)


def verify_amount(q,setup,call,state,check,name,bounty):
    setup('addon','funded_pko_addon_'+name,before_register=
          "UPDATE tournaments SET is_bounty=true,is_pko=true,bounty_amount=%s WHERE id='%s';"%(bounty,EVENT))
    q((FIXTURE/'installed.sql').read_text())
    manifest=json.loads((FIXTURE/'source-manifest.json').read_text())
    expected={x['signature']:x['body_md5'] for x in manifest['functions']}
    actual=json.loads(q("SELECT jsonb_object_agg(oid::regprocedure::text,md5(prosrc)) FROM pg_proc WHERE oid IN ("+
                        ','.join("'%s'::regprocedure"%sig for sig in expected)+");"))
    assert actual==expected,(actual,expected)

    # The retained fixture predates the denomination and conservation guards.
    # Install the captured current bodies, without replacing either guard.
    q("""ALTER TABLE clubs ADD COLUMN IF NOT EXISTS asset text DEFAULT 'chips';
      ALTER TABLE clubs ADD COLUMN IF NOT EXISTS is_platform boolean DEFAULT false;
      CREATE TABLE tournament_felt_supply_acknowledgements(tournament_id uuid PRIMARY KEY,chips numeric);
    """)
    current=json.loads((FIXTURE/'current-purchase.json').read_text())['functions']
    order=['fn_ca_unit_floor_cents','fn_ca_tournament_fee_ratio','fn_ca_tournament_unit_cents',
           'fn_ca_recovery_fee_cents','fn_ca_tournament_chip_supply','fn_ca_tournament_felt_total',
           'fn_ca_assert_tournament_chip_grant','fn_ca_process_tournament_chip_purchase_money_v1',
           'process_tournament_rebuy']
    for function in sorted(current,key=lambda f:order.index(f['proname'])):
        body=function['definition'].split('$function$')[1]
        assert hashlib.md5(body.encode()).hexdigest()==function['body_md5']
        q(function['definition']+';')
    current_hashes=json.loads(q("SELECT jsonb_object_agg(oid::regprocedure::text,md5(prosrc)) FROM pg_proc WHERE oid IN ("+
        ','.join("'%s'::regprocedure"%f['signature'] for f in current)+");"))
    assert current_hashes=={f['signature']:f['body_md5'] for f in current}

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
        wallets=1800,pool=180-bounty,fee=20,gross=200,prize=180-bounty,fee_escrow=20),before
    assert rails==dict(pool=bounty,escrow=bounty,**{'in':bounty},head=bounty,refund_bounty=bounty,obligations=0,payouts=0),rails
    q('UPDATE tournaments SET starting_chips=100;')
    refused_before=state()
    refused=json.loads(q(call('addon')))
    assert 'TOURNAMENT_CHIP_GRANT_WOULD_MINT' in refused.get('error',''),refused
    assert state()==refused_before and bounty_state()==rails
    q('UPDATE tournaments SET starting_chips=1000;')
    check('current conservation guard refuses over-supply with full rollback for '+str(bounty)+' bounty')
    result=json.loads(q(call('addon')))
    assert result.get('success') is True,result
    after=state()
    expected_after=dict(wallets=1785,pool=195-bounty,fee=20,gross=215,prize=195-bounty,fee_escrow=20,
                        journal=2,wallet_receipts=2,entitlements=2,operations=2,purchase_keys=1,
                        stack=600,roster=600,rebuys=0,addon=True,candidate_states=None,wakes=1)
    assert {k:after[k] for k in expected_after}==expected_after,(after,expected_after)
    assert bounty_state()==rails
    assert after['joined']==before['joined']
    split=json.loads(q("SELECT jsonb_build_object('gross',gross,'prize',refund_prize,'bounty',refund_bounty,'fee',refund_fee) FROM tournament_refund_entitlements WHERE gross=15;"))
    assert split==dict(gross=15,prize=15,bounty=0,fee=0),split
    replay=json.loads(q(call('addon','another-client-token')))
    assert replay==result and state()==after and bounty_state()==rails,(result,replay)
    check('real funded PKO entry and add-on conserve prize, bounty and fee rails; replay preserves the '+str(bounty)+' bounty head')
