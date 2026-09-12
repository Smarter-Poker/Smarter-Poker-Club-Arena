-- ============================================================================
-- ONE RULE SAYS WHAT A PLAIN DIAMOND CASH TABLE IS
-- ============================================================================
--
-- The rule lived in five functions and had drifted into five different rules.
-- Measured on production before this migration, by md5 of the clause alone:
--
--   fn_poker_diamond_buyin                    045578...  the current, correct one
--   fn_poker_diamond_top_up                   d21393...  no rake_cap_bb, permits an
--                                                        UNSET rake, refuses straddles,
--                                                        run it twice AND bomb pots
--   fn_poker_diamond_set_table_straddle       e3eed6...  refuses bomb pots and refuses
--                                                        a table with run it twice ON
--   fn_poker_diamond_set_table_run_it_twice   afdd6a...  refuses bomb pots
--   fn_poker_diamond_set_table_bomb_pot       16609b...  permits both, states neither
--                                                        run-it column
--
-- Two separate defects, and the top-up door carries both at once.
--
-- TOO STRICT. A Diamond table with straddles, run it twice or bomb pots on can
-- be bought into and seated and will deal, and the player can then never top
-- up: `diamond_plain_cash_table_required` from a door that was written on
-- 2026-09-12 before any of those three were permitted. The features shipped
-- that day each lifted the refusal in the buy-in door and in the engine
-- boundary, and none of them lifted it here.
--
-- TOO LOOSE, and this is the direction that matters. `coalesce(rake_percent,0)
-- <> 0` reads an UNSET rake as zero, and `rake_cap_bb` is not read at all. The
-- buy-in door was corrected on 2026-09-12 (migration 20260912014500) because
-- UNSET IS NOT OFF: the engine reads an absent column as the chip schedule's
-- default, so a table admitted on a NULL is a table the engine would then
-- refuse to load. The top-up door was never corrected.
--
-- Nothing live is affected today. All seventeen Diamond tables are `waiting`
-- with all four columns explicitly stated and every feature off. This is a
-- latent break of the features shipped hours earlier, closed before anything
-- can reach it.
--
-- THE STAFF DOORS ASK A DIFFERENT QUESTION, and hand-copying the money door's
-- list was the wrong way to answer it. A door that turns a feature ON must
-- refuse a table that would not be admissible AFTERWARDS - which is not the
-- same as a table that is admissible now, because the door is about to change
-- it. Each one therefore builds the row it is about to write and tests THAT.
-- The mutual exclusions disappear with the copies: a straddle can be turned on
-- at a table that runs it twice, and run it twice at a table that bombs,
-- because the one rule permits all three together and always did.
--
-- The hand SETTLER deliberately keeps its own narrow check and is not touched.
-- By settlement the hand has already been dealt, and refusing to settle a
-- dealt hand parks the table with the seat stuck - the exact failure the run
-- it twice work was written to avoid. It verifies the arena, the variant and
-- the hand's own invariants, and asks nothing about feature flags.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The rule, in one place.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_plain_cash_table(p_t public.tables)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT NOT (
    p_t.game_variant IS DISTINCT FROM 'nlh' OR p_t.tournament_id IS NOT NULL
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

COMMENT ON FUNCTION public.fn_poker_diamond_plain_cash_table(public.tables) IS
  'The single answer to "is this a plain Diamond cash table". Every Diamond money door and every staff door reads it. IS DISTINCT FROM, not coalesce: an unset column is the chip schedule''s default to the engine, so it is never read as off here.';

