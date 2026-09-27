-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820151414 "union_shared_costs_performance_stakes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 27aa21f4bc6de66cc4a0e5c727e1fb28 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- REMAINING UNION FEATURES (2026-08-20)
--
-- Closing out the last gaps identified by researching how real unions
-- operate. Dan's constraints observed throughout: the rake schedule is
-- untouched, and there are NO LATE FEES anywhere.
--
-- 1. SHARED COST ALLOCATION. Real unions bill their running costs — table
--    managers, accounting, MTT overlays, promo/diamond spend — to member
--    clubs pro-rata by each club's share of total union rake. Primetime's
--    charter states it exactly: "If your club rakes $1,000 and the union
--    rakes $100,000, then you only pay 1 percent of those fees." We had no
--    mechanism at all. Read-only: it computes the split, it does not move
--    chips or write an invoice line, so it can be reviewed before use.
--
-- 2. CRUSHING CLUB / WIN RATIO. ECO taxes a winning club, but the separate
--    signal every union watches is a club that wins *persistently*. The 2+2
--    AMA: "Most of the time, consistently winning clubs are just kicked."
--    Primetime: "If your club consistently finishes with a positive win
--    ratio, we will ask you to balance out... Max acceptable ratio is 1:1."
--    This reports each club's weekly net over N weeks plus the count of
--    winning weeks, so persistence is visible rather than a single spike.
--
-- 3. STAKES CAP. union_club_terms.stakes_cap_bb existed but nothing looked at
--    it. Added as a MONITORING invariant, not a hard block: enforcing at table
--    creation would mean editing a live gameplay path, and every other control
--    added today reports first and enforces only on Dan's word.

-- ─── 1. Shared cost allocation ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_union_shared_cost_allocation(
  p_union_id uuid, p_total_cost numeric,
  p_start timestamptz DEFAULT NULL, p_end timestamptz DEFAULT NULL)
