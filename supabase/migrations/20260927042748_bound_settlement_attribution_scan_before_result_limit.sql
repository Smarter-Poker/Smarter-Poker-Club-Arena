-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure)) = 'dbaa8f091599d0ecd9bdb2e56b85536f')
-- Job178 repeatedly exhausted 120s in C1. LIMIT's row goal selected a scan
-- of every historical attribution and a rake-record lookup for each.
-- Materializing the unchanged aggregate removes that row goal from the join;
-- the same 24h boundary, rounding, threshold and outer result limit remain.
-- Read-only production candidate: 19.359s with parallel workers disabled;
-- no observer, alert or financial writer was invoked to obtain that plan.
BEGIN;
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='8s';
DO $repair$
DECLARE
  v_original text;
  v_old constant text := $old$    SELECT rr.id AS record_id, rr.club_id, rr.rake_amount, round(sum(ra.rake_amount),2) AS attributed
    FROM public.rake_records rr
    JOIN public.rake_attributions ra ON ra.rake_record_id = rr.id
    WHERE rr.created_at > now() - interval '24 hours'
    GROUP BY rr.id, rr.club_id, rr.rake_amount
    HAVING round(sum(ra.rake_amount),2) > round(rr.rake_amount,2) + 0.01
    LIMIT 20$old$;
  v_new constant text := $new$    WITH attributed AS MATERIALIZED (
      SELECT rr.id AS record_id, rr.club_id, rr.rake_amount, round(sum(ra.rake_amount),2) AS attributed
      FROM public.rake_records rr
      JOIN public.rake_attributions ra ON ra.rake_record_id = rr.id
      WHERE rr.created_at > now() - interval '24 hours'
      GROUP BY rr.id, rr.club_id, rr.rake_amount
      HAVING round(sum(ra.rake_amount),2) > round(rr.rake_amount,2) + 0.01
    )
    SELECT * FROM attributed LIMIT 20$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_original FROM pg_proc p
  WHERE p.oid='public.fn_ca_settlement_correctness_check()'::regprocedure
    AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v'
    AND p.proacl=ARRAY['postgres=X/postgres','service_role=X/postgres']::aclitem[]
    AND p.proconfig=ARRAY['search_path=public'];
  IF md5(v_original) IS DISTINCT FROM '6592ae7ce48565652dd101a85ecd8172'
     OR length(v_original)-length(replace(v_original,v_old,'')) <> length(v_old) THEN
    RAISE EXCEPTION 'SETTLEMENT_ATTRIBUTION_SOURCE_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE replace(v_original,v_old,v_new);
END $repair$;
COMMIT;
