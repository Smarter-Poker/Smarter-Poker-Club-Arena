-- 20260914112746_every_limited_read_on_the_rail_is_total
--
-- WHY THIS EXISTS SEPARATELY FROM THE MIGRATION ABOVE IT (2026-09-14)
--
-- 20260914102703 had ALREADY been applied to production when the final sweep
-- found this, so the fix could not go back into it: a migration that has run is
-- history. That file carries the corrected function too, so a fresh replay of
-- the directory is correct on its own and this one is a no-op replace. This file
-- is the record of what production actually received, and when.
--
-- THE DEFECT. `ORDER BY start_time LIMIT 25` does not name 25 rows when
-- start_times tie, and they tie constantly. Measured on production: 124 of 136
-- pre-start MTTs share an exact start_time with another, across 56 distinct
-- timestamps, 44 of which carry a tie, largest group five. No group is bigger
-- than the limit today, so the boundary falls INSIDE one - which makes the take
-- arbitrary there, and arbitrary again on the next poll with nothing underneath
-- having changed. That is the #4601 crowd-out in a new disguise: an eligible
-- major dropped in favour of a tied turbo, and a bar whose contents flicker for
-- no reason a player could name.
--
-- Every ORDER BY that feeds a LIMIT now ends on the row id, and so does every
-- jsonb_agg - whose output order is unspecified even over an ordered subquery.
-- A trailing id costs nothing and makes each take TOTAL.
--
-- The verification below is the property itself: two identical reads must agree
-- exactly. With a non-total ordering under a limit they need not.
--
-- ONE TRANSACTION, per CLAUDE.md's production DDL policy.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_get_ticker_feed(
  p_sources       jsonb   DEFAULT '{}'::jsonb,
  p_horizon_ms    integer DEFAULT 900000,     -- MAX_LEAD_MS: the longest rung
  p_rail_club_id  uuid    DEFAULT NULL        -- the club whose rail is painted
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_now      timestamptz := now();
  v_horizon  timestamptz;
  v_clubs    uuid[];
  v_out      jsonb := jsonb_build_object('ok', true);

  -- Each source is OFF unless the operator switched it on, and the comparison
  -- is against the jsonb literal `true` rather than a cast: a missing key, a
  -- null, a string and a number all read as off, and none of them can throw
  -- inside a function the whole bar depends on.
  v_want_soon      boolean := (p_sources->'starting_soon')        = 'true'::jsonb;
  v_want_overlays  boolean := (p_sources->'overlays')             = 'true'::jsonb;
  v_want_closing   boolean := (p_sources->'registration_closing') = 'true'::jsonb;
  v_want_guarantee boolean := (p_sources->'guarantees')           = 'true'::jsonb;
  v_want_results   boolean := (p_sources->'winner_results')       = 'true'::jsonb;
  v_want_tables    boolean := (p_sources->'table_openings')       = 'true'::jsonb;
