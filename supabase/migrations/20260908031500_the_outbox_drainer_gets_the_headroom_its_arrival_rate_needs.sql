-- ============================================================================
--  THE OUTBOX DRAINER GETS THE HEADROOM ITS ARRIVAL RATE NEEDS
--
--  With the index fix (20260908030000) each shard clears ~500-600 events per
--  run at ~25 ms an event, so four shards clear ~2,000-2,400 a minute against
--  an arrival rate of ~2,500 (measured 03:05-03:09 UTC: depth held at ~2,400
--  and the oldest row sat 3-5 minutes back instead of shrinking). The 20 s
--  budget, not the work, was the ceiling.
--
--  pg_cron runs as `postgres`, whose statement_timeout is 2 minutes, so 45 s
--  leaves ample margin and roughly doubles capacity to ~4,800/min. A run that
--  outlives its minute cannot overlap itself: the next one fails
--  pg_try_advisory_xact_lock for that shard and returns 0.
--
--  Everything else - the inlined shard bounds, the 250 ms lock_timeout, the
--  per-event subtransaction, the booking path - is unchanged from
--  20260908030000.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_drain_daily_challenge_event_outbox(
  p_limit integer DEFAULT 500,
  p_shard integer DEFAULT 0,
  p_shards integer DEFAULT 1
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_done integer := 0;
  v_skipped integer := 0;
  -- The cron gives this call the role's statement_timeout; the budget keeps
  -- it well inside that and lets four shards run every minute without ever
  -- overlapping themselves.
  c_budget CONSTANT interval := interval '45 seconds';
  v_deadline timestamptz := clock_timestamp() + c_budget;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Invalid outbox batch size';
  END IF;
  -- The shard count is inlined into the query text below so the expression
  -- index can match it, so it may only ever be one of these.
  IF p_shards IS NULL OR p_shards NOT IN (1, 2, 4, 8)
     OR p_shard IS NULL OR p_shard < 0 OR p_shard >= p_shards THEN
    RAISE EXCEPTION 'Invalid outbox shard %/%', p_shard, p_shards;
  END IF;
  -- One worker per shard at a time.
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('daily-missions-event-outbox-drain', p_shard)
  ) THEN
    RETURN 0;
  END IF;
  -- Never wait on a player who is being seated right now (see the header).
  PERFORM set_config('lock_timeout', '250ms', true);

  FOR r IN EXECUTE format(
    $q$
    SELECT *
      FROM public.daily_challenge_event_outbox
     WHERE dead_lettered_at IS NULL
       AND (
         occurred_at < now() - interval '35 days'
         OR next_attempt_at <= now()
       )
       AND (hashtext(user_id::text) & 2147483647) %% %s = %s
     ORDER BY user_id, created_at, event_key
     LIMIT %s
    $q$, p_shards, p_shard, p_limit)
  LOOP
    EXIT WHEN clock_timestamp() >= v_deadline;
    -- Each event in its own subtransaction: a deadlock or a lock timeout on
    -- one user's lock (a hand of theirs settling, or a seat being taken)
    -- skips that event to the next run instead of aborting the shard.
    BEGIN
      PERFORM public.fn_lock_daily_mission_user(r.user_id);
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
    EXCEPTION
      WHEN deadlock_detected OR lock_not_available OR serialization_failure THEN
        v_skipped := v_skipped + 1;
    END;
  END LOOP;

  IF v_skipped > 0 THEN
    RAISE NOTICE 'daily missions outbox shard %/%: booked %, skipped % on lock contention (retried next minute)',
      p_shard, p_shards, v_done, v_skipped;
  END IF;
  RETURN v_done;
END;
$function$;

COMMENT ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer, integer, integer) IS
  'Books queued Daily Missions events through enqueue_daily_challenge_event, oldest first per user, for the users whose hash falls in shard p_shard of p_shards (inlined so the expression index matches), until p_limit rows or a 45s budget. Sets a 250ms lock_timeout so a player being seated is skipped to the next run rather than waited on. Four shards run every minute.';

REVOKE ALL ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer, integer, integer) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_def text := pg_get_functiondef('public.fn_drain_daily_challenge_event_outbox(integer, integer, integer)'::regprocedure);
BEGIN
  IF position('EXECUTE format(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the shard bounds must be inlined so the expression index can match';
  END IF;
  IF position($q$set_config('lock_timeout', '250ms', true)$q$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'the drainer must never wait indefinitely on a player lock';
  END IF;
  IF position('p_shards NOT IN (1, 2, 4, 8)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'the inlined shard count must come from an allowlist';
  END IF;
  IF position($q$interval '45 seconds'$q$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'the drain budget must be 45s, inside the 2min statement timeout pg_cron runs under';
  END IF;
END $$;

COMMIT;
