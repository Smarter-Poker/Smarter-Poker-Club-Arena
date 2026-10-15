CREATE OR REPLACE FUNCTION public.fn_ca_horse_claim_due(p_limit integer DEFAULT 500)
 RETURNS TABLE(claimed integer, capped integer, failed integer, ran boolean, milestones_refused integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_claimed integer := 0; v_capped integer := 0; v_failed integer := 0; v_msg text;
  v_cap_resets timestamptz; v_by text; v_retry timestamptz; v_refused text;
  v_started timestamptz := clock_timestamp();
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_ca_horse_claim_due: service_role required';
  END IF;

  -- THE PLATFORM FREEZE (CLAUDE.md 13 rule 5). This moves money every minute, and profiles and
  -- diamond_transactions are NOT among the tables zz_freeze_guard protects - so nothing else would
  -- have stopped it crediting inside a :55-:00 break.
  IF public.fn_platform_frozen() THEN
    RETURN QUERY SELECT 0, 0, 0, false, 0;
    RETURN;
  END IF;

  -- xact-scoped: released at commit or rollback, with no unlock path to miss. The session-scoped
  -- form skipped its unlock on a statement timeout, because EXCEPTION WHEN OTHERS does not trap
  -- query_canceled - harmless under pg_cron (the backend exits) and a permanent leak from a pooled
  -- service_role backend, which also holds EXECUTE on this.
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_horse_claim_due')) THEN
    -- `ran = false` and not a zero count: "another run holds the lock" and "nothing was owed" are
    -- different answers and must not share a representation (CLAUDE.md 10.86 rule 1).
    RETURN QUERY SELECT 0, 0, 0, false, 0;
    RETURN;
  END IF;

  -- THE DAY A CAP RESETS (2026-09-30). fn_ca_diamond_earn_ledger counts a player's day in
  -- America/Chicago, so a reward its cap refused cannot be paid before that day's midnight.
  v_cap_resets := (date_trunc('day', now() AT TIME ZONE 'America/Chicago') + interval '1 day')
                  AT TIME ZONE 'America/Chicago';

  -- A deferral lives only as long as the reward it defers is owed.
  DELETE FROM public.ca_horse_claim_deferrals d
   WHERE NOT EXISTS (
     SELECT 1 FROM public.user_daily_challenges u
      WHERE u.id = d.challenge_row_id
        AND u.completed AND NOT u.claimed AND u.expired_at IS NULL
        AND u.completed_at >= now() - interval '7 days');

  -- The milestone step names, per transaction, the milestones it could not pay (20260930233000
  -- section 2). This run counts its own.
  PERFORM set_config('ca.daily_mission_milestones_refused', '', true);

  -- OLDEST FIRST TO CHOOSE, PRIMARY KEY ORDER TO LOCK (2026-09-24).
  --
  -- 33 claims died with `deadlock detected` between 2026-09-09 and 2026-09-22,
  -- across 29 horses. The whole loop is one transaction, so it holds every row
  -- lock it takes until it ends; it took them in completed_at order, while the
  -- four outbox drain shards update one player's rows in a single unordered
  -- bulk UPDATE on the same minute. Overlapping rows taken in two different
  -- orders is the cycle.
  --
  -- fn_expire_daily_challenge_rewards hit this on 2026-09-09 and its body
  -- carries the answer: primary key order gives every caller the same
  -- acquisition order, which is what makes a cycle impossible, and SKIP LOCKED
  -- leaves a row somebody is holding right now for the next run rather than
  -- waiting behind it. A skipped row is not a stranded one; it is still the
  -- oldest thing owed a minute later, so it is picked first next time.
  --
  -- The inner select still chooses by completed_at, so the limit continues to
  -- take what is closest to expiring. Only the order the locks are acquired in
  -- has changed, and the loop now never waits on a challenge row at all.
  --
  -- NOTHING REFUSED IS CHOSEN AGAIN BEFORE IT CAN BE PAID (2026-09-30). Oldest first
  -- used to mean a refused row was chosen again every minute, and on 2026-09-29/30 the
  -- refused rows of 160 horses filled the whole window: nothing behind them was paid for
  -- a day. A deferred row is not a candidate until its retry_after has passed.
  FOR r IN
    WITH oldest AS (
      SELECT u.id
        FROM public.user_daily_challenges u
        JOIN public.profiles p ON p.id = u.user_id AND p.is_horse
       WHERE u.completed AND NOT u.claimed AND u.expired_at IS NULL
         AND u.completed_at >= now() - interval '7 days'
         AND NOT EXISTS (SELECT 1 FROM public.ca_horse_claim_deferrals d
                          WHERE d.challenge_row_id = u.id AND d.retry_after > now())
       ORDER BY u.completed_at, u.id
       LIMIT GREATEST(COALESCE(p_limit, 500), 1)
    )
    SELECT u.id, u.user_id
      FROM public.user_daily_challenges u
      JOIN oldest o ON o.id = u.id
     ORDER BY u.id
       FOR UPDATE OF u SKIP LOCKED
  LOOP
    -- A RUN ENDS INSIDE ITS TIMEOUT (2026-10-01). pg_cron runs this as postgres, whose
    -- statement_timeout is two minutes, and a run that meets it pays nothing: it rolls back
    -- whole. Every claim registers its credit through a sum over ca_mint_ledger, so 500 of
    -- them do not fit. Stop starting claims at 45 seconds and commit what was paid; the rest
    -- are still the oldest owed a minute later.
    EXIT WHEN clock_timestamp() - v_started > interval '45 seconds';
    BEGIN
      PERFORM public.claim_daily_challenge_serialized_body(r.user_id, r.id, NULL);
      v_claimed := v_claimed + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg LIKE '%DR7:user_over_daily_cap%' THEN
        -- COUNTED, NOT FILED. A thousand horses meet the cap daily so an incident would be an
        -- always-on alarm, but returning it means the caller can see a run that paid nothing
        -- because everything was capped - which after DR7 arms is the difference between a
        -- backlog draining and a backlog dying. Since 2026-09-30 this is only ever the reward's
        -- own line: a streak milestone is paid apart from the claim and is counted below, in
        -- milestones_refused, never here.
        v_capped := v_capped + 1;
        v_by := 'DR7:user_over_daily_cap';
        v_retry := v_cap_resets;
      ELSE
        v_failed := v_failed + 1;
        v_by := 'CH3:horse_claim_failed';
        v_retry := now() + interval '10 minutes';
        BEGIN
          PERFORM public.fn_ca_diamond_incident(
            'CH3:horse_claim_failed', 'warning', r.user_id, NULL, 'fn_ca_horse_claim_due',
            jsonb_build_object('challenge_row_id', r.id, 'sqlerrm', v_msg));
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END IF;
      BEGIN
        INSERT INTO public.ca_horse_claim_deferrals AS d
               (challenge_row_id, user_id, refused_by, detail, retry_after)
        VALUES (r.id, r.user_id, v_by, left(v_msg, 500), v_retry)
        ON CONFLICT (challenge_row_id) DO UPDATE
           SET refused_by = EXCLUDED.refused_by,
               detail = EXCLUDED.detail,
               refusals = d.refusals + 1,
               last_refused_at = now(),
               retry_after = EXCLUDED.retry_after;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'fn_ca_horse_claim_due could not defer challenge row %: %', r.id, SQLERRM;
      END;
    END;
  END LOOP;

  v_refused := NULLIF(current_setting('ca.daily_mission_milestones_refused', true), '');
  RETURN QUERY SELECT v_claimed, v_capped, v_failed, true,
                      COALESCE(cardinality(string_to_array(v_refused, ',')), 0);
END $function$
