-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820193135 "rollup_completeness_marker_and_all_clubs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7b64ddeb91fc579c165e819d7972c82b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- THE ROLLUP COULD SILENTLY UNDERCOUNT RAKE.
--
-- fn_agent_downline_rake reads club_rake_daily_user for every completed day in
-- the window and live-scans only the edges. That is only correct if every
-- completed day is actually IN the rollup. Measured right now: 32 of the last
-- 90 club-days are absent, and one club that generates rake is not in
-- union_clubs at all, so the catch-up never visited it. Those days were being
-- skipped, not scanned — the agent saw less rake than they earned, with nothing
-- anywhere to indicate it.
--
-- Two structural faults behind that:
--   * There was no way to tell "rolled up, and the club genuinely had no rake"
--     from "never rolled up". Absence of rows meant both.
--   * The catch-up iterated union_clubs, but rake is generated per CLUB and a
--     club need not be in a union.
--
-- A completeness marker fixes both, and lets the reader fall back to a live
-- scan for any day it cannot prove is complete — so the view is correct
-- regardless of whether the cron has run, and self-heals when it does.

CREATE TABLE IF NOT EXISTS public.club_rake_rollup_complete (
  club_id     uuid NOT NULL,
  day         date NOT NULL,
  rows_written integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, day)
);

CREATE INDEX IF NOT EXISTS club_rake_rollup_complete_day_idx
  ON public.club_rake_rollup_complete (day);

ALTER TABLE public.club_rake_rollup_complete ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS club_rake_rollup_complete_read ON public.club_rake_rollup_complete;
CREATE POLICY club_rake_rollup_complete_read ON public.club_rake_rollup_complete
  FOR SELECT TO authenticated USING (true);   -- contains no financial data, only coverage

GRANT SELECT ON public.club_rake_rollup_complete TO authenticated, service_role;

-- Rebuild one club-day AND record that it is now complete.
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
  IF v_end > date_trunc('day', now()) THEN
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
       AND r.created_at >= v_start AND r.created_at < v_end
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
  ), ins AS (
    INSERT INTO club_rake_daily_user (club_id, day, user_id, rake_amount, hands)
    SELECT p_club_id, p_day, s.user_id, SUM(s.cents)::numeric / 100, count(*)
      FROM split s GROUP BY s.user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM ins;

  -- A day with zero rake is still a COMPLETE day. Recording that is the whole
  -- point: it is what stops the reader treating "no rake" as "not computed".
  INSERT INTO club_rake_rollup_complete (club_id, day, rows_written, computed_at)
  VALUES (p_club_id, p_day, v_rows, now())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_written = EXCLUDED.rows_written, computed_at = EXCLUDED.computed_at;

  RETURN v_rows;
END $$;

-- Every club that has ever generated rake, not just union members.
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

  FOR c IN
    SELECT DISTINCT club_id FROM union_clubs
    UNION
    SELECT DISTINCT r.club_id FROM rake_records r
     WHERE r.club_id IS NOT NULL
       AND r.created_at >= current_date - GREATEST(p_days,1) - 1
  LOOP
    FOR d IN
      SELECT gs::date FROM generate_series(
               current_date - GREATEST(p_days,1), current_date - 1, interval '1 day') gs
    LOOP
      IF EXISTS (SELECT 1 FROM club_rake_rollup_complete
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
