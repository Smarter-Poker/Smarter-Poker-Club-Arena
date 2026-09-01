-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826051534; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
--  The profit reconciler must not overwrite an estimate with a worse number
-- ============================================================================
--
-- WHAT WAS ALREADY HERE
--
--   fn_reconcile_club_member_daily_profit(date) and the cron job
--   'reconcile-club-member-daily-profit' (00:35 daily) were both installed and
--   active, but cron.job_run_details held NO rows for that job -- it had never
--   actually fired. So no day had ever been repaired, and the first thing it
--   would ever do was tonight's run.
--
-- WHAT THE HANDOFF PROMISED, AND WHAT IS TRUE NOW
--
--   .agent/handoffs/2026-08-20-club-dashboard-profit-reconcile.md records an
--   "exact" basis that reconciled to within a rounding error. Those numbers
--   still reproduce EXACTLY today:
--
--     Club JAQK  2026-08-18   dashboard drift    83,345.86
--     Club JAQK  2026-08-19   dashboard drift   190,617.83
--     Midway     2026-08-19   dashboard drift   567,769.70
--     SHARK CLUB 2026-08-18   dashboard drift    90,667.66
--
--   But the "exact" basis is d(total_winnings) - d(total_losses) from
--   player_stats_snapshots, and those two halves come from different places:
--
--     total_winnings  fn_fold_hand_winnings()      -- AFTER INSERT on hand_history
--     total_losses    promo_apply_playthrough()    -- a PROMO function, called
--                                                     by the engine per wager
--
--   Losses are therefore only as complete as the engine's calls to a promo
--   hook. Measured per club-day, (d_losses - d_winnings) / house_cut should be
--   exactly 1.0. It is not:
--
--     2026-08-19 Midway   0.929      2026-08-23 Midway  -1.346
--     2026-08-20 Midway   1.208      2026-08-24 Midway  -2.723
--     2026-08-21 Midway   0.876      2026-08-25 Midway   0.916
--     2026-08-22 Midway  -0.572
--
--   A NEGATIVE ratio means the ledger claims the players collectively finished
--   the day UP while paying rake. That cannot happen. On 2026-08-22 through
--   2026-08-24 the "exact" figure is not merely imprecise, it is impossible.
--
--   Worse, for 08-22..08-25 the exact figure equals the current dashboard
--   figure TO THE CENT, so reconciling those days would change nothing while
--   reporting success; and for 08-21 it would move the drift from 4,135.03 to
--   17,572.31 -- further from zero.
--
-- WHAT THIS MIGRATION DOES
--
--   It does not pretend to fix the engine's wager accounting; that lives in
--   the engine and is called out below as the real defect. It makes the
--   reconciler refuse to write a number that breaks chip conservation.
--
--   For each club on the day, independently:
--       SUM(exact profit) + (rake + bbj) must be ~0
--   If it is, that club's rows are rewritten from the exact basis. If it is
--   not, the club is SKIPPED, the live trigger estimate is left alone, and the
--   reason is written to club_profit_reconcile_log.
--
--   Per club, not per day: Club JAQK and SHARK CLUB reconcile to ~0.01% of the
--   house cut, so a day-wide veto would throw away good repairs because a
--   different club on the same date is broken.
--
-- STILL OPEN (not fixable from here)
--   total_losses is accumulated by promo_apply_playthrough, a promo function,
--   and only when auth.role() is service_role. Any wager that reaches the felt
--   without that call is invisible to the ledger. Until the engine records
--   per-player contributions in its own right, no club-day whose ratio is off
--   can be repaired at all -- the correct number simply does not exist yet.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_club_profit_conservation(uuid, date);
--   DROP TABLE IF EXISTS public.club_profit_reconcile_log;
--   -- and re-apply the previous fn_reconcile_club_member_daily_profit body,
--   -- which is preserved verbatim in this file's git history.
--   -- No stats row is altered by this migration itself.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.club_profit_reconcile_log (
  id                     bigserial   PRIMARY KEY,
  ran_at                 timestamptz NOT NULL DEFAULT now(),
  stat_date              date        NOT NULL,
  club_id                uuid        NOT NULL,
  exact_profit_sum       numeric,
  house_cut              numeric,
  exact_drift            numeric,
  dashboard_drift_before numeric,
  tolerance              numeric,
  applied                boolean     NOT NULL,
  reason                 text,
  rows_updated           integer
);

