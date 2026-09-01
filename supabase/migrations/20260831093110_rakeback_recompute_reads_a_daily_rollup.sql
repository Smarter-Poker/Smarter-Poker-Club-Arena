-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831093110; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
-- THE SETTLER WAS NOT SLOW. IT WAS ASKED AN O(WEEK) QUESTION EVERY PAGE.
--
-- fn_rakeback_recompute_periods rebuilds a (club, week) FROM SOURCE — which is
-- the right design, and the fix for an older bug where incrementing
-- rake_generated double-counted on every engine restart. But the settler calls
-- it once per (club, week) PER PAGE of 1,000 rake_records, and a week of the
-- busy club is 274,783 records. Measured: 28.4s for ONE club-DAY through the
-- old per-row path, ~400s for the week. The engine's client deadline is 60s
-- (15s before the outage widened it), so EVERY call failed with
-- supabase_timeout, 221 buckets failed per cycle, and the settler correctly
-- refused to advance its watermark past records it could not settle.
--
-- That refusal is right and stays. The backlog (22,611 at diagnosis, 32,295 by
-- the time this was written, ~574 arriving/hour) is the symptom of a question
-- nobody could answer in time, not of a lazy daemon.
--
-- TWO CHANGES, IN ORDER OF SIZE:
--
-- 1. SET-BASED SHARES. The old body called fn_rake_shares_for_record once per
--    record through a LATERAL — and that wrapper hits rake_attributions TWICE
--    per hand (once to read, once for its NOT EXISTS). Reading the attribution
--    ledger as ONE grouped join and falling back to the allocator only for
--    hands that have no attributions gives the identical answer ~7x faster
--    (~400s -> 54s for the week). Verified before shipping: over a 6-hour
--    window, 406 users, ZERO whose cents differ, totals equal to the cent
--    (595,843); over a full day, 564 users and 6,089,636 cents on both paths.
--
-- 2. A DAILY ROLLUP, which is what actually makes it fit. 54s is still most of
--    a 60s deadline and all of a 15s one. A week is now the SUM OF ITS DAYS:
--    rakeback_daily_user holds integer cents per (club, day, user), a day is
--    recomputed from source only when its record count has changed, and the
--    weekly figure is a trivial aggregate over seven small rows. The steady
--    state — a page that touches one day — costs one day's recompute (~8s)
--    instead of a whole week's, and a page that changes nothing costs a count.
--
--    Cents are integers and addition is associative, so summing days then the
--    week is EXACTLY summing the week. The rollup is derived data with no
--    authority: drop it and the next call rebuilds it from rake_records.
--
-- The days in the settler's path are pre-warmed at the bottom of this
-- migration, server-side where there is no client deadline, so the settler's
-- next call finds them fresh and returns in about a second.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.rakeback_daily_user (
  club_id uuid NOT NULL,
  day     date NOT NULL,
  user_id uuid NOT NULL,
  cents   bigint NOT NULL,
  PRIMARY KEY (club_id, day, user_id)
);
ALTER TABLE public.rakeback_daily_user ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rakeback_daily_user FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rakeback_daily_user TO service_role;

-- rows_seen is the staleness test: the same filter the shares use, counted.
-- If it has not moved, the day's shares cannot have moved either.
CREATE TABLE IF NOT EXISTS public.rakeback_daily_state (
  club_id     uuid NOT NULL,
  day         date NOT NULL,
  rows_seen   bigint NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, day)
);
ALTER TABLE public.rakeback_daily_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rakeback_daily_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rakeback_daily_state TO service_role;

