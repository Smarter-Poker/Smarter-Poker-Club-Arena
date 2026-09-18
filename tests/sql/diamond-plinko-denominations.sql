-- Real public admission, sealed paths, diamond custody, chip wallet, replay and refusal.
-- Only executed against the isolated accounting fixture; every row rolls back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
DO $$
DECLARE
 player uuid:='d1000000-0000-4000-8000-000000000005'; owner uuid:='d1000000-0000-4000-8000-000000000002';
 club uuid:='d1000000-0000-4000-8000-000000000003'; ticket uuid; denom integer; total integer; doubled boolean;
 result jsonb; replay jsonb; ball jsonb; before_player numeric; before_owner numeric; before_chips numeric; before_promo numeric;
 payout numeric; count_before integer; installed text; digest bytea; expected_slot integer; path integer; idx integer; bit_idx integer; cents numeric; rounded numeric;
BEGIN
 -- Reproduce the original list refusal through the real public entry before checking the repair.
 installed:=pg_get_functiondef('public.fn_plinko_bonus_run(uuid,uuid,text,integer,integer,integer)'::regprocedure);
 IF position('(1,2,4,5,10,20,25,50,100)' IN installed)=0 THEN RAISE EXCEPTION 'New denomination migration is absent'; END IF;
 EXECUTE replace(installed,'(1,2,4,5,10,20,25,50,100)','(1,5,10,25,50,100)');
 ticket:=gen_random_uuid();
 INSERT INTO diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,'plinko','isolated-server',encode(extensions.digest('isolated-server','sha256'),'hex'));
 SET LOCAL ROLE authenticated;
 result:=fn_diamond_bonus_start(club,'plinko',100,false,ticket,'isolated-client',NULL,4,1,NULL,NULL);
 RESET ROLE;
 IF result->>'error' IS DISTINCT FROM 'Choose A Drop Value That Uses Every Diamond' OR EXISTS(SELECT 1 FROM diamond_bonus_entries WHERE commit_id=ticket) THEN RAISE EXCEPTION 'Original denomination refusal was not reproduced'; END IF;
 EXECUTE installed;
 FOREACH doubled IN ARRAY ARRAY[false,true] LOOP
  total:=CASE WHEN doubled THEN 200 ELSE 100 END;
  FOREACH denom IN ARRAY ARRAY[1,2,4,5,10,20,25,50,100] LOOP
   ticket:=gen_random_uuid();
   INSERT INTO diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,'plinko','isolated-server',encode(extensions.digest('isolated-server','sha256'),'hex'));
   SELECT diamonds INTO before_player FROM profiles WHERE id=player;
   SELECT diamonds INTO before_owner FROM profiles WHERE id=owner;
   SELECT chip_balance INTO before_chips FROM club_members WHERE club_id=club AND user_id=player;
   SELECT promo_balance INTO before_promo FROM clubs WHERE id=club;
   SET LOCAL ROLE authenticated;
   result:=fn_diamond_bonus_start(club,'plinko',100,doubled,ticket,'isolated-client',NULL,denom,1,NULL,NULL);
   RESET ROLE;
   IF result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'denomination %: %',denom,result; END IF;
   IF jsonb_array_length(result->'drops') IS DISTINCT FROM total/denom OR (result->>'diamonds_per_drop')::integer IS DISTINCT FROM denom THEN RAISE EXCEPTION 'Wrong allocation %',result; END IF;
   payout:=0;
   FOR ball IN SELECT value FROM jsonb_array_elements(result->'drops') LOOP
    idx:=(ball->>'index')::integer;
    digest:=extensions.hmac('isolated-client:'||(result->>'nonce')||':drop:'||idx,'isolated-server','sha256');
    expected_slot:=0; path:=0;
    FOR bit_idx IN 0..15 LOOP
     IF get_bit(digest,bit_idx)=1 THEN expected_slot:=expected_slot+1; path:=path|(1<<bit_idx); END IF;
    END LOOP;
    IF (ball->>'slot')::integer IS DISTINCT FROM expected_slot OR (ball->>'path_bits')::integer IS DISTINCT FROM path THEN RAISE EXCEPTION 'Wrong sealed path'; END IF;
    IF (ball->>'multiplier_cents')::integer IS DISTINCT FROM (SELECT multipliers_cents[expected_slot+1] FROM plinko_tables WHERE version=1) THEN RAISE EXCEPTION 'Wrong table prize'; END IF;
    -- Independent integer-cent oracle for sealed fractional-cent rounding.
    cents:=denom::numeric*(ball->>'multiplier_cents')::integer/100;
    digest:=extensions.hmac('isolated-client:'||(result->>'nonce')||':rounding:'||idx,'isolated-server','sha256');
    rounded:=floor(cents)+CASE WHEN (('x'||substr(encode(digest,'hex'),1,12))::bit(48)::bigint+1) <= (cents-floor(cents))*281474976710656::numeric THEN 1 ELSE 0 END;
    IF (ball->>'payout_chips')::numeric IS DISTINCT FROM rounded/100 THEN RAISE EXCEPTION 'Wrong denomination payout'; END IF;
    payout:=payout+rounded/100;
   END LOOP;
   IF (result->>'payout_chips')::numeric IS DISTINCT FROM payout OR
      (SELECT diamonds FROM profiles WHERE id=player) IS DISTINCT FROM before_player-total OR
      (SELECT diamonds FROM profiles WHERE id=owner) IS DISTINCT FROM before_owner+total OR
      (SELECT chip_balance FROM club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips+payout OR
      (SELECT promo_balance FROM clubs WHERE id=club) IS DISTINCT FROM before_promo-payout THEN RAISE EXCEPTION 'Allocation custody or payout mismatch'; END IF;
   SET LOCAL ROLE authenticated;
   replay:=fn_diamond_bonus_start(club,'plinko',100,doubled,ticket,'isolated-client',NULL,denom,1,NULL,NULL);
   RESET ROLE;
   IF replay->>'replayed' IS DISTINCT FROM 'true' OR replay-'replayed' IS DISTINCT FROM result OR (SELECT diamonds FROM profiles WHERE id=player) IS DISTINCT FROM before_player-total OR (SELECT chip_balance FROM club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips+payout THEN RAISE EXCEPTION 'Replay repeated money or changed outcome'; END IF;
  END LOOP;
 END LOOP;
 SELECT count(*) INTO count_before FROM diamond_bonus_entries;
 SELECT diamonds INTO before_player FROM profiles WHERE id=player;
 FOREACH denom IN ARRAY ARRAY[0,3,7,101] LOOP
  ticket:=gen_random_uuid();
  INSERT INTO diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,'plinko','isolated-server',encode(extensions.digest('isolated-server','sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  result:=fn_diamond_bonus_start(club,'plinko',100,false,ticket,'isolated-client',NULL,denom,1,NULL,NULL);
  RESET ROLE;
  IF result->>'ok' IS DISTINCT FROM 'false' OR (SELECT count(*) FROM diamond_bonus_entries) IS DISTINCT FROM count_before OR (SELECT diamonds FROM profiles WHERE id=player) IS DISTINCT FROM before_player OR (SELECT consumed_by FROM diamond_game_commits WHERE id=ticket) IS NOT NULL THEN RAISE EXCEPTION 'Invalid allocation consumed entry or money: %',result; END IF;
 END LOOP;
 RAISE NOTICE 'PASS Plinko denominations: nine choices, Double Down, exact drop budget, sealed outcomes, owner custody, Promo payout, replay and invalid allocation rollback';
END $$;
ROLLBACK;
