-- ═══════════════════════════════════════════════════════════════════════════
-- FIX: fn_tournament_entry_split invented a 10% rake when the fee was zero
-- 2026-08-22/23, Cowork session 11
-- ALREADY APPLIED TO PROD via Supabase MCP as `fix_entry_split_no_default_rake`
-- (schema_migrations 20260823004346 approx). This file is the repo record.
--
-- The bounty branch computed rake from a ratio with `ELSE 0.10`: when
-- buy_in_fee = 0 it charged 10% of the buy-in anyway. Under the 2026-08-21
-- floor rule a total under 10 legally carries a ZERO fee, so every small
-- bounty event was raked over the cap at the registration layer, and the
-- prize pool picked up decimals: Blitz Bounty ($3+$0, bounty $1) accrued
-- 1.7/entry instead of 2 (pool 6.8, observed in prod), Bounty Builder Turbo
-- ($5+$0, bounty $2) accrued 2.5 instead of 3 (pool 12.5).
--
-- The rake IS the fee — the ratio construct reduced to `fee` in every case
-- where fee > 0 and to the illegal 10% default otherwise. Charge and
-- non-bounty behaviour unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_tournament_entry_split(
  p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean
)
RETURNS TABLE(charge numeric, rake numeric, bounty numeric, prize numeric)
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_charge numeric; v_rake numeric; v_bounty numeric; v_prize numeric;
BEGIN
  IF NOT COALESCE(p_is_bounty, false) THEN
    -- Non-bounty: unchanged — fee charged on top of the buy-in portion.
    v_charge := round(COALESCE(p_buy_in,0),2) + round(COALESCE(p_fee,0),2);
    v_rake   := round(COALESCE(p_fee,0),2);
    v_bounty := 0;
    v_prize  := round(COALESCE(p_buy_in,0),2);
  ELSE
    -- Bounty event: the rake is exactly the fee. A zero fee is a legitimate
    -- outcome of the whole-number floor rule (totals under 10 take no rake)
    -- and must NEVER be replaced with a percentage default.
    v_charge := round(COALESCE(p_buy_in,0),2) + round(COALESCE(p_fee,0),2);
    v_rake   := round(COALESCE(p_fee,0),2);
    v_bounty := round(COALESCE(p_bounty,0), 2);
    v_prize  := round(v_charge - v_rake - v_bounty, 2);  -- = buy_in - bounty
  END IF;
  RETURN QUERY SELECT v_charge, v_rake, v_bounty, v_prize;
END;
$function$;

-- POST-APPLY ASSERTIONS ─────────────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  -- Blitz Bounty shape: $3 total, fee 0 (floor rule), bounty 1 → 2 to pool, 0 rake.
  SELECT * INTO r FROM public.fn_tournament_entry_split(3, 0, 1, true);
  IF r.charge <> 3 OR r.rake <> 0 OR r.bounty <> 1 OR r.prize <> 2 THEN
    RAISE EXCEPTION 'entry split (3,0,1,bounty) wrong: charge %, rake %, bounty %, prize %', r.charge, r.rake, r.bounty, r.prize;
  END IF;
  -- Bounty Builder Turbo shape: $5 total, fee 0, bounty 2 → 3 to pool, 0 rake.
  SELECT * INTO r FROM public.fn_tournament_entry_split(5, 0, 2, true);
  IF r.prize <> 3 OR r.rake <> 0 THEN
    RAISE EXCEPTION 'entry split (5,0,2,bounty) wrong: prize %, rake %', r.prize, r.rake;
  END IF;
  -- Fee-carrying bounty event: $20 total as 18+2, bounty 9 → rake 2, 9 to pool.
  SELECT * INTO r FROM public.fn_tournament_entry_split(18, 2, 9, true);
  IF r.charge <> 20 OR r.rake <> 2 OR r.prize <> 9 THEN
    RAISE EXCEPTION 'entry split (18,2,9,bounty) wrong: charge %, rake %, prize %', r.charge, r.rake, r.prize;
  END IF;
  -- Non-bounty unchanged: 90+10 → charge 100, rake 10, prize 90.
  SELECT * INTO r FROM public.fn_tournament_entry_split(90, 10, 0, false);
  IF r.charge <> 100 OR r.rake <> 10 OR r.prize <> 90 THEN
    RAISE EXCEPTION 'entry split (90,10,non-bounty) wrong: charge %, rake %, prize %', r.charge, r.rake, r.prize;
  END IF;
END $$;
