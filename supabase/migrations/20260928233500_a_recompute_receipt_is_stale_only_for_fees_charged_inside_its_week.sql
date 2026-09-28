-- A RECOMPUTE RECEIPT IS STALE ONLY FOR FEES CHARGED INSIDE ITS WEEK (2026-09-28).
--
-- Follow-up to 20260928233000. accounting_tournament_fee_sources has no
-- earned_at, so the reuse test treated every tournament fee source of the club
-- recorded after the receipt as new evidence for the closed week, including
-- fees charged in the following week (1,039 for Deep Stack Society, all
-- charged after 2026-09-28 07:00). A fee can belong to a week only if it was
-- charged before that week ended, so the test now also requires
-- charged_at < p_to. Conservative: any fee charged before the week's end and
-- recorded after the receipt still forces the recompute.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $patch$
DECLARE source text; needle text; replacement text;
BEGIN
 source:=pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 IF md5(source) IS DISTINCT FROM 'ffc420357ae52db28848dcb28f2263e6' THEN
  RAISE EXCEPTION 'preimage mismatch: fn_prepare_accounting_week is not 20260928233000'; END IF;
 needle:=$n$       WHERE f.club_id=club AND f.recorded_at>q.attempted_at-interval '1 minute')) THEN$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'reuse_test_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$       WHERE f.club_id=club AND f.charged_at<p_to AND f.recorded_at>q.attempted_at-interval '1 minute')) THEN$r$;
 EXECUTE replace(source,needle,replacement);
END $patch$;

REVOKE ALL ON FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated, service_role;

DO $post$
BEGIN
 IF position('f.charged_at<p_to' in pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'postimage: charged_at bound not installed'; END IF;
END $post$;
COMMIT;
