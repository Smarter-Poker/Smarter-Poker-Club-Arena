-- ============================================================================
--  A SKIPPED MISSION EVENT SAYS SO, AND EVENTUALLY WINS ITS LOCK
--
--  20260908030000 gave the drainer a 250 ms lock_timeout so it could never
--  wait minutes on a player being seated. The skip it produced was SILENT:
--  the per-event subtransaction counted it into a NOTICE and left the row
--  exactly as it was - same attempts, same next_attempt_at - so the next run
--  retried it, lost the race again, and so on. Nothing in the table showed
--  it, which is the failure mode CLAUDE.md 10.86 is about: a detector that
--  answers when it does not know.
--
--  MEASURED 03:12 UTC, four minutes after that migration: one horse
--  (2928e6a1 "onyxravenscroft") had seven events queued since 03:09:05 and
--  was being skipped on every run, while a five-minute PostgREST money sweep
--  (p_days/p_apply/p_limit) held an advisory lock across its whole
--  transaction. Everything else drained; that player's progress simply
--  stopped, and only a hand-written query found it.
--
--  TWO CHANGES.
--  1. A SKIP IS WRITTEN DOWN. The row's attempts is incremented, last_error
--     records the contention, and next_attempt_at is pushed by a short
--     backoff (10 s per attempt, capped at a minute) so a contended player
--     does not spin against the same lock inside every run. `attempts > 0`
--     is now the honest signal it always should have been.
--  2. PATIENCE ESCALATES. A first attempt still waits only 250 ms - the
--     whole point of that timeout is that a busy player never stalls the
--     shard. From the fourth attempt the wait grows to 3 s, which is longer
--     than any ordinary holder of that lock, so a row cannot be starved
--     indefinitely by a queue of short transactions.
--
--  The booking path, the shard bounds, the budget and the lock ORDER are
--  unchanged from 20260908031500.
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
  -- Never wait long on a player who is being seated right now; the patience
  -- for a row that has already lost races is raised per event below.
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
      -- A row that keeps losing the race waits longer, so it cannot be
      -- starved for ever by a queue of short transactions.
      PERFORM set_config('lock_timeout',
                         CASE WHEN COALESCE(r.attempts, 0) >= 3 THEN '3s' ELSE '250ms' END,
                         true);
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
        -- WRITE THE SKIP DOWN. Without this the row looked untouched and was
        -- retried into the same contention on every run, invisibly.
        UPDATE public.daily_challenge_event_outbox
           SET attempts = attempts + 1,
               last_error = left('Skipped on lock contention at ' || now()::text
                                 || ' (the player was locked by another transaction)', 1000),
               next_attempt_at = now() + LEAST(GREATEST(attempts + 1, 1) * interval '10 seconds',
                                               interval '1 minute')
         WHERE user_id = r.user_id
           AND event_key = r.event_key;
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
  IF position('SET attempts = attempts + 1' IN v_def) = 0 THEN
    RAISE EXCEPTION 'a skipped event must be written down, never silently retried';
  END IF;
  IF position($q$THEN '3s' ELSE '250ms'$q$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'lock patience must escalate so a contended event cannot be starved';
  END IF;
END $$;

COMMIT;
