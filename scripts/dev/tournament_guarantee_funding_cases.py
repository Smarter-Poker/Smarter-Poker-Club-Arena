"""Current guarantee authority through real bank, entry ledger and escrow writes."""
from pathlib import Path
import json

EVENT = 'c3000000-0000-4000-8000-000000000001'
OTHER = 'c3000000-0000-4000-8000-000000000002'
CLUB = 'c2000000-0000-4000-8000-000000000001'
UNION = 'c4000000-0000-4000-8000-000000000001'
MOVED = 'c4000000-0000-4000-8000-000000000002'
FIXTURE = Path(__file__).parent/'fixtures/tournament-guarantee-funding'
RELATIONS = ['clubs','union_wallets','union_wallet_transactions','tournaments',
             'tournament_guarantee_overlays','tournament_escrow','chip_ledger',
             'chip_ledger_idem','financial_alerts','tournament_players',
             'tournament_refund_entitlements','wallet_transactions',
             'entry_purchase_idempotency_receipts','club_members']

def verify(q, fresh, overlap, entry, check):
    manifest = json.loads((FIXTURE/'source-manifest.json').read_text())
    expected = {x['signature']:x['body_md5'] for x in manifest['functions']}

    def call(event=EVENT):
        return "SELECT public.fn_apply_prize_guarantee('%s','isolated Phase 3 guarantee');" % event

    def fingerprint():
        return {name:q("SELECT md5(COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb)::text) FROM public."+name+" x;") for name in RELATIONS}

    def setup(name, union=False, private=False, bank=1000, missing_union=False, moved=False):
        fresh('guarantee_'+name)
        q((FIXTURE/'installed.sql').read_text())
        actual=json.loads(q("SELECT jsonb_object_agg(oid::regprocedure::text,md5(prosrc)) FROM pg_proc WHERE oid IN ("+','.join("'"+s+"'::regprocedure" for s in expected)+");"))
        assert actual==expected,(actual,expected)
        q("UPDATE clubs SET name='Fixture Host',chip_treasury=%s WHERE id='%s';" % (bank,CLUB))
        if union:
            q("INSERT INTO unions(id,name) VALUES ('%s','Original Union'),('%s','Later Union'); UPDATE tournaments SET union_id='%s',is_private=%s WHERE id='%s'; UPDATE clubs SET union_id='%s' WHERE id='%s';" % (UNION,MOVED,UNION,str(private).lower(),EVENT,MOVED if moved else UNION,CLUB))
            if not missing_union:
                q("INSERT INTO union_wallets(union_id,chip_balance) VALUES ('%s',%s);" % (UNION,bank))
        assert json.loads(q(entry(1,1))).get('ok') is True
        q("UPDATE tournaments SET guaranteed_prize=300 WHERE id='%s';" % EVENT)
        q((FIXTURE/'triggers.sql').read_text())

    def state(event=EVENT):
        return json.loads(q("""SELECT jsonb_build_object(
          'club',(SELECT chip_treasury FROM clubs WHERE id='%s'),
          'union',(SELECT chip_balance FROM union_wallets WHERE union_id='%s'),
          'pool',(SELECT prize_pool FROM tournaments WHERE id='%s'),
          'finalized',(SELECT prize_pool_finalized FROM tournaments WHERE id='%s'),
          'escrow',(SELECT prize_balance FROM tournament_escrow WHERE tournament_id='%s'),
          'fee',(SELECT fee_balance FROM tournament_escrow WHERE tournament_id='%s'),
          'overlay',(SELECT amount FROM tournament_guarantee_overlays WHERE tournament_id='%s'),
          'bank_type',(SELECT bank_type FROM tournament_guarantee_overlays WHERE tournament_id='%s'),
          'bank_id',(SELECT bank_entity_id FROM tournament_guarantee_overlays WHERE tournament_id='%s'),
          'explicit',(SELECT count(*) FROM chip_ledger WHERE tournament_id='%s' AND category='overlay' AND idempotency_key IS NOT NULL),
          'shadow',(SELECT count(*) FROM chip_ledger WHERE tournament_id='%s' AND category='overlay' AND description LIKE 'auto-ledgered%%'),
          'overlay_sum',(SELECT COALESCE(sum(overlay_in),0) FROM tournament_escrow WHERE tournament_id='%s')
        );""" % (CLUB,UNION,event,event,event,event,event,event,event,event,event,event)))

    def funded(union=False, bank=1000, event=EVENT):
        s=state(event)
        assert s['pool']==300 and s['escrow']==300 and s['fee']==20 and s['finalized'] is True,s
        assert s['overlay']==120 and s['explicit']==1 and s['shadow']==1 and s['overlay_sum']==120,s
        assert s['bank_type']==('union' if union else 'club'),s
        assert s['bank_id']==(UNION if union else CLUB),s
        assert s['union']==bank-120 if union else s['club']==bank-120,s
        if union: assert s['club']==bank,s
        return s

    for name, options, union_pays in [
        ('club',{},False),
        ('union',{'union':True},True),
        ('private',{'union':True,'private':True},False),
        ('scope',{'union':True,'moved':True},True),
        ('fallback',{'union':True,'missing_union':True},False),
    ]:
        setup(name,**options)
        response=json.loads(q(call()))
        assert response.get('ok') is True and response.get('overlay_journaled') is True,response
        funded(union_pays)
        before=fingerprint()
        replay=json.loads(q(call()))
        assert replay.get('ok') is True and replay.get('already_finalized') is True,replay
        assert fingerprint()==before
        check('guarantee '+name+' funds exactly one bank debit and escrow credit; replay writes nothing')

    setup('insufficient',bank=119)
    before=fingerprint()
    response=json.loads(q(call()))
    assert response.get('ok') is False and response.get('reason')=='atomic_guarantee_funding_aborted',response
    assert fingerprint()==before
    check('an insufficient guarantee bank leaves every financial and finalization row unchanged')

    setup('late_failure')
    q("""CREATE FUNCTION probe_guarantee_journal_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected final guarantee journal failure'; END $$;
      CREATE TRIGGER probe_guarantee_journal_failure BEFORE INSERT ON chip_ledger
      FOR EACH ROW WHEN (NEW.category='overlay' AND NEW.idempotency_key IS NOT NULL)
      EXECUTE FUNCTION probe_guarantee_journal_failure();""")
    before=fingerprint()
    response=json.loads(q(call()))
    assert response.get('ok') is False and 'injected final guarantee journal failure' in response.get('detail',''),response
    assert fingerprint()==before
    check('late explicit journal failure rolls back bank debit, autojournal, overlay claim and pool finalization')

    setup('overlap')
    a,b=overlap(call(),call())
    assert a.get('ok') is True and b.get('ok') is True,(a,b)
    assert b.get('already_finalized') is True,b
    funded()
    check('overlapping guarantee requests serialize on the real authority and fund once')

    setup('two_events',bank=200)
    q("INSERT INTO tournaments(id,club_id,name,buy_in_amount,buy_in_fee,start_time,max_players,status,current_players,prize_pool,bounty_pool,total_rake,variant,guaranteed_prize) VALUES ('%s','%s','Other Guarantee',180,20,now()+interval '1 day',100,'REGISTERING',0,0,0,0,'mtt',300);" % (OTHER,CLUB))
    q("SET test.actor='c1000000-0000-4000-8000-000000000002'; SELECT fn_register_for_tournament_request('%s','c8000000-0000-4000-8000-000000000002');" % OTHER)
    a,b=overlap(call(),call(OTHER))
    assert a.get('ok') is True and b.get('ok') is False,(a,b)
    funded(bank=200)
    s=state(OTHER)
    assert s['pool']==180 and s['escrow']==180 and s['finalized'] is False and s['overlay'] is None,s
    check('two events cannot spend the same remaining guarantee bank balance')
