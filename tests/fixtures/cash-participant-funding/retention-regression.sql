-- The real pruning owner must keep seven-day and exactly-eight-day hands.
DO $$ DECLARE n integer; h uuid; younger uuid; boundary uuid; older uuid; human uuid; v_reported uuid; caught boolean:=false;
BEGIN
 h:='20000000-0000-4000-8000-000000000001';
 INSERT INTO hand_history(table_id,hand_number,created_at,players) VALUES(h,2000001,now()-interval '7 days 12 hours','[{"userId":"40000000-0000-4000-8000-000000000002"}]') RETURNING id INTO younger;
 INSERT INTO hand_history(table_id,hand_number,created_at,players) VALUES(h,2000002,now()-interval '8 days','[{"userId":"40000000-0000-4000-8000-000000000002"}]') RETURNING id INTO boundary;
 INSERT INTO hand_history(table_id,hand_number,created_at,players) VALUES(h,2000003,now()-interval '8 days 1 hour','[{"userId":"40000000-0000-4000-8000-000000000002"}]') RETURNING id INTO older;
 INSERT INTO hand_history(table_id,hand_number,created_at,players,has_human) VALUES(h,2000004,now()-interval '9 days','[{"userId":"40000000-0000-4000-8000-000000000002"}]',true) RETURNING id INTO human;
 INSERT INTO hand_history(table_id,hand_number,created_at,players,reported) VALUES(h,2000005,now()-interval '9 days','[{"userId":"40000000-0000-4000-8000-000000000002"}]',true) RETURNING id INTO v_reported;
 n:=sp_prune_hand_history(100);
 IF n<>1 OR EXISTS(SELECT 1 FROM hand_history WHERE id=older)
  OR (SELECT count(*) FROM hand_history WHERE id=ANY(ARRAY[younger,boundary,human,v_reported]))<>4 THEN
  RAISE EXCEPTION 'Eight-day pruning boundary or protected-history behavior failed'; END IF;
 IF (fn_hand_history_prune_backlog()->>'retention_days')::integer<>8
  OR (fn_prune_ca_hand_facts(10)->>'retention_days')::integer<>8 THEN
  RAISE EXCEPTION 'Dependent retention consumers did not adopt eight days'; END IF;
 BEGIN UPDATE hand_history_retention_policy SET horse_retention_days=7 WHERE id IS TRUE;
 EXCEPTION WHEN check_violation THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'Retention floor may not regress below eight days'; END IF;
END $$;
