-- Daily Missions final transaction, replay, streak, and reset-alert safety.
--
-- Every mutation and dashboard read for one player now enters through the same
-- transaction-scoped advisory lock, then locks profiles before any assignment
-- or revision row. This removes the remaining cross-tab lock inversion and
-- also prevents two rerolls of different cards from selecting one replacement.
-- Rerolls receive durable request-bound receipts. Streak rewards are keyed to
-- a stable run id rather than the lifetime freezes_earned counter. Reset alerts
-- are drained in bounded batches by an engine-authorized 00:02 UTC cron job.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- One lock order for the whole Daily Missions subsystem:
-- advisory player lock -> profile -> subsystem rows -> revision cursor.
CREATE OR REPLACE FUNCTION public.fn_lock_daily_mission_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A Daily Missions player is required';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('daily-missions-user:' || p_user_id::text, 0)
  );

  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Daily Missions profile not found for player %', p_user_id;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_lock_daily_mission_user(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lock_daily_mission_user(uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_lock_daily_mission_user(uuid) IS
'Private transaction-scoped Daily Missions player mutex. It locks profiles before assignment, streak, wallet, and revision rows so every path uses one deadlock-safe order.';

-- Preserve the already-certified assignment implementation behind a private
-- body. The public internal name becomes the mandatory serialized entrypoint.
ALTER FUNCTION public.fn_assign_current_challenge_period(uuid, text, text, integer)
  RENAME TO fn_assign_current_challenge_period_serialized_body;

