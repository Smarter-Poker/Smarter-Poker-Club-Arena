BEGIN;
DO $$ DECLARE r jsonb; again jsonb; e jsonb; survivor jsonb; n integer; BEGIN
 SELECT expected INTO STRICT e FROM original_paid_fixture.input;
 SELECT to_jsonb(s) INTO survivor FROM public.table_seats s WHERE id='b7400000-0000-4000-8000-000000000002';
 IF public.fn_ca_tournament_chip_supply('b7200000-0000-4000-8000-000000000001')<>320000
 OR public.fn_ca_tournament_felt_total('b7200000-0000-4000-8000-000000000001')<>320000 THEN RAISE EXCEPTION 'native opening money differs'; END IF;
 r:=public.fn_ca_assign_tournament_player_seat_locked('b7200000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001','b7300000-0000-4000-8000-000000000001',1);
 IF r->>'reason' IS DISTINCT FROM 'tournament_chip_conservation' THEN RAISE EXCEPTION 'ordinary guard changed: %',r; END IF;
 RAISE NOTICE 'CUSTODY PASS: ordinary assignment preserves conservation refusal';
 r:=public.fn_ca_resume_original_paid_tournament_entry('b7c00000-0000-4000-8000-000000000001',e);
 IF r->>'ok' IS DISTINCT FROM 'true' OR (r->>'stack')::numeric IS DISTINCT FROM 2500
 OR (r->>'scoring_excess')::numeric IS DISTINCT FROM 5000 THEN RAISE EXCEPTION 'custody transfer differs: %',r; END IF;
 IF public.fn_ca_tournament_chip_supply('b7200000-0000-4000-8000-000000000001')<>320000
 OR (SELECT to_jsonb(a) FROM public.tournament_felt_supply_acknowledgements a WHERE a.tournament_id='b7200000-0000-4000-8000-000000000001') IS DISTINCT FROM e->'supply_acknowledgement'
 OR NOT EXISTS(SELECT 1 FROM public.tournament_paid_stack_custody_receipts WHERE id='b7c00000-0000-4000-8000-000000000001' AND funded_supply=317500 AND scoring_excess=5000)
 OR public.fn_ca_tournament_felt_total('b7200000-0000-4000-8000-000000000001')<>322500
 OR (SELECT to_jsonb(s) FROM public.table_seats s WHERE id='b7400000-0000-4000-8000-000000000002') IS DISTINCT FROM survivor
 THEN RAISE EXCEPTION 'survivor or existing funding changed'; END IF;
 RAISE NOTICE 'CUSTODY PASS: original2500 transferred and320000 survivor preserved';
 IF NOT EXISTS(SELECT 1 FROM public.tournament_knockout_candidates c
 WHERE c.id=(e->>'candidate_id')::uuid AND c.state='rebought' AND c.resolved_at IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.id=(r->>'seat_id')::uuid
 AND s.user_id=(e->>'user_id')::uuid AND s.stack=2500 AND s.left_at IS NULL
 AND s.joined_at>(e->'candidate'->>'seat_joined_at')::timestamptz AND s.occupancy_id IS NOT NULL
 AND s.occupancy_id::text IS DISTINCT FROM e->'original_seat'->>'occupancy_id')
 THEN RAISE EXCEPTION 'old generation not retired or new occupancy missing'; END IF;
 RAISE NOTICE 'CUSTODY PASS: original candidate closed and fresh occupancy bound';
 again:=public.fn_ca_resume_original_paid_tournament_entry('b7c00000-0000-4000-8000-000000000001',e);
 IF again IS DISTINCT FROM r||'{"replayed":true}'::jsonb THEN RAISE EXCEPTION 'same receipt replay differs'; END IF;
 RAISE NOTICE 'CUSTODY PASS: exact replay returns original receipt';
 BEGIN PERFORM public.fn_ca_resume_original_paid_tournament_entry('b7c00000-0000-4000-8000-000000000001',e||'{"grant_chips":2501}'::jsonb);
 RAISE EXCEPTION 'changed replay accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN
 IF SQLERRM<>'ORIGINAL_PAID_CHANGED_REPLAY' THEN RAISE; END IF; END;
 RAISE NOTICE 'CUSTODY PASS: changed replay refused';
 SET CONSTRAINTS ALL IMMEDIATE;
 BEGIN UPDATE public.tournament_paid_stack_custody_receipts SET scoring_excess=scoring_excess+1;
 RAISE EXCEPTION 'immutable receipt changed'; EXCEPTION WHEN SQLSTATE '55000' THEN
 IF SQLERRM<>'ORIGINAL_PAID_CUSTODY_IMMUTABLE' THEN RAISE; END IF; END;
 BEGIN DELETE FROM public.tournament_paid_stack_custody_receipts;
 RAISE EXCEPTION 'immutable receipt deleted'; EXCEPTION WHEN SQLSTATE '55000' THEN
 IF SQLERRM<>'ORIGINAL_PAID_CUSTODY_IMMUTABLE' THEN RAISE; END IF; END;
 BEGIN TRUNCATE public.tournament_paid_stack_custody_receipts;
 RAISE EXCEPTION 'immutable receipt truncated'; EXCEPTION WHEN SQLSTATE '55000' THEN
 IF SQLERRM<>'ORIGINAL_PAID_CUSTODY_IMMUTABLE' THEN RAISE; END IF; END;
 RAISE NOTICE 'CUSTODY PASS: update delete and truncate refused';
 SET CONSTRAINTS ALL IMMEDIATE;
 RAISE NOTICE 'CUSTODY PASS: deferred receipt and real financial guards complete';
END $$;
-- @OUTCOME@
