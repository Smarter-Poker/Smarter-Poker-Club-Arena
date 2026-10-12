DO $$DECLARE v jsonb;BEGIN
 v:=fn_union_pnl_prove_late_seat_credit('10000000-0000-0000-0000-000000000001',200);
 IF v->>'status' IS DISTINCT FROM 'refused' OR v->>'reason' IS DISTINCT FROM 'starting_stack_not_explained_by_receipts' THEN RAISE EXCEPTION 'before-contract mismatch %',v;END IF;
 IF (SELECT fn_union_pnl_cash_outcome_accepted(o) FROM union_pnl_cash_outcomes o WHERE hand_number=200) THEN RAISE EXCEPTION 'before unexpected financial acceptance';END IF;
 RAISE NOTICE 'PASS BEFORE: original unchanged stack remains blocked; existing late contract correctly refuses';END$$;
