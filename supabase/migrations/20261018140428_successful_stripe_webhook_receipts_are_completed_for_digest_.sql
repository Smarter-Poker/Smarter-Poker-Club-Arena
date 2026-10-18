-- Successful webhook completion is recorded as done by complete_stripe_webhook_event.
-- Both Oct16 payment problems were done receipts, not failed payments.
-- Preserve legacy completed receipts and retain pending, unknown and failed states.
-- @live-proof: md5(pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure)) = '578cb5d7c2f80139eefa395a59cbd3d0'
BEGIN;
SET LOCAL lock_timeout='3s';
DO $migration$
DECLARE source text; patched text;
BEGIN
 source:=pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure);
 IF md5(source)<>'8056093672bc76bbe02244a6615af79c' THEN RAISE EXCEPTION 'digest metrics preimage changed';END IF;
 patched:=replace(source, 'processing_status IS DISTINCT FROM ''completed''',
  '(processing_status IS NULL OR processing_status NOT IN (''done'',''completed''))');
 IF patched=source THEN RAISE EXCEPTION 'digest receipt substitution failed';END IF;
 EXECUTE patched;
 IF pg_get_functiondef('public.fn_sp_daily_metrics_compute(date)'::regprocedure) IS DISTINCT FROM patched
 THEN RAISE EXCEPTION 'digest metrics readback mismatch'; END IF;
END $migration$;
COMMIT;
