DO $test$ DECLARE projected boolean; players jsonb; owned numeric; total numeric; BEGIN
 FOREACH projected IN ARRAY ARRAY[false,true] LOOP
 SELECT hand_participants INTO STRICT players FROM fn_union_pnl_week_hand_lines('fade0000-0000-0000-0000-000000000001','2026-10-10 18:23:19.475321+00','2026-10-10 18:23:19.475322+00',projected);
 SELECT sum((p->>'observed_stack_delta')::numeric) FILTER(WHERE p->>'earning_club_id'='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'),sum((p->>'observed_stack_delta')::numeric) INTO owned,total FROM jsonb_array_elements(players) p;
 IF jsonb_array_length(players)<>2 OR owned IS DISTINCT FROM -3.75::numeric OR total IS DISTINCT FROM -3.75::numeric
 OR (SELECT count(*) FROM jsonb_array_elements(players) p WHERE p->'ownership_certified'='true'::jsonb)<>2
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(players) p WHERE p->>'user_id'='0f5f1d65-7ce1-4250-93fe-49078f4f14d1' AND (p->>'observed_stack_delta')::numeric=56.25)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(players) p WHERE (p->>'observed_stack_delta')::numeric IN(368.62,424.87)) THEN RAISE EXCEPTION 'qualified projected owners/delta differ or escrow counted as winnings';END IF;
 RAISE NOTICE 'PASS-AFTER hand lines projected=% both original owners, -60/+56.25 once; total -3.75; escrow excluded',projected;
 END LOOP;
 IF (SELECT md5(evidence::text) FROM union_pnl_cash_outcomes WHERE hand_number=31008564)<>'148cad7b685e11b4d48130d390cb13e1' THEN RAISE EXCEPTION 'historical outcome mutated';END IF;
END $test$;
