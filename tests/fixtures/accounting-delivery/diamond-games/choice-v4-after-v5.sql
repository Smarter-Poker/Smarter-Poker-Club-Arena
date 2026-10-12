\set ON_ERROR_STOP on
SET "test.user"='d1000000-0000-4000-8000-000000000005';
SET request.jwt.claims='{"role":"authenticated"}';
DO $after$
DECLARE r public.diamond_choice_rounds; result jsonb; replay jsonb; before_chips numeric; count integer:=0;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Private fixture required'; END IF;
 FOR r IN SELECT * FROM public.diamond_choice_rounds WHERE client_seed='historical-v4-transition' LOOP
  SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id;
  SET LOCAL ROLE authenticated;
  result:=public.fn_choice_act(r.id,'cashout',NULL,1);
  replay:=public.fn_choice_act(r.id,'cashout',NULL,1);
  RESET ROLE;
  IF result->>'payout_version'<>'4' OR result->>'status'<>'cashed' OR (result->>'payout_chips')::numeric<>20 OR (replay->>'payout_chips')::numeric<>20 OR (SELECT chip_balance FROM public.club_members WHERE club_id=r.club_id AND user_id=r.user_id)<>before_chips+20 THEN RAISE EXCEPTION 'Version5 installation changed a sealed version4 round: % / %',result,replay; END IF;
  count:=count+1;
 END LOOP;
 IF count<>2 THEN RAISE EXCEPTION 'Historical Mines/Crossing cases missing'; END IF;
 RAISE NOTICE 'PASS Sealed v4 Mines and Crossing survived v5 installation, retained their payout contract, and credited the reached prize exactly once';
END $after$;
