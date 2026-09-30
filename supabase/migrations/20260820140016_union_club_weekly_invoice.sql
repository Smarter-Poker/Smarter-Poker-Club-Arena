-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820140016 "union_club_weekly_invoice"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bb0c89e31863de4e5be9d0cd30d335c0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- THE WEEKLY CLUB INVOICE (2026-08-20)
--
-- One number per club per week: what the club owes the union, or the union
-- owes the club, with every component shown so it can be argued with.
--
-- Until now the pieces existed but nobody could see them together: the player
-- P&L settlement moved chips, the 90/10 rakeback close moved chips, ECO was
-- new, and presettlements were new. A club could not be handed a single
-- statement.
--
-- CRITICAL DISTINCTION, made explicit in the output so nothing is ever paid
-- twice:
--   * settled_in_chips  = player P&L + rakeback. These ALREADY move
--     automatically (Monday settlement + the engine's weekly 90/10 close).
--     They are shown for transparency, not as something to pay again.
--   * outstanding       = ECO + presettlements. ECO is an invoice adjustment
--     with NO auto-distribution (Dan's rule); presettlements are cash the club
--     has already sent. This is the number that actually needs squaring up.
--
-- Rake schedule is untouched. No late fees anywhere.
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
    SELECT p.club_id, COALESCE(SUM(p.amount), 0) AS amt
      FROM union_presettlements p
     WHERE p.union_id = p_union_id
       AND p.received_at >= v_start AND p.received_at < v_end
       AND p.applied_settlement_id IS NULL
     GROUP BY p.club_id
  ),
  calc AS (
    SELECT eco.club_id, eco.club_name,
           eco.rake_generated,
           round(eco.rake_generated * (1 - COALESCE(r.rb_rate, 0.90)), 2) AS union_fee_kept,
           round(eco.rake_generated * COALESCE(r.rb_rate, 0.90), 2)       AS rakeback_due,
           eco.players_won,
           eco.eco_base AS player_pnl_net,   -- settle_net: the chips the settlement moves
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

REVOKE EXECUTE ON FUNCTION public.fn_union_club_invoice(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_union_club_invoice(uuid, timestamptz, timestamptz) TO authenticated;
