DO $$DECLARE u uuid:='00000000-0000-0000-0000-000000000001';c uuid:='00000000-0000-0000-0000-000000000011';t uuid:='00000000-0000-0000-0000-000000000021';s uuid:='00000000-0000-0000-0000-000000000031';j jsonb;BEGIN
  PERFORM set_config('request.jwt.claim.sub',u::text,false);
  INSERT INTO clubs VALUES(c,'chips','active'),('00000000-0000-0000-0000-000000000012','diamonds','active'),('00000000-0000-0000-0000-000000000013','chips','retired');
  INSERT INTO club_members VALUES(u,c,'active'),(u,'00000000-0000-0000-0000-000000000012','active'),(u,'00000000-0000-0000-0000-000000000013','active');
  INSERT INTO tables(id,club_id,status) VALUES(t,c,'active');
  INSERT INTO cash_player_session(id,player_id,club_id,scope_type,scope_id,table_id,variant,baseline,opened_at) VALUES(s,u,c,'table',t,t,'nlh',100,now()-interval '1 hour');
  PERFORM fn_cash_session_close(u,t,145,'leave');
  IF NOT EXISTS(SELECT 1 FROM cash_player_session WHERE id=s AND final_stack=145 AND financial_capture_status='exact') THEN RAISE EXCEPTION 'normal close did not capture exact final stack';END IF;
  SELECT ca_player_stats_cash_sessions(u,c,30,'UTC','chips',100) INTO j;
  IF j#>>'{coverage,total_sessions}'<>'1' OR j#>>'{sessions,0,session_result}'<>'45.00' THEN RAISE EXCEPTION 'scoped exact reader failed: %',j;END IF;
  INSERT INTO cash_player_session(id,player_id,club_id,scope_type,scope_id,table_id,variant,baseline,opened_at,closed_at) VALUES
    ('00000000-0000-0000-0000-000000000032',u,'00000000-0000-0000-0000-000000000012','table','00000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-000000000022','nlh',100,now()-interval '1 hour',now()),
    ('00000000-0000-0000-0000-000000000033',u,'00000000-0000-0000-0000-000000000013','table','00000000-0000-0000-0000-000000000023','00000000-0000-0000-0000-000000000023','nlh',100,now()-interval '1 hour',now()),
    ('00000000-0000-0000-0000-000000000034',u,c,'table','00000000-0000-0000-0000-000000000024','00000000-0000-0000-0000-000000000024','nlh',100,now()-interval '90 days',now()-interval '89 days');
  SELECT ca_player_stats_cash_sessions(u,c,30,'UTC','chips',100) INTO j;
  IF j#>>'{coverage,total_sessions}'<>'1' THEN RAISE EXCEPTION 'club/asset/retired/range rows polluted coverage: %',j;END IF;
  IF coalesce((SELECT (x->>'overlap')::boolean FROM jsonb_array_elements(j->'sessions') x WHERE x->>'session_id'=s::text),true) THEN
    RAISE EXCEPTION 'unrelated-club overlap poisoned selected session: %',j;
  END IF;
END$$;

DO $$DECLARE u uuid:='00000000-0000-0000-0000-000000000001';c uuid:='00000000-0000-0000-0000-000000000011';BEGIN
  INSERT INTO tables(id,club_id,status) VALUES
    ('00000000-0000-0000-0000-000000000041',c,'active'),
    ('00000000-0000-0000-0000-000000000042',c,'active'),
    ('00000000-0000-0000-0000-000000000043',c,'active'),
    ('00000000-0000-0000-0000-000000000044',c,'active'),
    ('00000000-0000-0000-0000-000000000045',c,'active');
  INSERT INTO table_seats VALUES
    ('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000041',u,0,now(),NULL),
    ('00000000-0000-0000-0000-000000000052','00000000-0000-0000-0000-000000000043',u,175,now(),NULL),
    ('00000000-0000-0000-0000-000000000053','00000000-0000-0000-0000-000000000044',u,90,now(),NULL);
  INSERT INTO cash_player_session(id,player_id,club_id,scope_type,scope_id,table_id,variant,baseline,opened_at) VALUES
    ('00000000-0000-0000-0000-000000000061',u,c,'table','00000000-0000-0000-0000-000000000041','00000000-0000-0000-0000-000000000041','nlh',100,now()),
    ('00000000-0000-0000-0000-000000000062',u,c,'table','00000000-0000-0000-0000-000000000043','00000000-0000-0000-0000-000000000043','nlh',100,now()),
    ('00000000-0000-0000-0000-000000000063',u,c,'table','00000000-0000-0000-0000-000000000045','00000000-0000-0000-0000-000000000045','nlh',100,now()),
    ('00000000-0000-0000-0000-000000000064',u,c,'table','00000000-0000-0000-0000-000000000044','00000000-0000-0000-0000-000000000044','nlh',100,now());
  UPDATE table_seats SET left_at=now() WHERE id='00000000-0000-0000-0000-000000000051';
  SET CONSTRAINTS zz_close_session_when_seat_vacated IMMEDIATE;
  IF NOT EXISTS(SELECT 1 FROM cash_player_session WHERE id='00000000-0000-0000-0000-000000000061' AND final_stack=0 AND financial_capture_status='exact') THEN RAISE EXCEPTION 'vacate did not capture exact zero';END IF;
  UPDATE tables SET status='closed' WHERE id='00000000-0000-0000-0000-000000000043';
  IF NOT EXISTS(SELECT 1 FROM cash_player_session WHERE id='00000000-0000-0000-0000-000000000062' AND final_stack=175 AND financial_capture_status='exact') THEN RAISE EXCEPTION 'table close did not capture seat stack';END IF;
  UPDATE tables SET status='closed' WHERE id='00000000-0000-0000-0000-000000000045';
  IF NOT EXISTS(SELECT 1 FROM cash_player_session WHERE id='00000000-0000-0000-0000-000000000063' AND final_stack IS NULL AND financial_capture_status='partial') THEN RAISE EXCEPTION 'seatless table close was mislabeled exact';END IF;
  UPDATE cash_player_session SET scope_id='00000000-0000-0000-0000-000000000042',table_id='00000000-0000-0000-0000-000000000042' WHERE id='00000000-0000-0000-0000-000000000064';
  UPDATE table_seats SET left_at=now() WHERE id='00000000-0000-0000-0000-000000000053';
  SET CONSTRAINTS zz_close_session_when_seat_vacated IMMEDIATE;
  IF EXISTS(SELECT 1 FROM cash_player_session WHERE id='00000000-0000-0000-0000-000000000064' AND closed_at IS NOT NULL) THEN RAISE EXCEPTION 'seat move closed the continuous session';END IF;
