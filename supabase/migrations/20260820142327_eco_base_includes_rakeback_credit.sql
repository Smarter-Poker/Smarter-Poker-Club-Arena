-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820142327 "eco_base_includes_rakeback_credit"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 87faab633e649a31f92b9aef2627e981 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ECO BASE CORRECTED (2026-08-20) — Dan:
--   "RAKE IS COUNTED AS PROFIT AS WELL, AS THEY ARE RECEIVING 90% OF THE RAKE
--    GENERATED BACK. ANY AND ALL RAKE GENERATED NETS A 90% INVOICE CREDIT."
--
-- My first version used settle_net alone as the base. settle_net already
-- contains 100% of the rake (settle_net = players_won + rake_generated),
-- because the rake leg is settled separately through the rake wallet. But the
-- club does not keep 100% of that rake — it receives 90% of it back as an
-- invoice credit, and the union keeps 10%. So the club's PROFIT OVERALL, which
-- is what ECO is charged on, is its settlement position PLUS that 90% credit:
--
--   eco_base = settle_net + (club_commission_rate x rake_generated)
--   eco      = -eco_rate x eco_base
--
-- which is precisely the `settled_in_chips` line already shown on
-- fn_union_club_invoice: player P&L settlement + rakeback credit. ECO is now
-- 10% of the club's actual net invoice position, so a club that ends the week
-- up pays 10% of that gain and a club that ends down is rebated 10% of that
-- loss — including, in both directions, the rake it generated at the 90% the
-- club actually receives.
--
-- The rakeback rate is read per club from union_clubs.club_commission_rate
-- (0.90 default) rather than hardcoded, so a club on a different deal is taxed
-- on the credit it actually gets.
--
-- Unchanged: ECO is an INVOICE ADJUSTMENT with no auto-distribution, it is
-- disabled by default, the rake schedule is untouched, and there are no late
-- fees.
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
BEGIN
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
           -- the club's overall profit: settlement position + the 90% rakeback
           -- credit it receives on every chip of rake it generated
           round(rep.settle_net
                 + rep.rake_paid * COALESCE(rb.rate, 0.90), 2) AS eco_base
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
