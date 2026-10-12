CREATE OR REPLACE PROCEDURE public.sp_drain_daily_challenge_event_outbox(IN p_limit integer DEFAULT 5000, IN p_shard integer DEFAULT 0, IN p_shards integer DEFAULT 1)
 LANGUAGE plpgsql
AS $procedure$
DECLARE
  c_budget constant interval := interval '45 seconds';
  c_user_batch constant integer := 100;
  v_deadline timestamptz := clock_timestamp() + c_budget;
  v_lock_key bigint;
  v_user_id uuid;
  v_result jsonb;
  v_seen integer := 0;
  v_done integer := 0;
  v_skipped integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Invalid outbox batch size';
  END IF;
  IF p_shards IS NULL OR p_shards NOT IN (1, 2, 4, 8)
     OR p_shard IS NULL OR p_shard < 0 OR p_shard >= p_shards THEN
    RAISE EXCEPTION 'Invalid outbox shard %/%', p_shard, p_shards;
  END IF;

  v_lock_key := hashtextextended('daily-missions-event-outbox-drain', p_shard);
  IF NOT pg_try_advisory_lock(v_lock_key) THEN
    RETURN;
  END IF;

  WHILE v_seen < p_limit AND clock_timestamp() < v_deadline LOOP
    -- COMMIT below resets transaction-local settings.  Restore the private
    -- lookup path explicitly at the start of every player's transaction.
    PERFORM set_config('search_path', 'pg_catalog, public, pg_temp', true);
    /* ONE PLAYER'S RECEIPT IS NOT WORTH AN FSYNC (2026-10-01). 21% of the
       drain's time was WAL flush at this per-player COMMIT. The event is
       booked and its outbox row deleted in one transaction, so a crash that
       loses an unflushed commit loses both and the event is drained again;
       any later synchronous commit flushes this one first. */
    PERFORM set_config('synchronous_commit', 'off', true);

    EXECUTE format(
      $q$
      SELECT o.user_id
        FROM public.daily_challenge_event_outbox o
       WHERE o.dead_lettered_at IS NULL
         AND (
           o.occurred_at < now() - interval '35 days'
           OR o.next_attempt_at <= now()
         )
         AND (hashtext(o.user_id::text) & 2147483647) %% %s = %s
         /* A DRAIN DRAINS WHAT WAS PENDING (2026-10-03). Events arrive at
            ~7/s, so the only early exit - the picker finding nothing - was
            unreachable and every shard ran its whole 45 s budget chasing
            arrivals: 1.135 cores held for 2.9 s of work, 1.98 events per
            per-player transaction. v_deadline - c_budget is this run's own
            entry instant, so the run finishes the backlog it found and the
            next minute takes the next one. A deferred row is at or before
            every later watermark, so nothing is stranded. */
         AND o.created_at <= $1
       ORDER BY o.user_id, o.created_at, o.event_key
       LIMIT 1
      $q$,
      p_shards,
      p_shard
    ) INTO v_user_id USING (v_deadline - c_budget);

    EXIT WHEN v_user_id IS NULL;

    v_result := public.fn_drain_daily_challenge_event_outbox_user(
      v_user_id,
      LEAST(c_user_batch, p_limit - v_seen)
    );
    v_seen := v_seen + COALESCE((v_result ->> 'seen')::integer, 0);
    v_done := v_done + COALESCE((v_result ->> 'booked')::integer, 0);
    v_skipped := v_skipped + COALESCE((v_result ->> 'skipped')::integer, 0);

    -- This is the repair: release this player's profile/advisory/row locks
    -- before the shard even discovers which player comes next.
    COMMIT AND CHAIN;

    -- A raced-away row must not spin this session forever.
    EXIT WHEN COALESCE((v_result ->> 'seen')::integer, 0) = 0;
  END LOOP;

  PERFORM pg_advisory_unlock(v_lock_key);
  IF v_skipped > 0 THEN
    RAISE NOTICE
      'daily missions outbox shard %/%: booked %, skipped % on lock contention',
      p_shard,
      p_shards,
      v_done,
      v_skipped;
  END IF;
END;
$procedure$
