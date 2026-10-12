DO $test$ DECLARE projected boolean; players jsonb; owned numeric; omitted numeric; BEGIN
 FOREACH projected IN ARRAY ARRAY[false,true] LOOP
 SELECT hand_participants INTO STRICT players FROM fn_union_pnl_week_hand_lines('fade0000-0000-0000-0000-000000000001','2026-10-10 18:23:19.475321+00','2026-10-10 18:23:19.475322+00',projected);
 SELECT sum((p->>'observed_stack_delta')::numeric) FILTER(WHERE p->>'earning_club_id'='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'),sum((p->>'observed_stack_delta')::numeric) FILTER(WHERE p->>'earning_club_id' IS NULL) INTO owned,omitted FROM jsonb_array_elements(players) p;
 IF jsonb_array_length(players)<>2 OR owned IS DISTINCT FROM -60::numeric OR omitted IS DISTINCT FROM 56.25::numeric THEN RAISE EXCEPTION 'old report hand line counterexample changed';END IF;
 RAISE NOTICE 'FAIL-BEFORE hand lines projected=% omit original +56.25 owner, retaining -60',projected;
 END LOOP;
END $test$;
