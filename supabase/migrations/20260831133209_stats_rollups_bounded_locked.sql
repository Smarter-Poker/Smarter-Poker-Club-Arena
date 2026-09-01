-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831133209; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- outage. The prior forward roll consumed the entire gap in one four-minute
-- transaction and had no lock, so a growing backlog could become impossible to
-- clear and overlapping callers could race the checkpoint backwards.

BEGIN;

CREATE OR REPLACE FUNCTION public.ca_roll_hand_stats_forward()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
SET statement_timeout = '4min'
AS $function$
DECLARE
  v_ceil timestamptz;
  v_now timestamptz := now();
  v_last_hand_at timestamptz;
  v_end timestamptz;
  v_hands int := 0;
  v_users uuid[];
  v_max_hands constant int := 15000;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_roll_hand_stats_forward')) THEN
    RETURN 0;
  END IF;

  SELECT rolled_ceil INTO v_ceil
  FROM public.ca_hand_player_stat_state
  WHERE id
  FOR UPDATE;

  IF v_ceil IS NULL OR v_ceil >= v_now THEN RETURN 0; END IF;

  SELECT max(created_at) INTO v_last_hand_at
  FROM (
    SELECT created_at
    FROM public.hand_history
    WHERE created_at >= v_ceil AND created_at < v_now
    ORDER BY created_at, id
    LIMIT v_max_hands
  ) bounded;

  IF v_last_hand_at IS NULL THEN
    UPDATE public.ca_hand_player_stat_state
    SET rolled_ceil = greatest(coalesce(rolled_ceil, v_now), v_now), updated_at = now()
    WHERE id;
    RETURN 0;
  END IF;

  -- Include every hand sharing the boundary timestamp. The next invocation
  -- starts at this exclusive end, so no tied hand can fall between batches.
  v_end := least(v_now, v_last_hand_at + interval '1 microsecond');

  SELECT count(*) INTO v_hands
  FROM public.hand_history
  WHERE created_at >= v_ceil AND created_at < v_end;

  WITH ins AS (
    INSERT INTO public.ca_hand_player_stat (
      user_id, hand_id, created_at, is_cash, tournament_id, game_variant,
      big_blind, small_blind, n_players, seat_position, my_blind, won_amt, is_winner,
      invested_actions, aggro_cnt, call_cnt, vpip, pfr, folded, three_bet,
      three_bet_opp, faced_three_bet, folded_to_three_bet, cbet_opp, cbet_made,
      showdown, hand_secs, profit)
    SELECT
      f.user_id, f.hand_id, f.created_at, f.is_cash, f.tournament_id, f.game_variant,
      f.big_blind, f.small_blind, f.n_players, f.seat_position, f.my_blind, f.won_amt, f.is_winner,
      f.invested_actions, f.aggro_cnt, f.call_cnt, f.vpip, f.pfr, f.folded, f.three_bet,
      f.three_bet_opp, f.faced_three_bet, f.folded_to_three_bet, f.cbet_opp, f.cbet_made,
      f.showdown, f.hand_secs, f.profit
    FROM public.ca_hand_player_facts(v_ceil, v_end) f
    ON CONFLICT (user_id, hand_id) DO NOTHING
    RETURNING user_id
  )
  SELECT array_agg(DISTINCT user_id) INTO v_users FROM ins;

  IF v_users IS NOT NULL THEN
    DELETE FROM public.ca_hand_player_stat s
    USING (
      SELECT user_id, hand_id,
             row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
      FROM public.ca_hand_player_stat
      WHERE user_id = ANY(v_users)
    ) r
    WHERE r.rn > 1000 AND s.user_id = r.user_id AND s.hand_id = r.hand_id;
  END IF;

  UPDATE public.ca_hand_player_stat_state
  SET rolled_ceil = greatest(coalesce(rolled_ceil, v_end), v_end), updated_at = now()
  WHERE id;

  RETURN v_hands;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_roll_hand_stats_forward() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_roll_hand_stats_forward() TO service_role;

