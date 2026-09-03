-- Make every Daily Missions dashboard receipt self-identifying.
--
-- Realtime is the fast path, but WebSocket delivery is not a durable queue. A
-- client that misses one revision event needs a cheap way to compare its last
-- atomic dashboard receipt with the server cursor. Locking the per-user cursor
-- while the existing dashboard RPC runs keeps the returned dashboard and
-- revision coherent, including first-load assignment writes made by that RPC.

CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard_v2(
  p_daily_key text,
  p_daily_ids text[],
  p_weekly_key text,
  p_weekly_ids text[],
  p_monthly_key text,
  p_monthly_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_dashboard jsonb;
  v_revision bigint;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  INSERT INTO public.daily_challenge_dashboard_revisions (user_id, revision, updated_at)
  VALUES (v_uid, 1, clock_timestamp())
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM 1
  FROM public.daily_challenge_dashboard_revisions
  WHERE user_id = v_uid
  FOR UPDATE;

  v_dashboard := public.get_daily_challenge_dashboard(
    p_daily_key,
    p_daily_ids,
    p_weekly_key,
    p_weekly_ids,
    p_monthly_key,
    p_monthly_ids
  );

  SELECT revision
    INTO v_revision
    FROM public.daily_challenge_dashboard_revisions
   WHERE user_id = v_uid;

  RETURN v_dashboard || jsonb_build_object('revision', COALESCE(v_revision, 1));
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard_v2(
  text, text[], text, text[], text, text[]
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_challenge_dashboard_v2(
  text, text[], text, text[], text, text[]
) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_daily_challenge_dashboard_v2(
  text, text[], text, text[], text, text[]
) IS 'Atomic Daily Missions dashboard plus its locked per-user revision cursor.';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'get_daily_challenge_dashboard_v2'
      AND p.proargtypes = '25 1009 25 1009 25 1009'::oidvector
      AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'Daily Missions revision-aware dashboard RPC was not created securely';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.get_daily_challenge_dashboard_v2(text,text[],text,text[],text,text[])',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Anonymous callers can execute the Daily Missions dashboard RPC';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
