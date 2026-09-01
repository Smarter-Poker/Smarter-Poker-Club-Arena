-- Follow-up to 20260901_no_result_without_a_hand_detector.sql, folded into that
-- file in the repo. check-definer-authorization refuses a SECURITY DEFINER
-- writer a browser role can execute that never asks who is calling. Nobody in a
-- browser calls a sweep. PUBLIC is named as well as the roles: revoking anon and
-- authenticated while PUBLIC still holds EXECUTE reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_detect_results_without_a_hand(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_detect_results_without_a_hand(integer) TO service_role;

DO $$
DECLARE
  v_acls text[];
  v_entry text;
BEGIN
  SELECT array_agg(a::text) INTO v_acls
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL unnest(p.proacl) AS a
   WHERE n.nspname = 'public' AND p.proname = 'fn_detect_results_without_a_hand';

  FOREACH v_entry IN ARRAY COALESCE(v_acls, ARRAY[]::text[]) LOOP
    IF v_entry LIKE '=%' OR v_entry LIKE 'anon=%' OR v_entry LIKE 'authenticated=%' THEN
      RAISE EXCEPTION 'fn_detect_results_without_a_hand is still reachable from a browser role: %', v_entry;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(v_acls, ARRAY[]::text[])) e
                  WHERE e LIKE 'service_role=X%') THEN
    RAISE EXCEPTION 'fn_detect_results_without_a_hand lost its service_role grant: %', v_acls;
  END IF;
END $$;