END$$;

DO $$DECLARE u uuid:='00000000-0000-0000-0000-000000000001';c uuid:='00000000-0000-0000-0000-000000000011';j jsonb;BEGIN
  INSERT INTO tables(id,club_id,status) VALUES
    ('00000000-0000-0000-0000-000000000046',c,'active'),
    ('00000000-0000-0000-0000-000000000047',c,'active'),
    ('00000000-0000-0000-0000-000000000048',c,'active'),
    ('00000000-0000-0000-0000-000000000049','00000000-0000-0000-0000-000000000012','active');
  INSERT INTO table_seats VALUES
    ('00000000-0000-0000-0000-000000000056','00000000-0000-0000-0000-000000000046',u,NULL,now(),NULL),
    ('00000000-0000-0000-0000-000000000057','00000000-0000-0000-0000-000000000047',u,NULL,now(),NULL),
    ('00000000-0000-0000-0000-000000000058','00000000-0000-0000-0000-000000000049',u,250,now(),NULL);
  INSERT INTO cash_player_session(id,player_id,club_id,scope_type,scope_id,table_id,variant,baseline,opened_at) VALUES
    ('00000000-0000-0000-0000-000000000066',u,c,'table','00000000-0000-0000-0000-000000000046','00000000-0000-0000-0000-000000000046','nlh',100,now()),
    ('00000000-0000-0000-0000-000000000067',u,c,'table','00000000-0000-0000-0000-000000000047','00000000-0000-0000-0000-000000000047','nlh',100,now()),
    ('00000000-0000-0000-0000-000000000068',u,c,'table','00000000-0000-0000-0000-000000000048','00000000-0000-0000-0000-000000000048','nlh',100,now()-interval '90 days'),
    ('00000000-0000-0000-0000-000000000069',u,'00000000-0000-0000-0000-000000000012','table','00000000-0000-0000-0000-000000000049','00000000-0000-0000-0000-000000000049','nlh',100,now());
  UPDATE table_seats SET left_at=now() WHERE id='00000000-0000-0000-0000-000000000056';
  SET CONSTRAINTS zz_close_session_when_seat_vacated IMMEDIATE;
  IF NOT EXISTS(SELECT 1 FROM cash_player_session WHERE id='00000000-0000-0000-0000-000000000066'
      AND final_stack IS NULL AND final_stack_captured_at IS NULL AND financial_capture_status='partial') THEN
    RAISE EXCEPTION 'nullable vacated stack was manufactured as exact';
  END IF;
  UPDATE tables SET status='closed' WHERE id='00000000-0000-0000-0000-000000000047';
  IF NOT EXISTS(SELECT 1 FROM cash_player_session WHERE id='00000000-0000-0000-0000-000000000067'
      AND final_stack IS NULL AND final_stack_captured_at IS NULL AND financial_capture_status='partial') THEN
    RAISE EXCEPTION 'nullable table-close stack did not close partial';
  END IF;
  UPDATE table_seats SET left_at=now() WHERE id='00000000-0000-0000-0000-000000000058';
  IF EXISTS(SELECT 1 FROM cash_player_session WHERE id='00000000-0000-0000-0000-000000000069'
      AND closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'diamond seat vacate entered chip cash-session close machinery';
  END IF;
  SELECT ca_player_stats_cash_sessions(u,c,30,'UTC','chips',100) INTO j;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j->'sessions') x
      WHERE x->>'session_id'='00000000-0000-0000-0000-000000000068') THEN
    RAISE EXCEPTION 'open session beginning before range was omitted: %',j;
  END IF;
END$$;
SELECT 'stats exact cash sessions fixture: PASS';
