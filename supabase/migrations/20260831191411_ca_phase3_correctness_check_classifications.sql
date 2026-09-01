-- ZERO-DRIFT phase 3 fixup (prod): fn_ca_settlement_correctness_check used
-- two classification strings not in ca_drift_incidents' CHECK
-- ('reroute_error', 'insurance_error'). Corrected to 'cross_club_posting'
-- and 'reporting_mismatch'. Idempotent.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure);
  v_new := replace(v_def, '''reroute_error''', '''cross_club_posting''');
  v_new := replace(v_new, '''insurance_error''', '''reporting_mismatch''');
  IF v_new <> v_def THEN
    EXECUTE v_new;
  END IF;
END $$;
