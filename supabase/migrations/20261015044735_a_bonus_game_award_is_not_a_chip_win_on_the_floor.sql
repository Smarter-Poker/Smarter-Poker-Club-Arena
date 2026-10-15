-- 20261015044735_a_bonus_game_award_is_not_a_chip_win_on_the_floor.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-14: "IT'S PAYING OUT WAY TOO MANY CHIPS THAN WHAT IS ACTUALLY
-- WON. I WAS JUST AWARDED OVER 2,000 CHIPS FOR THE LAST GAMES I PLAYED."
--
-- Read from production: nothing over 15 chips was credited to him for those
-- games (chip_ledger: plinko 14.28 and 13.62, mines 10.00, crossing 11.00,
-- wheel 10.00 and 1.00). The money is right. What was wrong is what the games
-- page TOLD him. Its Recent Wins and This Week's Biggest Wins (both from
-- fn_diamond_game_floor) listed "Diamond Wheel ... 1739.50 Chips",
-- "1570.20 Chips", "1453.50 Chips": wheel spins whose outcome was a BONUS
-- GAME (or an UPGRADE to a super game). wheel_spins.prize_value_chips on those
-- rows is the bonus game's top-prize value, a potential, not a payment; the
-- game's real payout is its own round_book row, which the feed already lists.
-- 54 bonus spins average 1,121 "chips" there against a 9.32 chip average for
-- real chip prizes.
--
-- The same field inflated fn_diamond_game_lifetime's "Average Wheel Prize
-- Value" (65.35x shown), whose own caption says wheel prize values exclude
-- later bonus game payouts.
--
-- Fix at the reader: a bonus or upgrade spin pays nothing at the wheel, so
--   - the floor feed leaves those spins out (the bonus game's own cashed round
--     still appears, with what it actually paid);
--   - the lifetime average counts them at 0 instant value.
-- Both rewritten from their exact production bodies (md5 guarded).
-- @live-proof: position('''bonus'', ''upgrade''' in pg_get_functiondef('public.fn_diamond_game_floor(uuid,integer)'::regprocedure)) > 0 AND position('''bonus'',''upgrade''' in pg_get_functiondef('public.fn_diamond_game_lifetime(uuid)'::regprocedure)) > 0

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $rewrite$
DECLARE
  d text;
  old_frag text;
  new_frag text;
BEGIN
  IF md5(pg_get_functiondef('public.fn_diamond_game_floor(uuid,integer)'::regprocedure))
       IS DISTINCT FROM '4856d297f04f16290480cafff22f0ae1' THEN
    RAISE EXCEPTION 'fn_diamond_game_floor changed since this migration was written';
  END IF;
  IF md5(pg_get_functiondef('public.fn_diamond_game_lifetime(uuid)'::regprocedure))
       IS DISTINCT FROM '42d751fe3d61ca92f5769ae2c2f79373' THEN
    RAISE EXCEPTION 'fn_diamond_game_lifetime changed since this migration was written';
  END IF;

  d := pg_get_functiondef('public.fn_diamond_game_floor(uuid,integer)'::regprocedure);
  old_frag := $f$WHERE s.host_id = v_host AND s.outcome_kind <> 'nothing' AND NOT COALESCE(s.is_fixture, false)$f$;
  new_frag := $f$WHERE s.host_id = v_host AND s.outcome_kind::text NOT IN ('nothing', 'bonus', 'upgrade') AND NOT COALESCE(s.is_fixture, false)$f$;
  IF (length(d) - length(replace(d, old_frag, ''))) / length(old_frag) <> 2 THEN
    RAISE EXCEPTION 'fn_diamond_game_floor: expected the wheel filter twice';
  END IF;
  EXECUTE replace(d, old_frag, new_frag);

  d := pg_get_functiondef('public.fn_diamond_game_lifetime(uuid)'::regprocedure);
  old_frag := $f$  SELECT 'wheel',s.prize_value_chips/NULLIF(s.spin_price_diamonds::numeric/s.diamonds_per_chip,0),NULL,false,NULL$f$;
  new_frag := $f$  SELECT 'wheel',(CASE WHEN s.outcome_kind::text IN ('bonus','upgrade') THEN 0 ELSE s.prize_value_chips END)/NULLIF(s.spin_price_diamonds::numeric/s.diamonds_per_chip,0),NULL,false,NULL$f$;
  IF strpos(d, old_frag) = 0 THEN RAISE EXCEPTION 'fn_diamond_game_lifetime fragment not found'; END IF;
  EXECUTE replace(d, old_frag, new_frag);
END
$rewrite$;

COMMIT;
