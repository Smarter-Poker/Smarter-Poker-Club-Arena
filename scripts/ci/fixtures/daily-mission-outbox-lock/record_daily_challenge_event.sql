CREATE OR REPLACE FUNCTION public.record_daily_challenge_event(p_user_id uuid, p_event_key text, p_amounts jsonb, p_magnitudes jsonb, p_values jsonb, p_occurred_at timestamp with time zone)
 RETURNS TABLE(id uuid, challenge_id text, progress integer, requirement integer, chip_reward numeric, diamond_reward integer, newly_completed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer;
  v_event public.daily_challenge_progress_events%ROWTYPE;
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
    SELECT * INTO STRICT v_event
    FROM public.daily_challenge_progress_events
    WHERE user_id = p_user_id
      AND event_key = p_event_key
    FOR UPDATE;

    IF v_event.amounts IS DISTINCT FROM p_amounts
       OR v_event.magnitudes IS DISTINCT FROM p_magnitudes
       OR v_event.threshold_values IS DISTINCT FROM p_values
       OR v_event.occurred_at IS DISTINCT FROM p_occurred_at
    THEN
      RAISE EXCEPTION 'Daily Missions event key is already bound to another payload';
    END IF;

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

  -- DIAMOND-RULINGS 3 (CLAUDE.md 10.5, horses are players): a horse has no browser, so the
  -- engine is its input device and it presses Claim the moment a human would be shown the
  -- and never breaks the progress just recorded.
  --
  -- five-argument serialized body, which nothing in the engine reaches; 733 challenges completed
  -- and 0 were claimed before this was noticed.
  -- The horse claim used to run here, which keyed it to a horse DOING something: a horse that
    -- stopped playing stopped claiming, and 23 quiet horses accumulated 759 rewards worth
    -- 51,380 diamonds. It is now fn_ca_horse_claim_due, keyed to who is OWED, on a minute
    -- tick. Recording an event does not pay anybody (CLAUDE.md 10.5, 10.11).
END;
$function$
