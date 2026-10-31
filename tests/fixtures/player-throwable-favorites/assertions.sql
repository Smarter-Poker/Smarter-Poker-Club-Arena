DO $$
BEGIN
  IF has_function_privilege('anon','public.fn_player_throwable_favorites()','execute') THEN
    RAISE EXCEPTION 'Anonymous ranking access';
  END IF;
  IF has_table_privilege('authenticated','public.throw_usage','select') THEN
    RAISE EXCEPTION 'Raw usage leaked';
  END IF;
END $$;
SET ROLE authenticated;
DO $$
DECLARE ids text[];
BEGIN
  BEGIN
    PERFORM public.fn_player_throwable_favorites();
    RAISE EXCEPTION 'Unauthenticated invocation succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
  SELECT array_agg(throwable_id) INTO ids FROM public.fn_player_throwable_favorites();
  IF cardinality(ids) <> 10 OR ids[1] <> 'tomato' OR ids[2] <> 'heart' OR ids[3] <> 'bomb' OR 'retired_item'=ANY(ids) THEN
    RAISE EXCEPTION 'Personal ranking wrong: %',ids;
  END IF;
  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',true);
  SELECT array_agg(throwable_id) INTO ids FROM public.fn_player_throwable_favorites();
  IF ids[1] <> 'heart' OR ids[2] <> 'bomb' OR ids[3] <> 'tomato' THEN
    RAISE EXCEPTION 'Default popularity wrong: %',ids;
  END IF;
END $$;
RESET ROLE;
TRUNCATE public.throw_usage;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false);
DO $$ BEGIN
 IF (SELECT count(DISTINCT throwable_id) FROM public.fn_player_throwable_favorites()) <> 10 THEN
   RAISE EXCEPTION 'Empty usage must still supply ten catalog choices';
 END IF;
END $$;
