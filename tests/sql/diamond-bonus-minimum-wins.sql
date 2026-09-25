-- Private, synthetic PostgreSQL only. Actual JWT role and canonical payout legs.
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL request.jwt.claims='{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated"}';
DO $$
#variable_conflict use_variable
DECLARE
 player uuid:='d1000000-0000-4000-8000-000000000005'; club uuid:='d1000000-0000-4000-8000-000000000003';
 game text; target integer; lower_bound integer; upper_bound integer; point numeric; roll numeric;
 seed text; commit uuid; ticket uuid; nonce bigint; i integer; result jsonb; started jsonb; settled jsonb; replay jsonb;
 rid uuid; award uuid; cell integer; minimum numeric; expected numeric; before_chips numeric; before_promo numeric; before_bank numeric; refused boolean;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Requires The Isolated Fixture'; END IF;
 UPDATE public.wheel_configs SET exposure_allowance_chips=100000 WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips)
 SELECT club,'club',g,true,0,100000 FROM unnest(ARRAY['crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET exposure_allowance_chips=100000,min_seconds_between_rounds=0 WHERE host_id=club;
 -- Reproduce the reported pending Crash award's exact2500entry/5905cap/1476.25hold.
 UPDATE public.diamond_game_configs SET max_multiplier_cents=5905 WHERE host_id=club AND diamond_game_configs.game='crash';
 UPDATE public.diamond_wheel_release SET enabled=true;
 FOREACH game IN ARRAY ARRAY['crash','crossing','mines'] LOOP
  target:=CASE game WHEN 'crash' THEN 4 WHEN 'crossing' THEN 7 ELSE 10 END;
  lower_bound:=CASE game WHEN 'crash' THEN 29600 WHEN 'crossing' THEN 59200 ELSE 85800 END;
  upper_bound:=lower_bound+10000;
  SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=player;
  FOR i IN 1..10000 LOOP
   seed:=encode(extensions.digest('minimum-win-wheel-'||game||i,'sha256'),'hex');
   point:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:win-client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/281474976710656);
   EXIT WHEN point>=lower_bound AND point<upper_bound;
  END LOOP;
  commit:=gen_random_uuid();
  INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  result:=public.fn_wheel_spin_v2(club,commit,'win-client',2500,'paid',NULL);
  RESET ROLE;
  IF result->>'ok'<>'true' OR (result#>>'{outcome,ord}')::integer<>target THEN RAISE EXCEPTION 'Expected Funded Game: %',result; END IF;
  award:=(result#>>'{bonus,id}')::uuid;
  IF game='crash' AND NOT EXISTS(SELECT 1 FROM public.wheel_bonus_awards WHERE id=award AND base_diamonds=2500 AND cap_cents=5905 AND reserved_chips=1476.25) THEN RAISE EXCEPTION 'Reported Crash Award Shape Not Reproduced'; END IF;
  IF game='crash' THEN SELECT count(*)+1 INTO nonce FROM public.crash_rounds WHERE user_id=player;
  ELSE SELECT count(*)+1 INTO nonce FROM public.diamond_choice_rounds WHERE user_id=player AND diamond_choice_rounds.game=game; END IF;
  FOR i IN 1..10000 LOOP
   seed:=encode(extensions.digest('minimum-win-game-'||game||i,'sha256'),'hex');
   roll:=(('x'||substr(encode(extensions.hmac('win-game:'||nonce||CASE WHEN game='crossing' THEN ':road' ELSE '' END,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
   EXIT WHEN game='mines' OR (game='crossing' AND roll<281474976710656*.1) OR (game='crash' AND public.fn_crash_point_cents(roll,25,2.5)>400);
  END LOOP;
  ticket:=gen_random_uuid();
  INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,game,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  started:=public.fn_wheel_bonus_start(award,ticket,'win-game',false,CASE WHEN game='mines' THEN '5' ELSE 'steady' END,100,1,NULL,1);
  RESET ROLE;
  IF started->>'ok'<>'true' OR started->>'status'<>'open' OR (started->>'minimum_payout_chips')::numeric<>2.5 THEN RAISE EXCEPTION 'Game Start Failed: %',started; END IF;
  rid:=COALESCE(started->>'round_id',started->>'id')::uuid;
  refused:=false;
  BEGIN
   IF game='crash' THEN UPDATE public.crash_rounds SET minimum_payout_chips=0 WHERE id=rid;
   ELSE UPDATE public.diamond_choice_rounds SET minimum_payout_chips=0 WHERE id=rid; END IF;
  EXCEPTION WHEN integrity_constraint_violation OR raise_exception THEN refused:=true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'Minimum Was Not Immutable'; END IF;
  -- A private clock advance makes a real winning manual request deterministic.
  -- A live round's clock is sealed (20260922173914), so the shortcut says it is maintenance.
  IF game='crash' THEN
   PERFORM set_config('app.ledger_maintenance','probe clock: ten seconds of play',true);
   UPDATE public.crash_rounds SET started_at=clock_timestamp()-interval '10 seconds' WHERE id=rid;
   PERFORM set_config('app.ledger_maintenance','',true);
  END IF;
  -- Drain through the canonical writer, never manufacture an unbalanced fixture.
  SELECT promo_balance INTO before_promo FROM public.clubs WHERE id=club;
  IF before_promo>1 THEN PERFORM * FROM public.fn_diamond_game_pay_chips('wheel_prize',club,'club',club,player,before_promo-1,'minimum-win-promo:'||game,'Isolated Minimum Funding Boundary','{}'::jsonb); END IF;
  SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
  SELECT promo_balance,chip_treasury INTO before_promo,before_bank FROM public.clubs WHERE id=club;
  IF game='mines' THEN SELECT n INTO cell FROM generate_series(0,24) n, public.diamond_choice_rounds r WHERE r.id=rid AND NOT(n=ANY(r.mine_cells)) LIMIT 1; ELSE cell:=0; END IF;
  SET LOCAL ROLE authenticated;
  IF game='crash' THEN settled:=public.fn_crash_cashout(rid,257); ELSE settled:=public.fn_choice_act(rid,'pick',cell,0); END IF;
  RESET ROLE;
  expected:=CASE game WHEN 'crash' THEN 64.25 WHEN 'crossing' THEN 27.5 ELSE 24.375 END;
  minimum:=COALESCE((settled#>>'{outcome,payout_chips}')::numeric,(settled->>'payout_chips')::numeric);
  IF COALESCE(settled#>>'{outcome,status}',settled->>'status')<>'cashed' OR minimum NOT IN(floor(expected*100)/100,ceil(expected*100)/100) OR
    (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips+minimum OR
    (SELECT promo_balance FROM public.clubs WHERE id=club) IS DISTINCT FROM 0::numeric OR
    (SELECT chip_treasury FROM public.clubs WHERE id=club) IS DISTINCT FROM before_bank-(minimum-before_promo) THEN RAISE EXCEPTION 'Winning Prize Or Funding Wrong: %',settled; END IF;
  SET LOCAL ROLE authenticated;
  IF game='crash' THEN replay:=public.fn_crash_cashout(rid,257); ELSE replay:=public.fn_choice_act(rid,'pick',cell,0); END IF;
  RESET ROLE;
  IF COALESCE(replay->'outcome',replay) IS DISTINCT FROM COALESCE(settled->'outcome',settled) OR (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips+minimum THEN RAISE EXCEPTION 'Winning Replay Paid Twice'; END IF;
 END LOOP;
 RAISE NOTICE 'PASS Bonus minimum wins: exact reported Crash award, authenticated start, full immutable minimum, exact257cashout, Mines and Crossing wins, Promo first and Main Bank shortfall, replay';
END $$;
ROLLBACK;
