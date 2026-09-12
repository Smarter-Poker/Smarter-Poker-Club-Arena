-- ============================================================================
-- THE DIAMOND ARENA DEALS THE GAMES THE ESTATE DEALS
-- ============================================================================
--
-- Dan, 2026-09-11: "DIAMOND ARENA NEEDS TO BE A 1:1 CLONE OF THE CLUB ARENA
-- (ONLY DIFFERENCE IS ... ITS PLAYED WITH DIAMONDS INSTEAD OF CHIPS)". The chip
-- cash create screen offers nine variants. This is the same nine.
--
-- WHY IT IS SAFE, WHICH IS NOT THE SAME AS WHY IT IS WANTED. A Diamond does not
-- divide, so the only question another game raises is whether it divides a pot
-- somewhere the cent-denominated code did not have to care about. Every such
-- place was already made unit-aware while this arena was NLH only: the
-- run-it-twice per-board slice, the multi-board settlement, the tie chop inside
-- one board, the payout unit, and THE HI-LO SPLIT. The last is the one this
-- list newly reaches, and it takes the same unit the tie chop takes, so the low
-- half of a Diamond pot is a whole number of Diamonds and the odd unit goes to
-- high, which is the standard rule.
--
-- Nothing else divides. Pot-limit sizing is addition. Fixed-limit multiplies
-- the blind; its two halvings are reopen thresholds and are never wagered.
-- Short deck strips the deck and derives no ante. The bomb-pot ante is already
-- Diamond aware.
--
-- ONE LIST, in SQL as in TypeScript. `fn_poker_diamond_cash_variant` is the
-- only place SQL names these games; `DIAMOND_CASH_VARIANTS` is the only place
-- TypeScript does, and tests/a-diamond-table-has-one-shape.law.test.ts asserts
-- the two agree. That is the same discipline migration 20260912061500 applied
-- to the plain-cash rule hours earlier, for the same reason: the rule that had
-- drifted into five rules had drifted because it was written down five times.
--
-- THE CREATION DOOR GAINS A PARAMETER, which means the six-argument signature
-- is dropped and a seven-argument one takes its place: a default cannot be
-- added by CREATE OR REPLACE without leaving an overload behind, and an
-- ambiguous staff door is worse than a missing one. The new parameter defaults
-- to 'nlh', so every existing six-argument call keeps working and keeps
-- meaning what it meant.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The list, in one place.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_cash_variant(p_variant text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  /* NULL-SAFE ON PURPOSE. `NULL IN (...)` is NULL, not false, so without the
     first clause an unset `game_variant` made the whole plain-cash rule return
     NULL rather than false: a row that is neither admitted nor refused. Every
     caller today happens to treat unknown as refusal, which is exactly the
     kind of accident that holds until one of them writes `IF fn(...) = false`.
     An unset game is not a game. */
  SELECT p_variant IS NOT NULL
     AND p_variant IN ('nlh','plo4','plo5','plo6','plo8','pineapple','short_deck','flh','flo8');
$fn$;

COMMENT ON FUNCTION public.fn_poker_diamond_cash_variant(text) IS
  'The games a Diamond cash table may deal: the same nine the chip cash create screen offers. The only place SQL names them; DIAMOND_CASH_VARIANTS is the only place TypeScript does, and a law asserts the two agree.';

-- ---------------------------------------------------------------------------
-- 2. The plain-cash rule reads it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_plain_cash_table(p_t public.tables)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT NOT (
    NOT public.fn_poker_diamond_cash_variant(p_t.game_variant)
    OR p_t.tournament_id IS NOT NULL
    OR p_t.cluster_id IS NOT NULL
    OR coalesce(p_t.is_template,false)
    OR p_t.status NOT IN ('waiting','running','playing','active')
    OR p_t.rake_percent IS DISTINCT FROM 0 OR p_t.rake_cap_bb IS DISTINCT FROM 0
    OR p_t.bbj_percent IS DISTINCT FROM 0
    OR coalesce(p_t.insurance_enabled,false)
    OR p_t.run_it_twice IS NULL OR p_t.allow_run_it_twice IS NULL
    OR coalesce(p_t.seven_deuce_enabled,false) OR coalesce(p_t.nit_game,false)
    OR coalesce(p_t.all_in_or_fold,false) OR coalesce(p_t.pineapple_holdem,false)
    OR coalesce(p_t.cap_enabled,false)
  );
$fn$;

-- ---------------------------------------------------------------------------
-- 3. The hand settler reads it too, and this is NOT the exemption the plain
--    cash rule has. The settler deliberately asks nothing about FEATURE FLAGS,
--    because by settlement the hand is dealt and refusing a dealt hand parks
--    the table. The game is not a feature flag: it is which table this is, and
--    a settler that admits only hold'em cannot settle a hand of Omaha the same
--    arena just dealt. Widening it is what stops exactly that.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_old text; v_new text; v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_poker_diamond_settle_cash_hand';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'diamond_variants: the settler does not exist';
  END IF;
  IF v_def NOT LIKE '%fn_poker_diamond_cash_variant(%' THEN
    v_old := 'AND t.tournament_id IS NULL AND t.game_variant=''nlh''';
    v_new := 'AND t.tournament_id IS NULL AND public.fn_poker_diamond_cash_variant(t.game_variant)';
    v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'diamond_variants: the settler names its game % times, not once', v_hits;
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fn_poker_diamond_settle_cash_hand';
    IF v_def NOT LIKE '%fn_poker_diamond_cash_variant(t.game_variant)%'
       OR v_def LIKE '%t.game_variant=''nlh''%' THEN
      RAISE EXCEPTION 'diamond_variants: the settler did not take the replacement';
    END IF;
  END IF;
END
$do$;

-- ---------------------------------------------------------------------------
-- 4. The creation door names the game it is opening.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_poker_diamond_open_cash_table(
  text, integer, integer, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_open_cash_table(
  p_name text,
  p_small_blind integer,
  p_big_blind integer,
  p_min_buy_in integer,
  p_max_buy_in integer,
  p_max_players integer DEFAULT 6,
  p_game_variant text DEFAULT 'nlh')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_arena uuid;
  v_table uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  -- Platform staff only. The estate already has one answer to this question and
  -- it is fn_is_platform_admin(); never re-derive a role list.
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

  -- The door names the game, and refuses one this arena does not deal rather
  -- than opening a table the engine would then refuse to load.
  IF p_game_variant IS NULL OR NOT public.fn_poker_diamond_cash_variant(p_game_variant) THEN
    RAISE EXCEPTION 'diamond_table_requires_a_supported_game' USING ERRCODE = '22023';
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
    coalesce(nullif(btrim(p_name), ''), 'Diamond Cash'), 'cash', p_game_variant,
    'waiting', p_max_players,
    p_small_blind, p_big_blind, 0,
    p_min_buy_in, p_max_buy_in,
    0, 0, 0,
    false, false, false,
    false, false, false,
    false, false, false,
    false, false, false, false, false
  )
  RETURNING id INTO v_table;

  -- The row this door just wrote must be one the engine will admit. A door
  -- that can open a table nobody can sit at is worse than no door.
  IF NOT EXISTS (
    SELECT 1 FROM public.tables t
     WHERE t.id = v_table AND public.fn_poker_diamond_plain_cash_table(t)
  ) THEN
    RAISE EXCEPTION 'diamond_table_would_not_be_admitted' USING ERRCODE = '23514';
  END IF;

  RETURN v_table;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_open_cash_table(
  text, integer, integer, integer, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_open_cash_table(
  text, integer, integer, integer, integer, integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_open_cash_table(
  text, integer, integer, integer, integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_open_cash_table(
  text, integer, integer, integer, integer, integer, text) TO service_role;

COMMENT ON FUNCTION public.fn_poker_diamond_open_cash_table(
  text, integer, integer, integer, integer, integer, text) IS
  'Staff door: open one plain Diamond cash table in the platform arena. Names the game it opens (default nlh) and refuses one this arena does not deal, then proves the row it wrote would be admitted before returning it.';

-- ---------------------------------------------------------------------------
-- 5. Prove it.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_def text; v_bad text[] := '{}';
BEGIN
  FOR v_def IN
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('fn_poker_diamond_plain_cash_table',
                         'fn_poker_diamond_settle_cash_hand',
                         'fn_poker_diamond_open_cash_table')
  LOOP
    NULL;
  END LOOP;
  -- Every door that names a game names it through the one list.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname IN ('fn_poker_diamond_plain_cash_table',
                         'fn_poker_diamond_settle_cash_hand',
                         'fn_poker_diamond_open_cash_table')
       AND pg_get_functiondef(p.oid) NOT LIKE '%fn_poker_diamond_cash_variant(%'
  ) THEN
    RAISE EXCEPTION 'diamond_variants: a door still names its own game';
  END IF;
  -- And the six-argument creation door is gone rather than shadowed.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_poker_diamond_open_cash_table') <> 1 THEN
    RAISE EXCEPTION 'diamond_variants: the creation door is overloaded';
  END IF;
  -- The list itself answers what it must.
  IF NOT (public.fn_poker_diamond_cash_variant('plo8')
          AND public.fn_poker_diamond_cash_variant('nlh')
          AND NOT public.fn_poker_diamond_cash_variant('razz')
          AND NOT public.fn_poker_diamond_cash_variant('NLH')) THEN
    RAISE EXCEPTION 'diamond_variants: the list does not answer correctly';
  END IF;
  IF v_bad <> '{}' THEN RAISE EXCEPTION 'unreachable'; END IF;
END
$do$;
