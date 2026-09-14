\set ON_ERROR_STOP on
SET test.uid='';
SET test.can_create='false';
DO $test$
DECLARE
  club uuid := '12121212-1212-1212-1212-121212121212';
  v text; r jsonb; count_cases int := 0;
BEGIN
  r:=public.fn_create_tournament(club,'{"gameVariant":"PINEAPPLE"}');
  IF r->>'error'<>'not_authenticated' THEN RAISE EXCEPTION 'Authentication ownership changed: %',r; END IF;
  PERFORM set_config('test.uid','12121212-1212-1212-1212-121212121213',false);
  r:=public.fn_create_tournament(club,'{"gameVariant":"PINEAPPLE"}');
  IF r->>'error'<>'not_authorised' THEN RAISE EXCEPTION 'Club authorization ownership changed: %',r; END IF;
  PERFORM set_config('test.can_create','true',false);
  FOREACH v IN ARRAY ARRAY['NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8'] LOOP
    r:=public.fn_create_tournament(club,jsonb_build_object('gameVariant',v,'maxPlayers',0));
    IF r->>'error'<>'max_players_must_be_positive' THEN RAISE EXCEPTION 'Supported variant did not reach unchanged creator: % %',v,r; END IF;
    r:=public.fn_create_tournament(club,jsonb_build_object('gameVariant',' '||lower(v)||' ','maxPlayers',0));
    IF r->>'error'<>'max_players_must_be_positive' THEN RAISE EXCEPTION 'Variant normalization failed: % %',v,r; END IF;
    count_cases:=count_cases+2;
  END LOOP;
  FOREACH v IN ARRAY ARRAY['NLH','PLO4','PLO5','PLO6','PLO8','SHORT_DECK','FLH','FLO8'] LOOP
    r:=public.fn_create_tournament(club,jsonb_build_object('gameVariant',v,'type','spin','maxPlayers',0));
    IF r->>'error' IS DISTINCT FROM (CASE WHEN v IN ('NLH','PLO4','PLO5','PLO6') THEN 'max_players_must_be_positive' ELSE 'unsupported_spin_variant' END) THEN
      RAISE EXCEPTION 'Spin catalogue mismatch: % %',v,r;
    END IF;
    count_cases:=count_cases+1;
  END LOOP;
  FOREACH v IN ARRAY ARRAY['PINEAPPLE','pineapple','UNKNOWN','', 'NLH;DROP TABLE', 'SHORTDECK','7'] LOOP
    r:=public.fn_create_tournament(club,jsonb_build_object('gameVariant',v,'maxPlayers',0));
    IF r->>'error'<>'unsupported_tournament_variant' THEN RAISE EXCEPTION 'Unsupported variant admitted: % %',v,r; END IF;
    r:=public.fn_create_tournament_governed_legacy(club,jsonb_build_object('gameVariant',v,'maxPlayers',0));
    IF r->>'error'<>'unsupported_tournament_variant' THEN RAISE EXCEPTION 'Direct creator escaped guard: % %',v,r; END IF;
    count_cases:=count_cases+2;
  END LOOP;
  r:=public.fn_create_tournament(club,'{"maxPlayers":0}');
  IF r->>'error'<>'max_players_must_be_positive' THEN RAISE EXCEPTION 'Missing variant default changed: %',r; END IF;
  r:=public.fn_create_tournament(club,'{"gameVariant":null,"maxPlayers":0}');
  IF r->>'error'<>'max_players_must_be_positive' THEN RAISE EXCEPTION 'Null variant default changed: %',r; END IF;
  FOREACH v IN ARRAY ARRAY['[]','null','12','true','"NLH"'] LOOP
    r:=public.fn_create_tournament(club,v::jsonb);
    IF r->>'error'<>'invalid_configuration' THEN RAISE EXCEPTION 'Malformed configuration admitted: % %',v,r; END IF;
    count_cases:=count_cases+1;
  END LOOP;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_create_tournament_governed_legacy(uuid,jsonb)'::regprocedure)<>'d00caa094f988ca352b6f7038f660c19' THEN RAISE EXCEPTION 'Postimage mismatch'; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure)<>'16305fb3739f13e64af6a1e8eb3bf165' THEN RAISE EXCEPTION 'Wrapper changed'; END IF;
  RAISE NOTICE 'PASS: % launch cases, unchanged authority/defaults, guarded direct creator; no tables or financial functions installed or invoked',count_cases+4;
END;
$test$;
