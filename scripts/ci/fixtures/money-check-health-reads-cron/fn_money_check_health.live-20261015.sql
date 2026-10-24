CREATE OR REPLACE FUNCTION public.fn_money_check_health(p_stale_multiple numeric DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_mult    numeric := GREATEST(COALESCE(p_stale_multiple, 3), 1);
  v_rows    jsonb   := '[]'::jsonb;
  v_stale   integer := 0;
  v_never   integer := 0;
  v_alerts  integer := 0;
  r         record;
BEGIN
  FOR r IN
    SELECT h.check_name, h.expected_interval_minutes AS every_min, h.last_run_at,
           h.run_count, h.note,
           CASE WHEN h.last_run_at IS NULL THEN NULL
                ELSE round(EXTRACT(epoch FROM (now() - h.last_run_at)) / 60.0, 1)
           END AS age_min
      FROM public.money_check_heartbeat h
     ORDER BY h.check_name
  LOOP
    DECLARE
      v_is_stale boolean := (r.last_run_at IS NULL)
                            OR (r.age_min > r.every_min * v_mult);
    BEGIN
      v_rows := v_rows || jsonb_build_object(
        'check', r.check_name, 'every_minutes', r.every_min,
        'last_run_at', r.last_run_at, 'age_minutes', r.age_min,
        'runs', r.run_count, 'stale', v_is_stale);

      IF v_is_stale THEN
        v_stale := v_stale + 1;
        IF r.last_run_at IS NULL THEN v_never := v_never + 1; END IF;

        PERFORM public.fn_raise_server_financial_alert(
          'critical', 'fn_money_check_health',
          CASE WHEN r.last_run_at IS NULL THEN
            format('%s has never run. It is expected every %s minutes, and until it does its silence means nothing.',
                   r.check_name, r.every_min)
          ELSE
            format('%s last ran %s minutes ago and is expected every %s. A check that stops looks exactly like a check finding nothing.',
                   r.check_name, r.age_min, r.every_min)
          END,
          jsonb_build_object('kind','money_check_stale','check', r.check_name,
            'every_minutes', r.every_min, 'last_run_at', r.last_run_at,
            'age_minutes', r.age_min, 'runs', r.run_count, 'purpose', r.note,
            'detail','no money was moved by this check'),
          r.check_name);
        v_alerts := v_alerts + 1;
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'stale_multiple', v_mult,
    'checks', jsonb_array_length(v_rows),
    'stale', v_stale,
    'never_run', v_never,
    'conditions_alerted', v_alerts,
    'board', v_rows);
END;
$function$
