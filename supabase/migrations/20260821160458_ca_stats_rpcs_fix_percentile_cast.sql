-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821160458 "ca_stats_rpcs_fix_percentile_cast"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2a992ad1cf11f2eadcf64ff1f2cd705c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- percentile_cont() returns double precision, and Postgres has no
-- round(double precision, int) — only round(numeric, int). The original
-- body called round(p10, 3) directly on the percentile output and failed
-- at runtime with 42883. Cast each breakpoint to numeric before rounding.
CREATE OR REPLACE FUNCTION public.ca_refresh_stat_distribution(
  p_min_hands int DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows int := 0;
BEGIN
  WITH base AS (
    SELECT
      ps.user_id,
      sum(ps.hands_played)                        AS hands,
      avg(nullif(ps.vpip, 0))                     AS vpip,
      avg(nullif(ps.pfr, 0))                      AS pfr,
      CASE WHEN sum(ps.sum_big_blind) > 0
        THEN (sum(ps.total_winnings) - sum(ps.total_losses)) / sum(ps.sum_big_blind) * 100
        ELSE NULL END                             AS bb100
    FROM public.player_stats ps
    GROUP BY ps.user_id
    HAVING sum(ps.hands_played) >= p_min_hands
  ),
  pos AS (
    SELECT
      pps.user_id,
      CASE WHEN sum(pps.hands_played) > 0
        THEN sum(pps.three_bet_count)::numeric / sum(pps.hands_played) * 100
        ELSE NULL END AS three_bet,
      CASE WHEN sum(pps.hands_played) > 0
        THEN sum(pps.hands_won)::numeric / sum(pps.hands_played) * 100
        ELSE NULL END AS win_rate
    FROM public.player_position_stats pps
    GROUP BY pps.user_id
    HAVING sum(pps.hands_played) >= p_min_hands
  ),
  merged AS (
    SELECT b.user_id, b.vpip, b.pfr, b.bb100, p.three_bet, p.win_rate
    FROM base b LEFT JOIN pos p ON p.user_id = b.user_id
  ),
  unpivoted AS (
    SELECT 'vpip'::text AS metric, vpip AS v FROM merged
    UNION ALL SELECT 'pfr', pfr FROM merged
    UNION ALL SELECT 'bb100', bb100 FROM merged
    UNION ALL SELECT 'three_bet', three_bet FROM merged
    UNION ALL SELECT 'win_rate', win_rate FROM merged
  ),
  computed AS (
    SELECT
      metric,
      percentile_cont(0.10) WITHIN GROUP (ORDER BY v)::numeric AS p10,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY v)::numeric AS p25,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY v)::numeric AS p50,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY v)::numeric AS p75,
      percentile_cont(0.90) WITHIN GROUP (ORDER BY v)::numeric AS p90,
      count(v) AS n
    FROM unpivoted
    WHERE v IS NOT NULL
    GROUP BY metric
  )
  INSERT INTO public.ca_stat_distribution
    (cohort, metric, p10, p25, p50, p75, p90, sample_size, computed_at)
  SELECT 'field', metric,
         round(p10, 3), round(p25, 3), round(p50, 3), round(p75, 3), round(p90, 3),
         n, now()
  FROM computed
  ON CONFLICT (cohort, metric) DO UPDATE SET
    p10 = EXCLUDED.p10, p25 = EXCLUDED.p25, p50 = EXCLUDED.p50,
    p75 = EXCLUDED.p75, p90 = EXCLUDED.p90,
    sample_size = EXCLUDED.sample_size, computed_at = EXCLUDED.computed_at;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('metrics_written', v_rows, 'min_hands', p_min_hands, 'at', now());
END $$;

GRANT EXECUTE ON FUNCTION public.ca_refresh_stat_distribution(int) TO service_role;
