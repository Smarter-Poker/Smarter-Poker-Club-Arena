-- ============================================================================
--  ONE DAILY-MISSIONS PLAYER NEVER HOLDS ANOTHER PLAYER'S TABLE COMMIT HOSTAGE
--
--  Production PostgreSQL logs at 17:20 and 17:24 UTC showed the four outbox
--  shards holding hundreds of profiles rows at once.  The drainer's
--  per-event BEGIN/EXCEPTION blocks were subtransactions, not commits, so
--  every profiles FOR UPDATE lock survived until the entire 5-15 second shard
--  call returned.  table_seats' user_id foreign key needs a KEY SHARE lock on
--  that same profile during hand settlement.  Four healthy outbox workers
--  therefore formed a platform-wide lock convoy and pushed unrelated hand
--  commits into the 8/15 second request timeouts.
--
--  The outbox remains the authoritative primary pipeline.  Its event payload,
--  receipt, replay horizon, same-player mutex, ordering, lock patience, retry
--  evidence, and four hash shards do not change.  What changes is the actual
--  transaction boundary: pg_cron invokes a postgres-only PROCEDURE, and that
--  procedure commits after one player's bounded group before selecting the
--  next player.  A compatibility FUNCTION remains for service callers, but it
--  is deliberately one-player-only, so no caller can recreate the convoy.
--
--  This is not a timeout increase, a skipped check, or a later reconciliation
--  job.  It repairs the transaction boundary in the existing consumer.
-- ============================================================================
BEGIN;

-- Process one player's due rows inside the caller's current transaction.  The
-- outer procedure owns commit boundaries; keeping the booking body a function
-- also leaves one safe, one-player compatibility entrypoint for service_role.
CREATE OR REPLACE FUNCTION public.fn_drain_daily_challenge_event_outbox_user(
  p_user_id uuid,
  p_limit integer DEFAULT 100
)
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
$function$;

COMMENT ON FUNCTION public.fn_drain_daily_challenge_event_outbox_user(uuid, integer) IS
  'Private one-player Daily Missions outbox booking transaction body. The postgres-only shard procedure commits after each call so profile locks never accumulate across players.';

REVOKE ALL ON FUNCTION public.fn_drain_daily_challenge_event_outbox_user(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the established service-role signature, but make it structurally
-- incapable of locking more than one player in one transaction.
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
  v_user_id uuid;
  v_result jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Invalid outbox batch size';
  END IF;
  IF p_shards IS NULL OR p_shards NOT IN (1, 2, 4, 8)
     OR p_shard IS NULL OR p_shard < 0 OR p_shard >= p_shards THEN
    RAISE EXCEPTION 'Invalid outbox shard %/%', p_shard, p_shards;
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('daily-missions-event-outbox-drain', p_shard)
  ) THEN
    RETURN 0;
  END IF;

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
     ORDER BY o.user_id, o.created_at, o.event_key
     LIMIT 1
    $q$,
    p_shards,
    p_shard
  ) INTO v_user_id;

  IF v_user_id IS NULL THEN
    RETURN 0;
  END IF;

  v_result := public.fn_drain_daily_challenge_event_outbox_user(
    v_user_id,
    LEAST(p_limit, 100)
  );
  RETURN COALESCE((v_result ->> 'booked')::integer, 0);
END;
$function$;

COMMENT ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer, integer, integer) IS
  'One-player compatibility entrypoint for trusted service callers. pg_cron uses sp_drain_daily_challenge_event_outbox, whose commit-per-player boundary drains the whole shard without retaining unrelated profile locks.';

REVOKE ALL ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer, integer, integer)
  TO service_role;

-- Transaction control is forbidden in SECURITY DEFINER procedures and in a
-- procedure with a SET clause.  This procedure is therefore intentionally
-- invoker-rights, has no SET clause, is callable only by its postgres owner,
-- and schema-qualifies every application object.  pg_cron runs these four jobs
-- as postgres and invokes CALL as a top-level statement.
CREATE OR REPLACE PROCEDURE public.sp_drain_daily_challenge_event_outbox(
  p_limit integer DEFAULT 5000,
  p_shard integer DEFAULT 0,
  p_shards integer DEFAULT 1
)
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
       ORDER BY o.user_id, o.created_at, o.event_key
       LIMIT 1
      $q$,
      p_shards,
      p_shard
    ) INTO v_user_id;

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
$procedure$;

