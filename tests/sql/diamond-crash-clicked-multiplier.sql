-- Actual authenticated settlement and canonical chip movement in isolated PostgreSQL only.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
DO $$
DECLARE
 player uuid:='d1000000-0000-4000-8000-000000000005'; club uuid:='d1000000-0000-4000-8000-000000000003';
 scenario text; rid uuid; result jsonb; replay jsonb; before_chips numeric; before_promo numeric; expected numeric; refused boolean;
BEGIN
 INSERT INTO diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds) VALUES(club,'club','crash',true,0);
 INSERT INTO diamond_game_pools(host_id,game,intake_diamonds) VALUES(club,'crash',10000);
 FOREACH scenario IN ARRAY ARRAY['manual','crashed','auto','cap','future','foreign'] LOOP
  rid:=gen_random_uuid();
  INSERT INTO crash_rounds(id,host_id,host_kind,club_id,user_id,bet_diamonds,bet_chips,diamonds_per_chip,commit_id,server_seed_hash,server_seed,client_seed,nonce,roll,crash_cents,cap_cents,growth_k,auto_cashout_cents,reserved_chips,started_at,chips_minted,diamonds_after)
   VALUES(rid,club,'club',club,player,100,1,100,gen_random_uuid(),encode(extensions.digest('test-server','sha256'),'hex'),'test-server','test-client',1,1,
    CASE WHEN scenario='crashed' THEN 210 ELSE 1000 END,CASE WHEN scenario='cap' THEN 300 ELSE 1000 END,.12,
    CASE WHEN scenario='auto' THEN 200 ELSE NULL END,10,clock_timestamp()-interval '10 seconds',0,100000);
  UPDATE diamond_game_pools SET reserved_chips=reserved_chips+10 WHERE host_id=club AND game='crash';
  SELECT chip_balance INTO before_chips FROM club_members WHERE club_id=club AND user_id=player;
  SELECT promo_balance INTO before_promo FROM clubs WHERE id=club;
  IF scenario='foreign' THEN PERFORM set_config('test.user','d1000000-0000-4000-8000-000000000001',true); END IF;
  SET LOCAL ROLE authenticated;
  IF scenario='future' THEN
   refused:=false;
   BEGIN
    result:=fn_crash_cashout(rid,100000);
   EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'The Requested Multiplier Is Not Available' THEN RAISE; END IF;
    refused:=true;
   END;
   IF NOT refused THEN RAISE EXCEPTION 'Future multiplier was accepted'; END IF;
  ELSE result:=fn_crash_cashout(rid,257); END IF;
  RESET ROLE;
  PERFORM set_config('test.user',player::text,true);
  IF scenario IN ('future','foreign') THEN
   IF scenario='foreign' AND (result->>'ok' IS DISTINCT FROM 'false' OR result->>'error' IS DISTINCT FROM 'That Round Belongs To Another Player') THEN RAISE EXCEPTION 'Foreign player settled round'; END IF;
   IF (SELECT status FROM crash_rounds WHERE id=rid) IS DISTINCT FROM 'open' OR (SELECT chip_balance FROM club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips OR (SELECT promo_balance FROM clubs WHERE id=club) IS DISTINCT FROM before_promo THEN RAISE EXCEPTION 'Rejected request moved money'; END IF;
   CONTINUE;
  END IF;
  expected:=CASE scenario WHEN 'manual' THEN 2.57 WHEN 'crashed' THEN 0 WHEN 'auto' THEN 2 ELSE 3 END;
  IF result->>'ok' IS DISTINCT FROM 'true' OR (result#>>'{outcome,payout_chips}')::numeric IS DISTINCT FROM expected OR
     (result#>>'{outcome,cashout_cents}')::integer IS DISTINCT FROM (CASE WHEN scenario='crashed' THEN NULL ELSE (expected*100)::integer END) OR
     (SELECT chip_balance FROM club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips+expected OR
     (SELECT promo_balance FROM clubs WHERE id=club) IS DISTINCT FROM before_promo-expected THEN RAISE EXCEPTION 'Wrong exact settlement %: %',scenario,result; END IF;
  SET LOCAL ROLE authenticated;
  replay:=fn_crash_cashout(rid,257);
  RESET ROLE;
  IF replay->'outcome' IS DISTINCT FROM result->'outcome' OR (SELECT chip_balance FROM club_members WHERE club_id=club AND user_id=player) IS DISTINCT FROM before_chips+expected THEN RAISE EXCEPTION 'Repeated cash-out paid twice'; END IF;
 END LOOP;
 IF has_function_privilege('authenticated','fn_crash_decide(crash_rounds,boolean,text,integer)','EXECUTE') OR has_function_privilege('anon','fn_crash_cashout(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Private settlement permission widened'; END IF;
 RAISE NOTICE 'PASS Crash clicked multiplier: exact 2.57x, no late rescue, auto and cap preserved, future and foreign requests refused, one payout on replay';
END $$;
ROLLBACK;
