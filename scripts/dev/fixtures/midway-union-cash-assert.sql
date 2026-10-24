SET TIME ZONE 'UTC';
SELECT set_config('fixture.uid','90000000-0000-4000-8000-000000000099',false);
DO $assert$
DECLARE member_id uuid; authority text; before_count integer; after_count integer;
BEGIN
 SELECT count(*) INTO before_count FROM cash_games;
 FOREACH member_id IN ARRAY ARRAY['946747c6-b991-4220-b0cb-effbea46ecd2'::uuid,'a0000000-0000-0000-0000-000000000001'::uuid] LOOP
  FOREACH authority IN ARRAY ARRAY['outer','implementation','ensure'] LOOP
   BEGIN
    IF authority='outer' THEN
     PERFORM fn_cash_game_create(member_id,'classic','nlh',.5,1,9,'{}',NULL,true);
    ELSIF authority='implementation' THEN
     PERFORM fn_cash_game_create_impl_20260905(member_id,'classic','nlh',.5,1,9,'{}',NULL,true);
    ELSE PERFORM fn_cash_game_ensure(member_id,'nlh',.5,1,'classic',9);
    END IF;
    RAISE EXCEPTION 'FAIL: member host admitted by %',authority;
   EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE 'UNION_HOST_REQUIRED:%' THEN RAISE; END IF;
   END;
  END LOOP;
 END LOOP;
 SELECT count(*) INTO after_count FROM cash_games;
 IF after_count<>before_count THEN RAISE EXCEPTION 'FAIL: refused authority wrote a catalog row'; END IF;
 IF (SELECT count(*) FROM cash_games WHERE club_id='946747c6-b991-4220-b0cb-effbea46ecd2' AND NOT enabled
      AND ruleset_snapshot ? 'retired_to_union_game_id')<>9 THEN RAISE EXCEPTION 'FAIL: source retirement scope'; END IF;
 IF EXISTS(SELECT 1 FROM cash_games s JOIN fixture_midway_catalog_before b USING(id)
    WHERE s.club_id='946747c6-b991-4220-b0cb-effbea46ecd2'
    AND (s.ruleset_snapshot-'retired_to_union_game_id'<>b.ruleset_snapshot OR s.club_id<>b.club_id
      OR s.union_id IS DISTINCT FROM b.union_id OR s.template_name<>b.template_name OR s.handedness<>b.handedness))
 THEN RAISE EXCEPTION 'FAIL: historical source promise or ownership changed'; END IF;
 IF (SELECT count(*) FROM cash_games WHERE club_id='fade0000-0000-0000-0000-000000000001'
     AND enabled AND template_name='classic' AND sb=.5 AND bb=1)<>9 THEN RAISE EXCEPTION 'FAIL: union nine canonical keys'; END IF;
 IF EXISTS(SELECT 1 FROM cash_games s JOIN cash_games u ON u.id::text=s.ruleset_snapshot->>'retired_to_union_game_id'
    WHERE s.club_id='946747c6-b991-4220-b0cb-effbea46ecd2'
     AND (u.club_id<>'fade0000-0000-0000-0000-000000000001' OR u.union_id<>'fade0000-0000-0000-0000-000000000001'
      OR NOT u.enabled OR u.variant<>s.variant OR u.sb<>s.sb OR u.bb<>s.bb OR u.template_name<>'classic'))
 THEN RAISE EXCEPTION 'FAIL: canonical retirement target mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM table_seats WHERE id='90000000-0000-4000-8000-000000000020' AND stack=33.33 AND left_at IS NULL)
 THEN RAISE EXCEPTION 'FAIL: live union player custody changed'; END IF;
 IF (SELECT count(*) FROM cash_games WHERE club_id='fade0000-0000-0000-0000-000000000001' AND variant='pineapple' AND NOT enabled)<>2
 THEN RAISE EXCEPTION 'FAIL: unrelated historical Pineapple disabled keys reopened'; END IF;
 IF NOT has_function_privilege('authenticated','fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)','EXECUTE')
   OR has_function_privilege('authenticated','fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)','EXECUTE')
   OR has_function_privilege('authenticated','fn_cash_game_ensure(uuid,text,numeric,numeric,text,integer)','EXECUTE')
 THEN RAISE EXCEPTION 'FAIL: creation ACL drift'; END IF;
END $assert$;
-- Other unions and standalone hosts retain the exact original admission behavior.
SELECT fn_cash_game_ensure('90000000-0000-4000-8000-000000000002','nlh',.5,1,'classic',6);
SELECT fn_cash_game_ensure('90000000-0000-4000-8000-000000000003','nlh',.5,1,'classic',6);
DO $assert$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM cash_games WHERE club_id='90000000-0000-4000-8000-000000000002' AND union_id='90000000-0000-4000-8000-000000000001')
   OR NOT EXISTS(SELECT 1 FROM cash_games WHERE club_id='90000000-0000-4000-8000-000000000003' AND union_id IS NULL)
 THEN RAISE EXCEPTION 'FAIL: unrelated host creation changed'; END IF;
END $assert$;
-- The original authenticated outer door remains usable at the union host.
SELECT fn_cash_game_create('fade0000-0000-0000-0000-000000000001','classic','nlh',.25,.5,6,'{}','Union Classic',true);
SELECT set_config('fixture.uid','',false);
DO $assert$
BEGIN
 BEGIN
  PERFORM fn_cash_game_create('fade0000-0000-0000-0000-000000000001','classic','nlh',.25,.5,6,'{}',NULL,true);
  RAISE EXCEPTION 'FAIL: unauthenticated creation admitted';
 EXCEPTION WHEN invalid_authorization_specification THEN NULL;
 END;
END $assert$;