CREATE INDEX IF NOT EXISTS idx_club_profit_reconcile_log_date
  ON public.club_profit_reconcile_log (stat_date DESC, club_id);

ALTER TABLE public.club_profit_reconcile_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.club_profit_reconcile_log FROM anon, authenticated;

-- -- Does this club-day's exact basis obey chip conservation? ----------------
CREATE OR REPLACE FUNCTION public.fn_club_profit_conservation(p_club_id uuid, p_date date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH exact AS (
    SELECT COALESCE(SUM((a.total_winnings - b.total_winnings)
                      - (a.total_losses  - b.total_losses)), 0) AS profit_sum,
           count(*) AS users
      FROM player_stats_snapshots b
      JOIN player_stats_snapshots a
        ON a.user_id = b.user_id AND a.club_id = b.club_id
       AND a.snapshot_date = p_date + 1
     WHERE b.snapshot_date = p_date AND b.club_id = p_club_id
  ),
  house AS (
    SELECT COALESCE(SUM(rake + bbj), 0) AS cut, count(*) AS days
      FROM club_hand_daily
     WHERE club_id = p_club_id AND stat_date = p_date
  ),
  dash AS (
    SELECT COALESCE(SUM(profit), 0) AS profit_sum
      FROM club_member_daily_stats
     WHERE club_id = p_club_id AND stat_date = p_date
  )
  SELECT jsonb_build_object(
    'club_id',                p_club_id,
    'stat_date',              p_date,
    'users',                  exact.users,
    'exact_profit_sum',       round(exact.profit_sum, 2),
    'dashboard_profit_sum',   round(dash.profit_sum, 2),
    'house_cut',              round(house.cut, 2),
    'exact_drift',            round(exact.profit_sum + house.cut, 2),
    'dashboard_drift',        round(dash.profit_sum  + house.cut, 2),
    'loss_to_win_ratio',      CASE WHEN house.cut <> 0
                                   THEN round(-exact.profit_sum / house.cut, 3) END,
    'tolerance',              round(GREATEST(abs(house.cut) * 0.02, 100), 2),
    'has_house_row',          (house.days > 0),
    'conserves',              house.days > 0
                              AND abs(exact.profit_sum + house.cut)
                                  <= GREATEST(abs(house.cut) * 0.02, 100)
  )
  FROM exact, house, dash;
$fn$;

-- -- The reconciler, now refusing to write numbers that cannot be true -------
CREATE OR REPLACE FUNCTION public.fn_reconcile_club_member_daily_profit(p_date date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_cutover  date := DATE '2026-08-20';
  v_club     uuid;
  v_check    jsonb;
  v_rows     integer;
  v_applied  integer := 0;
  v_skipped  integer := 0;
  v_total    integer := 0;
  v_report   jsonb := '[]'::jsonb;
BEGIN
  IF p_date IS NULL OR p_date >= CURRENT_DATE THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'day_not_complete', 'date', p_date);
  END IF;
  IF p_date < v_cutover THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'before_exact_ledger_cutover',
                              'date', p_date, 'cutover', v_cutover);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM player_stats_snapshots WHERE snapshot_date = p_date)
     OR NOT EXISTS (SELECT 1 FROM player_stats_snapshots WHERE snapshot_date = p_date + 1) THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'missing_boundary_snapshot', 'date', p_date);
  END IF;

  FOR v_club IN
    SELECT DISTINCT club_id FROM club_member_daily_stats WHERE stat_date = p_date
  LOOP
    v_total := v_total + 1;
    v_check := public.fn_club_profit_conservation(v_club, p_date);
    v_rows  := 0;

    IF (v_check ->> 'conserves')::boolean THEN
      WITH exact AS (
        SELECT b.user_id,
               (a.total_winnings - b.total_winnings) - (a.total_losses - b.total_losses) AS profit
          FROM player_stats_snapshots b
          JOIN player_stats_snapshots a
            ON a.user_id = b.user_id AND a.club_id = b.club_id
           AND a.snapshot_date = p_date + 1
         WHERE b.snapshot_date = p_date AND b.club_id = v_club
      ),
      shares AS (
        SELECT s.club_id, s.user_id, s.table_id, e.profit AS exact_profit,
               GREATEST(COALESCE(s.hands_played, 0), 0) AS w,
               SUM(GREATEST(COALESCE(s.hands_played, 0), 0))
                 OVER (PARTITION BY s.club_id, s.user_id) AS w_total,
               COUNT(*)     OVER (PARTITION BY s.club_id, s.user_id) AS n_rows,
               ROW_NUMBER() OVER (PARTITION BY s.club_id, s.user_id ORDER BY s.table_id) AS rn
          FROM club_member_daily_stats s
          JOIN exact e ON e.user_id = s.user_id
         WHERE s.stat_date = p_date AND s.club_id = v_club
      ),
      alloc AS (
        SELECT club_id, user_id, table_id, exact_profit, rn, n_rows,
               CASE WHEN w_total > 0 THEN round(exact_profit * w / w_total, 2)
                    ELSE round(exact_profit / n_rows, 2) END AS share
          FROM shares
      ),
      fixed AS (
        SELECT a.*, a.exact_profit - SUM(a.share) OVER (PARTITION BY a.club_id, a.user_id) AS remainder
          FROM alloc a
      )
      UPDATE club_member_daily_stats s
         SET profit = f.share + CASE WHEN f.rn = f.n_rows THEN f.remainder ELSE 0 END,
             updated_at = now()
        FROM fixed f
       WHERE s.stat_date = p_date
         AND s.club_id = f.club_id AND s.user_id = f.user_id
         AND s.table_id IS NOT DISTINCT FROM f.table_id;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_applied := v_applied + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;

    INSERT INTO public.club_profit_reconcile_log
      (stat_date, club_id, exact_profit_sum, house_cut, exact_drift,
       dashboard_drift_before, tolerance, applied, reason, rows_updated)
    VALUES (p_date, v_club,
            (v_check ->> 'exact_profit_sum')::numeric,
            (v_check ->> 'house_cut')::numeric,
            (v_check ->> 'exact_drift')::numeric,
            (v_check ->> 'dashboard_drift')::numeric,
            (v_check ->> 'tolerance')::numeric,
            (v_check ->> 'conserves')::boolean,
            CASE WHEN (v_check ->> 'conserves')::boolean THEN 'conserves'
                 WHEN NOT (v_check ->> 'has_house_row')::boolean THEN 'no_house_cut_row'
                 ELSE 'fails_chip_conservation' END,
            v_rows);

    v_report := v_report || jsonb_build_array(v_check);
  END LOOP;

  RETURN jsonb_build_object(
    'reconciled', true, 'date', p_date,
    'clubs_seen', v_total, 'clubs_applied', v_applied, 'clubs_skipped', v_skipped,
    'detail', v_report
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_club_profit_conservation(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_profit_conservation(uuid, date) TO authenticated, service_role;

-- -- Post-apply assertions ---------------------------------------------------
DO $verify$
DECLARE v jsonb;
BEGIN
  v := public.fn_reconcile_club_member_daily_profit(CURRENT_DATE);
  IF (v ->> 'reason') IS DISTINCT FROM 'day_not_complete' THEN
    RAISE EXCEPTION 'today was not refused: %', v;
  END IF;

  v := public.fn_reconcile_club_member_daily_profit(DATE '2026-08-18');
  IF (v ->> 'reason') IS DISTINCT FROM 'before_exact_ledger_cutover' THEN
    RAISE EXCEPTION 'pre-cutover day was not refused: %', v;
  END IF;
END
$verify$;