-- Bound the forward half of the player-to-hand index refresh as well. The
-- backward half already honored p_max_hands; the forward half previously read
-- the entire outage gap despite accepting that parameter.
CREATE OR REPLACE FUNCTION public.ca_refresh_hand_player_index(p_max_hands integer DEFAULT 50000)
RETURNS TABLE(hands_indexed integer, rows_added integer, floor_at timestamptz, ceil_at timestamptz, complete boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout = '10min'
AS $function$
DECLARE
  f timestamptz; c timestamptz; done boolean; new_floor timestamptz; new_ceil timestamptz;
  n_hands int := 0; n_rows int := 0; k int; kr int;
  v_limit int := least(greatest(coalesce(p_max_hands, 50000), 1), 100000);
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_refresh_hand_player_index')) THEN
    RETURN QUERY SELECT 0, 0, NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  SELECT idx_floor, idx_ceil, backfill_complete INTO f, c, done
  FROM public.ca_hand_player_idx_state WHERE id FOR UPDATE;
  IF f IS NULL THEN f := now(); END IF;
  IF c IS NULL THEN c := now(); END IF;

  SELECT max(created_at) INTO new_ceil
  FROM (
    SELECT created_at FROM public.hand_history
    WHERE created_at > c ORDER BY created_at, id LIMIT v_limit
  ) bounded;
  IF new_ceil IS NOT NULL THEN
    WITH src AS (
      SELECT h.id, h.created_at, h.players FROM public.hand_history h
      WHERE h.created_at > c AND h.created_at <= new_ceil
    ), expanded AS (
      SELECT DISTINCT ((pl->>'userId')::uuid) AS user_id, s.created_at, s.id AS hand_id
      FROM src s, jsonb_array_elements(s.players) pl
      WHERE pl->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ), ins AS (
      INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
      SELECT user_id, created_at, hand_id FROM expanded
      ON CONFLICT DO NOTHING RETURNING 1
    )
    SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int INTO k, kr;
    n_hands := n_hands + coalesce(k, 0); n_rows := n_rows + coalesce(kr, 0); c := new_ceil;
  END IF;

  IF NOT done THEN
    SELECT min(created_at) INTO new_floor FROM (
      SELECT created_at FROM public.hand_history
      WHERE created_at < f ORDER BY created_at DESC LIMIT v_limit
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
      ), ins AS (
        INSERT INTO public.ca_hand_player_idx (user_id, created_at, hand_id)
        SELECT user_id, created_at, hand_id FROM expanded
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

REVOKE ALL ON FUNCTION public.ca_refresh_hand_player_index(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_hand_player_index(integer) TO service_role;

-- The owner-only notable-hands wrapper delegated to this service-only legacy
-- body, which appended a raw hand_history scan after idx_ceil. Remove that
-- tail exactly as the overview repair removed its live facts tail: notable
-- hands are a bounded snapshot and maintenance alone owns freshness.
DO $patch_hands$
DECLARE
  v_source text;
  v_start int;
  v_end int;
  v_marker constant text := E'  IF v_ceil IS NOT NULL THEN\n';
BEGIN
  SELECT pg_get_functiondef('public.ca_player_hands(uuid,text,integer)'::regprocedure)
  INTO v_source;

  v_start := position(v_marker IN v_source);
  IF v_start = 0 THEN
    RAISE EXCEPTION 'ca_player_hands raw-tail shape changed; refusing an unverified patch';
  END IF;
  v_end := position(E'  END IF;\n' IN substring(v_source FROM v_start));
  IF v_end = 0 THEN
    RAISE EXCEPTION 'ca_player_hands raw-tail terminator not found';
  END IF;

  v_source := substring(v_source FROM 1 FOR v_start - 1)
    || substring(v_source FROM v_start + v_end + length(E'  END IF;\n') - 1);

  IF position('h.created_at > v_ceil' IN v_source) > 0 THEN
    RAISE EXCEPTION 'ca_player_hands still contains the raw history tail';
  END IF;
  EXECUTE v_source;
END;
$patch_hands$;

COMMENT ON FUNCTION public.ca_player_hands_v2(uuid, text, integer) IS
  'Owner-only bounded notable-hand evidence. Reads indexed hand ids only and does not scan the live raw-history tail.';

DO $assert$
DECLARE v_hands_definition text;
BEGIN
  SELECT pg_get_functiondef('public.ca_player_hands(uuid,text,integer)'::regprocedure)
  INTO v_hands_definition;
  IF position('h.created_at > v_ceil' IN v_hands_definition) > 0 THEN
    RAISE EXCEPTION 'Stats notable-hand path can still scan unbounded live history';
  END IF;
  IF has_function_privilege('authenticated', 'public.ca_player_hands(uuid,text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'legacy notable-hand function became browser-callable';
  END IF;
END;
$assert$;