-- ---------------------------------------------------------------------------
-- 2. The two money doors read it.
--
--    The clause is not retyped. It is READ from the live definition, bounded
--    by the structure that holds it (the `IF` that introduces it and the
--    `RAISE` that ends it), replaced, and re-created. Exact by construction
--    rather than by proofreading, which is how the 34KB settlement function
--    was edited on 2026-09-12. Every step asserts: the function exists, the
--    clause is found exactly once, the result actually changed, and the result
--    calls the predicate. Any failure raises and the migration rolls back.
--
--    A function that already calls the predicate is skipped, so this is safe
--    to replay onto a database built from the migration history.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_name text;
  v_def text;
  v_old text;
  v_new text;
  v_start int;
  v_raise int;
  v_hits int;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['fn_poker_diamond_buyin','fn_poker_diamond_top_up'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name AND p.prokind = 'f';
    IF v_def IS NULL THEN
      RAISE EXCEPTION 'plain_cash_rule: % does not exist', v_name;
    END IF;
    CONTINUE WHEN v_def LIKE '%fn_poker_diamond_plain_cash_table(%';

    v_start := position('IF v_t.game_variant IS DISTINCT' IN v_def);
    v_raise := position('RAISE EXCEPTION ''diamond_plain_cash_table_required''' IN v_def);
    IF v_start = 0 OR v_raise = 0 OR v_raise <= v_start THEN
      RAISE EXCEPTION 'plain_cash_rule: % does not carry the clause this migration replaces', v_name;
    END IF;

    -- From the `IF` through the whitespace that precedes the RAISE, so the
    -- trailing layout is preserved exactly when the head is swapped.
    v_old := substring(v_def FROM v_start FOR (v_raise - v_start));
    -- rtrim/1 strips SPACES only; the clause ends with a newline and an
    -- indent, so the whitespace class has to be named.
    IF right(rtrim(v_old, E' \t\r\n'), 4) <> 'THEN' THEN
      RAISE EXCEPTION 'plain_cash_rule: %''s clause does not end in THEN', v_name;
    END IF;

    v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_hits <> 1 THEN
      RAISE EXCEPTION 'plain_cash_rule: %''s clause appears % times, not once', v_name, v_hits;
    END IF;

    v_new := 'IF NOT public.fn_poker_diamond_plain_cash_table(v_t) THEN'
             || substring(v_old FROM length(rtrim(v_old, E' \t\r\n')) + 1);

    v_def := replace(v_def, v_old, v_new);
    EXECUTE v_def;

    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name AND p.prokind = 'f';
    IF v_def NOT LIKE '%fn_poker_diamond_plain_cash_table(v_t)%' THEN
      RAISE EXCEPTION 'plain_cash_rule: % did not take the replacement', v_name;
    END IF;
    IF v_def LIKE '%v_t.game_variant IS DISTINCT%' THEN
      RAISE EXCEPTION 'plain_cash_rule: % still carries its own copy', v_name;
    END IF;
  END LOOP;
END
$do$;

-- ---------------------------------------------------------------------------
-- 3. The staff doors test the row they are about to write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_set_table_straddle(
  p_table_id uuid, p_enabled boolean, p_auto_utg boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_t public.tables%ROWTYPE; v_after public.tables%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL THEN
  RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
 END IF;
 IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;
 IF p_table_id IS NULL OR p_enabled IS NULL OR p_auto_utg IS NULL THEN
  RAISE EXCEPTION 'diamond_straddle_requires_explicit_flags' USING ERRCODE='22023';
 END IF;
 IF p_auto_utg AND NOT p_enabled THEN
  RAISE EXCEPTION 'diamond_straddle_auto_requires_straddles' USING ERRCODE='22023';
 END IF;
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL
 FOR UPDATE OF t;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
 END IF;
 -- The row as it will be, not as it is: this door is about to change it.
 v_after:=v_t;
 v_after.straddle_enabled:=p_enabled;
 v_after.auto_utg_straddle:=CASE WHEN p_enabled THEN p_auto_utg ELSE false END;
 v_after.voluntary_straddle:=CASE WHEN p_enabled THEN NOT p_auto_utg ELSE false END;
 IF NOT public.fn_poker_diamond_plain_cash_table(v_after) THEN
  RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables
   SET straddle_enabled=v_after.straddle_enabled,
       auto_utg_straddle=v_after.auto_utg_straddle,
       voluntary_straddle=v_after.voluntary_straddle
 WHERE id=p_table_id;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_set_table_run_it_twice(
  p_table_id uuid, p_enabled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_t public.tables%ROWTYPE; v_after public.tables%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL THEN
  RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
 END IF;
 IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;
 IF p_table_id IS NULL OR p_enabled IS NULL THEN
  RAISE EXCEPTION 'diamond_run_it_twice_requires_an_explicit_flag' USING ERRCODE='22023';
 END IF;
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL
 FOR UPDATE OF t;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
 END IF;
 v_after:=v_t;
 v_after.run_it_twice:=p_enabled;
 v_after.allow_run_it_twice:=p_enabled;
 v_after.run_it_twice_enabled:=false;
 IF NOT public.fn_poker_diamond_plain_cash_table(v_after) THEN
  RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables
   SET run_it_twice=v_after.run_it_twice,
       allow_run_it_twice=v_after.allow_run_it_twice,
       run_it_twice_enabled=v_after.run_it_twice_enabled
 WHERE id=p_table_id;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_set_table_bomb_pot(
  p_table_id uuid, p_enabled boolean, p_ante_multiplier integer DEFAULT 2,
  p_board_count smallint DEFAULT 1)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_t public.tables%ROWTYPE; v_after public.tables%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL THEN
  RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
 END IF;
 IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;
 IF p_table_id IS NULL OR p_enabled IS NULL THEN
  RAISE EXCEPTION 'diamond_bomb_pot_requires_an_explicit_flag' USING ERRCODE='22023';
 END IF;
 IF p_enabled AND (p_ante_multiplier IS NULL OR p_ante_multiplier < 1
    OR p_board_count IS NULL OR p_board_count NOT BETWEEN 1 AND 3) THEN
  RAISE EXCEPTION 'diamond_bomb_pot_requires_a_real_ante_and_board_count' USING ERRCODE='22023';
 END IF;
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL
 FOR UPDATE OF t;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
 END IF;
 v_after:=v_t;
 v_after.bomb_pot_enabled:=p_enabled;
 v_after.bomb_pot_ante_multiplier:=CASE WHEN p_enabled THEN p_ante_multiplier ELSE 2 END;
 v_after.bomb_pot_ante_fixed:=0;
 v_after.bomb_pot_board_count:=CASE WHEN p_enabled THEN p_board_count ELSE 1 END;
 v_after.bomb_pot_double_board:=CASE WHEN p_enabled THEN p_board_count>=2 ELSE false END;
 v_after.bomb_pot_variant:=NULL;
 IF NOT public.fn_poker_diamond_plain_cash_table(v_after) THEN
  RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 -- The ante this would produce has to be a whole Diamond, checked here so the
 -- refusal costs nobody a table they thought they had configured.
 IF p_enabled AND (v_t.big_blind*p_ante_multiplier) IS DISTINCT FROM
    trunc(v_t.big_blind*p_ante_multiplier) THEN
  RAISE EXCEPTION 'diamond_bomb_pot_requires_a_whole_ante' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables
   SET bomb_pot_enabled=v_after.bomb_pot_enabled,
       bomb_pot_ante_multiplier=v_after.bomb_pot_ante_multiplier,
       bomb_pot_ante_fixed=v_after.bomb_pot_ante_fixed,
       bomb_pot_board_count=v_after.bomb_pot_board_count,
       bomb_pot_double_board=v_after.bomb_pot_double_board,
       bomb_pot_variant=v_after.bomb_pot_variant
 WHERE id=p_table_id;
END $function$;

-- ---------------------------------------------------------------------------
-- 4. Prove it, in the same transaction that made it true.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_name text; v_def text; v_missing text[] := '{}';
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
    'fn_poker_diamond_set_table_straddle','fn_poker_diamond_set_table_run_it_twice',
    'fn_poker_diamond_set_table_bomb_pot'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name AND p.prokind = 'f';
    IF v_def IS NULL OR v_def NOT LIKE '%fn_poker_diamond_plain_cash_table(%'
       OR v_def LIKE '%game_variant IS DISTINCT%' THEN
      v_missing := v_missing || v_name;
    END IF;
  END LOOP;
  IF array_length(v_missing,1) IS NOT NULL THEN
    RAISE EXCEPTION 'plain_cash_rule: these still hold their own copy: %', v_missing;
  END IF;
  -- And the settler deliberately does NOT read it.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_poker_diamond_settle_cash_hand';
  IF v_def LIKE '%fn_poker_diamond_plain_cash_table(%' THEN
    RAISE EXCEPTION 'plain_cash_rule: the settler must not refuse a dealt hand on a feature flag';
  END IF;
END
$do$;
