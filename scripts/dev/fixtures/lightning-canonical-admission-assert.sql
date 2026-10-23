
DO $test$
DECLARE a uuid:='10000000-0000-4000-8000-000000000001'; m uuid:='20000000-0000-4000-8000-000000000001'; c uuid:='40000000-0000-4000-8000-000000000001'; result jsonb; msg text;
BEGIN
 IF (SELECT enabled FROM cash_games WHERE id=a) THEN RAISE EXCEPTION 'duplicate Action still enabled'; END IF;
 IF NOT (SELECT enabled FROM cash_games WHERE id=m) THEN RAISE EXCEPTION 'canonical disabled'; END IF;
 IF to_regprocedure('public.fn_cash_canonical_lightning_game(uuid)') IS NOT NULL
 OR to_regprocedure('public.fn_cash_lightning_always_on(uuid)') IS NOT NULL
 OR to_regprocedure('public.fn_cash_retire_lightning_occupancies(uuid,uuid[])') IS NOT NULL THEN RAISE EXCEPTION 'unneeded public API introduced'; END IF;
 IF (SELECT count(*) FROM table_seats WHERE stack=57.35 AND left_at IS NULL AND table_id='50000000-0000-4000-8000-000000000001')<>1 THEN RAISE EXCEPTION 'existing custody changed'; END IF;
 IF (SELECT name FROM tables WHERE id='50000000-0000-4000-8000-000000000001') NOT LIKE '%Lightning Games' THEN RAISE EXCEPTION 'retiring table still named old format'; END IF;
 IF (SELECT auto_start_players FROM tables WHERE id='50000000-0000-4000-8000-000000000001')<>6 THEN RAISE EXCEPTION 'retiring source lost physical minimum'; END IF;
 BEGIN
  PERFORM fn_cash_game_join(a);
  RAISE EXCEPTION 'anonymous join accepted';
 EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
 END;
 PERFORM set_config('fixture.uid','60000000-0000-4000-8000-000000000001',true);
 PERFORM set_config('fixture.barred',a::text,true);
 BEGIN
  PERFORM fn_cash_game_join(a);
  RAISE EXCEPTION 'retired source VPIP bar bypassed';
 EXCEPTION WHEN check_violation THEN GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg NOT LIKE 'GAME_BARRED:%' THEN RAISE; END IF;
 END;
 PERFORM set_config('fixture.barred','',true);
 BEGIN
  PERFORM fn_cash_game_join(a);
  RAISE EXCEPTION 'private membership bypassed';
 EXCEPTION WHEN insufficient_privilege THEN GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg NOT LIKE 'PRIVATE_MEMBERSHIP_REQUIRED:%' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM fn_cash_game_create_impl_20260905(c,'madness','nlh',2,4,6,'{"lightning_enabled":false}');
  RAISE EXCEPTION 'Lightning capability override accepted';
 EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg NOT LIKE 'OVERRIDE_LOCKED:%' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM fn_cash_game_create_impl_20260905(c,'madness','nlh',2,4,6,'{"vpip_floor":0}');
  RAISE EXCEPTION 'VPIP override accepted';
 EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg NOT LIKE 'OVERRIDE_LOCKED:%' THEN RAISE; END IF;
 END;
 result:=fn_cash_game_create_impl_20260905(c,'madness','nlh',2,4,6,'{}');
 IF result->>'lightning_enabled'<>'true' OR result#>>'{snapshot,regular_ante}'<>'bb' OR result#>>'{snapshot,vpip_floor}'<>'40' THEN RAISE EXCEPTION 'new Lightning contract wrong: %',result; END IF;
 IF result#>>'{snapshot,lightning,on_threshold}'<>'5' OR result#>>'{snapshot,lightning,off_threshold}'<>'4' OR result#>>'{snapshot,lightning,worker_mode}'<>'form' THEN RAISE EXCEPTION 'new Lightning population contract wrong: %',result; END IF;
 IF (SELECT role FROM tables WHERE id=(result->>'table_id')::uuid)<>'feeder' THEN RAISE EXCEPTION 'Lightning initial feeder missing'; END IF;
 IF (SELECT cluster_mode FROM cash_games WHERE id=(result->>'game_id')::uuid)<>'pending_on'
 OR (SELECT dealing_halted_reason FROM tables WHERE id=(result->>'table_id')::uuid)<>'lightning_pending_on' THEN RAISE EXCEPTION 'new Lightning visible before original conversion halt'; END IF;
 BEGIN
  PERFORM fn_cash_game_create_impl_20260905(c,'action','nlh',2.00,4.00,6,'{}');
  RAISE EXCEPTION 'alias duplicate accepted';
 EXCEPTION WHEN raise_exception THEN GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg NOT LIKE 'GAME_EXISTS:%' THEN RAISE; END IF;
 END;
 result:=fn_cash_game_create_impl_20260905(c,'classic','nlh',2,4,9,'{}');
 IF result->>'lightning_enabled'<>'false' OR result#>>'{snapshot,regular_ante}'<>'none' THEN RAISE EXCEPTION 'Classic changed'; END IF;
 UPDATE cash_games SET ruleset_snapshot=jsonb_set(ruleset_snapshot,'{canonical_lightning_game_id}',to_jsonb('30000000-0000-4000-8000-000000000001'::text)) WHERE id=a;
 INSERT INTO club_members(club_id,user_id,status) VALUES(c,'60000000-0000-4000-8000-000000000001','active');
 BEGIN
  PERFORM fn_cash_game_join(a);
  RAISE EXCEPTION 'cross-stake alias accepted';
 EXCEPTION WHEN check_violation THEN GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg NOT LIKE 'GAME_CLOSED:%' THEN RAISE; END IF;
 END;
 UPDATE cash_games SET ruleset_snapshot=jsonb_set(ruleset_snapshot,'{canonical_lightning_game_id}',to_jsonb(m::text)) WHERE id=a;
END $test$;

