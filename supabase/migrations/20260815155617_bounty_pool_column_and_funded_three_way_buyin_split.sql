-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815155617 "bounty_pool_column_and_funded_three_way_buyin_split"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c315f86ab9427c1448a93bf86829c096 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- DAN'S SPEC 2026-08-15: bounty tournaments must FUND their bounties out of
-- the buy-in, with the bounty pool kept SEPARATE from the prize pool.
--   "$50 bounty tournament with a $25 bounty: $25 to the bounty pool,
--    $5 rake, $20 into the prize pool."
-- i.e. for a bounty event the buy_in_amount is the player's ALL-IN entry cost
-- and splits three ways:  rake = 10% (or the tournament's configured
-- fee/buy-in ratio), bounty = bounty_amount, prize = the remainder.
--
-- Before this change bounties were MINTED: registration put the whole buy-in
-- into prize_pool and separately handed every player a bounty head funded from
-- nowhere (21,949.87 chips paid out that way to date).

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS bounty_pool numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bounty_pool_paid numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.tournaments.bounty_pool IS
  'Total collected into the bounty pool from entries (funded from buy_in_amount). Separate from prize_pool.';
COMMENT ON COLUMN public.tournaments.bounty_pool_paid IS
  'Running total of bounty money paid out. Must never exceed bounty_pool.';

-- Guard: a bounty tournament must be configurable such that the split is
-- possible (bounty + rake <= buy-in). Enforced at creation time by the app and
-- re-checked at registration.
CREATE OR REPLACE FUNCTION public.fn_tournament_entry_split(
  p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean
) RETURNS TABLE (charge numeric, rake numeric, bounty numeric, prize numeric)
LANGUAGE plpgsql IMMUTABLE
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
    -- Bounty event: buy_in_amount IS the all-in entry cost; split three ways.
    v_charge := round(COALESCE(p_buy_in,0),2);
    v_ratio  := CASE WHEN COALESCE(p_buy_in,0) > 0 AND COALESCE(p_fee,0) > 0
                     THEN p_fee / p_buy_in ELSE 0.10 END;
    v_rake   := round(v_charge * v_ratio, 2);
    v_bounty := round(COALESCE(p_bounty,0), 2);
    v_prize  := round(v_charge - v_rake - v_bounty, 2);
  END IF;
  RETURN QUERY SELECT v_charge, v_rake, v_bounty, v_prize;
END;
$function$;

-- Sanity: Dan's worked example must come out exactly 25 / 5 / 20 on a $50 entry.
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fn_tournament_entry_split(50, 5, 25, true);
  IF r.charge <> 50 OR r.rake <> 5 OR r.bounty <> 25 OR r.prize <> 20 THEN
    RAISE EXCEPTION 'split check failed: charge=% rake=% bounty=% prize=% (expected 50/5/25/20)',
      r.charge, r.rake, r.bounty, r.prize;
  END IF;
  -- 10%% default when no explicit fee is configured
  SELECT * INTO r FROM public.fn_tournament_entry_split(50, 0, 25, true);
  IF r.rake <> 5 OR r.prize <> 20 THEN
    RAISE EXCEPTION 'default-10%% split failed: rake=% prize=%', r.rake, r.prize;
  END IF;
  -- Non-bounty path unchanged: fee on top
  SELECT * INTO r FROM public.fn_tournament_entry_split(100, 10, 0, false);
  IF r.charge <> 110 OR r.rake <> 10 OR r.prize <> 100 THEN
    RAISE EXCEPTION 'non-bounty split changed: charge=% rake=% prize=%', r.charge, r.rake, r.prize;
  END IF;
END $$;
