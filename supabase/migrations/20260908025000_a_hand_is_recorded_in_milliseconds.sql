-- ============================================================================
--  PHASE 8, PART 2: A HAND IS RECORDED IN MILLISECONDS; ITS MISSION PROGRESS
--  IS BOOKED BY THE OUTBOX, NOT INSIDE THE INSERT
--
--  MEASURED 2026-09-08 02:40 UTC (EXPLAIN ANALYZE of a real cash hand row,
--  rolled back): INSERT INTO hand_history = 502 ms, of which the row and its
--  eleven indexes cost 7 ms and TRIGGERS cost 495 ms:
--
--      trg_enqueue_hand_daily_missions   280 ms   (this file)
--      trg_ca_stats_live_from_hand       125 ms
--      hand_history_club_member_stats     82 ms
--      fold / position stats               9 ms
--
--  pg_stat_statements agrees: hand_history INSERTs are the second-largest
--  consumer on the whole database since 09-02 (~8,850 minutes, 199-402 ms
--  mean) - at ~530,000 hands a day that trigger chain alone is more than one
--  of the database's two cores, permanently. It is the saturation every
--  other symptom sits on top of (hourly crons timing out, the 8s PostgREST
--  cap being hit, deadlocks).
--
--  WHY THE MISSIONS TRIGGER COSTS 280 ms. For every player in the hand
--  (2-9) it calls enqueue_daily_challenge_event SYNCHRONOUSLY: the player's
--  Daily Missions advisory lock (which also locks their profiles row), an
--  outbox insert, two SELECT ... FOR UPDATE, record_daily_challenge_event
--  (a receipt insert into a 4 GB / 12.3 M-row table plus the challenge
--  bumps), and the outbox delete. Cold pages on the receipt table make it
--  40-360 ms per player. And because the hand insert takes every player's
--  missions lock, it deadlocked 12 times a day against horse seating until
--  20260906152850 re-ordered the seating function around it.
--
--  THE CHANGE. The trigger now does the one thing an outbox trigger should:
--  it writes the event to daily_challenge_event_outbox (ON CONFLICT DO
--  NOTHING) and returns - ~1 ms per player, no lock, no profiles row, no
--  receipt. fn_drain_daily_challenge_event_outbox - which has consumed that
--  outbox every minute since the pipeline was built, for retries - now does
--  the booking for every event, through the SAME enqueue_daily_challenge_event
--  it always called, so the idempotency contract (receipt per event key,
--  payload equality, 35-day replay horizon, dead-lettering) is untouched. The
--  drainer gains a 20s time budget so it can never outrun the cron's
--  statement timeout, and runs as four hash-sharded workers (by user) so its
--  throughput matches the fleet's event rate (~1,500-2,500 events/min at
--  peak; measured per-event cost once a user's pages are warm is 15-25 ms).
--  Events for one user always land in the same shard, in created_at order,
--  so per-user progress stays serial and the daily/weekly/monthly period
--  assignment is paid once per user per run instead of once per event.
--
--  WHAT A PLAYER SEES. Mission progress for a hand appears within about a
--  minute instead of at the moment the hand ends. Nothing is lost: a booking
--  that fails is retried by the same outbox machinery that has always
--  retried it. Horses and humans are booked identically (10.5).
--
--  NOT A REPAIR JOB (10.12). The outbox and its consumer are the pipeline's
--  own design, already in production; this moves the primary path onto them
--  and takes the work off the hand insert. The two remaining stats triggers
--  (207 ms) are the next cut.
-- ============================================================================
BEGIN;

-- 1. The trigger only enqueues.
CREATE OR REPLACE FUNCTION public.fn_enqueue_hand_daily_missions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  event jsonb;
  v_uid uuid;
