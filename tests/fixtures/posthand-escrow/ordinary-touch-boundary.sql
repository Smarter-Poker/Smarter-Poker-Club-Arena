BEGIN;
-- Native cache-only synthetic row population, not original financial claims.
INSERT INTO union_pnl_cash_outcome_touches(table_id,hand_number,recognized_at,game_union_id,shaped,accepted_rake,participants)
 SELECT h.table_id,100000000+n,h.recognized_at,'fade0000-0000-0000-0000-000000000002',true,h.accepted_rake,h.participants
 FROM union_pnl_cash_outcome_touches h CROSS JOIN generate_series(1,10000) n WHERE h.hand_number=31008564;
\ir hand-lines-unbounded-candidate.sql
DO $test$BEGIN
 BEGIN
  PERFORM count(*) FROM fn_union_pnl_week_hand_lines('fade0000-0000-0000-0000-000000000002','2026-10-10 18:23:19+00','2026-10-10 18:23:20+00',true);
  RAISE EXCEPTION 'previous candidate did not reproduce original lookup';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'posthand_escrow_projection_touch_disagrees' THEN RAISE;END IF;END;
 RAISE NOTICE 'FAIL-BEFORE unmerged candidate asks original outcome for ordinary shaped cache row';
END $test$;
\i :qualified_hand_lines
DO $test$DECLARE n bigint;valid boolean;BEGIN
 SELECT count(*),bool_and(hand_participants=(SELECT participants FROM union_pnl_cash_outcome_touches WHERE hand_number=31008564)) INTO n,valid
 FROM fn_union_pnl_week_hand_lines('fade0000-0000-0000-0000-000000000002','2026-10-10 18:23:19+00','2026-10-10 18:23:20+00',true);
 IF n<>10000 OR valid IS DISTINCT FROM true THEN RAISE EXCEPTION 'ordinary narrow reader changed participants';END IF;
 IF EXISTS(SELECT 1 FROM union_pnl_cash_outcomes WHERE hand_number BETWEEN 100000001 AND 100010000) THEN RAISE EXCEPTION 'counterexample manufactured originals';END IF;
 RAISE NOTICE 'PASS 10000 ordinary uncertified shaped cache rows return exact old participants without original lookup/projection';
END $test$;
ROLLBACK;
