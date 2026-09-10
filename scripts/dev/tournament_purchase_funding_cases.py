"""Real tournament purchase functions over the shared isolated funding fixture."""
from pathlib import Path
import json

HERE=Path(__file__).resolve().parent
EVENT='c3000000-0000-4000-8000-000000000001'
CLUB='c2000000-0000-4000-8000-000000000001'
USER='c1000000-0000-4000-8000-000000000001'
TABLE='d2000000-0000-4000-8000-000000000001'
SEAT='d3000000-0000-4000-8000-000000000001'

def verify(q,fresh,overlap,register,check):
    source=HERE/'fixtures/tournament-purchase-funding'
    def setup(kind,name,live=True):
        fresh('purchase_'+name)
        assert json.loads(q(register(1,1))).get('ok') is True
        q((source/'installed.sql').read_text())
        manifest=json.loads((source/'source-manifest.json').read_text())
        expected={r['signature']:r['body_md5'] for r in manifest['functions']}
        signatures=','.join("to_regprocedure('"+k+"')" for k in expected)
        observed=json.loads(q("SELECT jsonb_object_agg(oid::regprocedure::text,md5(prosrc)) FROM pg_proc WHERE oid IN ("+signatures+");"))
        assert observed==expected,'fixture function bodies differ from the installed capture'
        q(f"""
          UPDATE tournaments SET status='RUNNING',started_at=clock_timestamp()-interval '1 minute',
            starting_chips=1000,is_rebuy=true,is_reentry=true,rebuy_cost=15,rebuy_chips=100,
            max_rebuys=2,max_reentries=2,rebuy_levels=5,current_level=0,
            add_on_available=true,addon_period_triggered=true,addon_cost=15,addon_chips=100,
            addon_period_started_at=clock_timestamp()-interval '1 minute',
            addon_period_ends_at=clock_timestamp()+interval '5 minutes' WHERE id='{EVENT}';
          INSERT INTO tables(id,club_id,tournament_id,name,game_type,status,current_players,
            seat_game_scope,seat_admission_key)
          VALUES('{TABLE}','{CLUB}','{EVENT}','Isolated Purchase Table','tournament','running',
            {1 if live else 0},'table:{TABLE}','tournament:{EVENT}');
          UPDATE tournament_players SET status='{'eliminated' if kind=='reentry' else 'playing'}',
            chips={500 if kind=='addon' else 0},table_id='{TABLE}',seat_number=1
            WHERE tournament_id='{EVENT}' AND user_id='{USER}';
          INSERT INTO table_seats(id,table_id,seat_number,user_id,club_id,stack,joined_at,
            left_at,active_game_scope,active_parent_key)
          VALUES('{SEAT}','{TABLE}',1,'{USER}','{CLUB}',{500 if kind=='addon' else 0},
            '2026-09-01T00:00:00Z',
            {'NULL' if live else 'clock_timestamp()'},
            {"'table:"+TABLE+"'" if live else 'NULL'},
            {"'tournament:"+EVENT+"'" if live else 'NULL'});
        """)
        if kind!='addon': bust(kind,1)
        q((source/'triggers.sql').read_text())
        q("""
          CREATE FUNCTION probe_purchase(p_kind text,p_token text,p_user uuid,p_cost numeric DEFAULT 15)
          RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE v_context text; BEGIN
            RETURN process_tournament_rebuy('c3000000-0000-4000-8000-000000000001',
              p_user,p_kind,p_cost,100,0,p_token);
          EXCEPTION WHEN OTHERS THEN
            GET STACKED DIAGNOSTICS v_context=PG_EXCEPTION_CONTEXT;
            RETURN jsonb_build_object('error',SQLERRM,'sqlstate',SQLSTATE,'context',v_context);
          END $$;
        """)

    def bust(kind,generation):
        hand='d4000000-0000-4000-8000-'+str(generation).zfill(12)
        candidate='d5000000-0000-4000-8000-'+str(generation).zfill(12)
        n=1000000+generation
        q(f"""
          INSERT INTO hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,stack_result)
          VALUES('{TABLE}',{n},'{hand}',repeat('a',64),
            jsonb_build_object('hand_id','{hand}','written',jsonb_build_object('{USER}',0)));
          INSERT INTO settlement_idempotency_keys(table_id,hand_id,status,completed_at,result)
          VALUES('{TABLE}','{hand}','succeeded',clock_timestamp(),
            jsonb_build_object('table_id','{TABLE}','hand_number',{n},
              'written',jsonb_build_object('{USER}',0)));
          INSERT INTO tournament_knockout_candidates(id,tournament_id,eliminated_user_id,
            table_id,seat_id,seat_joined_at,hand_id,hand_number,stack_before,stack_after,state,rebuy_prompt_until)
          SELECT '{candidate}','{EVENT}','{USER}','{TABLE}','{SEAT}',joined_at,
            '{hand}',{n},100,0,'{'eliminated' if kind=='reentry' else 'pending'}',
            clock_timestamp()+interval '5 minutes' FROM table_seats WHERE id='{SEAT}';
        """)

    def call(kind,token='prompt-1',user=USER,cost=15):
        return f"SET test.actor='{USER}'; SELECT probe_purchase('{kind}','{token}','{user}',{cost});"

    tracked=['club_members','chip_ledger','wallet_transactions','tournament_escrow',
        'tournament_refund_entitlements','rake_records','wallet_credit_idempotency',
        'entry_purchase_idempotency_receipts','tournament_players','table_seats','tournaments',
        'tournament_knockout_candidates','tournament_manager_wakes','tables','tournament_capacity_table_receipts']
    all_rows='jsonb_build_array('+','.join("(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM "+table+" r)" for table in tracked)+')'
    def state():
        observed=json.loads(q("""SELECT jsonb_build_object(
          'wallets',(SELECT sum(chip_balance) FROM club_members),
          'pool',(SELECT prize_pool FROM tournaments),'fee',(SELECT total_rake FROM tournaments),
          'gross',(SELECT gross_in FROM tournament_escrow),
          'prize',(SELECT prize_balance FROM tournament_escrow),
          'fee_escrow',(SELECT fee_balance FROM tournament_escrow),
          'journal',(SELECT count(*) FROM chip_ledger),
          'wallet_receipts',(SELECT count(*) FROM wallet_transactions),
          'entitlements',(SELECT count(*) FROM tournament_refund_entitlements),
          'operations',(SELECT count(*) FROM entry_purchase_idempotency_receipts),
          'purchase_keys',(SELECT count(*) FROM wallet_credit_idempotency),
          'stack',(SELECT stack FROM table_seats),
          'roster',(SELECT chips FROM tournament_players),
          'rebuys',(SELECT rebuys FROM tournament_players),
          'addon',(SELECT add_on FROM tournament_players),
          'joined',(SELECT joined_at FROM table_seats),
          'candidate_states',(SELECT jsonb_agg(state ORDER BY hand_number) FROM tournament_knockout_candidates),
          'wakes',(SELECT COALESCE(sum(generation),0) FROM tournament_manager_wakes)
        );"""))
        observed['row_fingerprint']=q("SELECT md5(("+all_rows+")::text);")
        return observed

    def funded(kind):
        s=state()
        expected={'wallets':1785,'pool':195 if kind=='addon' else 193.5,
            'fee':20 if kind=='addon' else 21.5,'gross':215,
            'prize':195 if kind=='addon' else 193.5,
            'fee_escrow':20 if kind=='addon' else 21.5,
            'journal':2,'wallet_receipts':2,'entitlements':2,'operations':2,
            'purchase_keys':1,'stack':600 if kind=='addon' else 100,
            'roster':600 if kind=='addon' else 100,'rebuys':0 if kind=='addon' else 1,
            'addon':kind=='addon','candidate_states':None if kind=='addon' else ['rebought'],'wakes':1}
        assert {k:s[k] for k in expected}==expected,(s,expected)
        return s

    for kind in ['rebuy','reentry','addon']:
        setup(kind,kind)
        before=state()
        result=json.loads(q(call(kind)))
        assert result.get('success') is True,result
        after=funded(kind)
        if kind!='addon': assert after['joined']!=before['joined']
        replay=json.loads(q(call(kind)))
        assert replay==result and state()==after,(replay,result)
        check(kind+' atomically binds exact wallet funding, ledger, escrow, seat, generation and receipt')

    for kind in ['reentry','addon']:
        setup(kind,'rollback_'+kind)
        before=state()
        q("""CREATE FUNCTION probe_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected final receipt failure'; END $$;
          CREATE TRIGGER probe_receipt_failure BEFORE UPDATE OF response
          ON entry_purchase_idempotency_receipts FOR EACH ROW EXECUTE FUNCTION probe_receipt_failure();""")
        result=json.loads(q(call(kind)))
        assert result.get('error')=='injected final receipt failure',result
        assert state()==before,'partial purchase survived final receipt failure'
        check(kind+' rolls back the debit, grant, generation, pool, journal and wake on final receipt failure')

    for kind,second_token in [('reentry','prompt-1'),('reentry','prompt-2'),('addon','ignored-new-token')]:
        setup(kind,'race_'+kind+'_'+second_token.replace('-','_'))
        first,second=overlap(call(kind),call(kind,second_token))
        assert first.get('success') is True,first
        if kind=='reentry' and second_token=='prompt-2':
            assert 'Only the exact unpaid zero-stack entry' in second.get('error',''),second
        else:
            assert second==first,(first,second)
        funded(kind)
        check(kind+' concurrent '+('competing tokens' if second_token=='prompt-2' else 'retries')+' commit one funded grant')

    setup('reentry','seatless',live=False)
    result=json.loads(q(call('reentry')))
    assert result.get('success') is True,result
    funded('reentry')
    assert q("SELECT left_at IS NULL FROM table_seats")=='t'
    check('seatless reentry commits its funded replacement chair in the same transaction')

    setup('reentry','generations')
    first=json.loads(q(call('reentry')))
    assert first.get('success') is True,first
    first_joined=state()['joined']
    def next_bust(generation):
        q(f"UPDATE table_seats SET stack=0,left_at=clock_timestamp() WHERE id='{SEAT}'; UPDATE tournament_players SET chips=0,status='eliminated' WHERE tournament_id='{EVENT}' AND user_id='{USER}';")
        bust('reentry',generation)
    next_bust(2)
    before=state()
    assert json.loads(q(call('reentry')))==first
    assert state()==before,'old prompt changed a later knockout generation'
    second=json.loads(q(call('reentry','prompt-2')))
    assert second.get('success') is True and second['candidate_id']!=first['candidate_id'],second
    after=state()
    assert after['joined']!=first_joined and after['rebuys']==2,after
    assert after['wallets']==1770 and after['pool']==207 and after['fee']==23,after
    assert after['candidate_states']==['rebought','rebought'] and after['operations']==3,after
    next_bust(3)
    before=state()
    refused=json.loads(q(call('reentry','prompt-3')))
    assert 'Re-entry limit reached' in refused.get('error',''),refused
    assert state()==before,'limit refusal changed a third generation'
    check('successive reentries have distinct bust/seat generations and old-token replay cannot bypass the entry limit')

    refusal_cases=[
        ('positive_stack',"UPDATE tournament_players SET status='playing',chips=10; UPDATE table_seats SET stack=10;",'Only the exact unpaid zero-stack entry'),
        ('paid_result',"UPDATE tournament_players SET prize=1;",'Only the exact unpaid zero-stack entry'),
        ('level_closed',"UPDATE tournaments SET current_level=5,addon_period_ends_at=clock_timestamp()-interval '1 second';",'Rebuy period is closed'),
        ('time_closed',"UPDATE tournaments SET rebuy_levels=0,late_reg_levels=0,late_reg_mins=1,started_at=clock_timestamp()-interval '2 minutes',addon_period_ends_at=clock_timestamp()-interval '1 minute';",'Rebuy period is closed'),
        ('missing_hand',"DELETE FROM hand_atomic_commits;",'REBUY_ATOMIC_HAND_REQUIRED'),
        ('nonzero_hand',f"UPDATE hand_atomic_commits SET stack_result=jsonb_set(stack_result,ARRAY['written','{USER}'],'5');",'REBUY_ATOMIC_HAND_REQUIRED'),
        ('missing_settlement',"DELETE FROM settlement_idempotency_keys;",'REBUY_SETTLEMENT_RECEIPT_REQUIRED'),
        ('unfunded',"UPDATE club_members SET chip_balance=14 WHERE user_id='"+USER+"';",'Insufficient club chips'),
    ]
    for name,mutation,error in refusal_cases:
        setup('reentry','refuse_'+name)
        q(mutation)
        before=state()
        response=json.loads(q(call('reentry')))
        assert error in response.get('error',''),response
        assert state()==before,'refusal changed the purchase state: '+name
    check('reentry rejects live/paid entries, closed level/time windows, missing or contradictory bust proofs and insufficient funds without writes')

    setup('addon','closed_addon')
    q("UPDATE tournaments SET addon_period_ends_at=clock_timestamp()-interval '1 second';")
    before=state()
    response=json.loads(q(call('addon')))
    assert 'Add-On Period Is Closed' in response.get('error',''),response
    assert state()==before
    check('an expired add-on window cannot charge or grant chips')

    for name,mutation,error in [
        ('prompt_expired',"UPDATE tournament_knockout_candidates SET rebuy_prompt_until=clock_timestamp()-interval '1 second';",'decision window has closed'),
        ('disabled',"UPDATE tournaments SET is_rebuy=false;",'Rebuys are not offered'),
        ('limit',"UPDATE tournaments SET max_rebuys=0;",'Rebuy limit reached'),
    ]:
        setup('rebuy','rebuy_'+name)
        q(mutation)
        before=state()
        response=json.loads(q(call('rebuy')))
        assert error in response.get('error',''),response
        assert state()==before,'rebuy eligibility refusal changed money or a generation'
    check('rebuy requires an open decision prompt, the offered format and an unused purchase limit')
