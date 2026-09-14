-- ============================================================================
-- THE TOURNAMENT DOOR HAS A SWITCH
-- ============================================================================
--
-- `fn_poker_diamond_reserve` has always had two branches. The cash_seat branch
-- prices against a table's buy-in range; the tournament_entry branch prices
-- against a tournament's buy-in plus fee. Both then reserve real Diamonds out
-- of a real wallet into custody.
--
-- ONLY ONE OF THEM ASKS WHETHER IT IS OPEN. The cash path is admitted through
-- `ca_arena_settings.cash_games_enabled`, which defaults to false and is
-- checked inside the same fail-closed lookup that finds the table, in
-- fn_poker_diamond_buyin. The tournament path checks nothing at all: it finds
-- the tournament, prices the entry, and reserves.
--
-- That has been harmless for exactly one reason, and it is not a good one. No
-- Diamond tournament exists, poker_diamond_custody holds zero rows, and the
-- function's only caller in the database is the cash buy-in. The hole is not
-- that money has moved. It is that THE FIRST SERVER CODE TO CALL THIS FOR A
-- TOURNAMENT WOULD BE ADMITTED, with no switch anywhere to refuse it, and
-- whoever writes that code would have no way to tell that nothing was guarding
-- them. A door that is merely unused is not a door that is shut.
--
-- The switch has to exist BEFORE the caller does, which is the whole reason
-- this lands now rather than alongside the entry function it will gate.
--
-- WHAT THIS DOES NOT DO. It does not write a tournament_entry custody row, and
-- it does not open anything: `tournaments_enabled` defaults to FALSE, so the
-- effect of this migration on the running estate is to turn an unguarded path
-- into a refused one. Diamond cash is untouched; `cash_games_enabled` keeps
-- its own value and its own meaning.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The switch. Default false, like the cash one, because a door that
--    defaults open is not a door.
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_arena_settings
  ADD COLUMN IF NOT EXISTS tournaments_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ca_arena_settings.tournaments_enabled IS
  'Whether the Diamond arena admits tournament entries. Defaults false and is checked inside the fail-closed lookup in fn_poker_diamond_reserve, exactly as cash_games_enabled is checked in fn_poker_diamond_buyin.';

-- ---------------------------------------------------------------------------
-- 2. The tournament branch is admitted the same way the cash branch is.
--
--    The shape is copied from fn_poker_diamond_buyin deliberately: the arena
--    identity, the union exclusions and the switch all live in the SAME lookup
--    that finds the row, so a missing setting, a union-owned tournament, a
--    chip club or a closed switch all arrive as NOT FOUND rather than as four
--    separate checks somebody can reorder or forget.
--
--    The price check stays a SEPARATE failure, because "this arena is not
--    open" and "you offered the wrong amount" are different answers and a
--    caller needs to be able to tell them apart.
--
--    The block is sliced out of the live definition between anchors rather
--    than retyped, so no whitespace can drift.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text; v_a text;
  v_from integer; v_to integer; v_hits integer;
  c_head constant text := ' ELSE
   SELECT t.club_id,t.buy_in_amount+COALESCE(t.buy_in_fee,0),t.status';
  c_tail constant text := 'RAISE EXCEPTION ''invalid_diamond_entry_price''; END IF;';
BEGIN
  SELECT pg_get_functiondef('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)'::regprocedure)
    INTO v_old;
  IF position('tournaments_enabled' in v_old) > 0 THEN
    RAISE NOTICE 'diamond reserve already consults the tournament switch; skipping';
    RETURN;
  END IF;

  v_from := position(c_head in v_old);
  IF v_from = 0 THEN RAISE EXCEPTION 'reserve: tournament branch anchor not found'; END IF;
  v_to := v_from - 1 + position(c_tail in substr(v_old, v_from));
  IF v_to < v_from THEN RAISE EXCEPTION 'reserve: price check anchor not found'; END IF;
  v_a := substr(v_old, v_from, v_to + length(c_tail) - v_from + 1);

  IF position('invalid_diamond_entry_price' in v_a) = 0
     OR position('public.tournaments' in v_a) = 0 THEN
    RAISE EXCEPTION 'reserve: sliced block is not the tournament branch';
  END IF;
  v_hits := (length(v_old) - length(replace(v_old, v_a, ''))) / length(v_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'reserve: tournament branch matched % times, expected 1', v_hits;
  END IF;

  v_new := replace(v_old, v_a, $r$ ELSE
   SELECT t.club_id,t.buy_in_amount+COALESCE(t.buy_in_fee,0),t.status
   INTO v_arena,v_min,v_status FROM public.tournaments t
     JOIN public.clubs c ON c.id=t.club_id
     JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
   WHERE t.id=p_target_id AND c.asset='diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND a.tournaments_enabled
   FOR SHARE OF t;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'diamond_tournaments_not_open' USING ERRCODE='55000';
   END IF;
   IF v_min IS NULL OR p_amount<>v_min THEN RAISE EXCEPTION 'invalid_diamond_entry_price'; END IF;$r$);

  IF v_new = v_old
     OR position('tournaments_enabled' in v_new) = 0
     OR position('diamond_tournaments_not_open' in v_new) = 0
     OR position('cash_seat' in v_new) = 0 THEN
    RAISE EXCEPTION 'reserve: rewrite did not take';
  END IF;
  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 3. THE SWITCH IS OFF, THE CASH DOOR IS UNTOUCHED, AND THE GATE IS REAL.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_def text;
  v_open integer;
BEGIN
  SELECT pg_get_functiondef('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)'::regprocedure)
    INTO v_def;

  IF position('a.tournaments_enabled' in v_def) = 0
     OR position('diamond_tournaments_not_open' in v_def) = 0 THEN
    RAISE EXCEPTION 'the tournament branch does not consult the switch';
  END IF;
  -- The cash branch still prices against the table, and still reserves.
  IF position('invalid_diamond_table_buy_in' in v_def) = 0
     OR position('cash_seat' in v_def) = 0 THEN
    RAISE EXCEPTION 'the cash branch was disturbed';
  END IF;
  -- And the tournament branch still refuses a wrong price, separately.
  IF position('invalid_diamond_entry_price' in v_def) = 0 THEN
    RAISE EXCEPTION 'the tournament branch stopped checking its price';
  END IF;

  SELECT count(*) INTO v_open FROM public.ca_arena_settings WHERE tournaments_enabled;
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'the tournament switch is ON in % arena settings row(s); it must default closed', v_open;
  END IF;

  IF EXISTS (SELECT 1 FROM public.poker_diamond_custody WHERE purpose='tournament_entry') THEN
    RAISE EXCEPTION 'a tournament_entry custody row exists already; this migration assumed none did';
  END IF;

  RAISE NOTICE 'tournament door: switch added (closed), reserve gated, cash untouched';
END;
$do$;
