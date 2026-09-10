"""Exercise the installed cancellation body up to its first financial write."""
from pathlib import Path
import json
import sys

EVENT='c3000000-0000-4000-8000-000000000001'
CLUB='c2000000-0000-4000-8000-000000000001'
USER='c1000000-0000-4000-8000-000000000001'
TABLE='c5000000-0000-4000-8000-000000000001'
ROOT=Path(__file__).resolve().parents[2]
FIXTURE=Path(__file__).parent/'fixtures/tournament-cancellation-policy'

def verify(q,fresh,overlap,entry,check):
    manifest=json.loads((FIXTURE/'source-manifest.json').read_text())
    baseline='--baseline' in sys.argv
    lock_only='--cancellation-lock-composition-only' in sys.argv
    migrations=list((ROOT/'supabase/migrations').glob('*_started_tournaments_resume_or_settle_instead_of_cancelling.sql'))
    assert len(migrations)==1

    def setup(name):
        fresh('cancel_policy_'+name)
        q((FIXTURE/'installed.sql').read_text())
        helper=manifest['lock_helper']
        assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='%s'::regprocedure;"%helper['signature'])==helper['body_md5']
        expected=manifest['baseline_body_md5']
        if not baseline:
            q(migrations[0].read_text())
            if name=='started' or lock_only: q(migrations[0].read_text())
            expected=manifest['corrected_body_md5']
        assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='atomic_cancel_tournament(uuid,uuid)'::regprocedure;")==expected

    def call():
        return "SELECT public.probe_cancel_result('%s');" % EVENT

    def fingerprint():
        return q("""SELECT md5(jsonb_build_object(
          'tournaments',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM tournaments t),
          'escrow',(SELECT jsonb_agg(to_jsonb(t) ORDER BY tournament_id) FROM tournament_escrow t),
          'wallets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM club_members t),
          'ledger',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM chip_ledger t),
          'awards',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM tournament_obligations t),
          'draws',(SELECT jsonb_agg(to_jsonb(t) ORDER BY tournament_id) FROM spin_draw_receipts t),
          'reserve',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM spin_reserve_ledger t),
          'receipts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY tournament_id) FROM tournament_cancellation_receipts t)
        )::text);""")

    refused=[
      ('started',"UPDATE tournaments SET started_at=now() WHERE id='%s';"%EVENT),
      ('running',"UPDATE tournaments SET status='RUNNING' WHERE id='%s';"%EVENT),
      ('launch',"INSERT INTO tournament_launch_receipts(tournament_id,launch_id,lease_generation,completed_at) VALUES ('%s',gen_random_uuid(),gen_random_uuid(),now());"%EVENT),
      ('multiplier',"UPDATE tournaments SET variant='spin',buy_in_fee=0,spin_multiplier=100 WHERE id='%s';"%EVENT),
      ('draw',"INSERT INTO spin_draw_receipts(tournament_id) VALUES ('%s');"%EVENT),
      ('reserve',"INSERT INTO spin_reserve_ledger(club_id,tournament_id,kind,amount,balance_after,multiplier,buy_in,seats,house_rake) VALUES ('%s','%s','jackpot_draw',-500,1000,100,5,3,1.5);"%(CLUB,EVENT)),
      ('hand',"INSERT INTO hand_history(tournament_id) VALUES ('%s');"%EVENT),
      ('legacy_hand',"INSERT INTO tables(id,club_id,name,tournament_id,game_type,max_players,status) VALUES ('%s','%s','Fixture Table','%s','tournament',9,'waiting'); INSERT INTO hand_history(table_id) VALUES ('%s');"%(TABLE,CLUB,EVENT,TABLE)),
      ('paid_award',"INSERT INTO tournament_obligations(tournament_id,user_id,kind,place,amount_owed,amount_paid) VALUES ('%s','%s','place',1,1,1);"%(EVENT,USER)),
    ]
    if '--cancellation-policy-from' in sys.argv:
        name=sys.argv[sys.argv.index('--cancellation-policy-from')+1]
        refused=refused[[case[0] for case in refused].index(name):]
    for name,state in ([] if lock_only else refused):
        setup(name)
        q(state)
        before=fingerprint()
        result=json.loads(q(call()))
        assert result.get('sqlstate')=='55000' and 'resume or settle' in result.get('message',''),(name,result)
        assert fingerprint()==before,name
        check('cancellation refuses '+name+' evidence before its first financial write')

    for name in ([] if lock_only else ['unstarted','default_zero','past_schedule']):
        setup(name)
        if name in ['default_zero','past_schedule']:
            q("UPDATE tournaments SET variant='spin',buy_in_fee=0 WHERE id='%s';"%EVENT)
            assert q("SELECT spin_multiplier FROM tournaments WHERE id='%s';"%EVENT)=='0'
        if name=='past_schedule':
            q("UPDATE tournaments SET start_time=now()-interval '1 day' WHERE id='%s';"%EVENT)
        before=fingerprint()
        result=json.loads(q(call()))
        assert result.get('sqlstate')=='PX001',result
        assert fingerprint()==before
        check('cancellation '+name+' remains routed to the existing financial authority')

    if not lock_only:
        setup('replay')
        receipt=dict(ok=True,receipt_version=2,tournament_id=EVENT,status='CANCELLED')
        q("UPDATE tournaments SET status='CANCELLED',started_at=now() WHERE id='%s'; INSERT INTO tournament_cancellation_receipts(tournament_id,receipt) VALUES ('%s','%s'::jsonb);"%(EVENT,EVENT,json.dumps(receipt)))
        before=fingerprint()
        result=json.loads(q(call()))
        assert result.get('response')==receipt,result
        assert fingerprint()==before
        check('stored cancellation replay reaches its existing receipt reader before the new refusal')

    setup('draw_overlap')
    first="INSERT INTO spin_draw_receipts(tournament_id) VALUES ('%s'); UPDATE tournaments SET spin_multiplier=100 WHERE id='%s'; SELECT '{}'::jsonb;"%(EVENT,EVENT)
    a,b=overlap(first,call())
    assert b.get('sqlstate')=='55000',b
    assert q("SELECT count(*) FROM spin_draw_receipts;")=='1'
    assert q("SELECT count(*) FROM tournament_escrow;")=='0'
    check('cancellation waiting behind a committed draw refuses without releasing the draw')
