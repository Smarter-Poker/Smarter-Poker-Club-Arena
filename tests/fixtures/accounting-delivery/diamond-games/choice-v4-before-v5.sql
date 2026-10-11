\set ON_ERROR_STOP on
SET "test.user"='d1000000-0000-4000-8000-000000000005';
SET request.jwt.claims='{"role":"authenticated"}';
DO $before$
DECLARE club uuid:='d1000000-0000-4000-8000-000000000003'; game text; mode text; commit jsonb; quote jsonb; round jsonb;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Private fixture required'; END IF;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,exposure_allowance_chips) SELECT club,'club',g,true,10000 FROM unnest(ARRAY['mines','crossing']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['mines','crossing']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET enabled=true,exposure_allowance_chips=10000,min_seconds_between_rounds=0 WHERE host_id=club;
 FOREACH game IN ARRAY ARRAY['mines','crossing'] LOOP
  mode:=public.fn_choice_mode(game);
  SET LOCAL ROLE authenticated;
  commit:=public.fn_diamond_game_commit(game);
  quote:=public.fn_choice_state(club,game,mode,2500);
  round:=public.fn_choice_start(club,game,mode,2500,(commit->>'commit_id')::uuid,'historical-v4-transition',(quote->>'max_steps')::integer);
  IF round->>'ok' IS DISTINCT FROM 'true' OR round->>'payout_version'<>'4' THEN RAISE EXCEPTION 'Historical round could not open: %',round; END IF;
  round:=public.fn_choice_act((round->>'id')::uuid,'pick',0,0);
  RESET ROLE;
  IF round->>'status'<>'open' OR jsonb_array_length(round->'picked')<>1 THEN RAISE EXCEPTION 'Historical first pick changed'; END IF;
 END LOOP;
END $before$;
