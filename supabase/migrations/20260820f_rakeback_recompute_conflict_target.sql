-- 2026-08-20: fn_rakeback_recompute_periods failed EVERY settler cycle with
-- 'duplicate key value violates unique constraint
-- "rakeback_periods_user_period_unique"'. The table has TWO unique
-- constraints: (user_id, club_id, period_start, period_end) — which the old
-- ON CONFLICT targeted — and the stricter (user_id, period_start). The
-- 2026-08-19 catch-up close left PAID rows for week 2026-08-17 with
-- period_end = 2026-08-17; the recompute then inserted the same users for
-- the same week with period_end = 2026-08-23, missing the first conflict
-- target and violating the second — and one collision aborts the whole
-- insert, so NO user's recompute landed.
--
-- Fix: target the stricter constraint. A conflicting row is always at the
-- SAME club (the eligible CTE already excludes users with rows at other
-- clubs), so the update also refreshes club_id/period_end; the existing
-- WHERE status = 'pending' guard means already-paid rows are skipped
-- silently instead of erroring. Constraint (user_id, period_start)
-- guarantees the update target is unique, so refreshing period_end cannot
-- collide with the four-column constraint.
--
-- Applied to production via Supabase MCP apply_migration as
-- 'rakeback_recompute_conflict_target' on 2026-08-20. Verified: the exact
-- call that failed every cycle (SHARK, 2026-08-17..2026-08-23) now returns
-- {"written": 129}.
CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(
  p_club_id uuid, p_period_start date, p_period_end date,
  p_user_ids uuid[] DEFAULT NULL::uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
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
    ON CONFLICT ON CONSTRAINT rakeback_periods_user_period_unique DO UPDATE
      SET club_id         = EXCLUDED.club_id,
          period_end      = EXCLUDED.period_end,
          rake_generated  = EXCLUDED.rake_generated,
          rakeback_rate   = EXCLUDED.rakeback_rate,
          rakeback_earned = EXCLUDED.rakeback_earned,
          rakeback_amount = EXCLUDED.rakeback_amount,
          total_rake_paid = EXCLUDED.total_rake_paid
      WHERE rakeback_periods.status = 'pending'
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM ins;

  RETURN jsonb_build_object('written', v_written);
END $function$;
