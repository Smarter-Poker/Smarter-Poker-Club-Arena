-- The arena door names its format.
--
-- tables.game_type defaults to the legacy value 'nlhe', and the check
-- constraint tables_game_type_is_format requires 'cash' or 'tournament'. The
-- door did not name the column, so every call it could ever receive would have
-- been refused by that constraint before a row was written.
--
-- Found by using it. The first attempt to create the Diamond stake ladder was
-- rejected, which is the argument for a creation door that is exercised rather
-- than merely applied: a function nobody has called is a function nobody has
-- tested. Applied to production as version 20260911230759.

BEGIN;


CREATE OR REPLACE FUNCTION public.fn_poker_diamond_open_cash_table(
  p_name text,
  p_small_blind integer,
  p_big_blind integer,
  p_min_buy_in integer,
  p_max_buy_in integer,
  p_max_players integer DEFAULT 6
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_arena uuid;
  v_table uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  -- Platform staff only. Diamond Arena has no owner, no agents and no club
  -- hierarchy to borrow an authority from, so the only authority that exists
  -- for it is the platform's own. A staff permission is not an agent hierarchy.
  --
  -- THE ESTATE ALREADY HAS ONE ANSWER TO THIS QUESTION and it is
  -- fn_is_platform_admin(), which gates the RLS policies and the admin RPCs.
  -- The first draft of this function re-listed the roles by hand and got it
  -- wrong in both directions, which is the documented failure in
  -- src/utils/platformRoles.ts: a hand-written list admitted spellings that
  -- match nobody and excluded 'god', the highest privilege the platform
  -- issues. Ask the authority, never re-derive it.
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE = '42501';
  END IF;

  SELECT c.id INTO v_arena
  FROM public.clubs c
  WHERE c.asset = 'diamonds' AND c.is_platform = true AND c.union_id IS NULL
  LIMIT 1;

  IF v_arena IS NULL THEN
    RAISE EXCEPTION 'diamond_arena_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Whole Diamonds, and a band that makes sense. The engine refuses fractional
  -- amounts on every path; refusing them here means the refusal costs nobody a
  -- table they thought they had made.
  IF p_small_blind IS NULL OR p_big_blind IS NULL
     OR p_min_buy_in IS NULL OR p_max_buy_in IS NULL
     OR p_small_blind <= 0 OR p_big_blind <= 0
     OR p_min_buy_in <= 0 OR p_max_buy_in <= 0
     OR p_small_blind > p_big_blind
     OR p_min_buy_in > p_max_buy_in
     OR p_big_blind > p_min_buy_in
     OR p_max_buy_in > 2147483647
  THEN
    RAISE EXCEPTION 'diamond_table_requires_whole_positive_stakes' USING ERRCODE = '22023';
  END IF;

  IF p_max_players IS NULL OR p_max_players < 2 OR p_max_players > 10 THEN
    RAISE EXCEPTION 'diamond_table_requires_a_real_seat_count' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tables (
    club_id, union_id, tournament_id, cluster_id,
    name, game_type, game_variant, status, max_players,
    small_blind, big_blind, ante,
    min_buy_in, max_buy_in,
    rake_percent, rake_cap_bb, bbj_percent,
    is_template, insurance_enabled, bomb_pot_enabled,
    run_it_twice, allow_run_it_twice, run_it_twice_enabled,
    straddle_enabled, auto_utg_straddle, voluntary_straddle,
    seven_deuce_enabled, nit_game, all_in_or_fold, pineapple_holdem, cap_enabled
  ) VALUES (
    v_arena, NULL, NULL, NULL,
    coalesce(nullif(btrim(p_name), ''), 'Diamond Cash'), 'cash', 'nlh', 'waiting', p_max_players,
    p_small_blind, p_big_blind, 0,
    p_min_buy_in, p_max_buy_in,
    0, 0, 0,
    false, false, false,
    false, false, false,
    false, false, false,
    false, false, false, false, false
  )
  RETURNING id INTO v_table;

  RETURN v_table;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_open_cash_table(
  text, integer, integer, integer, integer, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_open_cash_table(
  text, integer, integer, integer, integer, integer
) TO authenticated;

COMMENT ON FUNCTION public.fn_poker_diamond_open_cash_table(
  text, integer, integer, integer, integer, integer
) IS
  'Opens one plain NLH Diamond cash table with every deduction explicitly zero '
  'and every optional feature explicitly false, so it is admissible by the '
  'Diamond boundary by construction. Platform staff only. Sets no economics: '
  'stakes are supplied by the caller. Does not open admission; '
  'cash_games_enabled is checked separately at buy-in and stays false.';


COMMIT;
