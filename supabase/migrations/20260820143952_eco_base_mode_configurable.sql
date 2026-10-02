-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820143952 "eco_base_mode_configurable"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f37fb4d2905857c66b33451f4d1f5bdb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ECO BASE MODE (2026-08-20) — outcome of a deep research pass on how real
-- PokerBros/PPPoker unions actually calculate the ecosystem tax.
--
-- FINDING: there is no single industry formula. Three different bases are
-- documented by credible sources, and they disagree by exactly the rake terms.
-- Rather than hardcode one, the base is now selectable per union.
--
--   1. 'net_invoice_position'  (DEFAULT — Dan's spec for this platform)
--        base = settle_net + club_commission_rate * rake_generated
--      The club's actual net position on the weekly invoice: its settlement
--      position plus the 90% rakeback credit it receives. Dan: "RAKE IS
--      COUNTED AS PROFIT AS WELL, AS THEY ARE RECEIVING 90% OF THE RAKE
--      GENERATED BACK. ANY AND ALL RAKE GENERATED NETS A 90% INVOICE CREDIT."
--      Self-checking: equals fn_union_club_invoice.settled_in_chips exactly.
--
--   2. 'winnings_plus_rake'    (Primetime Union published charter)
--        base = settle_net          [ = players_won + rake_generated ]
--      "Tax/Rebate can be either negative or positive. It is -10% of your
--       club's winnings and rake from cash tables and -4% ... from MTT games.
--       Example: If your players won $5,000 and raked $1,000 from cash games,
--       the rebate will be negative $600 and vice versa."
--      (5,000 + 1,000) * 10% = 600. Note this union also runs a LOWER rate on
--      tournaments (4%); we use a single rate, see eco_rate.
--
--   3. 'winnings_only'         (Two Plus Two "guru of poker club apps" AMA)
--        base = settle_net - rake_generated   [ = players_won ]
--      Post #37: "Accountability is often provided through a tax/rebate
--       system. Each week, a percent of winnings is taken from each club and
--       given to losing clubs. In the long run this evens out to 0. Most of
--       the time, consistently winning clubs are just kicked."
--      That source states the base as winnings only, gives no percentage, and
--      gives no distribution rule.
--
-- Corroborated by the same AMA (post #1) and matching what we already built:
--   * "Union accounting is done on a weekly basis... A stop loss and security
--      deposit system is employed by the union to ensure accountability."
--   * "The union takes an amount (from 0-15%) of each club's weekly rake" —
--     our 10% sits inside that range.
--   * (post #55) the standard waterfall: "Union: takes 10% / Club owner: takes
--     90%" — exactly our 90/10 split.
--
-- Unchanged: ECO is an INVOICE ADJUSTMENT with no auto-distribution, disabled
-- by default, rake schedule untouched, no late fees.
CREATE OR REPLACE FUNCTION public.fn_union_eco_base_mode(p_union_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(NULLIF(u.settings->>'eco_base_mode', ''), 'net_invoice_position')
    FROM unions u WHERE u.id = p_union_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_eco_adjustment(
  p_union_id uuid, p_start timestamptz, p_end timestamptz)
RETURNS TABLE(
  club_id uuid, club_name text,
  players_won numeric, rake_generated numeric, eco_base numeric,
  eco_rate numeric, eco_amount numeric, direction text,
  union_net_eco numeric, eco_enabled boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric := fn_union_eco_rate(p_union_id);
  v_on   boolean := fn_union_eco_enabled(p_union_id);
  v_mode text    := fn_union_eco_base_mode(p_union_id);
BEGIN
  IF v_mode NOT IN ('net_invoice_position','winnings_plus_rake','winnings_only') THEN
    RAISE EXCEPTION 'unknown eco_base_mode: %', v_mode USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH rep AS (
    -- inherits the reconciliation report's authorization check
    SELECT r.club_id, r.club_name, r.settle_net, r.rake_paid
      FROM fn_union_reconciliation_report(p_union_id, p_start, p_end) r
  ),
  rb AS (
    SELECT uc.club_id, COALESCE(uc.club_commission_rate, 0.90) AS rate
      FROM union_clubs uc WHERE uc.union_id = p_union_id
  ),
  calc AS (
    SELECT rep.club_id, rep.club_name,
           -- chips the club's players actually gained, net of the rake they paid
           round(rep.settle_net - rep.rake_paid, 2) AS players_won,
           rep.rake_paid AS rake_generated,
           round(
             CASE v_mode
               -- Dan: settlement position + the 90% rakeback credit
               WHEN 'net_invoice_position' THEN
                 rep.settle_net + rep.rake_paid * COALESCE(rb.rate, 0.90)
               -- Primetime: winnings + full rake ( = settle_net by identity )
               WHEN 'winnings_plus_rake' THEN
                 rep.settle_net
               -- 2+2 AMA: winnings only
               ELSE
                 rep.settle_net - rep.rake_paid
             END, 2) AS eco_base
      FROM rep
      LEFT JOIN rb ON rb.club_id = rep.club_id
  ),
  amt AS (
    SELECT calc.*, round(-v_rate * calc.eco_base, 2) AS eco_amount FROM calc
  ),
  agg AS (SELECT round(SUM(-amt.eco_amount), 2) AS union_net FROM amt)
  SELECT amt.club_id, amt.club_name, amt.players_won, amt.rake_generated,
         amt.eco_base, v_rate, amt.eco_amount,
         CASE WHEN amt.eco_amount < 0 THEN 'club pays union (win tax)'
              WHEN amt.eco_amount > 0 THEN 'union pays club (loss rebate)'
              ELSE 'square' END::text,
         agg.union_net, v_on
    FROM amt CROSS JOIN agg
   ORDER BY amt.eco_amount;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_eco_base_mode(uuid) FROM PUBLIC, anon, authenticated;
