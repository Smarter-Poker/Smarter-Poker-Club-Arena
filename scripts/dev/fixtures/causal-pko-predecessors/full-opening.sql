-- Only synthetic opening rows; all production triggers are restored before calls.
UPDATE public.tournaments SET is_rebuy=false,is_reentry=false,rebuy_levels=0,
 late_reg_levels=0,late_reg_mins=0,current_level=6 WHERE id::text LIKE 'b7200000-%';
UPDATE public.tournament_players SET rebuy_prompt_until=NULL WHERE tournament_id::text LIKE 'b7200000-%';
UPDATE public.tournament_knockout_candidates SET rebuy_prompt_until=NULL WHERE tournament_id::text LIKE 'b7200000-%';
UPDATE public.tournament_players SET tournament_id='b7200000-0000-4000-8000-000000000002',
 table_id='b7300000-0000-4000-8000-000000000002',seat_number=seat_number+2
 WHERE tournament_id='b7200000-0000-4000-8000-000000000003';
UPDATE public.table_seats SET table_id='b7300000-0000-4000-8000-000000000002',seat_number=seat_number+2,
 active_game_scope='table:b7300000-0000-4000-8000-000000000002',active_parent_key='tournament:b7200000-0000-4000-8000-000000000002'
 WHERE table_id='b7300000-0000-4000-8000-000000000003';
UPDATE public.tournaments SET current_players=4,bounty_pool=20 WHERE id='b7200000-0000-4000-8000-000000000002';
UPDATE public.tables SET current_players=4 WHERE id='b7300000-0000-4000-8000-000000000002';
UPDATE public.tables SET current_players=0 WHERE id='b7300000-0000-4000-8000-000000000003';
UPDATE public.tournament_escrow SET gross_in=30,bounty_in=20,bounty_balance=20 WHERE tournament_id='b7200000-0000-4000-8000-000000000002';
UPDATE public.tournament_knockout_candidates SET tournament_id='b7200000-0000-4000-8000-000000000002',table_id='b7300000-0000-4000-8000-000000000002' WHERE hand_number=9720003;
UPDATE public.hand_history SET tournament_id='b7200000-0000-4000-8000-000000000002',table_id='b7300000-0000-4000-8000-000000000002' WHERE hand_number=9720003;
UPDATE public.hand_history SET players=replace(players::text,'b7100000-0000-4000-8000-000000000006','b7100000-0000-4000-8000-000000000004')::jsonb,
 pots=replace(pots::text,'b7100000-0000-4000-8000-000000000006','b7100000-0000-4000-8000-000000000004')::jsonb,
 winners=replace(winners::text,'b7100000-0000-4000-8000-000000000006','b7100000-0000-4000-8000-000000000004')::jsonb
 WHERE hand_number=9720003 AND current_setting('fixture.watermark_shared')='true';
UPDATE public.hand_atomic_commits SET table_id='b7300000-0000-4000-8000-000000000002',stack_result=jsonb_set(stack_result,'{table_id}','"b7300000-0000-4000-8000-000000000002"') WHERE hand_number=9720003;
UPDATE public.settlement_idempotency_keys SET table_id='b7300000-0000-4000-8000-000000000002',result=jsonb_set(result,'{table_id}','"b7300000-0000-4000-8000-000000000002"') WHERE hand_id='b7700000-0000-4000-8000-000000000003';
UPDATE public.hand_atomic_commits a SET committed_at=now()-interval '30 seconds'+(a.hand_number-9720000)*interval '2 seconds',
 stack_result=jsonb_set(a.stack_result,'{written}',(SELECT jsonb_object_agg(p->>'userId',p->'stack') FROM jsonb_array_elements(h.players) p))
 FROM public.hand_history h WHERE h.id=a.hand_id AND a.hand_number BETWEEN 9720001 AND 9720004;
UPDATE public.settlement_idempotency_keys k SET completed_at=a.committed_at-interval '3 milliseconds',result=jsonb_set(k.result,'{written}',a.stack_result->'written')
 FROM public.hand_atomic_commits a WHERE a.hand_number BETWEEN 9720001 AND 9720004 AND k.table_id=a.table_id AND k.hand_id=(a.stack_result->>'hand_id')::uuid;
UPDATE public.hand_history h SET created_at=a.committed_at-interval '2 milliseconds' FROM public.hand_atomic_commits a WHERE h.id=a.hand_id AND a.hand_number BETWEEN 9720001 AND 9720004;
UPDATE public.tournament_knockout_candidates c SET created_at=a.committed_at-interval '1 millisecond' FROM public.hand_atomic_commits a WHERE c.hand_id=a.hand_id AND a.hand_number BETWEEN 9720001 AND 9720004;
SET LOCAL session_replication_role=origin;
COMMIT;
