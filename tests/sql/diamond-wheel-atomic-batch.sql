\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL request.jwt.claims='{"role":"authenticated"}';
DO $probe$
DECLARE
 club uuid:='d1000000-0000-4000-8000-000000000003';
 player uuid:='d1000000-0000-4000-8000-000000000005';
 req uuid; count integer; prepared jsonb; receipt jsonb; replay jsonb; before_diamonds numeric; after_diamonds numeric; mismatch jsonb; stats jsonb; expected_next uuid;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Private fixture required'; END IF;
 UPDATE public.wheel_configs SET enabled=true,diamond_seed=100000,exposure_allowance_chips=62500,min_seconds_between_spins=3,max_spins_per_player_per_day=100000,purchased_only=false,welcome_spin_enabled=false WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips) SELECT club,'club',g,true,0,25000 FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET enabled=true,exposure_allowance_chips=25000,min_seconds_between_rounds=0,max_bet_diamonds=5000 WHERE host_id=club;
 UPDATE public.wheel_pools SET diamond_seed=100000,diamond_float=100000 WHERE host_id=club;
 UPDATE public.diamond_wheel_release SET enabled=true;
 FOREACH count IN ARRAY ARRAY[5,10,25] LOOP
  BEGIN
   req:=gen_random_uuid();
   SELECT diamonds INTO before_diamonds FROM public.profiles WHERE id=player;
   SET LOCAL ROLE authenticated;
   prepared:=public.fn_wheel_batch_prepare(req,club,count,2500);
   RESET ROLE;
   IF prepared->>'ok' IS DISTINCT FROM 'true' OR jsonb_array_length(prepared->'tickets')<>count THEN RAISE EXCEPTION 'Batch preparation refused: %',prepared; END IF;
   IF (SELECT diamonds FROM public.profiles WHERE id=player)<>before_diamonds THEN RAISE EXCEPTION 'Preparing charged a player'; END IF;
   SET LOCAL ROLE authenticated;
   receipt:=public.fn_wheel_batch_begin(req,'atomic-batch');
   replay:=public.fn_wheel_batch_begin(req,'atomic-batch');
   RESET ROLE;
   IF receipt->>'ok' IS DISTINCT FROM 'true' OR jsonb_array_length(receipt->'receipts')<>count OR (receipt->>'total_cost_diamonds')::integer<>count*2500 THEN RAISE EXCEPTION 'Complete batch refused: %',receipt; END IF;
   SELECT diamonds INTO after_diamonds FROM public.profiles WHERE id=player;
   IF after_diamonds<>before_diamonds-count*2500 THEN RAISE EXCEPTION 'Batch did not withdraw its entire cost exactly once'; END IF;
   IF replay-'replayed' IS DISTINCT FROM receipt OR replay->>'replayed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Batch replay changed receipts'; END IF;
   IF (SELECT count(*) FROM public.wheel_spins WHERE user_id=player AND receipt_v2#>>'{auto_run,run_id}'=receipt->>'run_id')<>count THEN RAISE EXCEPTION 'Batch did not fulfill all selected spins'; END IF;
   SET LOCAL ROLE authenticated;
   mismatch:=public.fn_wheel_batch_begin(req,'changed-seed');
   stats:=public.fn_diamond_game_lifetime(club);
   RESET ROLE;
   IF mismatch->>'ok' IS DISTINCT FROM 'false' OR (SELECT diamonds FROM public.profiles WHERE id=player)<>after_diamonds THEN RAISE EXCEPTION 'A changed batch seed replayed or moved money'; END IF;
   IF stats->>'ok' IS DISTINCT FROM 'true' OR jsonb_array_length(stats->'games')<>5 OR (SELECT (g->>'rounds')::integer FROM jsonb_array_elements(stats->'games') g WHERE g->>'game'='wheel')<count THEN RAISE EXCEPTION 'Completed paid run missing from measured lifetime games'; END IF;
   IF EXISTS(SELECT 1 FROM public.wheel_bonus_awards a JOIN public.wheel_spins s ON s.id=a.spin_id WHERE s.receipt_v2#>>'{auto_run,run_id}'=receipt->>'run_id' AND a.reserved_chips>20*(a.base_diamonds+a.entry_diamonds)::numeric/100) THEN RAISE EXCEPTION 'A batch game consumed more than its complete optional-addon reservation'; END IF;
   SELECT q.id INTO expected_next FROM (
    SELECT a.id,(s.receipt_v2#>>'{auto_run,spins_done}')::integer position FROM public.wheel_bonus_awards a JOIN public.wheel_spins s ON s.id=a.spin_id WHERE s.receipt_v2#>>'{auto_run,run_id}'=receipt->>'run_id'
    UNION ALL SELECT c.id,(s.receipt_v2#>>'{auto_run,spins_done}')::integer FROM public.wheel_card_awards c JOIN public.wheel_spins s ON s.id=c.spin_id WHERE s.receipt_v2#>>'{auto_run,run_id}'=receipt->>'run_id'
   ) q ORDER BY position,id LIMIT 1;
   IF public.fn_wheel_next_unplayed(player,club) IS DISTINCT FROM expected_next THEN RAISE EXCEPTION 'Earned games/cards did not share their receipt order'; END IF;
   PERFORM set_config('test.user','d1000000-0000-4000-8000-000000000006',true);
   SET LOCAL ROLE authenticated;
   mismatch:=public.fn_wheel_batch_read((receipt->>'run_id')::uuid);
   RESET ROLE;
   PERFORM set_config('test.user',player::text,true);
   IF mismatch->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Another player read this paid run'; END IF;
   RAISE EXCEPTION USING ERRCODE='P0099',MESSAGE='case rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
 END LOOP;
 -- Lose only the third synthetic ticket after admission preparation. The
 -- first two canonical spins execute, then the owning batch rolls them back.
 req:=gen_random_uuid();
 SELECT diamonds INTO before_diamonds FROM public.profiles WHERE id=player;
 SET LOCAL ROLE authenticated;
 prepared:=public.fn_wheel_batch_prepare(req,club,5,2500);
 RESET ROLE;
 DELETE FROM public.wheel_seed_commits WHERE id=(prepared#>>'{tickets,2,commit_id}')::uuid;
 SET LOCAL ROLE authenticated;
 receipt:=public.fn_wheel_batch_begin(req,'partial-refusal');
 RESET ROLE;
 IF receipt->>'ok' IS DISTINCT FROM 'false' OR (receipt->>'charged_diamonds')::integer IS DISTINCT FROM 0 OR (SELECT diamonds FROM public.profiles WHERE id=player)<>before_diamonds OR EXISTS(SELECT 1 FROM public.wheel_runs WHERE user_id=player AND status='open') OR (SELECT status FROM public.wheel_batch_requests WHERE id=req)<>'prepared' OR EXISTS(SELECT 1 FROM public.wheel_seed_commits WHERE id IN(SELECT unnest(commit_ids) FROM public.wheel_batch_requests WHERE id=req) AND consumed_by IS NOT NULL) THEN RAISE EXCEPTION 'Partial refusal committed money or consumed a seal: %',receipt; END IF;
 RAISE NOTICE 'PASS Atomic paid batches: 5/10/25 maximum-entry runs, sealed before payment, full cost withdrawn once, every spin fulfilled, exact immutable receipt replay';
END $probe$;
ROLLBACK;
