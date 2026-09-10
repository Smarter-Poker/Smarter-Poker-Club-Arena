"""Installed elimination/rank persistence over the shared local PG17 fixture."""
from pathlib import Path
import json
import sys

HERE=Path(__file__).resolve().parent
EVENT='c3000000-0000-4000-8000-000000000001'
CLUB='c2000000-0000-4000-8000-000000000001'
TABLE='d2000000-0000-4000-8000-000000000001'
HAND='d4000000-0000-4000-8000-000000000001'
INTERNAL_HAND='d4000000-0000-4000-8000-000000000002'
HAND_NUMBER=1000001

def uid(n):
    return 'c1000000-0000-4000-8000-'+str(n).zfill(12)

def seat(n):
    return 'd3000000-0000-4000-8000-'+str(n).zfill(12)

def verify(q,fresh,overlap,register,check):
    source=HERE/'fixtures/tournament-elimination-rank'
    purchase=HERE/'fixtures/tournament-purchase-funding'
    manifest=json.loads((source/'source-manifest.json').read_text())

    def eliminate(n,position):
        return "SELECT fn_eliminate_tournament_player_atomic('%s','%s',%s,0,0);" % (EVENT,uid(n),'NULL' if position is None else position)

    def setup(name,mutation=''):
        fresh('elimination_'+name)
        for n in [1,2,3]:
            assert json.loads(q(register(n,n))).get('ok') is True
        q((purchase/'installed.sql').read_text())
        q((source/'installed.sql').read_text())
        for row in manifest['functions']:
            observed=q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.%s'::regprocedure;" % row['signature'])
            assert observed==row['body_md5'],(row,observed)
        if manifest.get('candidate_migration') and '--elimination-baseline' not in sys.argv:
            q((HERE.parents[1]/manifest['candidate_migration']).read_text())
            observed=q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure;")
            assert observed==manifest['candidate_body_md5'],observed
            if '--elimination-null-rank-only' in sys.argv:
                q((HERE.parents[1]/manifest['candidate_migration']).read_text())
                assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_eliminate_tournament_player_atomic(uuid,uuid,integer,numeric,numeric)'::regprocedure;")==observed
        q("""
          UPDATE tournaments SET status='RUNNING',started_at=clock_timestamp()-interval '1 minute',
            starting_chips=1000,current_players=3,is_rebuy=false,is_reentry=false
            WHERE id='%s';
          INSERT INTO tables(id,club_id,tournament_id,name,game_type,status,current_players,
            seat_game_scope,seat_admission_key)
          VALUES('%s','%s','%s','Isolated Rank Table','tournament','running',3,
            'table:%s','tournament:%s');
        """ % (EVENT,TABLE,CLUB,EVENT,TABLE,EVENT))
        for n in [1,2,3]:
            stack=1000 if n==3 else 0
            q("""
              UPDATE tournament_players SET status='playing',chips=%s,table_id='%s',seat_number=%s
                WHERE tournament_id='%s' AND user_id='%s';
              INSERT INTO table_seats(id,table_id,seat_number,user_id,club_id,stack,joined_at,
                active_game_scope,active_parent_key)
              VALUES('%s','%s',%s,'%s','%s',%s,'2026-09-01T00:00:00Z',
                'table:%s','tournament:%s');
            """ % (stack,TABLE,n,EVENT,uid(n),seat(n),TABLE,n,uid(n),CLUB,stack,TABLE,EVENT))
        # Exact accepted-hand identities are synthetic inputs. The actual
        # elimination RPC, candidate resolver, seat and sequence writers run.
        written=json.dumps({uid(1):0,uid(2):0,uid(3):1000})
        result=json.dumps(dict(hand_id=INTERNAL_HAND,table_id=TABLE,hand_number=HAND_NUMBER,written=json.loads(written)))
        q("""
          INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)
          VALUES('%s',%s,'%s',repeat('a',64),'%s'::jsonb);
          INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,completed_at,result)
          VALUES('%s','%s','succeeded',clock_timestamp(),'%s'::jsonb);
        """ % (TABLE,HAND_NUMBER,HAND,result,TABLE,INTERNAL_HAND,result))
        for n in [1,2]:
            q("""
              INSERT INTO tournament_knockout_candidates(id,tournament_id,eliminated_user_id,
                table_id,seat_id,seat_joined_at,hand_id,hand_number,stack_before,stack_after,state,rebuy_prompt_until)
              SELECT 'd5000000-0000-4000-8000-%s','%s','%s','%s','%s',joined_at,
                '%s',%s,%s,0,'pending',clock_timestamp()-interval '1 second'
                FROM table_seats WHERE id='%s';
            """ % (str(n).zfill(12),EVENT,uid(n),TABLE,seat(n),HAND,HAND_NUMBER,n*100,seat(n)))
        if mutation:
            q(mutation)
        q((purchase/'triggers.sql').read_text())

    def fingerprint(money_only=False):
        names=['club_members','chip_ledger','chip_ledger_idem','wallet_transactions',
          'tournament_escrow','tournament_refund_entitlements','rake_records',
          'wallet_credit_idempotency','entry_purchase_idempotency_receipts']
        if not money_only:
            names+=['tournament_players','table_seats','tournaments','tables',
                    'tournament_knockout_candidates','hand_atomic_commits','settlement_idempotency_keys']
        return q("SELECT md5(jsonb_build_array("+','.join(
            "(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM "+n+" r)"
            for n in names)+")::text);")

    def ranked():
        return json.loads(q("""
          SELECT jsonb_agg(jsonb_build_object('user',tp.user_id,'position',tp.position,
            'status',tp.status,'sequence',tp.elimination_sequence,'closed',s.left_at IS NOT NULL,
            'candidate_state',c.state) ORDER BY tp.user_id)
          FROM tournament_players tp JOIN table_seats s ON s.user_id=tp.user_id
          JOIN tournament_knockout_candidates c ON c.eliminated_user_id=tp.user_id;
        """))

    if '--elimination-null-rank-only' not in sys.argv:
        setup('same_hand')
        money=fingerprint(True)
        first=json.loads(q(eliminate(1,3)))
        second=json.loads(q(eliminate(2,2)))
        assert first.get('claimed') is True and second.get('claimed') is True,(first,second)
        rows=ranked()
        assert [r['position'] for r in rows]==[3,2],rows
        assert all(r['status']=='eliminated' and r['closed'] and r['candidate_state']=='eliminated' for r in rows),rows
        assert 0<rows[0]['sequence']<rows[1]['sequence'],rows
        assert fingerprint(True)==money,'rank persistence moved spendable money'
        before=fingerprint()
        assert json.loads(q(eliminate(1,3))).get('already') is True
        assert json.loads(q(eliminate(2,2))).get('already') is True
        assert fingerprint()==before,'exact rank replay changed durable evidence'
        check('accepted same-hand candidates persist supplied distinct ranks and monotonic sequences once without money movement')

        setup('overlap')
        first,second=overlap(eliminate(1,3),eliminate(1,3))
        assert first.get('claimed') is True and second.get('already') is True,(first,second)
        rows=ranked()
        assert rows[0]['position']==3 and rows[0]['sequence']>0 and rows[1]['sequence'] is None,rows
        check('overlapping exact elimination requests persist one rank and one sequence')

        setup('replay_conflict')
        assert json.loads(q(eliminate(1,3))).get('claimed') is True
        before=fingerprint()
        refused=json.loads(q(eliminate(1,2)))
        assert refused.get('reason')=='elimination_identity_conflict',refused
        assert fingerprint()==before,'different rank replay rewrote elimination evidence'
        check('a replay cannot change an already persisted finishing rank')

        refusals=[
            ('missing_candidate',"DELETE FROM tournament_knockout_candidates;",'knockout_candidate_required',False),
            ('wrong_atomic_table',"UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{table_id}','\"d2000000-0000-4000-8000-000000000009\"');",'atomic_knockout_candidate_identity_conflict',False),
            ('missing_receipt',"DELETE FROM settlement_idempotency_keys;",'REBUY_SETTLEMENT_RECEIPT_REQUIRED',True),
            ('open_rebuy',"UPDATE tournament_knockout_candidates SET rebuy_prompt_until=clock_timestamp()+interval '5 minutes';",'rebuy_decision_open',False),
            ('new_seat',"UPDATE table_seats SET joined_at='2026-09-02T00:00:00Z' WHERE user_id='"+uid(1)+"';",'knockout_generation_has_new_live_seat',False),
        ]
        for name,mutation,reason,raises in refusals:
            setup(name,mutation)
            before=fingerprint()
            if raises:
                q(eliminate(1,3),reason)
            else:
                refused=json.loads(q(eliminate(1,3)))
                assert refused.get('reason')==reason,(name,refused)
            assert fingerprint()==before,'unproven elimination changed durable state: '+name
        check('missing or contradictory hand, receipt, decision and seat evidence cannot persist a rank')

        setup('rollback')
        q("CREATE FUNCTION fail_rank_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected rank seat release failure'; END $$; CREATE TRIGGER fail_rank_release BEFORE UPDATE OF left_at ON table_seats FOR EACH ROW EXECUTE FUNCTION fail_rank_release();")
        before=fingerprint()
        q(eliminate(1,3),'injected rank seat release failure')
        assert fingerprint()==before,'failed seat release left a rank or candidate mutation'
        check('seat release failure rolls back rank, sequence row and candidate mutation together')

    setup('null_rank')
    before=fingerprint()
    refused=json.loads(q(eliminate(1,None)))
    observed=ranked()
    print('NULL_RANK_RESULT '+json.dumps({'response':refused,'rows':observed}),flush=True)
    assert refused.get('ok') is False and refused.get('reason')=='invalid_place_or_prize',(
        'NULL rank eliminated a player without a finishing position',refused,observed)
    assert fingerprint()==before,'NULL rank refusal changed durable state'
    assert json.loads(q(eliminate(1,3))).get('claimed') is True
    check('a missing rank is refused before elimination and leaves the valid rank claim available')
