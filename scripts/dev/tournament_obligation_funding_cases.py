"""Actual cumulative-obligation money cases for the shared local PG17 runner."""
from pathlib import Path
import json
import sys
import re

fixture = Path(__file__).resolve().parent / 'fixtures/tournament-obligation-funding'
event = 'c3000000-0000-4000-8000-000000000001'
club = 'c2000000-0000-4000-8000-000000000001'

def uid(n):
    return 'c1000000-0000-4000-8000-' + str(n).zfill(12)

def verify(q, fresh, overlap, call, check):
    manifest = json.loads((fixture / 'source-manifest.json').read_text())
    def settle(user, place, amount, kind='place'):
        return "SELECT public.fn_settle_tournament_obligation('%s','%s',%s,'%s',%s,'engine.audit');" % (event,kind,place,uid(user),amount)

    def setup(name):
        fresh('obligation_' + name)
        q((fixture / 'installed.sql').read_text())
        for row in manifest['functions']:
            actual = q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.%s'::regprocedure;" % row['signature'])
            assert actual == row['body_md5'], (row['signature'],actual,row['body_md5'])
        from tournament_guard_fixture_roles import align
        align(q,'fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)',service=False,search_path='public')
        if '--obligation-baseline' not in sys.argv:
            patch = fixture.parents[3] / manifest['candidate_migration']
            q(patch.read_text())
            actual=q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_settle_tournament_obligation_before_atomic_batch_gate(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure;")
            assert actual==manifest['candidate_body_md5'],actual
        for n in [1,2]:
            response=json.loads(q(call(n,n)))
            assert response.get('ok') is True,response
        q("UPDATE tournaments SET status='RUNNING',started_at=now(),late_reg_levels=10,rebuy_levels=10,current_level=0 WHERE id='%s';" % event)

    def state():
        return json.loads(q("""SELECT jsonb_build_object(
          'wallets',(SELECT sum(chip_balance) FROM club_members),
          'pool',(SELECT prize_pool FROM tournaments),
          'prize',(SELECT prize_balance FROM tournament_escrow),
          'fee',(SELECT fee_balance FROM tournament_escrow),
          'payouts',(SELECT count(*) FROM tournament_payouts),
          'paid',COALESCE((SELECT sum(amount) FROM tournament_payouts),0),
          'owed',COALESCE((SELECT sum(amount_owed) FROM tournament_obligations),0),
          'ob_paid',COALESCE((SELECT sum(amount_paid) FROM tournament_obligations),0),
          'obligations',(SELECT count(*) FROM tournament_obligations),
          'credits',(SELECT count(*) FROM wallet_credit_idempotency),
          'receipts',(SELECT count(*) FROM wallet_transactions WHERE type='credit'),
          'journal',(SELECT count(*) FROM chip_ledger)
        );"""))

    def fingerprint():
        names=['club_members','tournaments','tournament_players','tournament_escrow',
               'tournament_obligations','tournament_payouts','wallet_credit_idempotency',
               'wallet_transactions','chip_ledger','chip_ledger_idem','financial_alerts']
        return q("SELECT jsonb_build_object(" + ','.join(
            "'%s',(SELECT md5(COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,'[]')) FROM %s r)" % (n,n)
            for n in names) + ");")

    setup('existing_refused_debt')
    assert json.loads(q(settle(1,1,100)))['paid']==100
    # Reproduce a preexisting unpaid debt through the actual older owner.
    # This is an explicit synthetic historical shape, never a production repair.
    legacy_source=(fixture / 'installed.sql').read_text()
    legacy_defs=re.findall(
        r'CREATE OR REPLACE FUNCTION public[.]fn_settle_tournament_obligation_before_atomic_batch_gate\b.*?AS (\$[A-Za-z_0-9]*\$).*?\1;',
        legacy_source,re.S)
    legacy_match=re.search(
        r'CREATE OR REPLACE FUNCTION public[.]fn_settle_tournament_obligation_before_atomic_batch_gate\b.*?AS (\$[A-Za-z_0-9]*\$).*?\1;',
        legacy_source,re.S)
    assert len(legacy_defs)==1 and legacy_match, 'one captured legacy obligation owner required'
    q(legacy_match.group(0))
    prior=json.loads(q(settle(1,2,10)))
    assert prior.get('refused_reason')=='player_already_holds_a_place',prior
    assert q("SELECT amount_owed FROM tournament_obligations WHERE place=2;")=='10.00'
    if '--obligation-baseline' not in sys.argv:
        q((fixture.parents[3] / manifest['candidate_migration']).read_text())
    # Baseline deliberately retains the old owner and must fail the debt invariant.
    before=state()
    debt_before=q("SELECT to_jsonb(o)::text FROM tournament_obligations o WHERE place=2;")
    refused=json.loads(q(settle(1,2,50)))
    assert refused.get('refused_reason')=='player_already_holds_a_place',refused
    print('EXISTING_REFUSAL_STATE '+json.dumps(state()),flush=True)
    assert state()==before, 'a refused existing second place increased debt or moved money'
    assert q("SELECT to_jsonb(o)::text FROM tournament_obligations o WHERE place=2;")==debt_before, 'refusal rewrote the existing debt'
    zero=json.loads(q(settle(1,2,0)))
    assert zero['paid']==0 and zero['remaining']==10 and zero['fully_settled'] is False,zero
    assert state()==before, 'no-payment replay changed old unpaid debt'
    check('a refused existing second place preserves its unpaid debt and no-payment replay')
    if '--obligation-existing-refusal-only' in sys.argv:
        return

    setup('cumulative')
    first=json.loads(q(settle(1,1,50)))
    last=json.loads(q(settle(1,1,180,'late_reg_adjustment')))
    assert first['paid']==50 and last['paid']==130,(first,last)
    before=fingerprint()
    replay=json.loads(q(settle(1,1,50)))
    assert replay['paid']==0 and replay['amount_paid']==180,replay
    assert fingerprint()==before,'older replay wrote money or debt'
    second=json.loads(q(settle(2,2,180)))
    assert second['paid']==180 and second['fully_settled'] is True,second
    observed=state()
    assert observed==dict(wallets=1960,pool=360,prize=0,fee=40,payouts=3,paid=360,
                         owed=360,ob_paid=360,obligations=2,credits=3,receipts=3,journal=5),observed
    check('early award and final adjustment move only cumulative deltas and exhaust only prize escrow')

    setup('replay')
    a,b=overlap(settle(1,1,180),settle(1,1,180))
    assert a['paid']==180 and b['paid']==0,(a,b)
    observed=state()
    assert observed['paid']==180 and observed['payouts']==1 and observed['credits']==1,observed
    check('overlapping identical obligations credit once under the real database lock')

    setup('increase')
    a,b=overlap(settle(1,1,100),settle(1,1,180,'late_reg_adjustment'))
    assert a['paid']==100 and b['paid']==80,(a,b)
    observed=state()
    assert observed['paid']==180 and observed['owed']==180 and observed['payouts']==2,observed
    check('overlapping early and final totals produce only the unpaid increment')

    setup('owner')
    assert json.loads(q(settle(1,1,100)))['paid']==100
    before=fingerprint()
    refused=json.loads(q(settle(2,1,180)))
    assert refused.get('refused_reason')=='place_paid_to_another_user',refused
    assert fingerprint()==before,'paid-place ownership refusal changed money or debt'
    check('another user cannot take an already paid place or raise its debt')

    setup('rollback')
    q("CREATE FUNCTION fail_payout_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected payout receipt failure'; END $$; CREATE TRIGGER fail_payout_receipt BEFORE INSERT ON tournament_payouts FOR EACH ROW EXECUTE FUNCTION fail_payout_receipt();")
    before=fingerprint()
    q(settle(1,1,180),'injected payout receipt failure')
    assert fingerprint()==before,'late receipt failure left a wallet, journal, key, bank or debt write'
    check('late payout evidence failure rolls back the real wallet and escrow writers')

    setup('short')
    short=json.loads(q(settle(1,1,400)))
    assert short['paid']==360 and short['amount_owed']==400 and short['remaining']==40 and short['fully_settled'] is False,short
    before=fingerprint()
    stale=json.loads(q(settle(1,1,360)))
    assert stale['paid']==0 and stale['remaining']==40 and stale['fully_settled'] is False,stale
    assert fingerprint()==before,'short-bank stale replay changed or hid debt'
    observed=state()
    assert observed['prize']==0 and observed['fee']==40 and observed['owed']==400 and observed['ob_paid']==360,observed
    check('a short prize bank pays what it holds and preserves debt and the fee bank')

    setup('history')
    assert json.loads(q(settle(1,1,180)))['paid']==180
    before=fingerprint()
    q("UPDATE tournament_payouts SET amount=179;",'append-only payout record')
    q("DELETE FROM tournament_payouts;",'append-only payout record')
    assert fingerprint()==before,'normal history mutation changed payment evidence'
    check('paid history cannot be rewritten or deleted through normal table operations')

    setup('second_place')
    assert json.loads(q(settle(1,1,100)))['paid']==100
    refused=json.loads(q(settle(1,2,50)))
    assert refused.get('refused_reason')=='player_already_holds_a_place',refused
    observed=state()
    print('SECOND_PLACE_REFUSAL_STATE '+json.dumps(observed),flush=True)
    assert observed['obligations']==1 and observed['owed']==100,(
        'refused second place created a new finishing debt',observed)
    before=fingerprint()
    again=json.loads(q(settle(1,2,50)))
    assert again.get('refused_reason')=='player_already_holds_a_place',again
    assert fingerprint()==before,'repeated refusal created new evidence'
    correct=json.loads(q(settle(2,2,50)))
    assert correct['paid']==50,correct
    owner=q("SELECT user_id FROM tournament_obligations WHERE place=2;")
    assert owner==uid(2),('refused request reserved the correct recipient place',owner)
    check('a refused second place creates no debt and leaves the place available to its recipient')

    setup('zero_second_place')
    assert json.loads(q(settle(1,1,100)))['paid']==100
    before=state()
    refused=json.loads(q(settle(1,2,0)))
    assert refused.get('refused_reason')=='player_already_holds_a_place',refused
    assert state()==before,'zero second-place request created a reservation or changed money'
    assert q("SELECT count(*) FROM tournament_obligations WHERE place=2;")=='0'
    correct=json.loads(q(settle(2,2,50)))
    assert correct['paid']==50,correct
    recorded=json.loads(q("SELECT jsonb_build_object('obligation_user',o.user_id,'payout_user',p.user_id,'owed',o.amount_owed,'paid',o.amount_paid) FROM tournament_obligations o JOIN tournament_payouts p ON p.tournament_id=o.tournament_id AND p.position=o.place WHERE o.place=2;"))
    assert recorded==dict(obligation_user=uid(2),payout_user=uid(2),owed=50,paid=50),recorded
    check('a zero second-place request reserves no obligation and the correct recipient owns the later payment')

    setup('legacy_replay')
    assert json.loads(q(settle(1,1,100)))['paid']==100
    # Model an already-paid legacy place through the real low-level credit
    # writer. This deliberately historical-shaped input is local and synthetic.
    legacy_key='tourney:'+event+':prize:place:2'
    q("SELECT fn_credit_and_log('%s',50,'%s','prize','Synthetic existing legacy receipt','%s','PLAYER',NULL,NULL,2,'structure');" % (uid(1),legacy_key,event))
    before=state()
    replay=json.loads(q(settle(1,2,50)))
    assert replay['paid']==0 and replay['already_paid']==50 and replay['fully_settled'] is True,replay
    after=state()
    expected=dict(before,owed=150,ob_paid=150,obligations=2)
    assert after==expected,(before,after,expected)
    check('an existing legacy payment is still seeded and replayed without another credit')
