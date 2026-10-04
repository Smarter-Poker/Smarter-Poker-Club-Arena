CREATE OR REPLACE FUNCTION public.fn_drain_daily_challenge_event_outbox_user(p_user_id uuid, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_attempts integer;
  v_seen integer := 0;
  v_done integer := 0;
  v_skipped integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'A Daily Missions outbox player is required';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'A per-player Daily Missions outbox batch must be between 1 and 100';
  END IF;

  -- Read only enough state to choose the already-established lock patience.
  -- The row is rechecked after the player mutex has been acquired.
  SELECT o.attempts
    INTO v_attempts
    FROM public.daily_challenge_event_outbox o
   WHERE o.user_id = p_user_id
     AND o.dead_lettered_at IS NULL
     AND (
       o.occurred_at < now() - interval '35 days'
       OR o.next_attempt_at <= now()
     )
   ORDER BY o.created_at, o.event_key
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('seen', 0, 'booked', 0, 'skipped', 0);
  END IF;

  BEGIN
    PERFORM set_config(
      'lock_timeout',
      CASE WHEN COALESCE(v_attempts, 0) >= 3 THEN '3s' ELSE '250ms' END,
      true
    );
    /* A HELD PLAYER IS SKIPPED, NOT WAITED ON (2026-10-01). 41% of the
       drain's time was this wait, every sample behind fn_ca_horse_claim_due,
       which holds each horse it claims until its run commits; the wait then
       timed out into the skip below anyway. The player key is tried once
       and a held player takes the same skip path at once. */
    IF NOT pg_try_advisory_xact_lock(
      hashtextextended('daily-missions-user:' || p_user_id::text, 0)
    ) THEN
      RAISE EXCEPTION 'Daily Missions player % is held by another transaction', p_user_id
        USING ERRCODE = 'lock_not_available';
    END IF;
    PERFORM public.fn_lock_daily_mission_user(p_user_id);

    FOR r IN
      SELECT o.*
        FROM public.daily_challenge_event_outbox o
       WHERE o.user_id = p_user_id
         AND o.dead_lettered_at IS NULL
         AND (
           o.occurred_at < now() - interval '35 days'
           OR o.next_attempt_at <= now()
         )
       ORDER BY o.created_at, o.event_key
       LIMIT p_limit
    LOOP
      v_seen := v_seen + 1;

      IF r.occurred_at < now() - interval '35 days' THEN
        UPDATE public.daily_challenge_event_outbox
           SET dead_lettered_at = now(),
               last_error = left(
                 COALESCE(last_error || '; ', '')
                   || 'Authoritative event exceeded 35-day replay horizon',
                 1000
               )
         WHERE user_id = r.user_id
           AND event_key = r.event_key
           AND dead_lettered_at IS NULL
           AND occurred_at < now() - interval '35 days';
      ELSE
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
      END IF;
    END LOOP;
  EXCEPTION
    WHEN deadlock_detected OR lock_not_available OR serialization_failure THEN
      -- The failed lock statement's subtransaction has rolled back, so this
      -- evidence write does not inherit its short lock_timeout.  Advance only
      -- the oldest currently-due event, exactly as the former drainer did for
      -- the event whose player lock it could not acquire.
      UPDATE public.daily_challenge_event_outbox o
         SET attempts = o.attempts + 1,
             last_error = left(
               'Skipped on lock contention at ' || now()::text
                 || ' (the player was locked by another transaction)',
               1000
             ),
             next_attempt_at = now()
               + LEAST(
                   GREATEST(o.attempts + 1, 1) * interval '10 seconds',
                   interval '1 minute'
                 )
       WHERE (o.user_id, o.event_key) = (
         SELECT due.user_id, due.event_key
           FROM public.daily_challenge_event_outbox due
          WHERE due.user_id = p_user_id
            AND due.dead_lettered_at IS NULL
            AND (
              due.occurred_at < now() - interval '35 days'
              OR due.next_attempt_at <= now()
            )
          ORDER BY due.created_at, due.event_key
          LIMIT 1
      );
      -- Everything inside the protected block, including earlier successful
      -- event receipts, was rolled back by the subtransaction. PL/pgSQL local
      -- variables are not transactional, so reset the booked count explicitly
      -- or the caller reports work that does not exist.
      v_done := 0;
      v_seen := 1;
      v_skipped := 1;
  END;

  RETURN jsonb_build_object(
    'seen', v_seen,
    'booked', v_done,
    'skipped', v_skipped
  );
END;
$function$