REVOKE ALL ON FUNCTION public.fn_assign_current_challenge_period_serialized_body(
  uuid, text, text, integer
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_assign_current_challenge_period(
  p_user_id uuid,
  p_tier text,
  p_period_key text,
  p_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.fn_lock_daily_mission_user(p_user_id);
  PERFORM public.fn_assign_current_challenge_period_serialized_body(
    p_user_id,
    p_tier,
    p_period_key,
    p_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_assign_current_challenge_period(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_current_challenge_period(uuid, text, text, integer)
  TO service_role;

-- The event receipt used to be inserted before any common player lock. Keep
-- its validated implementation, but serialize before that first write.
ALTER FUNCTION public.record_daily_challenge_event(uuid, text, jsonb, jsonb, timestamptz)
  RENAME TO record_daily_challenge_event_serialized_body;

REVOKE ALL ON FUNCTION public.record_daily_challenge_event_serialized_body(
  uuid, text, jsonb, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_daily_challenge_event(
  p_user_id uuid,
  p_event_key text,
  p_amounts jsonb,
  p_magnitudes jsonb DEFAULT '{}'::jsonb,
  p_occurred_at timestamptz DEFAULT now()
)
RETURNS TABLE(
  id uuid,
  challenge_id text,
  progress integer,
  requirement integer,
  chip_reward numeric,
  diamond_reward integer,
  newly_completed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.fn_lock_daily_mission_user(p_user_id);
  RETURN QUERY
  SELECT *
  FROM public.record_daily_challenge_event_serialized_body(
    p_user_id,
    p_event_key,
    p_amounts,
    p_magnitudes,
    p_occurred_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_daily_challenge_event(
  uuid, text, jsonb, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_daily_challenge_event(
  uuid, text, jsonb, jsonb, timestamptz
) TO service_role;

-- New hand projections carry individual threshold candidates. Scalar amounts
-- and magnitudes stay intact for deployed callers and old outbox rows.
ALTER TABLE public.daily_challenge_progress_events
  ADD COLUMN IF NOT EXISTS threshold_values jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(threshold_values) = 'object');

ALTER TABLE public.daily_challenge_event_outbox
  ADD COLUMN IF NOT EXISTS threshold_values jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(threshold_values) = 'object');

CREATE FUNCTION public.record_daily_challenge_event(
  p_user_id uuid,
  p_event_key text,
  p_amounts jsonb,
  p_magnitudes jsonb,
  p_values jsonb,
  p_occurred_at timestamptz
)
RETURNS TABLE(
  id uuid,
  challenge_id text,
  progress integer,
  requirement integer,
  chip_reward numeric,
  diamond_reward integer,
  newly_completed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer;
  v_daily_key text;
  v_weekly_key text;
  v_monthly_key text;
BEGIN
  IF p_user_id IS NULL OR p_event_key IS NULL
     OR length(p_event_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'A player and stable event key are required';
  END IF;
  IF p_amounts IS NULL OR jsonb_typeof(p_amounts) <> 'object'
     OR p_magnitudes IS NULL OR jsonb_typeof(p_magnitudes) <> 'object'
     OR p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN
    RAISE EXCEPTION 'Challenge event amounts, magnitudes, and values must be JSON objects';
  END IF;
  IF p_occurred_at < now() - interval '35 days'
     OR p_occurred_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'Daily Missions events must be recorded at their authoritative occurrence time';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_amounts) key
    WHERE key NOT IN (
      'hands_played',
      'hands_won',
      'showdowns',
      'showdowns_won',
      'hands_won_no_showdown',
      'big_pots',
      'strong_hands',
      'chips_won',
      'tournaments_played',
      'friends_added'
    )
  ) THEN
    RAISE EXCEPTION 'Unknown Daily Missions event type';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_each_text(p_amounts) item
    WHERE CASE
      WHEN item.value ~ '^\d+$' THEN
        item.value::numeric < 0
        OR (item.key = 'chips_won' AND item.value::numeric > 1000000000)
        OR (item.key <> 'chips_won' AND item.value::numeric > 2500)
      ELSE true
    END
  )
  OR EXISTS (
    SELECT 1
    FROM jsonb_each_text(p_magnitudes) item
    WHERE CASE
      WHEN item.value ~ '^\d+(\.\d+)?$' THEN
        item.value::numeric < 0 OR item.value::numeric > 1000000000
      ELSE true
    END
  ) THEN
    RAISE EXCEPTION 'Daily Missions event values are outside their server contract';
  END IF;

  -- Only catalog types with per-occurrence thresholds may carry value arrays.
  IF EXISTS (
    SELECT 1
    FROM jsonb_each(p_values) item
    WHERE item.key NOT IN ('big_pots', 'strong_hands')
       OR jsonb_typeof(item.value) <> 'array'
  ) THEN
    RAISE EXCEPTION 'Daily Missions exact values have an invalid category or shape';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_each(p_values) item
    WHERE jsonb_array_length(item.value) > 2500
  ) THEN
    RAISE EXCEPTION 'Daily Missions exact values exceed the event candidate limit';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_each(p_values) item
    WHERE NOT (p_amounts ? item.key)
       OR jsonb_array_length(item.value) <> (p_amounts ->> item.key)::integer
  ) THEN
    RAISE EXCEPTION 'Daily Missions exact values must match their scalar candidate count';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_each(p_values) category
    CROSS JOIN LATERAL jsonb_array_elements(category.value) AS candidate(value)
    WHERE CASE
      WHEN jsonb_typeof(candidate.value) = 'number' THEN
        candidate.value::text::numeric < 0
        OR candidate.value::text::numeric > 1000000000
        OR (category.key = 'strong_hands' AND candidate.value::text::numeric > 20)
      ELSE true
    END
  ) THEN
    RAISE EXCEPTION 'Daily Missions exact values must be bounded nonnegative numbers';
  END IF;

  PERFORM public.fn_lock_daily_mission_user(p_user_id);

  v_daily_key := to_char((p_occurred_at AT TIME ZONE 'utc')::date, 'YYYY-MM-DD');
  v_weekly_key := 'W'
    || to_char(date_trunc('week', p_occurred_at AT TIME ZONE 'utc')::date, 'YYYY-MM-DD');
  v_monthly_key := 'M' || to_char(p_occurred_at AT TIME ZONE 'utc', 'YYYY-MM');

  INSERT INTO public.daily_challenge_progress_events (
    user_id,
    event_key,
    amounts,
    magnitudes,
    threshold_values,
    occurred_at
  ) VALUES (
    p_user_id,
    p_event_key,
    p_amounts,
    p_magnitudes,
    p_values,
    p_occurred_at
  )
  ON CONFLICT (user_id, event_key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN;
  END IF;

  PERFORM public.fn_assign_current_challenge_period(
    p_user_id,
    'daily',
    v_daily_key,
    5
  );
  PERFORM public.fn_assign_current_challenge_period(
    p_user_id,
    'weekly',
    v_weekly_key,
    3
  );
  PERFORM public.fn_assign_current_challenge_period(
    p_user_id,
    'monthly',
    v_monthly_key,
    2
  );

  RETURN QUERY
  WITH scalar_bumps AS (
    SELECT key AS challenge_type,
           GREATEST(COALESCE((value #>> '{}')::integer, 0), 0) AS amount
    FROM jsonb_each(p_amounts)
  ), calculated_bumps AS (
    SELECT u.id,
           CASE
             WHEN u.threshold_snapshot IS NULL THEN b.amount
             WHEN p_values ? u.challenge_type_snapshot THEN (
               SELECT count(*)::integer
               FROM jsonb_array_elements(
                 p_values -> u.challenge_type_snapshot
               ) AS candidate(value)
               WHERE candidate.value::text::numeric >= u.threshold_snapshot
             )
             WHEN COALESCE(
               (p_magnitudes -> u.challenge_type_snapshot) #>> '{}',
               '0'
             )::numeric >= u.threshold_snapshot THEN b.amount
             ELSE 0
           END AS amount
    FROM public.user_daily_challenges u
    JOIN scalar_bumps b
      ON b.challenge_type = u.challenge_type_snapshot
    WHERE u.user_id = p_user_id
      AND u.completed = false
      AND u.assigned_date IN (v_daily_key, v_weekly_key, v_monthly_key)
  ), updated AS (
    UPDATE public.user_daily_challenges u
    SET progress = LEAST(
          u.progress + calculated.amount,
          u.requirement_snapshot
        ),
        completed = (u.progress + calculated.amount) >= u.requirement_snapshot,
        completed_at = CASE
          WHEN (u.progress + calculated.amount) >= u.requirement_snapshot
               AND u.completed_at IS NULL THEN now()
          ELSE u.completed_at
        END
    FROM calculated_bumps calculated
    WHERE u.id = calculated.id
      AND calculated.amount > 0
    RETURNING u.id,
              u.challenge_id,
              u.progress,
              u.requirement_snapshot,
              u.chip_reward_snapshot,
              u.diamond_reward_snapshot,
              u.completed
  )
  SELECT updated.id,
         updated.challenge_id,
         updated.progress,
         updated.requirement_snapshot,
         updated.chip_reward_snapshot,
         updated.diamond_reward_snapshot,
         updated.completed
  FROM updated;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_daily_challenge_event(
  uuid, text, jsonb, jsonb, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_daily_challenge_event(
  uuid, text, jsonb, jsonb, jsonb, timestamptz
) TO service_role;

CREATE FUNCTION public.enqueue_daily_challenge_event(
  p_user_id uuid,
  p_event_key text,
  p_amounts jsonb,
  p_magnitudes jsonb,
  p_values jsonb,
  p_occurred_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.daily_challenge_event_outbox (
    user_id,
    event_key,
    amounts,
    magnitudes,
    threshold_values,
    occurred_at
  ) VALUES (
    p_user_id,
    p_event_key,
    p_amounts,
    p_magnitudes,
    p_values,
    p_occurred_at
  )
  ON CONFLICT (user_id, event_key) DO NOTHING;

  BEGIN
    PERFORM public.record_daily_challenge_event(
      p_user_id,
      p_event_key,
      p_amounts,
      p_magnitudes,
      p_values,
      p_occurred_at
    );
    DELETE FROM public.daily_challenge_event_outbox
    WHERE user_id = p_user_id
      AND event_key = p_event_key;
    RETURN true;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.daily_challenge_event_outbox
    SET attempts = attempts + 1,
        last_error = left(SQLERRM, 1000),
        next_attempt_at = now() + interval '1 minute'
    WHERE user_id = p_user_id
      AND event_key = p_event_key;
    RETURN false;
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_daily_challenge_event(
  uuid, text, jsonb, jsonb, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_daily_challenge_event(
  uuid, text, jsonb, jsonb, jsonb, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_enqueue_hand_daily_missions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  event jsonb;
BEGIN
  IF jsonb_typeof(NEW.daily_mission_events) <> 'array' THEN
    RETURN NEW;
  END IF;

  FOR event IN
    SELECT value FROM jsonb_array_elements(NEW.daily_mission_events)
  LOOP
    BEGIN
      PERFORM public.enqueue_daily_challenge_event(
        (event ->> 'user_id')::uuid,
        'hand:' || NEW.id::text,
        event -> 'amounts',
        COALESCE(event -> 'magnitudes', '{}'::jsonb),
        COALESCE(event -> 'values', '{}'::jsonb),
        COALESCE(NEW.ended_at, NEW.created_at, now())
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Missions hand event % could not be queued: %',
        NEW.id,
        SQLERRM;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_enqueue_hand_daily_missions()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_drain_daily_challenge_event_outbox(
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_done integer := 0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Invalid outbox batch size';
  END IF;

  UPDATE public.daily_challenge_event_outbox
  SET dead_lettered_at = now(),
      last_error = left(
        COALESCE(last_error || '; ', '')
          || 'Authoritative event exceeded 35-day replay horizon',
        1000
      )
  WHERE dead_lettered_at IS NULL
    AND occurred_at < now() - interval '35 days';

  FOR r IN
    SELECT *
    FROM public.daily_challenge_event_outbox
    WHERE next_attempt_at <= now()
      AND dead_lettered_at IS NULL
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    IF public.enqueue_daily_challenge_event(
      r.user_id,
      r.event_key,
      r.amounts,
      r.magnitudes,
      r.threshold_values,
      r.occurred_at
    ) THEN
      v_done := v_done + 1;
    END IF;
  END LOOP;

  RETURN v_done;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer)
  TO service_role;

-- Dashboard entrypoints take the player/profile lock before the revision-aware
-- body can assign or lock its cursor. The legacy six-argument reader remains
-- rollout-compatible behind the same order.
ALTER FUNCTION public.get_daily_challenge_dashboard(
  text, text[], text, text[], text, text[]
) RENAME TO get_daily_challenge_dashboard_serialized_body;

REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard_serialized_body(
  text, text[], text, text[], text, text[]
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_daily_challenge_dashboard(
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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  PERFORM public.fn_lock_daily_mission_user(v_uid);
  RETURN public.get_daily_challenge_dashboard_serialized_body(
    p_daily_key,
    p_daily_ids,
    p_weekly_key,
    p_weekly_ids,
    p_monthly_key,
    p_monthly_ids
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard(
  text, text[], text, text[], text, text[]
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_challenge_dashboard(
  text, text[], text, text[], text, text[]
) TO authenticated, service_role;

ALTER FUNCTION public.get_daily_challenge_dashboard_v2(
  text, text[], text, text[], text, text[]
) RENAME TO get_daily_challenge_dashboard_v2_serialized_body;

REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard_v2_serialized_body(
  text, text[], text, text[], text, text[]
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_daily_challenge_dashboard_v2(
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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  PERFORM public.fn_lock_daily_mission_user(v_uid);
  RETURN public.get_daily_challenge_dashboard_v2_serialized_body(
    p_daily_key,
    p_daily_ids,
    p_weekly_key,
    p_weekly_ids,
    p_monthly_key,
    p_monthly_ids
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard_v2(
  text, text[], text, text[], text, text[]
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_challenge_dashboard_v2(
  text, text[], text, text[], text, text[]
) TO authenticated, service_role;

-- Claims retain their proven settlement implementations. These narrow wrappers
-- establish the player/profile lock before the receipt or challenge row lock.
ALTER FUNCTION public.claim_daily_challenge(uuid, uuid, numeric)
  RENAME TO claim_daily_challenge_serialized_body;

REVOKE ALL ON FUNCTION public.claim_daily_challenge_serialized_body(uuid, uuid, numeric)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_reward_amount numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim a challenge for another user' USING ERRCODE = '42501';
  END IF;

  PERFORM public.fn_lock_daily_mission_user(v_uid);
  RETURN public.claim_daily_challenge_serialized_body(
    p_user_id,
    p_challenge_row_id,
    p_reward_amount
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric)
  TO authenticated, service_role;

ALTER FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid)
  RENAME TO claim_daily_challenges_serialized_body;

REVOKE ALL ON FUNCTION public.claim_daily_challenges_serialized_body(uuid, uuid[], uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_daily_challenges(
  p_user_id uuid,
  p_challenge_row_ids uuid[],
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim challenges for another user' USING ERRCODE = '42501';
  END IF;

  PERFORM public.fn_lock_daily_mission_user(v_uid);
  RETURN public.claim_daily_challenges_serialized_body(
    p_user_id,
    p_challenge_row_ids,
    p_request_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid)
  TO authenticated, service_role;

-- Freeze purchases use the same profile-first transaction order as claims and
-- rerolls. The existing immutable request receipt remains the settlement body.
ALTER FUNCTION public.buy_streak_freeze(uuid, integer, uuid)
  RENAME TO buy_streak_freeze_serialized_body;

REVOKE ALL ON FUNCTION public.buy_streak_freeze_serialized_body(uuid, integer, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.buy_streak_freeze(
  p_user_id uuid,
  p_cost integer,
  p_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL OR p_user_id IS NULL OR p_user_id <> v_uid THEN
    RETURN public.buy_streak_freeze_serialized_body(
      p_user_id,
      p_cost,
      p_request_id
    );
  END IF;

  PERFORM public.fn_lock_daily_mission_user(v_uid);
  RETURN public.buy_streak_freeze_serialized_body(
    p_user_id,
    p_cost,
    p_request_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.buy_streak_freeze(uuid, integer, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buy_streak_freeze(uuid, integer, uuid)
  TO authenticated, service_role;

-- Stable streak-run identity and per-run freeze entitlement receipts.
ALTER TABLE public.challenge_streak_state
  ADD COLUMN IF NOT EXISTS current_streak_run_id uuid,
  ADD COLUMN IF NOT EXISTS current_streak_started_on date,
  ADD COLUMN IF NOT EXISTS current_streak_ended_on date,
  ADD COLUMN IF NOT EXISTS current_streak_length integer;

ALTER TABLE public.challenge_streak_state
  DROP CONSTRAINT IF EXISTS challenge_streak_state_current_run_complete,
  DROP CONSTRAINT IF EXISTS challenge_streak_state_current_length_nonnegative;

ALTER TABLE public.challenge_streak_state
  ADD CONSTRAINT challenge_streak_state_current_length_nonnegative
    CHECK (current_streak_length IS NULL OR current_streak_length >= 0),
  ADD CONSTRAINT challenge_streak_state_current_run_complete
    CHECK (
      (current_streak_run_id IS NULL
        AND current_streak_started_on IS NULL
        AND current_streak_ended_on IS NULL
        AND current_streak_length IS NULL)
      OR
      (current_streak_run_id IS NOT NULL
        AND current_streak_started_on IS NOT NULL
        AND current_streak_ended_on IS NOT NULL
        AND current_streak_length IS NOT NULL
        AND current_streak_length > 0
        AND current_streak_started_on <= current_streak_ended_on)
    );

CREATE TABLE public.daily_challenge_freeze_entitlements (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  streak_run_id uuid NOT NULL,
  entitlement_day integer NOT NULL CHECK (
    entitlement_day > 0 AND entitlement_day % 7 = 0
  ),
  streak_started_on date NOT NULL,
  inventory_granted boolean NOT NULL DEFAULT false,
  legacy_accounted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, streak_run_id, entitlement_day)
);

ALTER TABLE public.daily_challenge_freeze_entitlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.daily_challenge_freeze_entitlements
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_challenge_freeze_entitlements
  TO service_role;

-- Reconstruct only a genuinely current contiguous run (ending today or
-- yesterday), including every already-recorded frozen date. Do not infer a
-- current run length from the lifetime freezes_earned counter.
WITH RECURSIVE completed_days AS (
  SELECT DISTINCT user_id, assigned_date::date AS completed_on
  FROM public.user_daily_challenges
  WHERE completed
    AND assigned_date ~ '^\d{4}-\d{2}-\d{2}$'
), latest_completed AS (
  SELECT user_id, max(completed_on) AS ended_on
  FROM completed_days
  GROUP BY user_id
), continuity_days AS (
  SELECT user_id, completed_on AS covered_on
  FROM completed_days
  UNION
  SELECT s.user_id, frozen.frozen_on::date
  FROM public.challenge_streak_state s
  CROSS JOIN LATERAL unnest(s.frozen_dates) AS frozen(frozen_on)
  WHERE frozen.frozen_on ~ '^\d{4}-\d{2}-\d{2}$'
), run_walk(user_id, covered_on) AS (
  SELECT l.user_id, l.ended_on
  FROM latest_completed l
  WHERE l.ended_on IN (
    (now() AT TIME ZONE 'utc')::date,
    (now() AT TIME ZONE 'utc')::date - 1
  )
  UNION ALL
  SELECT walk.user_id, walk.covered_on - 1
  FROM run_walk walk
  WHERE EXISTS (
    SELECT 1
    FROM continuity_days covered
    WHERE covered.user_id = walk.user_id
      AND covered.covered_on = walk.covered_on - 1
  )
), current_runs AS (
  SELECT walk.user_id,
         min(completed.completed_on) AS started_on,
         max(walk.covered_on) AS ended_on,
         (max(walk.covered_on) - min(completed.completed_on) + 1)::integer
           AS run_length
  FROM run_walk walk
  JOIN completed_days completed
    ON completed.user_id = walk.user_id
   AND completed.completed_on = walk.covered_on
  GROUP BY walk.user_id
), prepared AS (
  SELECT s.user_id,
         gen_random_uuid() AS run_id,
         run.started_on,
         run.ended_on,
         run.run_length
  FROM public.challenge_streak_state s
  JOIN current_runs run ON run.user_id = s.user_id
  WHERE s.current_streak_run_id IS NULL
)
UPDATE public.challenge_streak_state s
SET current_streak_run_id = p.run_id,
    current_streak_started_on = p.started_on,
    current_streak_ended_on = p.ended_on,
    current_streak_length = p.run_length
FROM prepared p
WHERE s.user_id = p.user_id;

-- `last_earned_at` is the only legacy evidence that an accounted threshold
-- belongs to the reconstructed current run. Map at most the thresholds the
-- current run could actually have crossed. These rows grant no new inventory.
WITH evidence AS (
  SELECT s.*,
         CASE
           WHEN s.current_streak_run_id IS NOT NULL
                AND s.last_earned_at IS NOT NULL
                AND (s.last_earned_at AT TIME ZONE 'utc')::date
                    BETWEEN s.current_streak_started_on
                        AND s.current_streak_ended_on + 1
             THEN LEAST(s.freezes_earned, s.current_streak_length / 7)
           ELSE 0
         END AS current_accounted
  FROM public.challenge_streak_state s
)
INSERT INTO public.daily_challenge_freeze_entitlements (
  user_id,
  streak_run_id,
  entitlement_day,
  streak_started_on,
  inventory_granted,
  legacy_accounted
)
SELECT evidence.user_id,
       evidence.current_streak_run_id,
       entitlement_number * 7,
       evidence.current_streak_started_on,
       false,
       true
FROM evidence
CROSS JOIN LATERAL generate_series(1, evidence.current_accounted) entitlement_number
WHERE evidence.current_streak_run_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Any remaining lifetime total is real accounting history but cannot safely be
-- attributed to today's run. Preserve it on a deterministic legacy identity
-- and a sentinel descriptive date that can never be selected as a live run.
WITH evidence AS (
  SELECT s.*,
         CASE
           WHEN s.current_streak_run_id IS NOT NULL
                AND s.last_earned_at IS NOT NULL
                AND (s.last_earned_at AT TIME ZONE 'utc')::date
                    BETWEEN s.current_streak_started_on
                        AND s.current_streak_ended_on + 1
             THEN LEAST(s.freezes_earned, s.current_streak_length / 7)
           ELSE 0
         END AS current_accounted
  FROM public.challenge_streak_state s
)
INSERT INTO public.daily_challenge_freeze_entitlements (
  user_id,
  streak_run_id,
  entitlement_day,
  streak_started_on,
  inventory_granted,
  legacy_accounted
)
SELECT evidence.user_id,
       md5('daily-mission-legacy-freezes:' || evidence.user_id::text)::uuid,
       entitlement_number * 7,
       date '0001-01-01',
       false,
       true
FROM evidence
CROSS JOIN LATERAL generate_series(
  1,
  evidence.freezes_earned - evidence.current_accounted
) entitlement_number
WHERE evidence.freezes_earned > evidence.current_accounted
ON CONFLICT DO NOTHING;

-- Milestones are unique by stable run identity. The descriptive start date is
-- retained and existing rows are grouped onto a deterministic legacy run id.
ALTER TABLE public.daily_challenge_milestone_claims
  ADD COLUMN IF NOT EXISTS streak_run_id uuid;

UPDATE public.daily_challenge_milestone_claims claims
SET streak_run_id = COALESCE(
  (
    SELECT state.current_streak_run_id
    FROM public.challenge_streak_state state
    WHERE state.user_id = claims.user_id
      AND state.current_streak_started_on = claims.streak_started_on
  ),
  md5(claims.user_id::text || ':' || claims.streak_started_on::text)::uuid
)
WHERE claims.streak_run_id IS NULL;

ALTER TABLE public.daily_challenge_milestone_claims
  ALTER COLUMN streak_run_id SET NOT NULL;

ALTER TABLE public.daily_challenge_milestone_claims
  DROP CONSTRAINT IF EXISTS daily_challenge_milestone_claims_pkey;

ALTER TABLE public.daily_challenge_milestone_claims
  ADD CONSTRAINT daily_challenge_milestone_claims_pkey
    PRIMARY KEY (user_id, streak_run_id, milestone_days);

CREATE INDEX IF NOT EXISTS daily_challenge_milestone_claims_started_idx
  ON public.daily_challenge_milestone_claims (user_id, streak_started_on);

-- All recorded frozen dates can bridge one run. Only one previously-unrecorded
-- gap may consume inventory during a calculation. The returned boundaries are
-- computed from the same authoritative run used for entitlements and awards.
CREATE OR REPLACE FUNCTION public.get_challenge_streak(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (transaction_timestamp() AT TIME ZONE 'utc')::date;
  v_state public.challenge_streak_state%ROWTYPE;
  v_days date[];
  v_day_count integer := 0;
  v_streak integer := 0;
  v_cursor date;
  v_i integer := 1;
  v_used_new_freeze boolean := false;
  v_frozen_on date;
  v_honored_frozen_dates integer := 0;
  v_started_on date;
  v_ended_on date;
  v_run_id uuid;
  v_historical_run_id uuid;
  v_entitlement_day integer;
  v_new_entitlements integer := 0;
  v_inventory_grant integer := 0;
  v_inserted integer;
  v_probe date;
  v_older_length integer;
  MAX_FREEZES constant integer := 3;
  EARN_EVERY constant integer := 7;
  MIN_TO_PROTECT constant integer := 3;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot read another player''s challenge streak' USING ERRCODE = '42501';
  END IF;

  PERFORM public.fn_lock_daily_mission_user(v_uid);

  INSERT INTO public.challenge_streak_state (user_id)
  VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_state
  FROM public.challenge_streak_state
  WHERE user_id = v_uid
  FOR UPDATE;

  SELECT COALESCE(array_agg(d ORDER BY d DESC), ARRAY[]::date[])
  INTO v_days
  FROM (
    SELECT DISTINCT assigned_date::date AS d
    FROM public.user_daily_challenges
    WHERE user_id = v_uid
      AND completed
      AND assigned_date ~ '^\d{4}-\d{2}-\d{2}$'
  ) completed_days;

  v_day_count := COALESCE(array_length(v_days, 1), 0);
  IF v_day_count = 0 OR v_days[1] NOT IN (v_today, v_today - 1) THEN
    RETURN jsonb_build_object(
      'streak', 0,
      'streakRunId', NULL,
      'streakStartedOn', NULL,
      'streakEndedOn', NULL,
      'freezesAvailable', v_state.freezes_available,
      'usedFreeze', false,
      'frozenDate', NULL,
      'honoredFrozenDates', 0,
      'nextFreezeIn', CASE
        WHEN v_state.freezes_available >= MAX_FREEZES THEN NULL
        ELSE EARN_EVERY
      END
    );
  END IF;

  v_ended_on := v_days[1];
  v_cursor := v_ended_on;

  LOOP
    EXIT WHEN v_i > v_day_count;

    IF v_days[v_i] = v_cursor THEN
      v_streak := v_streak + 1;
      v_started_on := v_cursor;
      v_cursor := v_cursor - 1;
      v_i := v_i + 1;
    ELSIF v_cursor::text = ANY(v_state.frozen_dates)
          AND EXISTS (
            SELECT 1 FROM unnest(v_days) completed_day WHERE completed_day < v_cursor
          )
    THEN
      v_honored_frozen_dates := v_honored_frozen_dates + 1;
      v_streak := v_streak + 1;
      v_started_on := v_cursor;
      v_cursor := v_cursor - 1;
    ELSIF NOT v_used_new_freeze
          AND v_state.freezes_available > 0
          AND v_days[v_i] = v_cursor - 1
    THEN
      -- Qualify against either side of the gap. This protects an established
      -- run when the missed date is yesterday, not only gaps encountered after
      -- three newer rows while scanning backwards.
      v_probe := v_cursor - 1;
      v_older_length := 0;
      WHILE v_probe = ANY(v_days)
         OR v_probe::text = ANY(v_state.frozen_dates)
      LOOP
        v_older_length := v_older_length + 1;
        v_probe := v_probe - 1;
      END LOOP;

      IF GREATEST(v_streak, v_older_length) < MIN_TO_PROTECT THEN
        EXIT;
      END IF;

      UPDATE public.challenge_streak_state
      SET freezes_available = freezes_available - 1,
          freezes_used = freezes_used + 1,
          frozen_dates = CASE
            WHEN v_cursor::text = ANY(frozen_dates) THEN frozen_dates
            ELSE array_append(frozen_dates, v_cursor::text)
          END,
          updated_at = now()
      WHERE user_id = v_uid
      RETURNING * INTO v_state;

      v_used_new_freeze := true;
      v_frozen_on := v_cursor;
      v_streak := v_streak + 1;
      v_started_on := v_cursor;
      v_cursor := v_cursor - 1;
    ELSE
      EXIT;
    END IF;
  END LOOP;

  -- When a recorded/new frozen gap reconnects an older rewarded run, prefer
  -- its historical identity. Otherwise retain the current identity whenever
  -- the calculated windows overlap or touch, and mint a UUID only for a truly
  -- disconnected run.
  SELECT historical.streak_run_id
  INTO v_historical_run_id
  FROM (
    SELECT e.streak_run_id, e.created_at
    FROM public.daily_challenge_freeze_entitlements e
    WHERE e.user_id = v_uid
      AND e.streak_started_on = v_started_on
    UNION ALL
    SELECT m.streak_run_id, m.claimed_at
    FROM public.daily_challenge_milestone_claims m
    WHERE m.user_id = v_uid
      AND m.streak_started_on = v_started_on
  ) historical
  ORDER BY historical.created_at
  LIMIT 1;

  IF v_historical_run_id IS NOT NULL THEN
    v_run_id := v_historical_run_id;
  ELSIF v_state.current_streak_run_id IS NOT NULL
        AND v_state.current_streak_started_on <= v_ended_on + 1
        AND v_state.current_streak_ended_on >= v_started_on - 1
  THEN
    v_run_id := v_state.current_streak_run_id;
  ELSE
    v_run_id := gen_random_uuid();
  END IF;

  -- A newly honored frozen gap can extend the authoritative start backwards.
  -- Keep descriptive dates aligned without changing the run's stable identity.
  UPDATE public.daily_challenge_freeze_entitlements
  SET streak_started_on = v_started_on
  WHERE user_id = v_uid
    AND streak_run_id = v_run_id
    AND streak_started_on IS DISTINCT FROM v_started_on;

  UPDATE public.daily_challenge_milestone_claims
  SET streak_started_on = v_started_on
  WHERE user_id = v_uid
    AND streak_run_id = v_run_id
    AND streak_started_on IS DISTINCT FROM v_started_on;

  UPDATE public.challenge_streak_state
  SET current_streak_run_id = v_run_id,
      current_streak_started_on = v_started_on,
      current_streak_ended_on = v_ended_on,
      current_streak_length = v_streak,
      updated_at = now()
  WHERE user_id = v_uid
  RETURNING * INTO v_state;

  -- Insert each threshold once for this run. A threshold reached while the
  -- three-slot inventory is full is still recorded as processed, so spending
  -- later cannot retroactively mint a skipped reward.
  FOR v_entitlement_day IN
    SELECT generate_series(EARN_EVERY, v_streak, EARN_EVERY)
  LOOP
    INSERT INTO public.daily_challenge_freeze_entitlements (
      user_id,
      streak_run_id,
      entitlement_day,
      streak_started_on,
      inventory_granted,
      legacy_accounted
    ) VALUES (
      v_uid,
      v_run_id,
      v_entitlement_day,
      v_started_on,
      false,
      false
    )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 1 THEN
      v_new_entitlements := v_new_entitlements + 1;
      IF v_state.freezes_available + v_inventory_grant < MAX_FREEZES THEN
        UPDATE public.daily_challenge_freeze_entitlements
        SET inventory_granted = true
        WHERE user_id = v_uid
          AND streak_run_id = v_run_id
          AND entitlement_day = v_entitlement_day;
        v_inventory_grant := v_inventory_grant + 1;
      END IF;
    END IF;
  END LOOP;

  IF v_new_entitlements > 0 THEN
    UPDATE public.challenge_streak_state
    SET freezes_available = freezes_available + v_inventory_grant,
        -- Compatibility/audit total only. Entitlement decisions no longer read
        -- this lifetime counter; the per-run ledger above is authoritative.
        freezes_earned = freezes_earned + v_new_entitlements,
        last_earned_at = CASE
          WHEN v_inventory_grant > 0 THEN now()
          ELSE last_earned_at
        END,
        updated_at = now()
    WHERE user_id = v_uid
    RETURNING * INTO v_state;
  END IF;

  RETURN jsonb_build_object(
    'streak', v_streak,
    'streakRunId', v_run_id,
    'streakStartedOn', v_started_on,
    'streakEndedOn', v_ended_on,
    'freezesAvailable', v_state.freezes_available,
    'usedFreeze', v_used_new_freeze,
    'frozenDate', v_frozen_on,
    'honoredFrozenDates', v_honored_frozen_dates,
    'nextFreezeIn', CASE
      WHEN v_state.freezes_available >= MAX_FREEZES THEN NULL
      ELSE EARN_EVERY - (v_streak % EARN_EVERY)
    END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_challenge_streak(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_challenge_streak(uuid)
  TO authenticated, service_role;

-- Milestones now consume the authoritative streak boundaries and stable run id
-- from get_challenge_streak. This fixes the morning-after start-date shift.
CREATE OR REPLACE FUNCTION public.fn_award_daily_mission_milestones(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_streak_receipt jsonb;
  v_streak integer;
  v_run_id uuid;
  v_started date;
  v_ended date;
  v_reward numeric := 0;
  v_max integer;
  v_max_reward numeric;
  v_reference text;
  v_credit jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A Daily Missions milestone player is required';
  END IF;

  PERFORM public.fn_lock_daily_mission_user(p_user_id);
  v_streak_receipt := public.get_challenge_streak(p_user_id);
  v_streak := COALESCE((v_streak_receipt ->> 'streak')::integer, 0);
  v_run_id := NULLIF(v_streak_receipt ->> 'streakRunId', '')::uuid;
  v_started := NULLIF(v_streak_receipt ->> 'streakStartedOn', '')::date;
  v_ended := NULLIF(v_streak_receipt ->> 'streakEndedOn', '')::date;

  IF v_streak <= 0 OR v_run_id IS NULL OR v_started IS NULL OR v_ended IS NULL THEN
    RETURN 0;
  END IF;

  SELECT max(days) INTO v_max
  FROM public.daily_challenge_milestones;

  SELECT reward_diamonds INTO v_max_reward
  FROM public.daily_challenge_milestones
  WHERE days = v_max;

  WITH due AS (
    SELECT days, reward_diamonds
    FROM public.daily_challenge_milestones
    WHERE days <= v_streak
    UNION ALL
    SELECT day, v_max_reward
    FROM generate_series(
      v_max + 30,
      v_max + ((v_streak - v_max) / 30) * 30,
      30
    ) day
  ), inserted AS (
    INSERT INTO public.daily_challenge_milestone_claims (
      user_id,
      streak_run_id,
      streak_started_on,
      milestone_days,
      reward_diamonds
    )
    SELECT p_user_id, v_run_id, v_started, days, reward_diamonds
    FROM due
    ON CONFLICT DO NOTHING
    RETURNING reward_diamonds, milestone_days
  )
  SELECT COALESCE(sum(reward_diamonds), 0),
         'daily_mission_milestones:' || p_user_id::text || ':'
           || v_run_id::text || ':' || max(milestone_days)
  INTO v_reward, v_reference
  FROM inserted;

  IF v_reward > 0 THEN
    v_credit := public.add_diamonds_to_balance(
      p_user_id,
      v_reward::integer,
      'daily_mission_milestone',
      'Daily Missions streak circuit',
      v_reference
    );

    IF COALESCE((v_credit ->> 'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Daily Missions streak milestone could not be credited: %',
        COALESCE(v_credit ->> 'error', 'unknown');
    END IF;
  END IF;

  RETURN v_reward;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_award_daily_mission_milestones(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_daily_mission_milestones(uuid)
  TO service_role;

-- A durable request receipt replaces "the card changed, so assume the retry
-- succeeded". The receipt binds all caller inputs and preserves the exact
-- committed card/balance snapshot even if the response is lost.
CREATE TABLE public.daily_challenge_reroll_receipts (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  challenge_row_id uuid NOT NULL,
  expected_challenge_id text NOT NULL,
  cost integer NOT NULL CHECK (cost = 10),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);

ALTER TABLE public.daily_challenge_reroll_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.daily_challenge_reroll_receipts
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_challenge_reroll_receipts
  TO service_role;

CREATE FUNCTION public.reroll_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_expected_challenge_id text,
  p_cost integer,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  REROLL_COST constant integer := 10;
  v_uid uuid := auth.uid();
  v_row public.user_daily_challenges%ROWTYPE;
  v_receipt public.daily_challenge_reroll_receipts%ROWTYPE;
  v_replacement text;
  v_deduct jsonb;
  v_balance integer;
  v_result jsonb;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'cannot reroll another player''s challenge'
    );
  END IF;
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'a reroll request id is required');
  END IF;
  IF p_cost IS DISTINCT FROM REROLL_COST THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'reroll price changed; refresh and try again'
    );
  END IF;

  PERFORM public.fn_lock_daily_mission_user(v_uid);

  SELECT * INTO v_receipt
  FROM public.daily_challenge_reroll_receipts
  WHERE user_id = v_uid
    AND request_id = p_request_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_receipt.challenge_row_id IS DISTINCT FROM p_challenge_row_id
       OR v_receipt.expected_challenge_id IS DISTINCT FROM p_expected_challenge_id
       OR v_receipt.cost IS DISTINCT FROM p_cost
    THEN
      RETURN jsonb_build_object(
        'success', false,
        'requestId', p_request_id,
        'error', 'reroll request id is already bound to another request'
      );
    END IF;

    RETURN v_receipt.result || jsonb_build_object(
      'requestId', p_request_id,
      'alreadyRerolled', true,
      'diamondsSpent', 0
    );
  END IF;

  SELECT * INTO v_row
  FROM public.user_daily_challenges
  WHERE id = p_challenge_row_id
    AND user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'challenge not found');
  END IF;
  IF v_row.challenge_id IS DISTINCT FROM p_expected_challenge_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'challenge changed; refresh and try again'
    );
  END IF;
  IF v_row.completed OR v_row.claimed THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'completed challenges cannot be rerolled'
    );
  END IF;

  SELECT c.id INTO v_replacement
  FROM public.daily_challenge_catalog c
  WHERE c.tier = v_row.tier_snapshot
    AND c.is_active
    AND c.id <> v_row.challenge_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_daily_challenges active
      WHERE active.user_id = v_uid
        AND active.assigned_date = v_row.assigned_date
        AND active.challenge_id = c.id
    )
  ORDER BY random()
  LIMIT 1;

  IF v_replacement IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'no replacement challenge is available'
    );
  END IF;

  v_deduct := public.deduct_diamonds(
    p_user_id          := v_uid,
    p_amount           := REROLL_COST,
    p_description      := 'Daily challenge reroll',
    p_transaction_type := 'challenge_reroll',
    p_source           := 'daily_challenge_reroll',
    p_metadata         := jsonb_build_object(
                            'request_id', p_request_id,
                            'challenge_row_id', v_row.id,
                            'from_challenge_id', v_row.challenge_id,
                            'to_challenge_id', v_replacement,
                            'tier', v_row.tier_snapshot
                          ),
    p_reference_id     := 'challenge_reroll:' || p_request_id::text,
    p_cooldown_seconds := 0
  );

  IF COALESCE((v_deduct ->> 'success')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', COALESCE(v_deduct ->> 'error', 'not enough diamonds')
    );
  END IF;
  IF COALESCE((v_deduct ->> 'idempotent')::boolean, false) THEN
    RAISE EXCEPTION 'A reroll debit exists without its bound action receipt';
  END IF;

  PERFORM set_config('app.daily_challenge_reroll', '1', true);
  UPDATE public.user_daily_challenges
  SET challenge_id = v_replacement,
      progress = 0,
      completed = false,
      claimed = false,
      completed_at = NULL,
      claimed_at = NULL
  WHERE id = v_row.id
    AND user_id = v_uid
  RETURNING * INTO v_row;

  SELECT COALESCE(diamonds, 0)::integer INTO v_balance
  FROM public.profiles
  WHERE id = v_uid;

  v_result := jsonb_build_object(
    'success', true,
    'requestId', p_request_id,
    'alreadyRerolled', false,
    'challengeId', v_row.challenge_id,
    'diamondBalance', COALESCE(v_balance, 0),
    'diamondsSpent', REROLL_COST,
    'challenge', jsonb_build_object(
      'id', v_row.id,
      'challenge_id', v_row.challenge_id,
      'assigned_date', v_row.assigned_date,
      'progress', v_row.progress,
      'completed', v_row.completed,
      'claimed', v_row.claimed,
      'completed_at', v_row.completed_at,
      'name', v_row.challenge_name_snapshot,
      'description', v_row.challenge_description_snapshot,
      'challenge_type', v_row.challenge_type_snapshot,
      'requirement', v_row.requirement_snapshot,
      'chip_reward', 0,
      'diamond_reward', v_row.diamond_reward_snapshot,
      'tier', v_row.tier_snapshot
    )
  );

  INSERT INTO public.daily_challenge_reroll_receipts (
    user_id,
    request_id,
    challenge_row_id,
    expected_challenge_id,
    cost,
    result
  ) VALUES (
    v_uid,
    p_request_id,
    p_challenge_row_id,
    p_expected_challenge_id,
    p_cost,
    v_result
  );

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid)
  TO authenticated, service_role;

-- Retain the deployed four-argument RPC until the new client is everywhere.
-- Its existing row-change replay behavior remains, but now participates in the
-- same player/profile serialization and cannot conflict with a five-arg call.
ALTER FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
  RENAME TO reroll_daily_challenge_legacy_serialized_body;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge_legacy_serialized_body(
  uuid, uuid, text, integer
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.reroll_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_expected_challenge_id text,
  p_cost integer DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL OR p_user_id IS NULL OR p_user_id <> v_uid THEN
    RETURN public.reroll_daily_challenge_legacy_serialized_body(
      p_user_id,
      p_challenge_row_id,
      p_expected_challenge_id,
      p_cost
    );
  END IF;

  PERFORM public.fn_lock_daily_mission_user(v_uid);
  RETURN public.reroll_daily_challenge_legacy_serialized_body(
    p_user_id,
    p_challenge_row_id,
    p_expected_challenge_id,
    p_cost
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
  TO authenticated, service_role;

-- pg_cron has no PostgREST JWT claims. Trust the one canonical engine predicate
-- rather than requiring auth.role() to equal service_role literally.
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
  IF NOT public.fn_caller_is_engine() THEN
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
  SELECT p.user_id,
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

CREATE OR REPLACE FUNCTION public.fn_drain_daily_mission_reset_notifications(
  p_cycle_date date DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  p_batch_size integer DEFAULT 5000,
  p_max_batches integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer;
  v_total integer := 0;
  v_batch integer := 0;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  IF p_batch_size NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'p_batch_size must be between 1 and 5000';
  END IF;
  IF p_max_batches NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'p_max_batches must be between 1 and 100';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('daily-mission-reset-alerts:' || p_cycle_date::text, 0)
  ) THEN
    RETURN 0;
  END IF;

  LOOP
    EXIT WHEN v_batch >= p_max_batches;
    v_batch := v_batch + 1;
    v_inserted := public.enqueue_daily_mission_reset_notifications(
      p_cycle_date,
      p_batch_size
    );
    v_total := v_total + v_inserted;
    EXIT WHEN v_inserted < p_batch_size;
  END LOOP;

  RETURN v_total;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_drain_daily_mission_reset_notifications(
  date, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_drain_daily_mission_reset_notifications(
  date, integer, integer
) TO service_role;

DO $schedule_reset_alerts$
DECLARE
  v_job_id bigint;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RETURN;
  END IF;

  FOR v_job_id IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'daily-missions-reset-alerts-0002-utc'
  LOOP
    PERFORM cron.unschedule(v_job_id);
  END LOOP;

  PERFORM cron.schedule(
    'daily-missions-reset-alerts-0002-utc',
    '2 0 * * *',
    $cron$SELECT public.fn_drain_daily_mission_reset_notifications(((now() AT TIME ZONE 'UTC')::date), 5000, 100);$cron$
  );
END;
$schedule_reset_alerts$;

DO $verify$
DECLARE
  v_source text;
  v_job_count integer;
BEGIN
  IF to_regprocedure('public.fn_lock_daily_mission_user(uuid)') IS NULL
     OR has_function_privilege(
       'authenticated',
       'public.fn_lock_daily_mission_user(uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Private Daily Missions player lock contract is missing';
  END IF;

  FOREACH v_source IN ARRAY ARRAY[
    pg_get_functiondef('public.fn_assign_current_challenge_period(uuid,text,text,integer)'::regprocedure),
    pg_get_functiondef('public.record_daily_challenge_event(uuid,text,jsonb,jsonb,timestamptz)'::regprocedure),
    pg_get_functiondef('public.record_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)'::regprocedure),
    pg_get_functiondef('public.get_daily_challenge_dashboard(text,text[],text,text[],text,text[])'::regprocedure),
    pg_get_functiondef('public.get_daily_challenge_dashboard_v2(text,text[],text,text[],text,text[])'::regprocedure),
    pg_get_functiondef('public.claim_daily_challenge(uuid,uuid,numeric)'::regprocedure),
    pg_get_functiondef('public.claim_daily_challenges(uuid,uuid[],uuid)'::regprocedure),
    pg_get_functiondef('public.buy_streak_freeze(uuid,integer,uuid)'::regprocedure),
    pg_get_functiondef('public.get_challenge_streak(uuid)'::regprocedure),
    pg_get_functiondef('public.fn_award_daily_mission_milestones(uuid)'::regprocedure),
    pg_get_functiondef('public.reroll_daily_challenge(uuid,uuid,text,integer,uuid)'::regprocedure),
    pg_get_functiondef('public.reroll_daily_challenge(uuid,uuid,text,integer)'::regprocedure)
  ]
  LOOP
    IF v_source NOT LIKE '%fn_lock_daily_mission_user%' THEN
      RAISE EXCEPTION 'A Daily Missions state path bypasses player serialization';
    END IF;
  END LOOP;

  IF to_regclass('public.daily_challenge_reroll_receipts') IS NULL
     OR to_regclass('public.daily_challenge_freeze_entitlements') IS NULL THEN
    RAISE EXCEPTION 'A Daily Missions replay or entitlement ledger is missing';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_enqueue_hand_daily_missions()'::regprocedure
  ) INTO v_source;
  IF v_source NOT LIKE '%event -> ''values''%'
     OR to_regprocedure(
       'public.enqueue_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)'
     ) IS NULL
     OR to_regprocedure(
       'public.record_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)'
     ) IS NULL THEN
    RAISE EXCEPTION 'Exact hand values are not wired through trigger, outbox, and recorder';
  END IF;

  SELECT pg_get_functiondef(
    'public.record_daily_challenge_event(uuid,text,jsonb,jsonb,jsonb,timestamptz)'::regprocedure
  ) INTO v_source;
  IF v_source NOT LIKE '%jsonb_array_elements%'
     OR v_source NOT LIKE '%candidate.value::text::numeric >= u.threshold_snapshot%'
     OR v_source NOT LIKE '%WHEN p_values ? u.challenge_type_snapshot%'
     OR v_source NOT LIKE '%jsonb_array_length(item.value) <> (p_amounts ->> item.key)::integer%'
     OR v_source NOT LIKE '%p_magnitudes -> u.challenge_type_snapshot%' THEN
    RAISE EXCEPTION 'Per-candidate threshold counting or scalar fallback is incomplete';
  END IF;
  IF has_table_privilege(
       'authenticated',
       'public.daily_challenge_reroll_receipts',
       'SELECT'
     )
     OR has_table_privilege(
       'authenticated',
       'public.daily_challenge_freeze_entitlements',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'A private Daily Missions receipt ledger is browser-readable';
  END IF;
  IF (
    SELECT count(*)
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid IN (
        'public.daily_challenge_reroll_receipts'::regclass,
        'public.daily_challenge_freeze_entitlements'::regclass
      )
      AND confrelid = 'public.profiles'::regclass
      AND confdeltype = 'c'
  ) <> 2 THEN
    RAISE EXCEPTION 'Daily Missions receipt ledgers do not cascade with profile cleanup';
  END IF;

  SELECT pg_get_functiondef(
    'public.reroll_daily_challenge(uuid,uuid,text,integer,uuid)'::regprocedure
  ) INTO v_source;
  IF v_source NOT LIKE '%challenge_reroll:%p_request_id%'
     OR v_source NOT LIKE '%request id is already bound%'
     OR v_source NOT LIKE '%daily_challenge_reroll_receipts%' THEN
    RAISE EXCEPTION 'Request-bound Daily Missions reroll replay is incomplete';
  END IF;

  SELECT pg_get_functiondef('public.get_challenge_streak(uuid)'::regprocedure)
  INTO v_source;
  IF v_source NOT LIKE '%streakRunId%'
     OR v_source NOT LIKE '%streakStartedOn%'
     OR v_source NOT LIKE '%streakEndedOn%'
     OR v_source NOT LIKE '%daily_challenge_freeze_entitlements%'
     OR v_source NOT LIKE '%NOT v_used_new_freeze%' THEN
    RAISE EXCEPTION 'Stable streak-run and freeze-entitlement contract is incomplete';
  END IF;

  SELECT pg_get_functiondef(
    'public.fn_award_daily_mission_milestones(uuid)'::regprocedure
  ) INTO v_source;
  IF v_source NOT LIKE '%streakRunId%'
     OR v_source NOT LIKE '%streakStartedOn%'
     OR v_source LIKE '%v_started := (now()%'
     OR v_source NOT LIKE '%streak_run_id%' THEN
    RAISE EXCEPTION 'Milestones do not use the authoritative stable streak run';
  END IF;

  SELECT pg_get_functiondef(
    'public.enqueue_daily_mission_reset_notifications(date,integer)'::regprocedure
  ) INTO v_source;
  IF v_source NOT LIKE '%fn_caller_is_engine()%'
     OR v_source LIKE '%auth.role() <> ''service_role''%' THEN
    RAISE EXCEPTION 'pg_cron cannot enter the Daily Missions reset enqueue contract';
  END IF;

  IF to_regnamespace('cron') IS NOT NULL THEN
    SELECT count(*) INTO v_job_count
    FROM cron.job
    WHERE jobname = 'daily-missions-reset-alerts-0002-utc'
      AND schedule = '2 0 * * *'
      AND active
      AND command LIKE '%fn_drain_daily_mission_reset_notifications%';

    IF v_job_count <> 1 THEN
      RAISE EXCEPTION 'Exactly one active 00:02 UTC Daily Missions reset job is required';
    END IF;
  END IF;
END;
$verify$;

COMMENT ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid) IS
'Replay-safe 10-diamond Daily Mission reroll. p_request_id binds the request, the debit reference is challenge_reroll:<request UUID>, and replay returns the committed card/balance with zero additional spend.';

COMMENT ON TABLE public.daily_challenge_freeze_entitlements IS
'One processed freeze entitlement per player, stable streak run, and seven-day threshold. Full inventory still records the threshold so spending later cannot mint it retroactively.';

COMMENT ON FUNCTION public.fn_drain_daily_mission_reset_notifications(date, integer, integer) IS
'Engine-only bounded reset-alert drain. Up to 100 batches of 5,000 cover more than 5,000 opt-ins without an unbounded transaction loop.';

NOTIFY pgrst, 'reload schema';

COMMIT;
