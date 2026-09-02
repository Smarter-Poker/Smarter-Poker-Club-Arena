-- ═══════════════════════════════════════════════════════════════════════════
-- 20260831150000_daily_mission_alerts_and_observability.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- TIER:        2
-- AUTHOR:      Codex
-- AFFECTS:     user_notification_preferences, notifications, one enqueue RPC,
--              daily_mission_operations, private operational views
-- IRREVERSIBLE: no
--
-- Reset reminders are opt-in and are enqueued through the canonical
-- notifications -> push_outbox bridge. The unique cycle index makes a retried
-- cron exactly-once per user/day. Operational telemetry is narrow, typed,
-- private, sampled on routine reads, and retained for 30 days.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.user_notification_preferences') IS NULL THEN
    RAISE EXCEPTION 'pre-flight failed: user_notification_preferences is missing';
  END IF;
  IF to_regclass('public.notifications') IS NULL THEN
    RAISE EXCEPTION 'pre-flight failed: notifications is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notifications'
      AND column_name IN ('data', 'is_read', 'action_url')
    GROUP BY table_schema, table_name
    HAVING count(*) = 3
  ) THEN
    RAISE EXCEPTION 'pre-flight failed: notifications delivery contract is incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.notifications'::regclass
      AND t.tgname = 'trg_mirror_notification_to_push_outbox'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'pre-flight failed: canonical notification-to-push bridge is missing';
  END IF;
END;
$preflight$;

ALTER TABLE public.user_notification_preferences
  ADD COLUMN IF NOT EXISTS daily_mission_reminders boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS user_notification_preferences_daily_mission_reminders_idx
  ON public.user_notification_preferences (user_id)
  WHERE daily_mission_reminders IS TRUE;

COMMENT ON COLUMN public.user_notification_preferences.daily_mission_reminders IS
  'Explicit opt-in for Club Arena Daily Mission reset reminders. Does not control other push categories.';

CREATE UNIQUE INDEX IF NOT EXISTS notifications_daily_mission_cycle_unique
  ON public.notifications (user_id, ((data ->> 'cycle_date')))
  WHERE type = 'daily_challenge'
    AND data ->> 'source' = 'club_arena_daily_missions';

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
    body,
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

CREATE TABLE IF NOT EXISTS public.daily_mission_operations (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event          text NOT NULL CHECK (event IN (
                   'dashboard_loaded', 'dashboard_failed',
                   'claim_succeeded', 'claim_failed',
                   'claim_all_succeeded', 'claim_all_failed',
                   'reroll_succeeded', 'reroll_failed',
                   'freeze_succeeded', 'freeze_failed',
                   'realtime_degraded', 'realtime_recovered',
                   'alerts_enabled', 'alerts_disabled', 'alerts_failed',
                   'mission_cta_opened'
                 )),
  tier           text CHECK (tier IS NULL OR tier IN ('daily', 'weekly', 'monthly')),
  duration_ms    integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 300000),
  item_count     integer CHECK (item_count IS NULL OR item_count BETWEEN 0 AND 10000),
  reason_code    text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9:_-]{1,64}$'),
  sample_weight  smallint NOT NULL DEFAULT 1 CHECK (sample_weight BETWEEN 1 AND 100),
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.daily_mission_operations IS
  'Privacy-safe Daily Missions load, mutation, realtime, navigation, and alert health signals. No free-form payloads.';

CREATE INDEX IF NOT EXISTS daily_mission_operations_created_idx
  ON public.daily_mission_operations (created_at DESC);
CREATE INDEX IF NOT EXISTS daily_mission_operations_event_created_idx
  ON public.daily_mission_operations (event, created_at DESC);

ALTER TABLE public.daily_mission_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS daily_mission_operations_insert_own ON public.daily_mission_operations;
CREATE POLICY daily_mission_operations_insert_own
  ON public.daily_mission_operations
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