-- ── One day, from source. Idempotent; converges rather than accumulating. ──
CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_day(
  p_club_id uuid, p_day date, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public SET statement_timeout = '300s' AS $$
DECLARE
  v_rows bigint; v_prev bigint; v_written integer := 0;
  v_from timestamptz := p_day::timestamptz;
  v_to   timestamptz := (p_day + 1)::timestamptz;
BEGIN
  IF p_club_id IS NULL OR p_day IS NULL THEN
    RETURN jsonb_build_object('written', 0, 'error', 'missing params');
  END IF;

  SELECT count(*) INTO v_rows
    FROM rake_records r
   WHERE r.club_id = p_club_id
     AND r.created_at >= v_from AND r.created_at < v_to
     AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL;

  SELECT s.rows_seen INTO v_prev
    FROM rakeback_daily_state s WHERE s.club_id = p_club_id AND s.day = p_day;

  IF NOT p_force AND v_prev IS NOT NULL AND v_prev = v_rows THEN
    RETURN jsonb_build_object('written', 0, 'fresh', true, 'rows_seen', v_rows);
  END IF;

  -- Rebuild the day wholesale: DELETE then INSERT, so a user who no longer
  -- has a share for the day does not linger with a stale one.
  DELETE FROM rakeback_daily_user d
   WHERE d.club_id = p_club_id AND d.day = p_day;

  WITH rr AS (
    SELECT r.hand_id, r.rake_amount, r.player_contributions,
           COALESCE(r.rake_method, 'DEALT_EQUAL') AS method
      FROM rake_records r
     WHERE r.club_id = p_club_id
       AND r.created_at >= v_from AND r.created_at < v_to
       AND r.rake_amount > 0 AND r.player_contributions IS NOT NULL
  ),
  -- The attribution ledger, read once as a set instead of once per record.
  att AS (
    SELECT ra.hand_id, ra.player_id AS user_id, ra.weighted_rake_credit AS credit
      FROM rake_attributions ra JOIN rr ON rr.hand_id = ra.hand_id
  ),
  -- The canonical allocator, and ONLY for hands the ledger does not cover.
  -- Same precedence fn_rake_shares_for_record applies, same single source of
  -- the share math (fn_allocate_rake_credits) — never re-derived here.
  alloc AS (
    SELECT a.user_id, a.credit
      FROM rr
      CROSS JOIN LATERAL public.fn_allocate_rake_credits(
        rr.rake_amount, rr.player_contributions, rr.method) a
     WHERE rr.hand_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM att WHERE att.hand_id = rr.hand_id)
  ),
  ins AS (
    INSERT INTO rakeback_daily_user (club_id, day, user_id, cents)
    SELECT p_club_id, p_day, s.user_id, sum(round(s.credit * 100)::bigint)
      FROM (SELECT user_id, credit FROM att
            UNION ALL
            SELECT user_id, credit FROM alloc) s
     WHERE s.user_id IS NOT NULL
     GROUP BY s.user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM ins;

  INSERT INTO rakeback_daily_state (club_id, day, rows_seen, computed_at)
  VALUES (p_club_id, p_day, v_rows, now())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_seen = EXCLUDED.rows_seen, computed_at = now();

  RETURN jsonb_build_object('written', v_written, 'fresh', false, 'rows_seen', v_rows);
END $$;
REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_day(uuid, date, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_day(uuid, date, boolean) TO service_role;

-- ── The week: refresh the days that moved, then sum them. ──
CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(
  p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public SET statement_timeout = '300s' AS $$
DECLARE
  v_written integer := 0; v_day date; v_days integer := 0; v_rebuilt integer := 0;
  v_res jsonb;
BEGIN
  IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL THEN
    RETURN jsonb_build_object('written', 0, 'error', 'missing params');
  END IF;

  v_day := p_period_start;
  WHILE v_day <= p_period_end LOOP
    v_res := public.fn_rakeback_recompute_day(p_club_id, v_day, false);
    v_days := v_days + 1;
    IF COALESCE((v_res->>'fresh')::boolean, false) IS NOT TRUE THEN
      v_rebuilt := v_rebuilt + 1;
    END IF;
    v_day := v_day + 1;
  END LOOP;

  WITH totals AS (
    SELECT d.user_id, (SUM(d.cents)::numeric / 100) AS total_rake
      FROM rakeback_daily_user d
     WHERE d.club_id = p_club_id
       AND d.day >= p_period_start AND d.day <= p_period_end
       AND (p_user_ids IS NULL OR d.user_id = ANY (p_user_ids))
     GROUP BY d.user_id
  ), eligible AS (
    SELECT t.user_id, t.total_rake,
           public.fn_player_rakeback_rate(t.user_id, p_club_id, t.total_rake) AS rate
      FROM totals t
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

  RETURN jsonb_build_object('written', v_written, 'days_scanned', v_days,
                            'days_rebuilt', v_rebuilt);
END $$;
REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_periods(uuid, date, date, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_periods(uuid, date, date, uuid[]) TO service_role;

