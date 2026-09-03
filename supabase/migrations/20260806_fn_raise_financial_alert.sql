-- Audit Wave 1, finding M7: financial CRITICAL alerts are swallowed.
--
-- public.financial_alerts has RLS enabled with exactly ONE policy, scoped to
-- service_role. Every client-side insert therefore fails with 42501, and
-- FinancialAlertService downgraded that to console.warn and returned void.
-- Net effect in production: 100% of client-initiated financial alerts vanish.
-- The table confirms it — all 1383 rows are severity='critical' and the most
-- recent is 2026-04-18, i.e. the client channel has been dead for months while
-- every "ops will be alerted" recovery path assumed it worked.
--
-- Fix: a SECURITY DEFINER raise-only entry point. Authenticated clients may
-- RAISE an alert; they still cannot read, update or resolve one. A per-reporter
-- throttle keeps a buggy loop or a malicious client from flooding the ops table
-- without ever silently dropping the first alerts of a burst.

CREATE OR REPLACE FUNCTION public.fn_raise_financial_alert(
  p_severity text,
  p_source   text,
  p_message  text,
  p_context  jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id       uuid;
  v_sev      text;
  v_uid      uuid := auth.uid();
  v_recent   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required to raise a financial alert'
      USING ERRCODE = '28000';
  END IF;

  v_sev := lower(coalesce(p_severity, 'info'));
  IF v_sev NOT IN ('critical', 'warning', 'info') THEN
    v_sev := 'info';
  END IF;

  -- Flood guard: at most 30 alerts per reporter per minute. Returning NULL
  -- rather than raising keeps the caller's error path clean; the caller still
  -- escalates to its own error reporter when it gets no id back.
  SELECT count(*) INTO v_recent
    FROM public.financial_alerts
   WHERE created_at > now() - interval '1 minute'
     AND context ->> 'reported_by' = v_uid::text;
  IF v_recent >= 30 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved)
  VALUES (
    v_sev,
    left(coalesce(nullif(p_source, ''), 'unknown'), 200),
    left(coalesce(nullif(p_message, ''), '(no message)'), 4000),
    coalesce(p_context, '{}'::jsonb)
      || jsonb_build_object('reported_by', v_uid::text, 'channel', 'client_rpc'),
    false
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_raise_financial_alert(text, text, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.fn_raise_financial_alert(text, text, text, jsonb)
  TO authenticated, service_role;

-- Supabase's ALTER DEFAULT PRIVILEGES also grants EXECUTE on new public
-- functions to anon, which the REVOKE ... FROM public above does not remove.
-- The function already refuses a NULL auth.uid(), but an unauthenticated role
-- should not hold the grant at all.
REVOKE EXECUTE ON FUNCTION public.fn_raise_financial_alert(text, text, text, jsonb) FROM anon;

COMMENT ON FUNCTION public.fn_raise_financial_alert(text, text, text, jsonb) IS
  'Audit M7: raise-only entry point for client financial alerts. financial_alerts RLS is service_role-only, so clients must route through this SECURITY DEFINER function. Throttled to 30 alerts/reporter/minute; returns NULL when throttled.';

-- Index supporting the throttle lookup (and general per-reporter forensics).
CREATE INDEX IF NOT EXISTS idx_financial_alerts_reported_by_created
  ON public.financial_alerts ((context ->> 'reported_by'), created_at DESC);
