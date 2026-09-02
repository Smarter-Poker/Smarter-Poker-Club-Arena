-- ═══════════════════════════════════════════════════════════════════════════
--  THE BREAK WRITES ITS OWN WEEKLY REPORT (to-do #2563 item 16)
-- ═══════════════════════════════════════════════════════════════════════════
-- The first-week trend review needs something to read. One read-only function
-- that turns the thaw ledger and hand_history into the week's story: how many
-- freezes ran, how long they really froze, what the thaw shifted, and how
-- deep the hourly dealing dip is. service_role only (operational internals).
--
-- Pre-arming baseline, first live run 2026-09-01: break_55_59 = 127,012 hands
-- across 7 days - the fleet dealt straight through the break minutes before
-- the freeze armed. That number heading to ~0 is the freeze working; the
-- after_00_04 bucket recovering to par with before_48_52 is the real
-- invisibility metric.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_maintenance_week_report(p_days INTEGER DEFAULT 7)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v JSONB;
BEGIN
  SELECT jsonb_build_object(
    'window_days', p_days,
    'generated_at', NOW(),

    -- The thaw ledger is the authoritative record of armed freezes.
    'freezes', (
      SELECT jsonb_build_object(
        'count', COUNT(*),
        'avg_frozen_seconds', ROUND(AVG(frozen_seconds)::numeric, 1),
        'max_frozen_seconds', MAX(frozen_seconds),
        'min_frozen_seconds', MIN(frozen_seconds),
        -- A healthy freeze is ~300s. Past 360 means a late adoption or a
        -- wedged engine; each one names an hour to read the log for.
        'over_360s', COUNT(*) FILTER (WHERE frozen_seconds > 360),
        'total_shifted', (
          SELECT jsonb_object_agg(k, s) FROM (
            SELECT k, SUM((t.shifted ->> k)::bigint) AS s
            FROM public.engine_maintenance_thaws t,
                 LATERAL jsonb_object_keys(t.shifted) k
            WHERE t.thawed_at > NOW() - make_interval(days => p_days)
            GROUP BY k
          ) agg
        )
      )
      FROM public.engine_maintenance_thaws
      WHERE thawed_at > NOW() - make_interval(days => p_days)
    ),

    -- The hourly dealing dip: break minutes should be ~zero once armed; what
    -- matters week over week is :00-:04 recovering to par with :48-:52 - a
    -- widening gap means rehydration time is creeping up.
    'dealing_by_minute', (
      SELECT jsonb_object_agg(bucket, hands) FROM (
        SELECT
          CASE
            WHEN EXTRACT(minute FROM created_at) BETWEEN 48 AND 52 THEN 'before_48_52'
            WHEN EXTRACT(minute FROM created_at) BETWEEN 53 AND 54 THEN 'last_hand_53_54'
            WHEN EXTRACT(minute FROM created_at) >= 55 THEN 'break_55_59'
            WHEN EXTRACT(minute FROM created_at) <= 4 THEN 'after_00_04'
            ELSE NULL
          END AS bucket,
          COUNT(*) AS hands
        FROM public.hand_history
        WHERE created_at > NOW() - make_interval(days => p_days)
        GROUP BY 1
      ) b WHERE bucket IS NOT NULL
    ),

    -- Breaks declared but never thawed should be zero; each one is an hour
    -- whose clocks silently lost their frozen minutes.
    'breaks_without_thaw_note',
      'compare freezes.count against 24*window_days minus deploy-skipped hours; a shortfall beyond dropped cron ticks means end() or the thaw is failing'
  ) INTO v;
  RETURN v;
END;
$$;

COMMENT ON FUNCTION public.fn_maintenance_week_report(INTEGER) IS
  'The maintenance break''s weekly self-report: freeze counts and durations, thaw shift totals, and the hourly dealing dip shape. Read-only; feeds the first-week trend review (club-arena to-do #2563 item 16).';

REVOKE ALL ON FUNCTION public.fn_maintenance_week_report(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_maintenance_week_report(INTEGER) TO service_role;

COMMIT;
