-- Run after the real source processor and refusal reader regressions. Their
-- intentionally unresolved u(130) source belongs to the already-closed week.
CREATE OR REPLACE FUNCTION public.fn_accounting_week_clubs(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS TABLE(club_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN RAISE EXCEPTION 'discovery_reached'; END $$;
SELECT assert_true(
 fn_prepare_accounting_week(u(20),NULL,'2026-09-07T07:00Z','2026-09-14T07:00Z')->>'success'='false'
 AND fn_prepare_accounting_week(u(20),NULL,'2026-09-07T07:00Z','2026-09-14T07:00Z')->'problems'->0->>'reason'='cash_source_refusals_pending',
 'an unresolved historical cash source stops union close before discovery or payer work');
SELECT assert_true(
 fn_prepare_accounting_week(NULL,u(40),'2026-09-07T07:00Z','2026-09-14T07:00Z')->'problems'->0->'source_check'->'sources'->0->>'rake_record_id'=u(130)::text,
 'an unknown historical source stops standalone close and retains its exact source identity');
DO $$DECLARE reached boolean:=false;
BEGIN
 BEGIN
  PERFORM fn_prepare_accounting_week(u(20),NULL,'2026-08-31T07:00Z','2026-09-07T07:00Z');
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'discovery_reached' THEN RAISE; END IF;
  reached:=true;
 END;
 PERFORM assert_true(reached,'a different week without unresolved sources proceeds to discovery');
END $$;
SELECT assert_true(NOT has_function_privilege('service_role','fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)','EXECUTE')
 AND NOT has_function_privilege('authenticated','fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)','EXECUTE'),
 'the preparation gate remains private to the single coordinator');
-- Malformed control results must not be interpreted as an empty healthy queue.
CREATE OR REPLACE FUNCTION public.fn_cash_source_refusals_for_period(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$SELECT '{}'::jsonb$$;
SELECT assert_true(fn_prepare_accounting_week(u(20),NULL,'2026-09-07T07:00Z','2026-09-14T07:00Z')->>'success'='false',
 'an incomplete refusal-check result cannot authorize weekly close');
