-- 20260922173916_the_owner_console_quotes_the_mines_and_road_that_are_dealt
--
-- The owner console quotes the Mines and the road that are actually dealt.
--
-- THE FINDING (Diamond Crash fairness audit, 2026-09-22, low). Since
-- 20260919220610 each choice game deals exactly one setting, named by
-- public.fn_choice_mode(p_game): six mines, and the twelve-street road.
-- fn_diamond_game_quote_max was never moved with it. It still looped over the
-- retired settings - mines '5', '10' and '15', and the road's 'steady', 'bold'
-- and 'extreme' ladders - so fn_diamond_game_room computed the console's max
-- win, its intake and ceiling wins and its 'stopped' state from games nobody
-- can play. Measured on production before this migration, at the 5,000-diamond
-- (50-chip) top bet on both hosts: Mines max win 1,449.88 chips, where the six
-- mines actually dealt top out at 1,243.47 under the same cap; Donkey Cross
-- 1,200.00, where the road tops out at 1,000.00 (20x); and the ceiling wins
-- 7,384.17 and 12,800.00 (the retired 256x ladder) where the dealt games give
-- 6,713.34 and 1,000.00.
--
-- THE FIX. The choice-game branch prices the one setting fn_choice_mode names,
-- through the same fn_choice_prizes the start function deals from. Plinko and
-- Crash are untouched, and nothing here moves a chip: this function only
-- quotes. No payout, price, odds, cap or prize table changes.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
DO $preimages$ BEGIN
  IF md5(pg_get_functiondef('public.fn_diamond_game_quote_max(text,numeric,integer)'::regprocedure))
     IS DISTINCT FROM 'c5777bdd093188bae790db9758480411' THEN
    RAISE EXCEPTION 'Quote Max Preimage Changed: fn_diamond_game_quote_max(text,numeric,integer)';
  END IF;
  -- The one-setting rule it now reads, exactly as read.
  IF md5(pg_get_functiondef('public.fn_choice_mode(text)'::regprocedure))
     IS DISTINCT FROM '9ac37c3bdde8024684b863331021790d' THEN
    RAISE EXCEPTION 'Quote Max Preimage Changed: fn_choice_mode(text)';
  END IF;
END $preimages$;

CREATE OR REPLACE FUNCTION public.fn_diamond_game_quote_max(p_game text, p_bet numeric, p_cap integer)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE best numeric:=0; prize numeric;
BEGIN
 IF p_game='plinko' THEN
  SELECT COALESCE(max(p_bet*max_multiplier_cents/100),0) INTO best FROM public.plinko_tables WHERE activated_at IS NOT NULL AND max_multiplier_cents<=p_cap;
 ELSIF p_game='crash' THEN IF p_cap>=101 THEN best:=ceil(p_bet*p_cap)/100; END IF;
 ELSE
  -- The one setting this game deals (fn_choice_mode), never a retired one.
  FOREACH prize IN ARRAY public.fn_choice_prizes(p_game,public.fn_choice_mode(p_game),p_bet) LOOP
   IF ceil(prize*100)/100<=p_bet*p_cap/100 THEN best:=GREATEST(best,ceil(prize*100)/100); END IF;
  END LOOP;
 END IF;
 RETURN best;
END $function$;
COMMIT;
