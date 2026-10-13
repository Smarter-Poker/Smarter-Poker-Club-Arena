DO $$DECLARE v jsonb;BEGIN
 v:=fn_union_pnl_prove_original_unchanged_stack('10000000-0000-0000-0000-000000000001',200);
 IF v->>'status' IS DISTINCT FROM 'proven' OR v->>'resolution_kind' IS DISTINCT FROM 'original_stack_unchanged_since_accepted_predecessor' THEN RAISE EXCEPTION 'after proof refused %',v;END IF;
 IF (v#>>'{participants,0,dealt_stack_before}')::numeric<>139.55 OR (v#>>'{participants,0,previous_hand,stack_after}')::numeric<>139.55 THEN RAISE EXCEPTION 'after wrong independent original stacks %',v;END IF;
 IF fn_union_pnl_prove_late_seat_credit('10000000-0000-0000-0000-000000000001',200)->>'status' IS DISTINCT FROM 'refused' THEN RAISE EXCEPTION 'late credit contract loosened';END IF;
 RAISE NOTICE 'PASS AFTER: separately proven original unchanged stack, late contract still refuses';END$$;
