-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820154856 "invoice_independent_of_eco_base_mode"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 958a26c432a7b31b09c097830c64d7f3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- LATENT BUG: the invoice depended on which ECO base mode was selected
-- (2026-08-20, found in adversarial review of my own work).
--
-- fn_union_club_invoice recovered the settlement position by backing the
-- rakeback credit out of eco_base:
--     player_pnl_net := eco_base - (rake x rb_rate)
-- That is only correct while eco_base = settle_net + rakeback credit, i.e.
-- while eco_base_mode = 'net_invoice_position'. When I later made the base
-- configurable, switching mode silently corrupted the invoice. Measured on
-- Club JAQK, true settle_net -146,299.27:
--     net_invoice_position -> -146,299.27  (correct)
--     winnings_plus_rake   -> -172,323.62  (out by one rakeback credit)
--     winnings_only        -> -201,239.56  (out by rake + rakeback)
-- A configuration switch in one function silently changing the money on
-- another function's invoice is exactly the class of coupling that causes
-- disputes nobody can reproduce later.
--
-- FIX: reconstruct the settlement position from two values that are
-- mode-independent, using the identity the whole system already rests on:
--     settle_net = players_won + rake_generated
-- fn_union_eco_adjustment returns both regardless of mode (players_won is
-- always settle_net - rake_paid, rake_generated is always rake_paid), so the
-- invoice now needs no knowledge of how ECO chose its base — and it costs no
-- extra query.
--
-- The self-check still holds in the default mode
-- (settled_in_chips = eco_base) and is simply no longer relied upon.
CREATE OR REPLACE FUNCTION public.fn_union_club_invoice(
  p_union_id uuid, p_start timestamptz DEFAULT NULL, p_end timestamptz DEFAULT NULL)
RETURNS TABLE(
  club_id uuid, club_name text,
  period_start timestamptz, period_end timestamptz,
  rake_generated numeric, union_fee_kept numeric, rakeback_due numeric,
  players_won numeric, player_pnl_net numeric,
  eco_amount numeric, eco_enabled boolean,
  presettled numeric,
  settled_in_chips numeric, outstanding numeric,
  net_position numeric, direction text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := COALESCE(p_start, fn_union_week_start());
  v_end   timestamptz := COALESCE(p_end, now());
BEGIN
  RETURN QUERY
  WITH eco AS (
    -- inherits the reconciliation report's authorization check
    SELECT e.club_id, e.club_name, e.players_won, e.rake_generated,
           e.eco_base, e.eco_amount, e.eco_enabled
      FROM fn_union_eco_adjustment(p_union_id, v_start, v_end) e
  ),
  rates AS (
    SELECT uc.club_id, COALESCE(uc.club_commission_rate, 0.90) AS rb_rate
      FROM union_clubs uc WHERE uc.union_id = p_union_id
  ),
  pre AS (
    -- unapplied cash held against the running balance (same rule as
    -- fn_union_club_exposure); closed out by applied_settlement_id, not time
    SELECT p.club_id, COALESCE(SUM(p.amount), 0) AS amt
      FROM union_presettlements p
     WHERE p.union_id = p_union_id
       AND p.received_at >= v_start
       AND p.applied_settlement_id IS NULL
     GROUP BY p.club_id
  ),
  calc AS (
    SELECT eco.club_id, eco.club_name,
           eco.rake_generated,
           round(eco.rake_generated * (1 - COALESCE(r.rb_rate, 0.90)), 2) AS union_fee_kept,
           round(eco.rake_generated * COALESCE(r.rb_rate, 0.90), 2)       AS rakeback_due,
           eco.players_won,
           -- settle_net = players_won + rake_generated. Both are
           -- mode-independent, so the invoice no longer changes when the ECO
           -- base mode changes.
           round(eco.players_won + eco.rake_generated, 2) AS player_pnl_net,
           CASE WHEN eco.eco_enabled THEN eco.eco_amount ELSE 0 END AS eco_amount,
           eco.eco_enabled,
           COALESCE(pre.amt, 0) AS presettled
      FROM eco
      LEFT JOIN rates r ON r.club_id = eco.club_id
      LEFT JOIN pre   ON pre.club_id = eco.club_id
  )
  SELECT calc.club_id, calc.club_name, v_start, v_end,
         calc.rake_generated, calc.union_fee_kept, calc.rakeback_due,
         calc.players_won, calc.player_pnl_net,
         calc.eco_amount, calc.eco_enabled, calc.presettled,
         round(calc.player_pnl_net + calc.rakeback_due, 2) AS settled_in_chips,
         round(calc.eco_amount + calc.presettled, 2)       AS outstanding,
         round(calc.player_pnl_net + calc.rakeback_due
               + calc.eco_amount + calc.presettled, 2)     AS net_position,
         CASE WHEN round(calc.eco_amount + calc.presettled, 2) > 0
                THEN 'union owes club'
              WHEN round(calc.eco_amount + calc.presettled, 2) < 0
                THEN 'club owes union'
              ELSE 'square' END::text
    FROM calc
   ORDER BY calc.club_name;
END;
$function$;
