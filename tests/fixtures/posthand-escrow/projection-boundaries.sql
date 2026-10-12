DO $test$ DECLARE o union_pnl_cash_outcomes; forged union_pnl_cash_outcomes; code text; mutation text; BEGIN
 SELECT * INTO STRICT o FROM union_pnl_cash_outcomes WHERE hand_number=31008564;
 forged:=o;forged.evidence:=jsonb_set(o.evidence,'{participants,1,observed_stack_delta}','424.87');
 IF fn_union_pnl_cash_outcome_accepted(forged) IS DISTINCT FROM false THEN RAISE EXCEPTION 'forged original consumer admitted';END IF;
 BEGIN PERFORM fn_union_pnl_posthand_escrow_participants(forged);RAISE EXCEPTION 'forged original projection admitted';EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'posthand_escrow_projection_original_disagrees' THEN RAISE;END IF;END;
 RAISE NOTICE 'PASS forged/stale composite outcome refuses consumer/projection';
 FOREACH mutation IN ARRAY ARRAY['missing_original','NULL_touch','wrong_touch','wrong_recognized'] LOOP
 BEGIN
  IF mutation='missing_original' THEN DELETE FROM union_pnl_cash_outcomes WHERE hand_number=31008564;
  ELSIF mutation='NULL_touch' THEN UPDATE union_pnl_cash_outcome_touches SET participants=NULL WHERE hand_number=31008564;
  ELSIF mutation='wrong_touch' THEN UPDATE union_pnl_cash_outcome_touches SET participants=jsonb_set(participants,'{1,observed_stack_delta}','424.87') WHERE hand_number=31008564;
  ELSE UPDATE union_pnl_cash_outcome_touches SET recognized_at=recognized_at+'1 microsecond'::interval WHERE hand_number=31008564;END IF;
  BEGIN
   PERFORM * FROM fn_union_pnl_week_hand_lines('fade0000-0000-0000-0000-000000000001','2026-10-10 18:23:19+00','2026-10-10 18:23:20+00',true);
   RAISE EXCEPTION 'projection mismatch silently accepted: %',mutation;
  EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'posthand_escrow_projection_touch_disagrees' THEN RAISE;END IF;END;
  RAISE EXCEPTION 'rollback boundary' USING ERRCODE='PT001';
 EXCEPTION WHEN SQLSTATE 'PT001' THEN RAISE NOTICE 'PASS shaped projected % refuses',mutation;END;
 END LOOP;
 IF fn_union_pnl_cash_outcome_accepted(o) IS DISTINCT FROM true THEN RAISE EXCEPTION 'original restoration failed';END IF;
END $test$;