REVOKE ALL ON public.daily_mission_operations FROM PUBLIC, anon, authenticated;
GRANT INSERT ON public.daily_mission_operations TO authenticated;
GRANT ALL ON public.daily_mission_operations TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.daily_mission_operations_id_seq
  TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_daily_mission_health_hourly
WITH (security_invoker = true) AS
SELECT
  date_trunc('hour', created_at) AS hour,
  sum(sample_weight) FILTER (WHERE event IN ('dashboard_loaded', 'dashboard_failed')) AS estimated_loads,
  count(*) FILTER (WHERE event = 'dashboard_failed') AS load_failures,
  round(
    100.0 * count(*) FILTER (WHERE event = 'dashboard_failed') /
    NULLIF(sum(sample_weight) FILTER (WHERE event IN ('dashboard_loaded', 'dashboard_failed')), 0),
    2
  ) AS load_failure_pct,
  percentile_disc(0.50) WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE event = 'dashboard_loaded' AND duration_ms IS NOT NULL) AS load_p50_ms,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE event = 'dashboard_loaded' AND duration_ms IS NOT NULL) AS load_p95_ms,
  count(*) FILTER (WHERE event LIKE '%_failed') AS action_failures,
  count(*) FILTER (WHERE event = 'realtime_degraded') AS realtime_degradations,
  count(*) FILTER (WHERE event = 'realtime_recovered') AS realtime_recoveries,
  count(*) FILTER (WHERE event = 'alerts_enabled') AS alert_opt_ins,
  count(*) FILTER (WHERE event = 'alerts_disabled') AS alert_opt_outs
FROM public.daily_mission_operations
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW public.v_daily_mission_health_daily
WITH (security_invoker = true) AS
SELECT
  date_trunc('day', created_at) AS day,
  coalesce(tier, 'all') AS tier,
  event,
  count(*) AS sampled_rows,
  sum(sample_weight) AS estimated_events,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE duration_ms IS NOT NULL) AS p95_ms
FROM public.daily_mission_operations
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;

REVOKE ALL ON public.v_daily_mission_health_hourly FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_daily_mission_health_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_daily_mission_health_hourly TO service_role;
GRANT SELECT ON public.v_daily_mission_health_daily TO service_role;

CREATE OR REPLACE FUNCTION public.fn_prune_daily_mission_operations(p_keep_days integer DEFAULT 30)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_keep_days < 7 OR p_keep_days > 180 THEN
    RAISE EXCEPTION 'p_keep_days must be between 7 and 180';
  END IF;
  DELETE FROM public.daily_mission_operations
  WHERE created_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_prune_daily_mission_operations(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_prune_daily_mission_operations(integer)
  TO service_role;

DO $postapply$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_notification_preferences'
      AND column_name = 'daily_mission_reminders'
      AND is_nullable = 'NO'
      AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: opt-in preference contract is missing';
  END IF;
  IF to_regclass('public.daily_mission_operations') IS NULL THEN
    RAISE EXCEPTION 'post-apply failed: daily_mission_operations is missing';
  END IF;
  IF to_regclass('public.notifications_daily_mission_cycle_unique') IS NULL THEN
    RAISE EXCEPTION 'post-apply failed: reset alert uniqueness index is missing';
  END IF;
  IF to_regprocedure('public.enqueue_daily_mission_reset_notifications(date,integer)') IS NULL THEN
    RAISE EXCEPTION 'post-apply failed: reset alert enqueue RPC is missing';
  END IF;
  IF to_regclass('public.v_daily_mission_health_hourly') IS NULL
     OR to_regclass('public.v_daily_mission_health_daily') IS NULL THEN
    RAISE EXCEPTION 'post-apply failed: operational health views are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = 'public.daily_mission_operations'::regclass
      AND polname = 'daily_mission_operations_insert_own'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: write-own telemetry policy is missing';
  END IF;
END;
$postapply$;

COMMIT;
