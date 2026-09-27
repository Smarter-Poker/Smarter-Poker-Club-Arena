-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820151651 "club_performance_from_settled_history"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 83f0baf6790d4b52f713b9cc444b8ef9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- fn_union_club_performance: read SETTLED history, don't recompute (2026-08-20)
--
-- My first version called fn_union_reconciliation_report once per week, and
-- each of those calls fn_union_pnl_all_clubs (~7s over a week). Measured:
-- 17.4s for 2 weeks, so ~35s at the default 4 and ~105s at the 12-week
-- maximum — for a function a dashboard would call. That is precisely the
-- unbounded-cost pattern this whole session has been removing, and I wrote it
-- again. Not shipping it.
--
-- Correct source: every closed week already has its per-club net stored in
-- union_pnl_settlements.club_results, written by the settlement itself. A
-- performance history should read what was actually SETTLED, not re-derive it
-- from live data that has moved on since — that is both cheaper and more
-- truthful, because it reports the figures the clubs were actually invoiced
-- on.
--
-- Live computation is now capped at ONE week: the current, still-open week,
-- which has no settlement yet. Closed weeks cost an index lookup.
--
-- weeks_measured therefore counts only weeks with real data (a settled period,
-- or the open week), so a union with little history reports honestly rather
-- than padding with zeroes.
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
  v_from  timestamptz := fn_union_week_start() - (v_weeks - 1) * interval '7 days';
BEGIN
  RETURN QUERY
  WITH settled AS (
    -- one row per club per settled period, straight from what was invoiced
    SELECT date_trunc('week', (s.period_start AT TIME ZONE 'UTC')) AS wk,
           (e->>'club_id')::uuid AS club_id,
           (e->>'net')::numeric  AS net
      FROM union_pnl_settlements s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.club_results, '[]'::jsonb)) e
     WHERE s.union_id = p_union_id
       AND s.status = 'settled'
       AND s.period_start >= v_from
       AND (e->>'club_id') IS NOT NULL
  ),
  settled_wk AS (
    -- collapse multiple settlements inside one week into that week's total
    SELECT wk, club_id, SUM(net) AS net FROM settled GROUP BY wk, club_id
  ),
  open_wk AS (
    -- the current week only, computed live (inherits the report's authz)
    SELECT date_trunc('week', (fn_union_week_start() AT TIME ZONE 'UTC')) AS wk,
           rep.club_id, rep.settle_net AS net
      FROM fn_union_reconciliation_report(p_union_id, fn_union_week_start(), now()) rep
     WHERE NOT EXISTS (
       SELECT 1 FROM settled_wk sw
        WHERE sw.club_id = rep.club_id
          AND sw.wk = date_trunc('week', (fn_union_week_start() AT TIME ZONE 'UTC')))
  ),
  allwk AS (
    SELECT * FROM settled_wk UNION ALL SELECT * FROM open_wk
  ),
  agg AS (
    SELECT a.club_id,
           count(*)::int AS weeks_measured,
           count(*) FILTER (WHERE a.net > 0)::int AS winning_weeks,
           count(*) FILTER (WHERE a.net < 0)::int AS losing_weeks,
           round(SUM(a.net), 2) AS total_net
      FROM allwk a GROUP BY a.club_id
  )
  SELECT agg.club_id, c.name::text, agg.weeks_measured,
         agg.winning_weeks, agg.losing_weeks, agg.total_net,
         round(agg.total_net / NULLIF(agg.weeks_measured, 0), 2),
         -- "consistently finishes with a positive win ratio": up overall AND
         -- winning in more weeks than it loses
         (agg.total_net > 0 AND agg.winning_weeks > agg.losing_weeks)
    FROM agg LEFT JOIN clubs c ON c.id = agg.club_id
   ORDER BY agg.total_net DESC;
END;
$function$;
