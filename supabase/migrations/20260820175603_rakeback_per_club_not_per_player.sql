-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820175603 "rakeback_per_club_not_per_player"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6c72e6516f2d5cedb9bdc44f7b678aeb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- MULTI-CLUB PLAYERS WERE EARNING RAKEBACK IN ONLY ONE CLUB.
--
-- rakeback_periods carried UNIQUE (user_id, period_start) — one rakeback row
-- per player per week across the WHOLE platform. That directly contradicts the
-- standing rule that every club is a standalone wallet that is never combined
-- with any other. It also forced fn_rakeback_recompute_periods to carry an
-- explicit workaround:
--
--     WHERE NOT EXISTS (SELECT 1 FROM rakeback_periods rp
--                        WHERE rp.user_id = t.user_id
--                          AND rp.period_start = p_period_start
--                          AND rp.club_id <> p_club_id)
--
-- i.e. "if this player already has rakeback in a different club this week,
-- skip them entirely." Whichever club happened to be recomputed first won; the
-- player earned nothing in every other club they played in. 578 players are in
-- more than one club, and there are currently zero rows anywhere in the table
-- with the same (user_id, period_start) across two clubs — not because it never
-- happens, but because it was impossible to record.
--
-- The correct grain already exists as
-- rakeback_periods_user_id_club_id_period_start_period_end_key.

-- 1. Drop the constraint that enforced the wrong grain.
ALTER TABLE public.rakeback_periods
  DROP CONSTRAINT IF EXISTS rakeback_periods_user_period_unique;

DROP INDEX IF EXISTS public.rakeback_periods_user_period_unique;

-- 2. Recompute per club, with no cross-club exclusion and the per-club upsert key.
CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(
  p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[])
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
           -- UNION LAW: the agent deal decides the rate, not a fixed ladder.
           public.fn_player_rakeback_rate(t.user_id, p_club_id, t.total_rake) AS rate
      FROM totals t
    -- No cross-club exclusion: a player earns in every club they rake in.
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
     WHERE e.rate > 0
    ON CONFLICT (user_id, club_id, period_start, period_end) DO UPDATE
      SET period_end      = EXCLUDED.period_end,
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
