-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831162000; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A browser can mint a new endpoint and installation id after cleared site
-- data or a PWA reinstall. Keep a newer, physically confirmed endpoint and
-- retire older never-confirmed rows for the same account and device signature.
CREATE OR REPLACE FUNCTION public.confirm_push_subscription_receipt(p_endpoint text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current public.push_subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO v_current
    FROM public.push_subscriptions
   WHERE endpoint = p_endpoint
     AND is_active
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.push_subscriptions
     SET last_receipt_at = now(), updated_at = now()
   WHERE id = v_current.id
     AND is_active;

  UPDATE public.push_subscriptions older
     SET is_active = false,
         last_failure_reason = 'superseded_by_confirmed_device',
         updated_at = now()
   WHERE older.user_id = v_current.user_id
     AND older.id <> v_current.id
     AND older.is_active
     AND older.last_receipt_at IS NULL
     AND older.created_at < v_current.created_at
     AND older.device_label IS NOT DISTINCT FROM v_current.device_label
     AND older.user_agent IS NOT DISTINCT FROM v_current.user_agent;
END;
$$
REVOKE ALL ON FUNCTION public.confirm_push_subscription_receipt(text) FROM public
GRANT EXECUTE ON FUNCTION public.confirm_push_subscription_receipt(text) TO anon, authenticated, service_role
-- Reconcile existing rows with the same evidence rule. This is recoverable:
-- rows are retained and can be re-enabled by a fresh browser subscription.
UPDATE public.push_subscriptions older
   SET is_active = false,
       last_failure_reason = 'superseded_by_confirmed_device',
       updated_at = now()
 WHERE older.is_active
   AND older.last_receipt_at IS NULL
   AND EXISTS (
     SELECT 1
       FROM public.push_subscriptions confirmed
      WHERE confirmed.user_id = older.user_id
        AND confirmed.id <> older.id
        AND confirmed.is_active
        AND confirmed.last_receipt_at IS NOT NULL
        AND confirmed.created_at > older.created_at
        AND confirmed.device_label IS NOT DISTINCT FROM older.device_label
        AND confirmed.user_agent IS NOT DISTINCT FROM older.user_agent
   )
DO $$
BEGIN
  IF to_regprocedure('public.confirm_push_subscription_receipt(text)') IS NULL THEN
    RAISE EXCEPTION 'confirmed receipt reconciliation function is missing';
  END IF;
END $$
