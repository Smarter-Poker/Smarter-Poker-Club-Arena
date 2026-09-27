-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820145602 "fix_bounty_tournament_fee_not_charged"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bb54d348d22685748fc2e66cd2ec7f76 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BOUNTY TOURNAMENTS NEVER CHARGED THE ENTRY FEE (2026-08-20)
--
-- Dan's rule: "IF ITS A $50 TOURNAMENT ITS $50 BUY IN $5 RAKE SO $50+$5."
-- The fee is added ON TOP of the buy-in. Rebuys are raked; add-ons are not.
--
-- Measured on production over 3 days, union tables only:
--   non-bounty MTT : 1,416 of 1,416 registrations charged buy_in + fee  (correct)
--   SNG            :   861 of   861 charged buy_in + fee                (correct)
--   SPIN           : 1,479 of 1,479 charged buy_in + fee                (correct)
--   bounty / PKO / mystery : 2,327 of 2,327 charged buy_in ONLY         (WRONG)
-- Perfect correlation with is_bounty/is_pko/is_mystery_bounty. 3,922.70 chips
-- of tournament rake never taken from entrants in three days.
--
-- Root cause is not in the registration functions. Both callers
-- (fn_register_horse_for_tournament and fn_register_for_tournament) delegate
-- to fn_tournament_entry_split and debit whatever it returns as `charge`. Its
-- bounty branch read:
--     v_charge := round(COALESCE(p_buy_in,0),2);          -- no + p_fee
-- having assumed buy_in_amount is the all-in entry cost for bounty events, and
-- then carved the fee back OUT of it (v_rake := v_charge * (p_fee/p_buy_in),
-- which equals p_fee exactly). But bounty tournaments are configured exactly
-- like the others -- all 507 of them carry buy_in_fee > 0 at the usual ~10%.
--
-- So the defect had TWO effects with one visible symptom:
--   1. the entrant was under-charged by exactly buy_in_fee, and
--   2. the prize pool was under-funded by exactly buy_in_fee, because the
--      house fee was financed out of the prize money instead of by the player
--      (v_prize = buy_in - fee - bounty instead of buy_in - bounty).
-- total_rake and rake_records were unaffected -- the fee was booked as
-- COLLECTED while nobody had actually paid it -- which is why the internal
-- identity charge = prize + bounty + rake still held and no invariant fired.
--
-- Fix: charge the fee on top in the bounty branch too, exactly as the
-- non-bounty branch already does. rake and bounty are byte-identical before
-- and after (v_rake is still computed off the buy-in, preserving the 0.10
-- fallback when p_fee = 0); prize becomes buy_in - bounty, which is what a
-- PKO prize pool should be. The identity charge = prize + bounty + rake still
-- holds, and the callers' 'misconfigured_bounty' guard (v_split.prize < 0) is
-- unchanged, it simply trips less often.
--
-- Fixing the helper fixes both callers at once: those two functions are the
-- only ones in the database that reference it. Attributes (IMMUTABLE,
-- SECURITY INVOKER, search_path) are preserved.
CREATE OR REPLACE FUNCTION public.fn_tournament_entry_split(
  p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean)
RETURNS TABLE(charge numeric, rake numeric, bounty numeric, prize numeric)
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_ratio numeric; v_charge numeric; v_rake numeric; v_bounty numeric; v_prize numeric;
BEGIN
  IF NOT COALESCE(p_is_bounty, false) THEN
    -- Non-bounty: unchanged legacy behaviour — fee charged ON TOP of the buy-in.
    v_charge := round(COALESCE(p_buy_in,0),2) + round(COALESCE(p_fee,0),2);
    v_rake   := round(COALESCE(p_fee,0),2);
    v_bounty := 0;
    v_prize  := round(COALESCE(p_buy_in,0),2);
  ELSE
    -- Bounty event: the fee is charged ON TOP of the buy-in, exactly as above
    -- (fixed 2026-08-20 — this branch used to charge the buy-in alone and take
    -- the fee out of the prize pool). The buy-in itself still splits between
    -- the prize pool and the bounty.
    v_charge := round(COALESCE(p_buy_in,0),2) + round(COALESCE(p_fee,0),2);
    v_ratio  := CASE WHEN COALESCE(p_buy_in,0) > 0 AND COALESCE(p_fee,0) > 0
                     THEN p_fee / p_buy_in ELSE 0.10 END;
    v_rake   := round(round(COALESCE(p_buy_in,0),2) * v_ratio, 2);
    v_bounty := round(COALESCE(p_bounty,0), 2);
    v_prize  := round(v_charge - v_rake - v_bounty, 2);
  END IF;
  RETURN QUERY SELECT v_charge, v_rake, v_bounty, v_prize;
END;
$function$;