RETURNS TABLE(
  club_id uuid, club_name text,
  club_rake numeric, union_rake numeric, rake_share numeric,
  allocated_cost numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_start timestamptz := COALESCE(p_start, fn_union_week_start());
  v_end   timestamptz := COALESCE(p_end, now());
  v_total numeric;
BEGIN
  IF p_total_cost IS NULL OR p_total_cost < 0 THEN
    RAISE EXCEPTION 'p_total_cost must be >= 0' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH r AS (
    -- inherits the reconciliation report's authorization check
    SELECT rep.club_id, rep.club_name, rep.rake_paid
      FROM fn_union_reconciliation_report(p_union_id, v_start, v_end) rep
  ),
  tot AS (SELECT NULLIF(SUM(r.rake_paid), 0) AS all_rake FROM r)
  SELECT r.club_id, r.club_name, r.rake_paid,
         COALESCE(tot.all_rake, 0),
         CASE WHEN tot.all_rake IS NULL THEN 0
              ELSE round(r.rake_paid / tot.all_rake, 6) END,
         CASE WHEN tot.all_rake IS NULL THEN 0
              ELSE round(p_total_cost * (r.rake_paid / tot.all_rake), 2) END
    FROM r CROSS JOIN tot
   ORDER BY r.rake_paid DESC;
END;
$function$;

-- ─── 2. Club performance / crushing-club detection ───────────────────────────
CREATE OR REPLACE FUNCTION public.fn_union_club_performance(
  p_union_id uuid, p_weeks integer DEFAULT 4)
RETURNS TABLE(
  club_id uuid, club_name text,
  weeks_measured integer, winning_weeks integer, losing_weeks integer,
  total_net numeric, avg_weekly_net numeric, crushing boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_weeks integer := GREATEST(1, LEAST(COALESCE(p_weeks, 4), 12));
BEGIN
  RETURN QUERY
  WITH wk AS (
    SELECT gs AS week_start, gs + interval '7 days' AS week_end
      FROM generate_series(fn_union_week_start() - (v_weeks - 1) * interval '7 days',
                           fn_union_week_start(), interval '7 days') gs
  ),
  per AS (
    SELECT w.week_start, rep.club_id, rep.club_name, rep.settle_net
      FROM wk w
      CROSS JOIN LATERAL fn_union_reconciliation_report(
        p_union_id, w.week_start, LEAST(w.week_end, now())) rep
  ),
  agg AS (
    SELECT per.club_id, per.club_name,
           count(*)::int AS weeks_measured,
           count(*) FILTER (WHERE per.settle_net > 0)::int AS winning_weeks,
           count(*) FILTER (WHERE per.settle_net < 0)::int AS losing_weeks,
           round(SUM(per.settle_net), 2) AS total_net
      FROM per GROUP BY per.club_id, per.club_name
  )
  SELECT agg.club_id, agg.club_name, agg.weeks_measured,
         agg.winning_weeks, agg.losing_weeks, agg.total_net,
         round(agg.total_net / NULLIF(agg.weeks_measured, 0), 2),
         -- "consistently finishes with a positive win ratio": up overall AND
         -- winning in more weeks than it loses
         (agg.total_net > 0 AND agg.winning_weeks > agg.losing_weeks)
    FROM agg
   ORDER BY agg.total_net DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_shared_cost_allocation(uuid, numeric, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_union_shared_cost_allocation(uuid, numeric, timestamptz, timestamptz) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_club_performance(uuid, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_union_club_performance(uuid, integer) TO authenticated;

-- ─── 3. Stakes cap monitoring, folded into the credit-risk sweep ─────────────
-- Costs nothing until someone actually sets a cap (the driving subquery is
-- empty while every stakes_cap_bb is NULL, which it is today).
CREATE OR REPLACE FUNCTION public.fn_union_credit_risk_check()
RETURNS TABLE(invariant text, severity text, offenders bigint, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT 'union_club_no_terms', 'warning', count(*),
         'Member clubs with no union_club_terms row: no security deposit and '
         || 'no stop loss on file, so their losses are carried unsecured'
    FROM union_clubs uc
   WHERE NOT EXISTS (SELECT 1 FROM union_club_terms t
                      WHERE t.union_id = uc.union_id AND t.club_id = uc.club_id)
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_club_stop_loss_breached', 'critical', count(*),
         'Clubs past their weekly stop loss and still active: '
         || COALESCE(string_agg(x.club_name || ' (exposure ' || x.exposure || ' vs limit '
                                || x.stop_loss_limit || ')', '; '), '')
    FROM (
      SELECT e.club_name, e.exposure, e.stop_loss_limit
        FROM (SELECT DISTINCT t.union_id
                FROM union_club_terms t
               WHERE t.stop_loss_limit IS NOT NULL
                 AND t.status <> 'suspended') u
        CROSS JOIN LATERAL fn_union_club_exposure(u.union_id) e
       WHERE e.breached AND e.status <> 'suspended'
    ) x
  HAVING count(*) > 0

  UNION ALL
  SELECT 'union_eco_not_recorded', 'warning', count(*),
         'Unions with ECO enabled and no union_eco_ledger row for the current '
         || 'settlement week: this week''s win tax / loss rebate is not reproducible'
    FROM unions un
   WHERE COALESCE((un.settings->>'eco_enabled')::boolean, false)
     AND EXISTS (SELECT 1 FROM union_clubs uc WHERE uc.union_id = un.id)
     AND NOT EXISTS (SELECT 1 FROM union_eco_ledger l
                      WHERE l.union_id = un.id
                        AND l.period_start >= fn_union_week_start())
  HAVING count(*) > 0

  UNION ALL
  -- A club spreading bigger blinds than its deposit tier permits.
  SELECT 'union_club_stakes_above_cap', 'warning', count(*),
         'Live tables above the club''s agreed stakes cap: '
         || COALESCE(string_agg(y.club_name || ' bb=' || y.big_blind
                                || ' cap=' || y.stakes_cap_bb, '; '), '')
    FROM (
      SELECT c.name AS club_name, tb.big_blind, t.stakes_cap_bb
        FROM union_club_terms t
        JOIN clubs c ON c.id = t.club_id
        JOIN tables tb ON tb.club_id = t.club_id
       WHERE t.stakes_cap_bb IS NOT NULL
         AND tb.big_blind > t.stakes_cap_bb
         AND COALESCE(tb.is_deleted, false) = false
         AND tb.status NOT IN ('closed','deleted')
    ) y
  HAVING count(*) > 0;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_credit_risk_check() FROM PUBLIC, anon, authenticated;
