-- The horses stop writing what nobody reads.
--
-- WHY
-- ---------------------------------------------------------------------------
-- On 2026-09-04 Supabase auto-expanded this project's disk 135GB -> 202GB.
-- The cause was not a leak. Two correct fixes landed within an hour of each
-- other on 2026-09-02 and the 21:00 restart picked up both:
--
--   #2754  the hourly restart had been silently DROPPING resume batches, and
--          "a dropped table re-parks itself forever" - the fleet had been
--          decaying at every break. Active tables 1,920 -> 3,772.
--   #2755  syncStacks wrote time_bank_remaining to its existing value 408,121
--          times; realtime.list_changes was 17.46% of all database execution
--          time. Removing it unblocked the engine. Per-table pace +67%.
--
-- So the platform ran at roughly half its true capacity for as long as those
-- bugs existed, and the disk budget was implicitly sized against a BROKEN
-- engine. Neither fix is reverted. Instead, each hand gets cheaper.
--
-- Measured 2026-09-04:
--   hand_history           2,515,767 has_human=false   1,796 has_human=true
--   last 24h                 761,731 bot hands            24 human hands
--
-- WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT
-- ---------------------------------------------------------------------------
-- A read-path audit of all five cascade tables found only TWO where bot rows
-- are provably unread. Those two are also, by a wide margin, the largest:
--
--   ca_hand_player_idx               3.85 GB  13.7M rows   GATED HERE
--   daily_challenge_progress_events  1.60 GB   5.4M rows   GATED HERE
--
-- The other three are LEFT ALONE ON PURPOSE. Gating them saves ~159 MB and
-- breaks three user-visible things:
--
--   club_member_daily_stats (123 MB) - ca_club_top_players IS the club
--     leaderboard, and ca_dashboard_hide_horses DEFAULTS TO FALSE, so horses
--     are shown. Gating empties the dashboard a club owner opens.
--   ca_hand_facts (28 MB) - fn_nit_check judges VPIP from this table. With no
--     sample, `0 >= floor` is false and every horse returns within_limits
--     forever. That is the 2026-08-27 bug: a human evicted at 24.6% VPIP over
--     544 hands while the horse beside them came back ok. Humans thrown off
--     NIT tables, horses never. (Horses already only get rows at NIT tables.)
--   player_position_stats (8 MB) - feeds ca_stat_distribution, whose cohort is
--     584 of 585 horses. Gating collapses sample_size past the 1,000-hand
--     HAVING, p10/p90 stop being finite, and the benchmark bars on every
--     player's own stats page vanish.
--
-- BOTH GATES FAIL SAFE. An unknown flag keeps the old behaviour: a NULL
-- has_human still enqueues, a player with no profile row is still indexed.
-- Only a CONFIRMED bot is skipped. Getting this backwards would silently drop
-- a human's mission progress, which is worse than any amount of disk.
--
-- This stops the GROWTH. It does not reclaim the 13.7M rows already indexed;
-- that is a separate batched delete + repack.

