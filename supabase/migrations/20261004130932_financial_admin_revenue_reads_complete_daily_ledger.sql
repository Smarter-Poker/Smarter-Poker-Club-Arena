-- FINANCIAL ADMIN REVENUE READS THE COMPLETE DAILY LEDGERS
--
-- FinancialAdminHub downloaded at most the oldest 5,000 rake_records from a
-- seven-day window and called their browser-side sum the whole club/platform
-- total. Busy scopes silently omitted newer money. The first replacement read
-- only ca_club_rake_daily and therefore omitted tournament fees; it also read
-- the live UTC day, whose deliberately non-blocking maintenance trigger can be
-- repaired only when that day closes. This contract returns seven complete UTC
-- days from both authoritative reporting ledgers, with explicit components,
-- exact period total, zero-filled dates, freshness, and the existing finance
-- authorization. It never presents a partial live day as reconciled revenue.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ca_financial_admin_revenue_series(
  p_club_id uuid DEFAULT NULL,
  p_days integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_end date := (now() AT TIME ZONE 'UTC')::date - 1;
  v_from date;
  v_result jsonb;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'p_days must be between 1 and 90'
      USING ERRCODE = '22023';
  END IF;
  v_from := v_end - (p_days - 1);

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_club_id IS NULL THEN
    IF NOT COALESCE(public.fn_is_platform_admin(), false) THEN
      RAISE EXCEPTION 'platform staff required for platform revenue'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NOT public.ca_can_view_club_finances(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  WITH days AS (
    SELECT g.day::date AS stat_date
      FROM generate_series(v_from, v_end, interval '1 day') AS g(day)
  ), cash AS (
    SELECT d.stat_date, sum(d.rake) AS cash_rake
      FROM public.ca_club_rake_daily d
     WHERE d.stat_date BETWEEN v_from AND v_end
       AND (p_club_id IS NULL OR d.club_id = p_club_id)
     GROUP BY d.stat_date
  ), tournaments AS (
    SELECT d.stat_date, sum(d.fee) AS tournament_fees
      FROM public.ca_club_tournament_daily d
     WHERE d.stat_date BETWEEN v_from AND v_end
       AND (p_club_id IS NULL OR d.club_id = p_club_id)
     GROUP BY d.stat_date
  ), daily AS (
    SELECT days.stat_date,
           COALESCE(cash.cash_rake, 0) AS cash_rake,
           COALESCE(tournaments.tournament_fees, 0) AS tournament_fees,
           COALESCE(cash.cash_rake, 0) + COALESCE(tournaments.tournament_fees, 0) AS revenue
      FROM days
      LEFT JOIN cash USING (stat_date)
      LEFT JOIN tournaments USING (stat_date)
  )
  SELECT jsonb_build_object(
    'contract', 'ca_financial_admin_revenue_series_v1',
    'basis', 'cash_rake_plus_tournament_fees',
    'includes_live_day', false,
    'scope', CASE WHEN p_club_id IS NULL THEN 'platform' ELSE 'club' END,
    'club_id', p_club_id,
    'range_days', p_days,
    'range_start', v_from,
    'range_end', v_end,
    'daily', jsonb_agg(
      jsonb_build_object(
        'd', daily.stat_date,
        'cash_rake', daily.cash_rake,
        'tournament_fees', daily.tournament_fees,
        'revenue', daily.revenue
      ) ORDER BY daily.stat_date
    ),
    'period_total', round(sum(daily.revenue), 2),
    'data_updated_at', (
      SELECT max(source.updated_at)
        FROM (
          SELECT max(d.updated_at) AS updated_at
            FROM public.ca_club_rake_daily d
           WHERE d.stat_date BETWEEN v_from AND v_end
             AND (p_club_id IS NULL OR d.club_id = p_club_id)
          UNION ALL
          SELECT max(d.updated_at) AS updated_at
            FROM public.ca_club_tournament_daily d
           WHERE d.stat_date BETWEEN v_from AND v_end
             AND (p_club_id IS NULL OR d.club_id = p_club_id)
        ) source
    ),
    'generated_at', now()
  )
    INTO v_result
    FROM daily;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_financial_admin_revenue_series(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_financial_admin_revenue_series(uuid, integer)
  TO authenticated;

COMMENT ON FUNCTION public.ca_financial_admin_revenue_series(uuid, integer) IS
  'Exact zero-filled complete-UTC-day cash-rake plus tournament-fee series for FinancialAdminHub. Club scope is finance-gated; null scope requires platform staff. Reads both reporting ledgers so browser caps and partial live-day maintenance cannot understate a certified period.';

COMMIT;
