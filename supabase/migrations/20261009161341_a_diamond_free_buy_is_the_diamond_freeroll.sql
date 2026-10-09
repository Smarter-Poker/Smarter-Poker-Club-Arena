-- a_diamond_free_buy_is_the_diamond_freeroll
--
-- A DIAMOND FREE BUY IS THE DIAMOND FREEROLL (2026-10-09). Full account:
-- docs/changelog/2026-10-09-the-diamond-arena-runs-its-freerolls.md.
--
-- Dan, 2026-10-06: "USE THE SAME TOURNAMENT SCHEDULE AND RAKE AS THE MIDWAY
-- UNION FOR NOW", and 20261007000010 built the Diamond freeroll exactly as
-- Midway runs it: 0 to enter, a guarantee set aside on the house, rebuys and
-- add-ons at one Diamond each wholly to the prize pool, gated by the
-- freeroll_allowed / freeroll_rebuy_cost / freeroll_addon_cost economics
-- (all three on). The engine marks every freeroll freeBuy (Dan: "FREE ROLLS
-- MUST ALWAYS BE SET AS 'FREE BUY'"), and one line left from 20261006090619
-- still refused freeBuy as diamond_tournament_format_not_open. So the four
-- Diamond Arena "$100 Freeroll" schedules seeded 2026-10-07 have been refused
-- on every poll and not one occurrence ever existed.
--
-- A free buy IS the freeroll format, so it is admitted on a zero-entry event,
-- where every freeroll check below this line still applies (a plain MTT, a
-- guarantee of at least one Diamond, the three economics). A paid event that
-- says freeBuy is still refused by the same name. Nothing else changes.
--
-- @live-proof: (SELECT position('A FREE BUY IS THE FREEROLL FORMAT' IN pg_get_functiondef('public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FREE_BUY_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)'::regprocedure);
BEGIN
  IF position('A FREE BUY IS THE FREEROLL FORMAT' IN v_src) > 0 THEN
    RAISE NOTICE 'FREE_BUY already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM '994322d1c85b5c9a73569247d307abd8' THEN
    RAISE EXCEPTION 'FREE_BUY_PREIMAGE_CHANGED';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$  IF COALESCE((v_cfg->>'freeBuy')::boolean,false) THEN
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
$a$,
$a$  -- A FREE BUY IS THE FREEROLL FORMAT (2026-10-09): admitted on a zero-entry
  -- event, where every freeroll check below still applies; a paid event that
  -- says freeBuy is refused as before.
  IF COALESCE((v_cfg->>'freeBuy')::boolean,false)
     AND COALESCE(NULLIF(v_cfg->>'buyIn','')::numeric,0) <> 0 THEN
    RAISE EXCEPTION 'diamond_tournament_format_not_open' USING ERRCODE='55000';
  END IF;
$a$, 'free buy');
  EXECUTE v_src;
END
$patch$;

DO $prove$
BEGIN
  IF position('A FREE BUY IS THE FREEROLL FORMAT' IN pg_get_functiondef('public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'FREE_BUY_RESULT_CHANGED: not live';
  END IF;
  IF has_function_privilege('anon', 'public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_poker_diamond_create_tournament_core(jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FREE_BUY_AUTHORITY_CHANGED';
  END IF;
END
$prove$;

COMMIT;
