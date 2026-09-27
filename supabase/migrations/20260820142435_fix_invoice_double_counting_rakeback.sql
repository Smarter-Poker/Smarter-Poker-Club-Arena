-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820142435 "fix_invoice_double_counting_rakeback"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 85cc8eb3e7e0e996056a12502178314d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX (2026-08-20, introduced minutes earlier by me and caught by
-- cross-checking the invoice against the ECO figures):
--
-- fn_union_club_invoice read `eco.eco_base` into its player_pnl_net column.
-- That was correct while eco_base meant settle_net. When the ECO base was
-- corrected to include the 90% rakeback credit, the invoice kept adding
-- rakeback_due on top of a base that already contained it — double-counting
-- the credit. Club JAQK showed settled_in_chips of -94,319.58 where the true
-- net invoice position was -120,324.51 (a 26,004.93 overstatement, exactly one
-- rakeback credit).
--
-- Fix: derive the settlement position back out of the base rather than
-- changing fn_union_eco_adjustment's signature (which has dependents):
--     eco_base   = settle_net + rakeback_credit
--  => settle_net = eco_base - rakeback_due
-- Since the invoice already computes rakeback_due with the same per-club rate,
-- this is exact. It also makes the identity explicit and self-checking:
--     settled_in_chips = settle_net + rakeback_due = eco_base
-- i.e. the club's net invoice position IS the ECO base, which is what Dan
-- described as "the profit the club makes overall".
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
           -- eco_base = settle_net + rakeback credit, so back out the credit
           -- to recover the settlement position the chips actually moved on
           round(eco.eco_base - eco.rake_generated * COALESCE(r.rb_rate, 0.90), 2)
             AS player_pnl_net,
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