BEGIN
  IF jsonb_typeof(NEW.daily_mission_events) <> 'array' THEN
    RETURN NEW;
  END IF;
  FOR event IN
    SELECT value
    FROM jsonb_array_elements(NEW.daily_mission_events)
    ORDER BY value ->> 'user_id', value::text
  LOOP
    BEGIN
      v_uid := (event ->> 'user_id')::uuid;
      IF v_uid IS NULL THEN CONTINUE; END IF;
      INSERT INTO public.daily_challenge_event_outbox
        (user_id, event_key, amounts, magnitudes, threshold_values, occurred_at)
      VALUES (
        v_uid,
        'hand:' || NEW.id::text,
        event -> 'amounts',
        COALESCE(event -> 'magnitudes', '{}'::jsonb),
        COALESCE(event -> 'values', '{}'::jsonb),
        COALESCE(NEW.ended_at, NEW.created_at, now())
      )
      ON CONFLICT (user_id, event_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Missions hand event % could not be queued: %',
        NEW.id,
        SQLERRM;
    END;
  END LOOP;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.fn_enqueue_hand_daily_missions() IS
  'AFTER INSERT on hand_history: writes one daily_challenge_event_outbox row per player in the hand and returns. The booking (receipt, challenge bumps) is done by fn_drain_daily_challenge_event_outbox within the minute. Was synchronous until 2026-09-08 and cost ~280 ms of every hand insert.';

-- 2. The drainer: time-budgeted, sharded by user. The one-argument signature
--    is dropped so a bare (500) call resolves to this one's defaults.
DROP FUNCTION IF EXISTS public.fn_drain_daily_challenge_event_outbox(integer);
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
  -- The cron gives this call the role's statement_timeout (2 min); the
  -- budget keeps it well inside that and lets four shards run every minute
  -- without ever overlapping themselves.
  c_budget CONSTANT interval := interval '20 seconds';
  v_deadline timestamptz := clock_timestamp() + c_budget;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Invalid outbox batch size';
  END IF;
  IF p_shards IS NULL OR p_shards < 1 OR p_shard IS NULL OR p_shard < 0 OR p_shard >= p_shards THEN
    RAISE EXCEPTION 'Invalid outbox shard %/%', p_shard, p_shards;
  END IF;
  -- One worker per shard at a time.
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('daily-missions-event-outbox-drain', p_shard)
  ) THEN
    RETURN 0;
  END IF;
  FOR r IN
    SELECT *
    FROM public.daily_challenge_event_outbox
    WHERE dead_lettered_at IS NULL
      AND (
        occurred_at < now() - interval '35 days'
        OR next_attempt_at <= now()
      )
      -- A user's events always belong to one shard, so their progress is
      -- booked serially and in order whichever worker picks them up.
      AND (hashtext(user_id::text) & 2147483647) % p_shards = p_shard
    ORDER BY user_id, created_at, event_key
    LIMIT p_limit
  LOOP
    EXIT WHEN clock_timestamp() >= v_deadline;
    -- Each event in its own subtransaction: a deadlock or lock timeout on
    -- one user's lock (a hand of theirs settling right now) skips that event
    -- to the next run instead of aborting the whole shard's minute.
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
    RAISE NOTICE 'daily missions outbox shard %/%: booked %, skipped % on lock contention (retried next minute)', p_shard, p_shards, v_done, v_skipped;
  END IF;
  RETURN v_done;
END;
$function$;

COMMENT ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer, integer, integer) IS
  'Books queued Daily Missions events through enqueue_daily_challenge_event, oldest first per user, for the users whose hash falls in shard p_shard of p_shards, until p_limit rows or a 20s budget. Four shards run every minute (daily-missions-outbox-minute-s0..s3). Since 2026-09-08 this is the primary booking path, not only the retry path.';

REVOKE ALL ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_enqueue_hand_daily_missions() FROM PUBLIC, anon, authenticated;

-- 3. Four workers a minute. The single job becomes shard 0 of 4; three more
--    join it. Idempotent: cron.schedule replaces a job of the same name.
SELECT cron.schedule('daily-missions-outbox-minute',    '* * * * *', $$SELECT public.fn_drain_daily_challenge_event_outbox(5000, 0, 4);$$);
SELECT cron.schedule('daily-missions-outbox-minute-s1', '* * * * *', $$SELECT public.fn_drain_daily_challenge_event_outbox(5000, 1, 4);$$);
SELECT cron.schedule('daily-missions-outbox-minute-s2', '* * * * *', $$SELECT public.fn_drain_daily_challenge_event_outbox(5000, 2, 4);$$);
SELECT cron.schedule('daily-missions-outbox-minute-s3', '* * * * *', $$SELECT public.fn_drain_daily_challenge_event_outbox(5000, 3, 4);$$);

-- 4. An index that lets each shard find its due rows without scanning the
--    whole outbox once it holds a minute's worth of events.
CREATE INDEX IF NOT EXISTS idx_daily_challenge_event_outbox_shard_due
  ON public.daily_challenge_event_outbox (((hashtext(user_id::text) & 2147483647) % 4), user_id, created_at)
  WHERE dead_lettered_at IS NULL;

DO $$
DECLARE v_trig text := pg_get_functiondef('public.fn_enqueue_hand_daily_missions()'::regprocedure);
BEGIN
  IF position('enqueue_daily_challenge_event' IN v_trig) > 0 THEN
    RAISE EXCEPTION 'the hand trigger must only write the outbox, never book inline';
  END IF;
  IF position('fn_lock_daily_mission_user' IN v_trig) > 0 THEN
    RAISE EXCEPTION 'the hand trigger must not take the missions lock';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname LIKE 'daily-missions-outbox-minute%') <> 4 THEN
    RAISE EXCEPTION 'four outbox workers are expected';
  END IF;
END $$;

COMMIT;