-- ---------------------------------------------------------------------------
-- 1. Daily missions: a horse cannot complete a challenge, and never has.
--
--    Proven, not assumed. Horses hold 28,523 user_daily_challenges rows and
--    5,355,667 progress events, and have produced ZERO milestone claims and
--    ZERO streak rows - the entire branch terminates in nothing. The table is
--    REVOKE'd from anon and authenticated and has no read site in either
--    repo; it is a pure idempotency ledger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_enqueue_hand_daily_missions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE event jsonb;
BEGIN
  -- A hand with no human in it cannot advance any human's mission. COALESCE
  -- to TRUE so an unknown flag keeps the old behaviour and no human loses
  -- progress; only a hand positively marked bot-only is skipped.
  IF NOT COALESCE(NEW.has_human, true) THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.daily_mission_events) <> 'array' THEN RETURN NEW; END IF;
  FOR event IN SELECT value FROM jsonb_array_elements(NEW.daily_mission_events)
  LOOP
    BEGIN
      PERFORM public.enqueue_daily_challenge_event(
        (event->>'user_id')::uuid,
        'hand:' || NEW.id::text,
        event->'amounts',
        COALESCE(event->'magnitudes', '{}'::jsonb),
        COALESCE(NEW.ended_at, NEW.created_at, now())
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Missions hand event % could not be queued: %', NEW.id, SQLERRM;
    END;
  END LOOP;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Hand-player index: every reader is the logged-in player asking for their
--    own hands, and a horse never logs in.
--
--    ca_player_stats_overview_v2 and ca_player_hands_v2 both PERFORM
--    ca_assert_self(p_user); the underlying ca_player_stats_full and
--    ca_player_hands have EXECUTE revoked from authenticated. Every read is
--    scoped to the caller's own uuid. Horse rows in this table can never be
--    returned to anyone.
--
--    Filtered PER PLAYER rather than per hand, so a mixed table still indexes
--    its humans. LEFT JOIN, not JOIN: an id with no profile row is KEPT.
--    This also drains the pruner, which was deleting ~15M rows/day - those
--    deletes were pure WAL, and WAL the Realtime slot could not release.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ca_refresh_hand_player_index(p_max_hands integer DEFAULT 50000)
 RETURNS TABLE(hands_indexed integer, rows_added integer, floor_at timestamp with time zone, ceil_at timestamp with time zone, complete boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '10min'
AS $function$
DECLARE
  f timestamptz; c timestamptz; done boolean; new_floor timestamptz; new_ceil timestamptz;
  n_hands int := 0; n_rows int := 0; k int; kr int;
  v_chunk constant int := 3000;
  v_budget int := least(greatest(coalesce(p_max_hands, 3000), 1), 200000);
  v_deadline timestamptz := clock_timestamp() + interval '90 seconds';
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_refresh_hand_player_index')) THEN
    RETURN QUERY SELECT 0, 0, NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  SELECT idx_floor, idx_ceil, backfill_complete INTO f, c, done
  FROM public.ca_hand_player_idx_state WHERE id FOR UPDATE;
  IF f IS NULL THEN f := now(); END IF;
  IF c IS NULL THEN c := now(); END IF;

  -- Forward, in chunks, until caught up, out of budget, or out of time.
  LOOP
    EXIT WHEN n_hands >= v_budget OR clock_timestamp() >= v_deadline;
    SELECT max(created_at) INTO new_ceil
    FROM (
      SELECT created_at FROM public.hand_history
      WHERE created_at > c ORDER BY created_at, id LIMIT v_chunk
    ) bounded;
    EXIT WHEN new_ceil IS NULL;
    WITH src AS (
      SELECT h.id, h.created_at, h.players FROM public.hand_history h
      WHERE h.created_at > c AND h.created_at <= new_ceil
    ), expanded AS (
      SELECT DISTINCT ((pl->>'userId')::uuid) AS user_id, s.created_at, s.id AS hand_id
      FROM src s, jsonb_array_elements(s.players) pl
      WHERE pl->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ), human AS (
      -- Only a CONFIRMED horse is dropped. No profile row -> kept.
      SELECT e.user_id, e.created_at, e.hand_id
      FROM expanded e
      LEFT JOIN public.profiles pr ON pr.id = e.user_id
      WHERE NOT COALESCE(pr.is_horse, false)
    ), ins AS (
      INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
      SELECT user_id, created_at, hand_id FROM human
      ON CONFLICT DO NOTHING RETURNING 1
    )
    SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int INTO k, kr;
    n_hands := n_hands + coalesce(k, 0); n_rows := n_rows + coalesce(kr, 0); c := new_ceil;
  END LOOP;

  -- Backward, one chunk per run, exactly as before.
  IF NOT done AND clock_timestamp() < v_deadline THEN
    SELECT min(created_at) INTO new_floor FROM (
      SELECT created_at FROM public.hand_history
      WHERE created_at < f ORDER BY created_at DESC LIMIT v_chunk
    ) q;
    IF new_floor IS NULL THEN done := true;
    ELSE
      WITH src AS (
        SELECT h.id, h.created_at, h.players FROM public.hand_history h
        WHERE h.created_at < f AND h.created_at >= new_floor
      ), expanded AS (
        SELECT DISTINCT ((pl->>'userId')::uuid) AS user_id, s.created_at, s.id AS hand_id
        FROM src s, jsonb_array_elements(s.players) pl
        WHERE pl->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ), human AS (
        SELECT e.user_id, e.created_at, e.hand_id
        FROM expanded e
        LEFT JOIN public.profiles pr ON pr.id = e.user_id
        WHERE NOT COALESCE(pr.is_horse, false)
      ), ins AS (
        INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
        SELECT user_id, created_at, hand_id FROM human
        ON CONFLICT DO NOTHING RETURNING 1
      )
      SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int INTO k, kr;
      n_hands := n_hands + coalesce(k, 0); n_rows := n_rows + coalesce(kr, 0); f := new_floor;
      IF NOT EXISTS (SELECT 1 FROM public.hand_history WHERE created_at < f) THEN done := true; END IF;
    END IF;
  END IF;

  UPDATE public.ca_hand_player_idx_state
  SET idx_floor = least(coalesce(idx_floor, f), f),
      idx_ceil = greatest(coalesce(idx_ceil, c), c),
      backfill_complete = done,
      rows_indexed = rows_indexed + n_rows,
      updated_at = now()
  WHERE id;

  RETURN QUERY SELECT n_hands, n_rows, f, c, done;
END;
$function$;
