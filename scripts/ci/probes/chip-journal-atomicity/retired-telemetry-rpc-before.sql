CREATE OR REPLACE FUNCTION public.fn_sentry_budget_take(p_fingerprint text, p_daily_limit integer DEFAULT 60, p_fingerprint_limit integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_day      date := (now() AT TIME ZONE 'utc')::date;
    v_fp       text := COALESCE(NULLIF(left(p_fingerprint, 200), ''), 'unknown');
    v_fp_sent  integer;
    v_sent     integer;
BEGIN
    DELETE FROM public.sentry_event_budget       WHERE day < v_day - 14;
    DELETE FROM public.sentry_event_fingerprints WHERE day < v_day - 14;

    INSERT INTO public.sentry_event_budget (day, sent)
        VALUES (v_day, 0) ON CONFLICT (day) DO NOTHING;
    INSERT INTO public.sentry_event_fingerprints (day, fingerprint, sent)
        VALUES (v_day, v_fp, 0) ON CONFLICT (day, fingerprint) DO NOTHING;

    UPDATE public.sentry_event_fingerprints
       SET sent = sent + 1
     WHERE day = v_day AND fingerprint = v_fp AND sent < p_fingerprint_limit
    RETURNING sent INTO v_fp_sent;

    IF v_fp_sent IS NULL THEN
        SELECT sent INTO v_fp_sent FROM public.sentry_event_fingerprints
         WHERE day = v_day AND fingerprint = v_fp;
        SELECT sent INTO v_sent FROM public.sentry_event_budget WHERE day = v_day;
        RETURN jsonb_build_object(
            'allowed', false, 'reason', 'fingerprint_cap',
            'sent', COALESCE(v_sent, 0), 'fingerprint_sent', COALESCE(v_fp_sent, 0));
    END IF;

    UPDATE public.sentry_event_budget
       SET sent = sent + 1
     WHERE day = v_day AND sent < p_daily_limit
    RETURNING sent INTO v_sent;

    IF v_sent IS NULL THEN
        UPDATE public.sentry_event_fingerprints
           SET sent = GREATEST(sent - 1, 0)
         WHERE day = v_day AND fingerprint = v_fp;
        SELECT sent INTO v_sent FROM public.sentry_event_budget WHERE day = v_day;
        RETURN jsonb_build_object(
            'allowed', false, 'reason', 'daily_budget',
            'sent', COALESCE(v_sent, 0), 'fingerprint_sent', GREATEST(v_fp_sent - 1, 0));
    END IF;

    RETURN jsonb_build_object(
        'allowed', true, 'reason', 'ok',
        'sent', v_sent, 'fingerprint_sent', v_fp_sent);
END;
$function$
;