ALTER PROCEDURE public.sp_drain_daily_challenge_event_outbox(integer, integer, integer)
  OWNER TO postgres;
REVOKE ALL ON PROCEDURE public.sp_drain_daily_challenge_event_outbox(integer, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON PROCEDURE public.sp_drain_daily_challenge_event_outbox(integer, integer, integer) IS
  'Postgres-only primary Daily Missions outbox consumer. It preserves same-player serial booking and commits after each bounded player group so unrelated table settlements never wait behind accumulated profile locks.';

-- Same four primary-pipeline workers, now wired to the transaction-owning
-- procedure.  CALL must remain the top-level cron command: wrapping it in
-- SELECT or BEGIN would make PostgreSQL reject its COMMIT AND CHAIN.
SELECT cron.schedule(
  'daily-missions-outbox-minute',
  '* * * * *',
  $$CALL public.sp_drain_daily_challenge_event_outbox(5000, 0, 4);$$
);
SELECT cron.schedule(
  'daily-missions-outbox-minute-s1',
  '* * * * *',
  $$CALL public.sp_drain_daily_challenge_event_outbox(5000, 1, 4);$$
);
SELECT cron.schedule(
  'daily-missions-outbox-minute-s2',
  '* * * * *',
  $$CALL public.sp_drain_daily_challenge_event_outbox(5000, 2, 4);$$
);
SELECT cron.schedule(
  'daily-missions-outbox-minute-s3',
  '* * * * *',
  $$CALL public.sp_drain_daily_challenge_event_outbox(5000, 3, 4);$$
);

DO $assertions$
DECLARE
  v_function text := pg_get_functiondef(
    'public.fn_drain_daily_challenge_event_outbox(integer,integer,integer)'::regprocedure
  );
  v_user_function text := pg_get_functiondef(
    'public.fn_drain_daily_challenge_event_outbox_user(uuid,integer)'::regprocedure
  );
  v_procedure text := pg_get_functiondef(
    'public.sp_drain_daily_challenge_event_outbox(integer,integer,integer)'::regprocedure
  );
BEGIN
  IF position('LIMIT 1' IN v_function) = 0
     OR position('fn_drain_daily_challenge_event_outbox_user' IN v_function) = 0 THEN
    RAISE EXCEPTION 'the compatibility function must be structurally one-player-only';
  END IF;
  IF position('fn_lock_daily_mission_user' IN v_user_function) = 0
     OR position('ORDER BY o.created_at, o.event_key' IN v_user_function) = 0 THEN
    RAISE EXCEPTION 'the one-player body lost its player mutex or event order';
  END IF;
  IF position('COMMIT AND CHAIN' IN v_procedure) = 0 THEN
    RAISE EXCEPTION 'the primary consumer must commit after each player';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc p
     WHERE p.oid = 'public.sp_drain_daily_challenge_event_outbox(integer,integer,integer)'::regprocedure
       AND (p.prosecdef OR p.proconfig IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'transaction-owning procedure cannot be SECURITY DEFINER or carry a SET clause';
  END IF;
  IF has_function_privilege(
       'service_role',
       'public.sp_drain_daily_challenge_event_outbox(integer,integer,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'only postgres may invoke the transaction-owning procedure';
  END IF;
  IF (
    SELECT count(*)
      FROM cron.job
     WHERE jobname LIKE 'daily-missions-outbox-minute%'
       AND username = 'postgres'
       AND command ~ '^CALL public[.]sp_drain_daily_challenge_event_outbox[(]5000, [0-3], 4[)];$'
  ) <> 4 THEN
    RAISE EXCEPTION 'all four postgres-owned outbox shards must invoke the procedure with top-level CALL';
  END IF;
END;
$assertions$;

COMMIT;