BEGIN
  -- `->` on a missing key is NULL, and NULL = 'true'::jsonb is NULL, not false.
  -- A NULL switch would then make `WHERE v_want_soon AND ...` unknown, which
  -- happens to return no rows - the right answer by accident. Pin them.
  v_want_soon      := COALESCE(v_want_soon, false);
  v_want_overlays  := COALESCE(v_want_overlays, false);
  v_want_closing   := COALESCE(v_want_closing, false);
  v_want_guarantee := COALESCE(v_want_guarantee, false);
  v_want_results   := COALESCE(v_want_results, false);
  v_want_tables    := COALESCE(v_want_tables, false);

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  -- A horizon a caller cannot use to widen its own read past the ladder.
  v_horizon := v_now + make_interval(secs => LEAST(GREATEST(COALESCE(p_horizon_ms, 0), 0), 3600000) / 1000.0);

  SELECT COALESCE(array_agg(cm.club_id), '{}')
    INTO v_clubs
  FROM public.club_members cm
  WHERE cm.user_id = v_uid
    AND cm.status IN ('active', 'approved');

  IF array_length(v_clubs, 1) IS NULL THEN
    -- A player in no club has no rail. Every array empty, and no further reads.
    RETURN v_out
      || jsonb_build_object('clubs', 0, 'upcoming', '[]'::jsonb, 'overlays', '[]'::jsonb,
                            'reg_closing', '[]'::jsonb, 'guarantees', '[]'::jsonb,
                            'results', '[]'::jsonb, 'table_openings', '[]'::jsonb);
  END IF;

  v_out := v_out || jsonb_build_object('clubs', array_length(v_clubs, 1));

  -- ── STARTING SOON ────────────────────────────────────────────────────────
  -- MTT only (Dan 2026-08-21: spins and heads-up fire when their seats fill, and
  -- the platform holds thousands of them). Pre-start states only. `is_registered`
  -- is resolved here, which is what removes the 200-row tournament_players read.
  -- The club name is attached ONLY when the event is somewhere other than the
  -- club whose rail is being painted - naming the room the player is standing
  -- in would be noise on every line.
  v_out := v_out || jsonb_build_object('upcoming', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.start_time, x.id)
    FROM (
      SELECT t.id, t.name, t.start_time, t.club_id,
             t.buy_in_amount, t.buy_in_fee, t.current_players,
             EXISTS (
               SELECT 1 FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id
                 AND tp.user_id = v_uid
                 -- Written in LOWER case by TournamentService: 'registered' on
                 -- entry, flipped to 'playing' at start. Both are kept because
                 -- this only ever meets pre-start events, so 'playing' cannot
                 -- leak a running one onto the bar.
                 AND tp.status IN ('registered', 'playing')
             ) AS is_registered,
             CASE WHEN p_rail_club_id IS NOT NULL AND t.club_id <> p_rail_club_id
                  THEN (SELECT c.name FROM public.clubs c WHERE c.id = t.club_id)
                  ELSE NULL END AS foreign_club_name
      FROM public.tournaments t
      WHERE v_want_soon
        AND t.club_id = ANY(v_clubs)
        AND t.tournament_type = 'MTT'
        AND t.status IN ('ANNOUNCED', 'REGISTERING')
        AND t.start_time > v_now
        AND t.start_time <= v_horizon
      ORDER BY t.start_time, t.id
      LIMIT 25
    ) x
  ), '[]'::jsonb));

  -- ── OVERLAYS ─────────────────────────────────────────────────────────────
  -- A running event whose guarantee the entries have not covered. Ranked in the
  -- client, which owns that judgement; ordered by guarantee here only so the
  -- limit takes the biggest rather than an arbitrary twenty-five.
  v_out := v_out || jsonb_build_object('overlays', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.guaranteed_prize DESC, x.id)
    FROM (
      SELECT t.id, t.name, t.status, t.start_time, t.guaranteed_prize, t.prize_pool,
             t.current_players, t.buy_in_amount, t.late_reg_levels, t.late_reg_mins,
             t.started_at, t.current_level, t.max_players
      FROM public.tournaments t
      WHERE v_want_overlays
        AND t.club_id = ANY(v_clubs)
        AND t.tournament_type = 'MTT'
        AND t.guaranteed_prize > 0
        AND t.status IN ('RUNNING', 'IN_PROGRESS', 'LATE_REG', 'LATE_REGISTRATION')
      ORDER BY t.guaranteed_prize DESC, t.id
      LIMIT 25
    ) x
  ), '[]'::jsonb));

  -- ── REGISTRATION CLOSING ─────────────────────────────────────────────────
  -- The superset argued for in the header. 1,028 -> 2 for a real three-club
  -- member. The exact close time is still lateRegEndMs()'s to compute.
  v_out := v_out || jsonb_build_object('reg_closing', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.id)
    FROM (
      SELECT t.id, t.name, t.status, t.start_time, t.started_at,
             t.late_reg_levels, t.late_reg_mins, t.current_level,
             t.blind_structure, t.level_started_at
      FROM public.tournaments t
      WHERE v_want_closing
        AND t.club_id = ANY(v_clubs)
        AND t.status IN ('RUNNING', 'LATE_REG', 'LATE_REGISTRATION')
        AND (
          ( COALESCE(t.late_reg_mins, 0) > 0
            AND COALESCE(t.started_at, t.start_time) + make_interval(mins => t.late_reg_mins) >  v_now
            AND COALESCE(t.started_at, t.start_time) + make_interval(mins => t.late_reg_mins) <= v_now + interval '5 minutes' )
          OR
          ( COALESCE(t.late_reg_levels, 0) > 0
            AND COALESCE(t.current_level, 0) < t.late_reg_levels
            AND t.level_started_at IS NOT NULL
            AND t.level_started_at > v_now - interval '12 hours' )
        )
      ORDER BY COALESCE(t.started_at, t.start_time) DESC, t.id
      LIMIT 25
    ) x
  ), '[]'::jsonb));

  -- ── GUARANTEES ───────────────────────────────────────────────────────────
  -- Pre-start, guaranteed, inside two hours. The exact predicate: three rows
  -- for that same member, none of which the eighty-row sweep was likely to hold.
  v_out := v_out || jsonb_build_object('guarantees', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.start_time, x.id)
    FROM (
      SELECT t.id, t.name, t.guaranteed_prize, t.current_players, t.start_time
      FROM public.tournaments t
      WHERE v_want_guarantee
        AND t.club_id = ANY(v_clubs)
        AND t.status IN ('ANNOUNCED', 'REGISTERING')
        AND t.guaranteed_prize > 0
        AND t.start_time > v_now
        AND t.start_time <= v_now + interval '2 hours'
      ORDER BY t.start_time, t.id
      LIMIT 25
    ) x
  ), '[]'::jsonb));

  -- ── RESULTS ──────────────────────────────────────────────────────────────
  -- Finished inside the last ten minutes, which is exactly how long the client
  -- renders one for.
  v_out := v_out || jsonb_build_object('results', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.ended_at DESC, x.id)
    FROM (
      SELECT t.id, t.name, t.prize_pool, t.ended_at
      FROM public.tournaments t
      WHERE v_want_results
        AND t.club_id = ANY(v_clubs)
        AND t.status = 'COMPLETED'
        AND t.ended_at > v_now - interval '10 minutes'
      ORDER BY t.ended_at DESC, t.id
      LIMIT 25
    ) x
  ), '[]'::jsonb));

  -- ── TABLE OPENINGS ───────────────────────────────────────────────────────
  v_out := v_out || jsonb_build_object('table_openings', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.created_at DESC, x.id)
    FROM (
      SELECT tb.id, tb.name, tb.game_variant, tb.created_at
      FROM public.tables tb
      WHERE v_want_tables
        AND tb.club_id = ANY(v_clubs)
        AND tb.tournament_id IS NULL
        AND tb.is_deleted = false
        AND tb.status IN ('waiting', 'running')
        AND tb.created_at > v_now - interval '10 minutes'
      ORDER BY tb.created_at DESC, tb.id
      LIMIT 10
    ) x
  ), '[]'::jsonb));

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_get_ticker_feed(jsonb, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_ticker_feed(jsonb, integer, uuid) TO authenticated, service_role;

DO $$
DECLARE
  v_uid uuid;
  v_a   jsonb;
  v_b   jsonb;
  v_off jsonb;
BEGIN
  SELECT cm.user_id INTO v_uid
  FROM public.club_members cm
  WHERE cm.status IN ('active', 'approved')
  GROUP BY cm.user_id ORDER BY count(*) DESC LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE NOTICE 'no club members; behavioural check skipped';
    RETURN;
  END IF;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  v_a := public.fn_get_ticker_feed(
    '{"starting_soon":true,"overlays":true,"registration_closing":true,
      "guarantees":true,"winner_results":true,"table_openings":true}'::jsonb, 900000, NULL);
  v_b := public.fn_get_ticker_feed(
    '{"starting_soon":true,"overlays":true,"registration_closing":true,
      "guarantees":true,"winner_results":true,"table_openings":true}'::jsonb, 900000, NULL);
  v_off := public.fn_get_ticker_feed('{}'::jsonb, 900000, NULL);
  RESET ROLE;

  IF (v_a->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'VERIFY FAILED: a member could not read the feed: %', v_a;
  END IF;

  -- THE POINT OF THIS MIGRATION: two identical reads must agree exactly.
  IF v_a->'upcoming' <> v_b->'upcoming'
     OR v_a->'overlays' <> v_b->'overlays'
     OR v_a->'reg_closing' <> v_b->'reg_closing'
     OR v_a->'guarantees' <> v_b->'guarantees'
     OR v_a->'results' <> v_b->'results'
     OR v_a->'table_openings' <> v_b->'table_openings' THEN
    RAISE EXCEPTION 'VERIFY FAILED: two identical reads disagreed, so a take is still arbitrary';
  END IF;

  IF jsonb_array_length(v_off->'upcoming') <> 0
     OR jsonb_array_length(v_off->'overlays') <> 0
     OR jsonb_array_length(v_off->'reg_closing') <> 0
     OR jsonb_array_length(v_off->'guarantees') <> 0
     OR jsonb_array_length(v_off->'results') <> 0
     OR jsonb_array_length(v_off->'table_openings') <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: a source that is switched off returned rows: %', v_off;
  END IF;
END $$;

COMMIT;
