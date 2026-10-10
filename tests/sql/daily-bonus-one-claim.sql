-- Isolated PostgreSQL only: real selector, claim, status and award bodies.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE uid uuid:=gen_random_uuid(); today date:=(now() AT TIME ZONE 'America/Chicago')::date;
 previous jsonb:='[]'; picked jsonb; again jsonb; r jsonb; replay jsonb; row jsonb; day integer; n integer; before_count integer;
BEGIN
 FOR day IN 1..400 LOOP
   -- Reset the streak every eleven days; the calendar date never resets.
   picked:=fn_ca_daily_bonus_pick_tiles(uid,today+day,((day-1)%11)+1,previous);
   again:=fn_ca_daily_bonus_pick_tiles(uid,today+day,((day-1)%11)+1,previous);
   IF picked IS DISTINCT FROM again THEN RAISE EXCEPTION 'Preview is not reproducible'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(picked) a JOIN jsonb_array_elements(previous) b
     ON a->>'slot'=b->>'slot' WHERE a->>'kind'=b->>'kind') THEN RAISE EXCEPTION 'Consecutive reward type repeated on day %',day; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(picked) a WHERE (a->>'diamonds')::int>125) THEN RAISE EXCEPTION 'Award ceiling exceeded'; END IF;
   previous:=picked;
 END LOOP;
 INSERT INTO auth.users(id) VALUES(uid);
 INSERT INTO profiles(id,diamonds,is_vip,vip_tier) VALUES(uid,0,true,'lifetime');
 PERFORM set_config('test.user',uid::text,true);
 r:=fn_ca_daily_bonus_status();
 IF r->>'eligible'<>'true' THEN RAISE EXCEPTION 'Fixture not eligible: %',r; END IF;
 n:=jsonb_array_length(r->'tiles');
 r:=fn_ca_daily_bonus_claim_all(today,gen_random_uuid());
 IF r->>'success'<>'true' OR jsonb_array_length(r->'results')<>n OR
   EXISTS(SELECT 1 FROM jsonb_array_elements(r->'results') t WHERE t->>'success'<>'true') THEN
   RAISE EXCEPTION 'One claim did not collect all rewards: %',r; END IF;
 SELECT count(*) INTO before_count FROM ca_daily_bonus_claims WHERE user_id=uid;
 replay:=fn_ca_daily_bonus_claim_all(today,gen_random_uuid());
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(replay->'results') t WHERE t->>'idempotent'<>'true')
  OR (SELECT count(*) FROM ca_daily_bonus_claims WHERE user_id=uid)<>before_count
  OR replay->'status'->>'unclaimed'<>'0' THEN RAISE EXCEPTION 'Batch replay duplicated an award'; END IF;
 IF fn_ca_daily_bonus_claim_all(today-1,gen_random_uuid())->>'reason'<>'day_rolled_over' THEN RAISE EXCEPTION 'Stale day accepted'; END IF;
 IF fn_ca_daily_bonus_claim_all(today,NULL)->>'reason'<>'request_id_required' THEN RAISE EXCEPTION 'Missing request accepted'; END IF;
 -- Non-VIP collects its own rewards but never the locked VIP slot.
 uid:=gen_random_uuid(); INSERT INTO auth.users(id) VALUES(uid); INSERT INTO profiles(id,diamonds,is_vip) VALUES(uid,0,false);
 PERFORM set_config('test.user',uid::text,true);
 r:=fn_ca_daily_bonus_claim_all(today,gen_random_uuid());
 IF EXISTS(SELECT 1 FROM ca_daily_bonus_claims WHERE user_id=uid AND (tile->>'vip_only')::boolean) THEN RAISE EXCEPTION 'VIP gate bypassed'; END IF;
 IF r->'status'->>'unclaimed'<>'0' THEN RAISE EXCEPTION 'Non-VIP rewards remain'; END IF;
 PERFORM set_config('test.user','',true);
 BEGIN PERFORM fn_ca_daily_bonus_claim_all(today,gen_random_uuid()); RAISE EXCEPTION 'Unauthenticated claim allowed';
 EXCEPTION WHEN SQLSTATE '28000' THEN NULL; END;
 IF has_function_privilege('anon','fn_ca_daily_bonus_claim_all(date,uuid,jsonb)','EXECUTE') OR
   has_function_privilege('authenticated','fn_ca_daily_bonus_pick_tiles(uuid,date,integer,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Private selection door exposed'; END IF;
 RAISE NOTICE 'PASS Daily Bonus: 400 dates, streak resets, preview repeatability, one batch, exact replay, stale day, request identity, VIP and auth permissions';
END $$;
ROLLBACK;
