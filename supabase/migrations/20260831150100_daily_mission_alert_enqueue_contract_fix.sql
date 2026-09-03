-- ═══════════════════════════════════════════════════════════════════════════
-- 20260831150100_daily_mission_alert_enqueue_contract_fix.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- TIER:        2
-- AUTHOR:      Codex
-- AFFECTS:     enqueue_daily_mission_reset_notifications
-- IRREVERSIBLE: no
--
-- WHY:
--   The Phase 6 migration's live rollback probe found that the production
--   notifications contract stores notification copy in `message`; it does not
--   carry a `body` column. Replace the new RPC before any scheduled call can
--   reach it. The failed probe rolled back its preference and delivery rows.

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notifications'
      AND column_name = 'message'
  ) THEN
    RAISE EXCEPTION 'pre-flight failed: notifications.message is missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notifications'
      AND column_name = 'body'
  ) THEN
    RAISE EXCEPTION 'pre-flight failed: notifications.body now exists; re-audit the insert contract';
  END IF;
  IF to_regprocedure('public.enqueue_daily_mission_reset_notifications(date,integer)') IS NULL THEN
    RAISE EXCEPTION 'pre-flight failed: enqueue RPC is missing';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.enqueue_daily_mission_reset_notifications(
  p_cycle_date date DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  IF p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 5000';
  END IF;

  INSERT INTO public.notifications (
    user_id,
    type,
    title,
    message,
    link,
    action_url,
    read,
    is_read,
    data
  )
  SELECT
    p.user_id,
    'daily_challenge',
    'Daily Missions Are Live',
    'A Fresh Set Of Poker Missions And Rewards Is Ready In Club Arena.',
    '/hub/club-arena/challenges',
    '/hub/club-arena/challenges',
    false,
    false,
    jsonb_build_object(
      'source', 'club_arena_daily_missions',
      'cycle_date', p_cycle_date::text,
      'tier', 'daily'
    )
  FROM public.user_notification_preferences p
  WHERE p.daily_mission_reminders IS TRUE
    AND NOT EXISTS (
      SELECT 1
      FROM public.notifications n
      WHERE n.user_id = p.user_id
        AND n.type = 'daily_challenge'
        AND n.data ->> 'source' = 'club_arena_daily_missions'
        AND n.data ->> 'cycle_date' = p_cycle_date::text
    )
  ORDER BY p.user_id
  LIMIT p_limit
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_daily_mission_reset_notifications(date, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_daily_mission_reset_notifications(date, integer)
  TO service_role;

DO $postapply$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef('public.enqueue_daily_mission_reset_notifications(date,integer)'::regprocedure)
    INTO v_definition;
  IF v_definition !~ 'INSERT INTO public.notifications' OR v_definition !~ 'message' THEN
    RAISE EXCEPTION 'post-apply failed: corrected notification insert is missing';
  END IF;
  IF v_definition ~ E'\\n\\s*body,?' THEN
    RAISE EXCEPTION 'post-apply failed: phantom notifications.body remains in RPC';
  END IF;
END;
$postapply$;

COMMIT;
