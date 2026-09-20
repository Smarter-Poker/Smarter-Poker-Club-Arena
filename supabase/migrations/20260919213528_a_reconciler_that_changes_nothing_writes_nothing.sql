-- 20260919213528_a_reconciler_that_changes_nothing_writes_nothing
--
-- Applied to production as version 20260919213146 (the apply transport stamps
-- its own version; match by name, never by version).
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- fn_reconcile_club_member_daily_profit recomputes each member's daily profit
-- from the exact ledger and writes it to club_member_daily_stats.profit. Its
-- UPDATE matched on identity alone:
--
--   WHERE s.stat_date = p_date
--     AND s.club_id = f.club_id AND s.user_id = f.user_id
--     AND s.table_id IS NOT DISTINCT FROM f.table_id;
--
-- Nothing in that predicate asks whether the value is actually changing.
-- Postgres counts a row as updated when the new value equals the old one, so
-- every invocation rewrote every row in scope, took every row lock, wrote
-- every one to WAL, and bumped every updated_at.
--
-- MEASURED 2026-09-19. The job is scheduled once a day (35 0 * * *) but is
-- ALSO called every 15 minutes by an off-box scheduler:
-- Smarter-Poker-World-Hub/scripts/openclaw-cron-dispatcher.py line 553 fires
-- GET /api/cron/club-stats-maintenance, whose handler
-- (pages/api/cron/club-stats-maintenance.js line 186) calls this RPC for
-- yesterday. 67 runs in one day, every one landing within two seconds of a
-- quarter hour.
--
--   rows genuinely in scope for that stat_date       42,094
--   rows_updated recorded for that stat_date         2,820,298
--   2,820,298 / 42,094                               67 exactly
--
-- Over 30 days the same log records 10,469,974 rows_updated.
--
-- The first run of a day does real work: at 00:15 it closed a dashboard drift
-- of 19,392.15 chips on one club and 1,811.52 on another. From the second run
-- on, club_profit_reconcile_log shows dashboard_drift_before equal to
-- exact_drift - the books already agree - and it re-applied the identical
-- correction 66 more times.
--
-- Two further costs beyond the writes. rows_updated is the estate's only
-- record of how much this reconciler corrects, and at 42,094 every run it
-- reports the size of the table rather than the size of the correction, so the
-- log cannot answer the one question worth asking of a reconciler. And
-- updated_at, which is what tells anything downstream that a row moved, was
-- being bumped on 42,094 rows that had not moved.
--
-- ===========================================================================
-- THE BAND-AID THAT WAS REFUSED
--
-- The obvious fix is to make the CALLER stop: change the dispatcher's */15 to
-- a daily trigger, or add a guard to the API route. That is a change in
-- another repository, on a host outside this one, to a schedule this estate
-- does not own - and it leaves the defect exactly where it is. A function that
-- rewrites 42,094 unchanged rows is wrong when it is called once a day too; it
-- just costs less. Fixing the schedule would hide it rather than remove it,
-- and the next caller would rediscover it.
--
-- The caller's cadence is still worth questioning and is recorded above so
-- somebody can. It is not this migration's business.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- One predicate. The UPDATE now also requires that the computed value differs
-- from the stored one. IS DISTINCT FROM rather than <> so a NULL profit still
-- gets written; <> would evaluate to NULL for those rows and silently skip
-- exactly the rows that most need the correction.
--
-- The expression is repeated verbatim from the SET clause on purpose. It is
-- the same value computed in the same CTE row, so there is no second source of
-- truth to drift - the alternative, lifting it into the `fixed` CTE as a named
-- column, is a larger edit to a money path for a cosmetic gain.
--
-- Everything else is byte-for-byte unchanged: same CTEs, same allocation, same
-- remainder placement on the last row, same conservation gate, same log row,
-- same return shape. The reconciled VALUES are identical. Only rows that were
-- already correct stop being rewritten.
--
--
-- ONE DIFFERENCE FROM THE APPLIED TEXT, DELIBERATE. The version applied to
-- production carried no REVOKE, because production's ACL was already
-- postgres|service_role and CREATE OR REPLACE preserves it - measured after
-- applying: has_function_privilege('anon', ...) false,
-- has_function_privilege('authenticated', ...) false. The REVOKE below is
-- therefore a no-op against production and is present for the REBUILD path,
-- where CREATE OR REPLACE is a CREATE and default privileges would hand the
-- function to anon. check-definer-authorization refused the push without it,
-- and it was right to.
--
-- @live-proof: (SELECT position('IS DISTINCT FROM (f.share' in p.prosrc) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_reconcile_club_member_daily_profit')
-- ===========================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_reconcile_club_member_daily_profit';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'failed: fn_reconcile_club_member_daily_profit does not exist';
  END IF;
  IF position('AND s.table_id IS NOT DISTINCT FROM f.table_id' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the UPDATE predicate this migration rewrites is not present; the body has changed';
  END IF;
  IF position('fn_club_profit_conservation' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the conservation gate is missing; this is not the body that was read';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_reconcile_club_member_daily_profit(p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
         AND s.table_id IS NOT DISTINCT FROM f.table_id
         -- A ROW THAT IS ALREADY RIGHT IS NOT WRITTEN (2026-09-19).
         -- Postgres counts an unchanged row as updated, so without this the
         -- reconciler rewrote all 42,094 rows on every call: 2,820,298 row
         -- writes in one day for a correction that was finished by 00:15.
         -- IS DISTINCT FROM, not <>, so a NULL profit is still written.
         AND s.profit IS DISTINCT FROM (f.share + CASE WHEN f.rn = f.n_rows THEN f.remainder ELSE 0 END);

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
$function$;

-- A REBUILD IS WHERE THIS FUNCTION BECOMES BROWSER-REACHABLE (2026-09-19).
-- On production this is a no-op: the live ACL is postgres|service_role and
-- has_function_privilege says anon and authenticated are both false. On a
-- FRESH rebuild, though, CREATE OR REPLACE is a CREATE, and this project
-- carries ALTER DEFAULT PRIVILEGES granting EXECUTE on new functions in schema
-- public to anon, authenticated and service_role. That is exactly how
-- fn_ca_cron_health was handed to anon earlier today, and it took
-- 20260919173340 to take it back. A SECURITY DEFINER function that writes and
-- never asks auth.uid() must name the roles, not just PUBLIC.
REVOKE ALL ON FUNCTION public.fn_reconcile_club_member_daily_profit(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_reconcile_club_member_daily_profit(date) TO service_role;

DO $verify$
DECLARE v_src text; v_set_pos int; v_where_pos int;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_reconcile_club_member_daily_profit';

  IF position('s.profit IS DISTINCT FROM (f.share' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the change-detecting predicate did not take';
  END IF;
  IF position('s.profit <> ' in v_src) > 0 THEN
    RAISE EXCEPTION 'failed: a plain <> would evaluate NULL for a NULL profit and skip the rows that need the correction most';
  END IF;

  -- THE OTHER DIRECTION (the 7.2 rule). Deleting the UPDATE entirely would
  -- also stop the writes and would stop the reconciliation with them.
  IF position('SET profit = f.share + CASE WHEN f.rn = f.n_rows THEN f.remainder ELSE 0 END' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the correction itself is gone, not just the redundant writes';
  END IF;
  IF position('fn_club_profit_conservation' in v_src) = 0 THEN
    RAISE EXCEPTION 'failed: the chip-conservation gate was lost';
  END IF;

  v_set_pos   := position('SET profit = f.share' in v_src);
  v_where_pos := position('s.profit IS DISTINCT FROM (f.share' in v_src);
  IF v_where_pos <= v_set_pos THEN
    RAISE EXCEPTION 'failed: the guard is not in the WHERE clause';
  END IF;

  RAISE NOTICE 'reconciler now writes only rows whose value actually changes';
END
$verify$;

COMMIT;
