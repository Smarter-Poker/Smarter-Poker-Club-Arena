DO $$ DECLARE alias text; message text; answer jsonb; BEGIN
 FOREACH alias IN ARRAY ARRAY['action','madness','lightning'] LOOP
  BEGIN
   PERFORM fn_cash_template_defaults(alias,'pineapple');
   RAISE EXCEPTION 'Unsupported Pineapple Lightning defaults accepted';
  EXCEPTION WHEN raise_exception THEN
   GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
   IF message NOT LIKE 'LIGHTNING_VARIANT_NOT_SUPPORTED:%' THEN RAISE; END IF;
  END;
 END LOOP;
 PERFORM set_config('fixture.uid','60000000-0000-4000-8000-000000000001',true);
 FOREACH alias IN ARRAY ARRAY['action','madness'] LOOP
  BEGIN
   PERFORM fn_cash_game_create_impl_20260905('40000000-0000-4000-8000-000000000001',alias,'pineapple',2,4,6,'{}');
   RAISE EXCEPTION 'Unsupported Pineapple Lightning creation accepted';
  EXCEPTION WHEN raise_exception THEN
   GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
   IF message NOT LIKE 'LIGHTNING_VARIANT_NOT_SUPPORTED:%' THEN RAISE; END IF;
  END;
 END LOOP;
 PERFORM set_config('fixture.uid','',true);
 BEGIN
  PERFORM fn_cash_game_join('71000000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'Pineapple anonymous alias accepted';
 EXCEPTION WHEN SQLSTATE '28000' THEN NULL; END;
 PERFORM set_config('fixture.uid','73000000-0000-4000-8000-000000000001',true);
 BEGIN
  PERFORM fn_cash_game_join('71000000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'Pineapple canonical private auth bypassed';
 EXCEPTION WHEN insufficient_privilege THEN
  GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  -- Private membership is enforced before any canonical seat is disclosed.
  IF message NOT LIKE 'PRIVATE_MEMBERSHIP_REQUIRED:%' THEN RAISE; END IF;
 END;
 INSERT INTO club_members(club_id,user_id,status)
 VALUES('40000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','active');
 INSERT INTO tables(id,cluster_id,role,main_index,name,auto_start_players,lifecycle,game_variant)
 VALUES('75000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001','main',1,'Existing Classic',2,'live','pineapple');
 INSERT INTO table_seats(table_id,user_id,seat_number,stack)
 VALUES('75000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001',1,10);
 answer:=fn_cash_game_join('71000000-0000-4000-8000-000000000001');
 IF answer->>'action' IS DISTINCT FROM 'seated' OR answer->>'table_id' IS DISTINCT FROM '75000000-0000-4000-8000-000000000001' THEN
  RAISE EXCEPTION 'Pineapple alias did not reach its canonical Classic seat: %',answer; END IF;
 PERFORM set_config('fixture.uid','',true);
 IF NOT (SELECT enabled AND name='Existing Classic' AND ruleset_snapshot='{"canonical_existing":true}'::jsonb
  FROM cash_games WHERE id='74000000-0000-4000-8000-000000000001') THEN RAISE EXCEPTION 'Existing Classic canonical changed'; END IF;
 IF (SELECT count(*) FROM cash_games WHERE variant='pineapple' AND template_name='classic'
  AND NOT enabled AND cluster_mode='must_move' AND NOT lightning_enabled
  AND ruleset_snapshot->>'canonical_lightning_game_id'='74000000-0000-4000-8000-000000000001'
  AND ruleset_snapshot->>'regular_ante'='none')<>2 THEN
  RAISE EXCEPTION 'Pineapple legacy games did not remain playable Classic'; END IF;
 IF EXISTS(SELECT 1 FROM cash_games WHERE variant='pineapple' AND (
  ruleset_snapshot->>'min_buyin_bb'<>'100' OR ruleset_snapshot->>'max_buyin_bb'<>'400'
  OR ruleset_snapshot->>'stay_clock_min'<>'17' OR ruleset_snapshot->>'rejoin_window_min'<>'180')) THEN
  RAISE EXCEPTION 'Pineapple buy-in or session clock changed'; END IF;
 IF (SELECT count(*) FROM tables WHERE game_variant='pineapple' AND auto_start_players=2
  AND dealing_halted_reason='lightning_retired' AND name LIKE '%Classic')<>2 THEN
  RAISE EXCEPTION 'Pineapple physical minimum/hold changed'; END IF;
 IF (SELECT count(*) FROM table_seats s JOIN tables t ON t.id=s.table_id WHERE t.game_variant='pineapple'
  AND s.stack=57.35 AND s.left_at IS NULL)<>2 THEN RAISE EXCEPTION 'Pineapple custody changed'; END IF;
 IF EXISTS(SELECT 1 FROM lightning_pool_session p JOIN cash_games g ON g.id=p.cluster_id WHERE g.variant='pineapple') THEN
  RAISE EXCEPTION 'Unsupported Pineapple entered Lightning'; END IF;
END $$;
