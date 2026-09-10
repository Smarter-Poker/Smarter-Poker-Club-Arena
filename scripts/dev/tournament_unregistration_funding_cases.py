"""Compose actual entry funding with exact pre-start unregistration.

Reuses the private PG17 runner. No database URL or production mutation.
"""
from pathlib import Path
import json

repo = Path(__file__).resolve().parents[2]
event = 'c3000000-0000-4000-8000-000000000001'
club = 'c2000000-0000-4000-8000-000000000001'

def uid(n): return 'c1000000-0000-4000-8000-' + str(n).zfill(12)
def key(n): return 'c9000000-0000-4000-8000-' + str(n).zfill(12)

def verify(q, fresh, overlap, register, check):
    authority = (repo/'supabase/migrations/20260909165629_satellite_settlement_has_one_atomic_authority.sql').read_text()
    cash = (repo/'supabase/migrations/20260909222303_satellite_unregister_returns_its_funded_cash.sql').read_text()
    captured = json.loads((repo/'scripts/dev/fixtures/unregistration-funding/source-manifest.json').read_text())
    hashes = {item['signature']:item['body_md5'] for item in captured['functions']}
    hashes.update({
        'fn_unregister_from_tournament(uuid,uuid)': 'dc6d39f7dd8ec69162d8404d8bc79d7c',
        'fn_leave_seat_and_refund(uuid,uuid)': '82916752c750ea7a088cd810015ad866',
        'fn_settle_tournament_refund_exact(uuid,uuid,uuid,numeric,numeric,numeric,numeric,text,text)': '0024ca5acfc4e4e12b51a4609349e98d',
    })

    def setup(name, gross=200, config=None):
        fresh('unreg_' + name)
        q("ALTER TABLE tournament_unregistration_receipts ADD COLUMN start_authority text NOT NULL DEFAULT 'scheduled_clock'; CREATE TABLE IF NOT EXISTS hand_history(id uuid,tournament_id uuid,table_id uuid); CREATE TABLE IF NOT EXISTS tournament_launch_receipts(tournament_id uuid,completed_at timestamptz,launch_id uuid); INSERT INTO ca_settle_sources(source,note) VALUES('fn_unregister_from_tournament','isolated funded entry/refund rehearsal');")
        q(cash)
        q((repo/"scripts/dev/fixtures/unregistration-funding/installed.sql").read_text())
        # The request overload comes second, so find its unique delimiter first.
        for name, tag in [
            ('fn_unregister_from_tournament','unregister_request_wrapper'),
            ('fn_leave_seat_and_refund','leave_request_wrapper'),
        ]:
            end = authority.index('$' + tag + '$;') + len(tag) + 3
            start = authority.rfind('CREATE OR REPLACE FUNCTION', 0, authority.index('AS $' + tag + '$'))
            q(authority[start:end])
        actual = json.loads(q("SELECT jsonb_object_agg(p.oid::regprocedure::text,md5(p.prosrc)) FROM pg_proc p WHERE p.oid=ANY(ARRAY[" + ','.join("'public." + signature + "'::regprocedure" for signature in hashes) + "]);"))
        assert actual == hashes, (actual, hashes)
        if gross != 200:
            q("UPDATE tournaments SET buy_in_amount=" + str(gross) + ",buy_in_fee=0;")
        if config:
            q(config)
        response = json.loads(q(register(1,1)))
        assert response.get('ok') is True, response
        return response

    def unregister(user=1, request=1):
        return "SET test.actor='%s'; SELECT public.fn_unregister_from_tournament('%s','%s');" % (uid(user),event,key(request))

    def snapshot():
        tables = ['club_members','tournaments','tournament_players','chip_ledger',
                  'wallet_transactions','rake_records','tournament_escrow',
                  'tournament_refund_entitlements','tournament_refund_tranches',
                  'tournament_unregistration_receipts','entry_purchase_idempotency_receipts',
                  'table_seats','tables','chip_transactions','chip_ledger_idem']
        return q('SELECT jsonb_build_object(' + ','.join(
            "'%s',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM %s t)" % (t,t)
            for t in tables) + ');')

    def refunded(gross=200, lifecycles=1):
        actual = json.loads(q("""SELECT jsonb_build_object(
          'wallet',(SELECT chip_balance FROM club_members WHERE user_id='%s' AND club_id='%s'),
          'registered',(SELECT count(*) FROM tournament_players),
          'cached',(SELECT current_players FROM tournaments),
          'prize',(SELECT prize_pool FROM tournaments),
          'bounty',(SELECT bounty_pool FROM tournaments),
          'fee',(SELECT total_rake FROM tournaments),
          'escrow',(SELECT prize_balance+bounty_balance+fee_balance FROM tournament_escrow),
          'refunds',(SELECT count(*) FROM tournament_unregistration_receipts),
          'credits',(SELECT count(*) FROM wallet_transactions WHERE type='credit'),
          'credit_total',COALESCE((SELECT sum(amount) FROM wallet_transactions WHERE type='credit'),0),
          'rake_total',COALESCE((SELECT sum(rake_amount) FROM rake_records),0),
          'tickets',(SELECT count(*) FROM tournament_tickets));""" % (uid(1),club)))
        expected = dict(wallet=500,registered=0,cached=0,prize=0,bounty=0,fee=0,
                        escrow=0,refunds=lifecycles,credits=lifecycles if gross else 0,credit_total=gross*lifecycles,
                        rake_total=0,tickets=0)
        assert actual == expected, (actual,expected)

    setup('round_trip')
    receipt = json.loads(q(unregister()))
    assert receipt.get('refunded_chips') == 200, receipt
    refunded()
    before = snapshot()
    replay = json.loads(q(unregister()))
    assert replay.get('replayed') is True and {k:v for k,v in replay.items() if k!='replayed'} == {k:v for k,v in receipt.items() if k!='replayed'}
    assert snapshot() == before
    check('real entry and public refund close original wallet escrow fees and roster once')

    setup('other_wallet')
    other = 'c2000000-0000-4000-8000-000000000002'
    q("INSERT INTO clubs(id) VALUES ('%s'); INSERT INTO club_members(club_id,user_id,chip_balance,status,role,joined_at) VALUES ('%s','%s',900,'active','player','2000-01-01');" % (other,other,uid(1)))
    q(unregister())
    refunded()
    assert q("SELECT chip_balance FROM club_members WHERE club_id='%s';" % other) == '900.00'
    assert q("SELECT bool_and(refund_wallet_club_id='%s') FROM tournament_refund_entitlements;" % club) == 't'
    check('refund preserves charged club wallet after another older membership appears')

    setup('price_change')
    q("UPDATE tournaments SET buy_in_amount=450,buy_in_fee=50;")
    receipt = json.loads(q(unregister()))
    assert receipt.get('refunded_chips') == 200, receipt
    refunded()
    check('refund returns immutable original charge when displayed entry price changes')

    setup('late_receipt_failure')
    q("CREATE FUNCTION probe_unreg_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected unregistration receipt failure'; END $$; CREATE TRIGGER probe_unreg_receipt_failure BEFORE INSERT ON tournament_unregistration_receipts FOR EACH ROW EXECUTE FUNCTION probe_unreg_receipt_failure();")
    before = snapshot()
    q(unregister(), 'injected unregistration receipt failure')
    assert snapshot() == before
    check('late unregistration receipt failure rolls back every funded relation')

    for name,second_key in [('same_request',1),('different_request',2)]:
        setup(name)
        a,b=overlap(unregister(),unregister(request=second_key))
        assert a.get('ok') is True,a
        if second_key == 1:
            assert b.get('replayed') is True,b
        else:
            assert b.get('reason') == 'not_registered',b
        refunded()
        check('overlapping '+name+' unregistrations pay one original entry')

    setup('start_wins')
    a,b = overlap("UPDATE tournaments SET status='RUNNING',started_at=now() WHERE id='%s';" % event,
                  unregister(),closing=True)
    assert b.get('reason') == 'registration_closed',b
    assert q("SELECT chip_balance FROM club_members WHERE user_id='%s';" % uid(1)) == '300.00'
    assert q("SELECT count(*) FROM tournament_unregistration_receipts;") == '0'
    check('unregistration waiting behind committed start preserves funded entry')

    setup('deadline')
    q("UPDATE tournaments SET start_time=now()-interval '1 second';")
    before = snapshot()
    response = json.loads(q(unregister()))
    assert response.get('reason') == 'tournament_started',response
    assert snapshot() == before
    check('scheduled start cutoff refuses voluntary refund without financial writes')

    setup('replay_after_start')
    receipt = json.loads(q(unregister()))
    q("UPDATE tournaments SET start_time=now()-interval '1 second',status='RUNNING',started_at=now();")
    before = snapshot()
    replay = json.loads(q(unregister()))
    assert replay.get('replayed') is True and replay.get('refunded_chips') == 200,replay
    assert snapshot() == before
    check('lost prestart refund response remains an exact read after start')

    setup('free_entry',0)
    receipt = json.loads(q(unregister()))
    assert receipt.get('refunded_chips') == 0,receipt
    refunded(0)
    check('free entry unregisters with zero spendable credit and a durable receipt')

    setup('new_lifecycle')
    first = json.loads(q(unregister()))
    again = json.loads(q(register(1,2)))
    assert again.get('ok') is True and again.get('registration_id') != first.get('registration_id'), again
    before = snapshot()
    q(unregister(), 'prior registration lifecycle')
    assert snapshot() == before
    second = json.loads(q(unregister(request=2)))
    assert second.get('registration_id') == again.get('registration_id'), second
    refunded(lifecycles=2)
    check('old refund identity cannot unregister a later paid registration')

    setup('late_cutoff_rollback')
    q("CREATE FUNCTION probe_refund_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.25); RETURN NEW; END $$; CREATE TRIGGER probe_refund_delay BEFORE INSERT ON wallet_transactions FOR EACH ROW WHEN (NEW.type='credit') EXECUTE FUNCTION probe_refund_delay(); UPDATE tournaments SET start_time=clock_timestamp()+interval '1 second';")
    before = snapshot()
    q(unregister(), 'tournament started before unregistration could commit')
    assert snapshot() == before
    check('cutoff reached during refund reverses the whole uncommitted transaction')

    for price in [1,5,10,25,40]:
        fee=price/10
        setup('price_'+str(price),config="UPDATE tournaments SET buy_in_amount=%s,buy_in_fee=%s;" % (price-fee,fee))
        assert json.loads(q("SELECT jsonb_build_object('gross',gross_in,'prize',prize_balance,'fee',fee_balance) FROM tournament_escrow;")) == dict(gross=price,prize=price-fee,fee=fee)
        receipt=json.loads(q(unregister()))
        assert receipt.get('refunded_chips') == price,receipt
        refunded(price)
    check('configured 1 5 10 25 and 40 entries fund disclosed components and refund exact cents')

    for bounty_flag in ['is_bounty','is_pko','is_mystery_bounty']:
        setup(bounty_flag,config="UPDATE tournaments SET %s=true,bounty_amount=50;" % bounty_flag)
        assert json.loads(q("SELECT jsonb_build_object('gross',gross_in,'prize',prize_balance,'bounty',bounty_balance,'fee',fee_balance) FROM tournament_escrow;")) == dict(gross=200,prize=130,bounty=50,fee=20)
        receipt=json.loads(q(unregister()))
        assert receipt.get('refunded_chips') == 200,receipt
        refunded()
    check('bounty PKO and mystery entry components return through the common funded refund')
