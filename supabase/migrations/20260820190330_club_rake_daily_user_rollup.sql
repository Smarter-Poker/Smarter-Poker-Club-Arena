-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820190330 "club_rake_daily_user_rollup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2a4ac20f8dd1a265ed83deb8d9cc68f3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PER-CLUB DAILY RAKE ROLLUP, ON THE PAYOUT'S OWN ATTRIBUTION RULE.
--
-- The live downline view had to expand every contribution in the window with
-- window functions: ~12s for a week and ~35s for 30 days on the largest super
-- agent. Unusable for a screen that is meant to update as hands are played.
--
-- Note there is already a union-level rollup, union_rake_paid_daily_user, but
-- it cannot be reused here for two reasons:
--   * grain — it keys on union_id, and every club is its own financial
--     ecosystem, so club is the unit that matters;
--   * rule  — it attributes PROPORTIONALLY (rake * contribution / total),
--     whereas the rakeback that actually gets paid splits a hand's rake EVENLY
--     between its contributors. Reusing it would show agents a number they are
--     not paid on.
--
-- This table therefore uses the even-split rule, identical to
-- fn_rakeback_recompute_periods, so the live screen, the rollup and the money
-- all agree.

CREATE TABLE IF NOT EXISTS public.club_rake_daily_user (
  club_id     uuid        NOT NULL,
  day         date        NOT NULL,
  user_id     uuid        NOT NULL,
  rake_amount numeric(20,2) NOT NULL DEFAULT 0,
  hands       bigint      NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, day, user_id)
);

CREATE INDEX IF NOT EXISTS club_rake_daily_user_day_idx
  ON public.club_rake_daily_user (day, club_id);
CREATE INDEX IF NOT EXISTS club_rake_daily_user_user_idx
  ON public.club_rake_daily_user (user_id, club_id, day);

ALTER TABLE public.club_rake_daily_user ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS club_rake_daily_user_read ON public.club_rake_daily_user;
CREATE POLICY club_rake_daily_user_read ON public.club_rake_daily_user
  FOR SELECT TO authenticated
  USING (
    -- your own rake, or anyone in a club you hold an agent role in. The
    -- downline function re-checks ancestry properly; this is the table-level
    -- floor so the rollup can never leak more than the RPC would.
    user_id = (SELECT auth.uid())
    OR EXISTS (SELECT 1 FROM agents a
                WHERE a.user_id = (SELECT auth.uid())
                  AND a.club_id = club_rake_daily_user.club_id
                  AND a.status = 'active')
    OR EXISTS (SELECT 1 FROM union_clubs uc
                WHERE uc.club_id = club_rake_daily_user.club_id
                  AND public.fn_is_union_overseer(uc.union_id, (SELECT auth.uid())))
  );

-- Rebuild one club-day. Refuses an incomplete day so a partial figure can never
-- be frozen into the rollup and then trusted as final.
CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_day(p_club_id uuid, p_day date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_start timestamptz := p_day::timestamptz;
  v_end   timestamptz := (p_day + 1)::timestamptz;
  v_rows  integer := 0;
BEGIN
  IF v_end > date_trunc('day', now()) + interval '1 day' THEN
    RAISE EXCEPTION 'club rake rollup: day % is not complete', p_day;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('club_rake_rollup:' || p_club_id::text || ':' || p_day::text, 42));

  DELETE FROM club_rake_daily_user WHERE club_id = p_club_id AND day = p_day;

  WITH split AS (
    SELECT (k.key)::uuid AS user_id,
           (round(r.rake_amount * 100)::bigint / count(*) OVER (PARTITION BY r.id))
           + CASE WHEN row_number() OVER (PARTITION BY r.id ORDER BY k.key)
                       <= (round(r.rake_amount * 100)::bigint % count(*) OVER (PARTITION BY r.id))
                  THEN 1 ELSE 0 END AS cents
      FROM rake_records r
      JOIN LATERAL jsonb_each(r.player_contributions) k
        ON (CASE WHEN jsonb_typeof(k.value) = 'number'
                 THEN (k.value)::numeric ELSE 0 END) > 0
     WHERE r.club_id = p_club_id
       AND r.created_at >= v_start
       AND r.created_at <  v_end
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
  ), agg AS (
    INSERT INTO club_rake_daily_user (club_id, day, user_id, rake_amount, hands)
    SELECT p_club_id, p_day, s.user_id, SUM(s.cents)::numeric / 100, count(*)
      FROM split s
     GROUP BY s.user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM agg;

  RETURN v_rows;
END $$;

-- Fill every club-day that is complete and missing. Cheap once warm because it
-- only touches days with no rows yet.
CREATE OR REPLACE FUNCTION public.fn_club_rake_rollup_catchup(p_days integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '600s'
AS $$
DECLARE
  c record; d date; v_days int := 0; v_rows int := 0; v_fail int := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  FOR c IN SELECT DISTINCT club_id FROM union_clubs LOOP
    FOR d IN
      SELECT gs::date
        FROM generate_series(
               (current_date - GREATEST(p_days,1)),
               current_date - 1, interval '1 day') gs
    LOOP
      IF EXISTS (SELECT 1 FROM club_rake_daily_user
                  WHERE club_id = c.club_id AND day = d) THEN
        CONTINUE;
      END IF;
      BEGIN
        v_rows := v_rows + public.fn_club_rake_rollup_day(c.club_id, d);
        v_days := v_days + 1;
      EXCEPTION WHEN OTHERS THEN
        v_fail := v_fail + 1;
      END;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('days_built', v_days, 'rows', v_rows,
                            'failures', v_fail, 'ran_at', now());
END $$;

REVOKE ALL ON FUNCTION public.fn_club_rake_rollup_day(uuid,date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_club_rake_rollup_catchup(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_rake_rollup_day(uuid,date) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_rake_rollup_catchup(integer) TO service_role;
GRANT SELECT ON public.club_rake_daily_user TO authenticated, service_role;
