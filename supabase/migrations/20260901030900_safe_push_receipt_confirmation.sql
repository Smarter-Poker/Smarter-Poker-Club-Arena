-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901030900; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A delivery receipt proves only that this exact endpoint painted a
-- notification. It does not prove another endpoint with the same generic
-- browser user-agent or device label belongs to the same physical device.
-- Endpoint rotation is handled at authenticated subscribe time with the
-- stable device_id/replacesEndpoint evidence; receipt confirmation must never
-- retire a second legitimate iPhone, Android device, or Mac.
CREATE OR REPLACE FUNCTION public.confirm_push_subscription_receipt(p_endpoint text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.push_subscriptions
     SET last_receipt_at = now(),
         updated_at = now()
   WHERE endpoint = p_endpoint
     AND is_active;
END;
$$
REVOKE ALL ON FUNCTION public.confirm_push_subscription_receipt(text) FROM public
REVOKE ALL ON FUNCTION public.confirm_push_subscription_receipt(text) FROM anon
REVOKE ALL ON FUNCTION public.confirm_push_subscription_receipt(text) FROM authenticated
GRANT EXECUTE ON FUNCTION public.confirm_push_subscription_receipt(text) TO service_role
DO $$
BEGIN
  IF to_regprocedure('public.confirm_push_subscription_receipt(text)') IS NULL THEN
    RAISE EXCEPTION 'safe receipt confirmation function is missing';
  END IF;
  IF has_function_privilege('anon', 'public.confirm_push_subscription_receipt(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.confirm_push_subscription_receipt(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.confirm_push_subscription_receipt(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'receipt confirmation privileges are unsafe';
  END IF;
END $$
