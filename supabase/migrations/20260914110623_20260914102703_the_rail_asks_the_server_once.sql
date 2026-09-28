-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260914110623 "20260914102703_the_rail_asks_the_server_once"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 09be001d576e856f1edf7e652826904c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_get_ticker_feed(
  p_sources       jsonb   DEFAULT '{}'::jsonb,
  p_horizon_ms    integer DEFAULT 900000,
  p_rail_club_id  uuid    DEFAULT NULL
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

  v_want_soon      boolean := (p_sources->'starting_soon')        = 'true'::jsonb;
  v_want_overlays  boolean := (p_sources->'overlays')             = 'true'::jsonb;
  v_want_closing   boolean := (p_sources->'registration_closing') = 'true'::jsonb;
  v_want_guarantee boolean := (p_sources->'guarantees')           = 'true'::jsonb;
  v_want_results   boolean := (p_sources->'winner_results')       = 'true'::jsonb;
  v_want_tables    boolean := (p_sources->'table_openings')       = 'true'::jsonb;
BEGIN
  -- `->` on a missing key is NULL, and NULL = 'true'::jsonb is NULL, not false.
  v_want_soon      := COALESCE(v_want_soon, false);
  v_want_overlays  := COALESCE(v_want_overlays, false);
  v_want_closing   := COALESCE(v_want_closing, false);
  v_want_guarantee := COALESCE(v_want_guarantee, false);
  v_want_results   := COALESCE(v_want_results, false);
  v_want_tables    := COALESCE(v_want_tables, false);

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  v_horizon := v_now + make_interval(secs => LEAST(GREATEST(COALESCE(p_horizon_ms, 0), 0), 3600000) / 1000.0);

  SELECT COALESCE(array_agg(cm.club_id), '{}')
    INTO v_clubs
  FROM public.club_members cm
  WHERE cm.user_id = v_uid
    AND cm.status IN ('active', 'approved');

  IF array_length(v_clubs, 1) IS NULL THEN
    RETURN v_out
      || jsonb_build_object('clubs', 0, 'upcoming', '[]'::jsonb, 'overlays', '[]'::jsonb,
                            'reg_closing', '[]'::jsonb, 'guarantees', '[]'::jsonb,
                            'results', '[]'::jsonb, 'table_openings', '[]'::jsonb);
  END IF;

  v_out := v_out || jsonb_build_object('clubs', array_length(v_clubs, 1));

  v_out := v_out || jsonb_build_object('upcoming', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.start_time)
    FROM (
      SELECT t.id, t.name, t.start_time, t.club_id,
             t.buy_in_amount, t.buy_in_fee, t.current_players,
             EXISTS (
               SELECT 1 FROM public.tournament_players tp
               WHERE tp.tournament_id = t.id
                 AND tp.user_id = v_uid
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
      ORDER BY t.start_time
      LIMIT 25
    ) x
  ), '[]'::jsonb));

  v_out := v_out || jsonb_build_object('overlays', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.guaranteed_prize DESC)
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
      ORDER BY t.guaranteed_prize DESC
      LIMIT 25
    ) x
  ), '[]'::jsonb));

  v_out := v_out || jsonb_build_object('reg_closing', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb)
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
      ORDER BY COALESCE(t.started_at, t.start_time) DESC
      LIMIT 25
    ) x
  ), '[]'::jsonb));

  v_out := v_out || jsonb_build_object('guarantees', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.start_time)
    FROM (
      SELECT t.id, t.name, t.guaranteed_prize, t.current_players, t.start_time
      FROM public.tournaments t
      WHERE v_want_guarantee
        AND t.club_id = ANY(v_clubs)
        AND t.status IN ('ANNOUNCED', 'REGISTERING')
        AND t.guaranteed_prize > 0
        AND t.start_time > v_now
        AND t.start_time <= v_now + interval '2 hours'
      ORDER BY t.start_time
      LIMIT 25
    ) x
  ), '[]'::jsonb));

  v_out := v_out || jsonb_build_object('results', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.ended_at DESC)
    FROM (
      SELECT t.id, t.name, t.prize_pool, t.ended_at
      FROM public.tournaments t
      WHERE v_want_results
        AND t.club_id = ANY(v_clubs)
        AND t.status = 'COMPLETED'
        AND t.ended_at > v_now - interval '10 minutes'
      ORDER BY t.ended_at DESC
      LIMIT 25
    ) x
  ), '[]'::jsonb));

  v_out := v_out || jsonb_build_object('table_openings', COALESCE((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.created_at DESC)
    FROM (
      SELECT tb.id, tb.name, tb.game_variant, tb.created_at
      FROM public.tables tb
      WHERE v_want_tables
        AND tb.club_id = ANY(v_clubs)
        AND tb.tournament_id IS NULL
        AND tb.is_deleted = false
        AND tb.status IN ('waiting', 'running')
        AND tb.created_at > v_now - interval '10 minutes'
      ORDER BY tb.created_at DESC
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
  v_uid   uuid;
  v_feed  jsonb;
  v_all   jsonb;
BEGIN
  SELECT cm.user_id INTO v_uid
  FROM public.club_members cm
  WHERE cm.status IN ('active', 'approved')
  GROUP BY cm.user_id
  ORDER BY count(*) DESC
  LIMIT 1;

  IF v_uid IS NULL THEN
    RAISE NOTICE 'no club members; behavioural check skipped';
    RETURN;
  END IF;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  v_feed := public.fn_get_ticker_feed('{}'::jsonb, 900000, NULL);
  v_all  := public.fn_get_ticker_feed(
    '{"starting_soon":true,"overlays":true,"registration_closing":true,
      "guarantees":true,"winner_results":true,"table_openings":true}'::jsonb,
    900000, NULL);
  RESET ROLE;

  IF (v_feed->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'VERIFY FAILED: a member could not read the feed: %', v_feed;
  END IF;

  IF NOT (v_feed ? 'upcoming' AND v_feed ? 'overlays' AND v_feed ? 'reg_closing'
          AND v_feed ? 'guarantees' AND v_feed ? 'results' AND v_feed ? 'table_openings') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the feed is missing a source array: %', v_feed;
  END IF;

  IF jsonb_array_length(v_feed->'upcoming') <> 0
     OR jsonb_array_length(v_feed->'overlays') <> 0
     OR jsonb_array_length(v_feed->'reg_closing') <> 0
     OR jsonb_array_length(v_feed->'guarantees') <> 0
     OR jsonb_array_length(v_feed->'results') <> 0
     OR jsonb_array_length(v_feed->'table_openings') <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: a source that is switched off returned rows: %', v_feed;
  END IF;

  IF (v_all->>'clubs')::int < 1 THEN
    RAISE EXCEPTION 'VERIFY FAILED: a club member was scoped to no clubs: %', v_all;
  END IF;

  IF jsonb_array_length(v_all->'upcoming') > 25
     OR jsonb_array_length(v_all->'overlays') > 25
     OR jsonb_array_length(v_all->'reg_closing') > 25
     OR jsonb_array_length(v_all->'guarantees') > 25
     OR jsonb_array_length(v_all->'results') > 25
     OR jsonb_array_length(v_all->'table_openings') > 10 THEN
    RAISE EXCEPTION 'VERIFY FAILED: a source exceeded its row budget: %', v_all;
  END IF;

  RAISE NOTICE 'VERIFY OK: clubs=% upcoming=% overlays=% closing=% guarantees=% results=% tables=%',
    v_all->>'clubs',
    jsonb_array_length(v_all->'upcoming'), jsonb_array_length(v_all->'overlays'),
    jsonb_array_length(v_all->'reg_closing'), jsonb_array_length(v_all->'guarantees'),
    jsonb_array_length(v_all->'results'), jsonb_array_length(v_all->'table_openings');
END $$;

COMMIT;
