-- ═══════════════════════════════════════════════════════════════════════════
--  AN ALERT THAT REPEATS HOURLY BURIES THE ONES THAT DO NOT (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_raise_server_financial_alert inserts unconditionally. Every hourly check
-- that finds the same unfixed thing therefore files it again, and the alert
-- table stops being a list of problems and becomes a list of minutes.
--
-- Measured on the open (unresolved) set, 2026-09-01:
--
--   source                                    open rows   subjects   repeats
--   fn_close_settlement_period                      244          1     244.0
--   FeeReconciler.prize_disbursement                 18          2       9.0
--   drift_incident:fn_ca_money_rpc_drift             10          1      10.0
--   drift_incident:fn_ca_guard_defs_watch             8          1       8.0
--   drift_incident:atomic_credit_wallet_and_log      38         10       3.8
--   FeeReconciler.bbj_unlinkable                     94         33       2.8
--
-- Two of those sources account for more open rows than every genuinely
-- distinct finding on the platform put together, and a critical that matters
-- is one line among them.
--
-- THE FIX IS ONE OPTIONAL PARAMETER. p_dedupe_key: when an UNRESOLVED alert
-- from the same source already carries that key, return ITS id and insert
-- nothing. The caller's contract is unchanged - a uuid still means "durably
-- recorded", which is true, because it is. Callers that pass nothing behave
-- exactly as they do today, so this cannot break anything that already works.
--
-- WHY NOT RETURN NULL FOR A DUPLICATE. NULL is the throttle signal, and the
-- server wrapper escalates a throttled CRITICAL to Sentry on the grounds that
-- it was never recorded. A deduped alert WAS recorded. Returning NULL would
-- move the noise from one system to another rather than removing it.
--
-- ROLLBACK
--   Restore the four-argument body from the migration that introduced it; the
--   new five-argument form can be dropped with
--   DROP FUNCTION IF EXISTS public.fn_raise_server_financial_alert(text,text,text,jsonb,text);

CREATE OR REPLACE FUNCTION public.fn_raise_server_financial_alert(
  p_severity text,
  p_source text,
  p_message text,
  p_context jsonb DEFAULT '{}'::jsonb,
  p_dedupe_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id     uuid;
  v_sev    text;
  v_source text;
  v_key    text;
  v_recent integer;
BEGIN
  v_sev := lower(coalesce(p_severity, 'info'));
  IF v_sev NOT IN ('critical', 'warning', 'info') THEN
    v_sev := 'info';
  END IF;

  v_source := left(coalesce(nullif(p_source, ''), 'unknown'), 200);
  v_key    := left(nullif(btrim(coalesce(p_dedupe_key, '')), ''), 200);

  /* ONE OPEN ALERT PER THING THAT IS WRONG. Not per pass over it. */
  IF v_key IS NOT NULL THEN
    SELECT fa.id INTO v_id
      FROM public.financial_alerts fa
     WHERE fa.source = v_source
       AND fa.resolved IS NOT TRUE
       AND fa.context ->> 'dedupe_key' = v_key
     ORDER BY fa.created_at DESC
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT count(*) INTO v_recent
    FROM public.financial_alerts
   WHERE created_at > now() - interval '1 minute'
     AND source = v_source
     AND context ->> 'channel' = 'server_rpc';

  IF v_recent >= 60 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved)
  VALUES (
    v_sev,
    v_source,
    left(coalesce(nullif(p_message, ''), '(no message)'), 4000),
    coalesce(p_context, '{}'::jsonb)
      || jsonb_build_object('channel', 'server_rpc')
      || CASE WHEN v_key IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('dedupe_key', v_key) END,
    false
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb, text) IS
  'Durable server-side financial alert. Pass p_dedupe_key to get one OPEN alert per thing that is wrong rather than one per pass over it: an unresolved alert from the same source carrying that key is returned instead of a second row being written. Returns the row id (deduped or new), or NULL only when the per-source flood guard fires.';

REVOKE ALL ON FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb, text) TO service_role;

/* The four-argument overload is dropped so no caller can silently keep the
   old behaviour by arity. Every existing call site passes four arguments or
   fewer BY NAME through PostgREST, which resolves to the new function because
   p_dedupe_key has a default. */
DROP FUNCTION IF EXISTS public.fn_raise_server_financial_alert(text, text, text, jsonb);

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'fn_raise_server_financial_alert') <> 1 THEN
    RAISE EXCEPTION 'fn_raise_server_financial_alert must have exactly one overload';
  END IF;
END $$;
