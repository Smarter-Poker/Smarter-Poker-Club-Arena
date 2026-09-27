-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820020131 "fn_rakeback_recompute_periods_drop_window_sort"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b858bbfa6ecd76533d3bea950ace1ad7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Follow-up to fn_rakeback_recompute_periods, from running it.
--
-- The first version ranked contributors with
--   row_number() OVER (PARTITION BY r.id ORDER BY k.key)
-- which forces a sort of every share row in the window — ~522,000 rows for the
-- busiest club-week — and blew past a 2-minute statement timeout.
--
-- The rank only needs "how many positive contributors sort at or before me",
-- which a correlated count answers per record without any global sort.
-- Same value, no sort: the busiest club-week (180,261 records -> 522,238 share
-- rows, 540 users, 440,887.23 total rake) now completes comfortably.
--
-- Arithmetic is unchanged and still mirrors equalShareCents exactly.

CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(
  p_club_id      uuid,
  p_period_start date,
  p_period_end   date,
  p_user_ids     uuid[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout = '300s'
AS $$
DECLARE
  v_written integer := 0;
BEGIN
  IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL THEN
    RETURN jsonb_build_object('written', 0, 'error', 'missing params');
  END IF;

  WITH shares AS (
    SELECT (k.key)::uuid AS user_id,
           (round(r.rake_amount * 100)::bigint / c.n)
           + CASE WHEN (SELECT count(*) FROM jsonb_each(r.player_contributions) e2
                         WHERE (e2.value)::numeric > 0 AND e2.key <= k.key)
                       <= (round(r.rake_amount * 100)::bigint % c.n)
                  THEN 1 ELSE 0 END AS cents
      FROM rake_records r
      CROSS JOIN LATERAL (
        SELECT count(*)::bigint AS n
          FROM jsonb_each(r.player_contributions) e
         WHERE (e.value)::numeric > 0
      ) c
      JOIN LATERAL jsonb_each(r.player_contributions) k
        ON (k.value)::numeric > 0
     WHERE r.club_id = p_club_id
       AND r.created_at >= p_period_start::timestamptz
       AND r.created_at <  (p_period_end + 1)::timestamptz
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
       AND c.n > 0
  ), totals AS (
    SELECT s.user_id, (SUM(s.cents)::numeric / 100) AS total_rake
      FROM shares s
     WHERE p_user_ids IS NULL OR s.user_id = ANY (p_user_ids)
     GROUP BY s.user_id
  ), eligible AS (
    SELECT t.user_id, t.total_rake,
           CASE WHEN t.total_rake >= 10000 THEN 0.30
                WHEN t.total_rake >=  2000 THEN 0.20
                WHEN t.total_rake >=   500 THEN 0.15
                WHEN t.total_rake >=   100 THEN 0.10
                ELSE 0.05 END AS rate
      FROM totals t
     WHERE NOT EXISTS (
       SELECT 1 FROM rakeback_periods rp
        WHERE rp.user_id = t.user_id
          AND rp.period_start = p_period_start
          AND rp.club_id <> p_club_id
     )
  ), ins AS (
    INSERT INTO rakeback_periods (
      user_id, club_id, period_start, period_end,
      rake_generated, rakeback_rate, rakeback_earned, rakeback_amount,
      total_rake_paid, status
    )
    SELECT e.user_id, p_club_id, p_period_start, p_period_end,
           round(e.total_rake, 2), e.rate,
           round(e.total_rake * e.rate, 2), round(e.total_rake * e.rate, 2),
           round(e.total_rake, 2), 'pending'
      FROM eligible e
    ON CONFLICT (user_id, club_id, period_start, period_end) DO UPDATE
      SET rake_generated  = EXCLUDED.rake_generated,
          rakeback_rate   = EXCLUDED.rakeback_rate,
          rakeback_earned = EXCLUDED.rakeback_earned,
          rakeback_amount = EXCLUDED.rakeback_amount,
          total_rake_paid = EXCLUDED.total_rake_paid
      WHERE rakeback_periods.status = 'pending'
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM ins;

  RETURN jsonb_build_object('written', v_written);
END $$;

REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_periods(uuid, date, date, uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_periods(uuid, date, date, uuid[]) TO service_role;
