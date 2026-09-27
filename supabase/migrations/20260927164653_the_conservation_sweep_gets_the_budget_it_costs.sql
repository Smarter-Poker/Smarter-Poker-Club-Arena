-- 20260927164653_the_conservation_sweep_gets_the_budget_it_costs
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-27 16:46:53 UTC.
--
-- WHAT WAS WRONG
--
-- `ca-conservation-sweep-hourly` (pg_cron, '52 * * * *') runs
-- fn_ca_conservation_sweep() under the postgres login's default 2-minute
-- statement_timeout. The sweep is one top-level statement that runs 30 checks.
-- In the 24 hours to 16:00 UTC on 2026-09-27 it completed ONCE (11:52, 106.98 s)
-- and was cancelled at exactly 120 s on every other run, each time inside a
-- different check (fn_settlement_conservation_check, fn_satellite_conservation_audit,
-- fn_ca_stranded_tournament_players, fn_union_chip_integrity_check, a BBJ sum ...):
-- the cancel lands wherever the running total crosses 120 s, not in one slow check.
--
-- A statement timeout is QUERY_CANCELED, which the sweep's per-check
-- `EXCEPTION WHEN OTHERS` does not catch (plpgsql excludes it), so a cancelled
-- run rolls back every incident it raised AND its ca_detector_runs row. Three
-- consequences, all measured on the board:
--   * 23 of 24 hours the platform's widest conservation check reported nothing;
--   * fn_ca_resolve_cleared_incidents closes a sweep incident only after two
--     recorded sweep runs without it, so no sweep incident could ever close;
--   * five open sweep incidents (7ab0dcbe, 546d9098, 28f5660c, 07d0babb,
--     999e071f) were last re-measured at 11:52 and had no way to be re-measured.
--
-- MEASURED COST (one call, read-only, 2026-09-27 ~16:50 UTC): the two dominant
-- checks were fn_chip_integrity_report 78.3 s (of which
-- fn_chip_drift_since_baseline 24.7 s on a warm re-run) and
-- fn_ca_payout_rows_without_money 30.6 s; every other check was under 3 s.
-- The whole sweep costs 100-120 s, so a 120 s ceiling fails it most hours.
--
-- WHAT THIS CHANGES
--
-- The job's command sets its own budget, exactly as the other whole-state
-- conservation jobs already do ('ca-cash-pot-conservation-hourly' and
-- 'tourney_money_conservation_deep_daily' both run under 600 s). 600 s is
-- five times the measured cost and a tenth of the hourly period, so a run can
-- never overlap the next. Nothing else about the job changes: same name,
-- schedule, function, database and role. No DDL: cron.alter_job is a row
-- update in the cron schema, so PostgREST does not reload.
--
-- This is the detector running on its own schedule, not a repair job; it moves
-- no money. The per-check cost (fn_chip_integrity_report) is its own
-- performance defect and is reported, not hidden, by this budget.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $sweep_budget$
DECLARE
  v_jobid bigint;
  v_old   text;
  v_new constant text := 'SET statement_timeout = ''600s''; SELECT public.fn_ca_conservation_sweep();';
BEGIN
  SELECT jobid, command INTO v_jobid, v_old
    FROM cron.job WHERE jobname = 'ca-conservation-sweep-hourly';
  IF v_jobid IS NULL THEN
    RAISE EXCEPTION 'ca-conservation-sweep-hourly is not scheduled; this migration only re-budgets an existing job';
  END IF;
  IF v_old = v_new THEN
    RAISE NOTICE 'ca-conservation-sweep-hourly already carries its 600 s budget';
    RETURN;
  END IF;
  -- Refuse to overwrite a command somebody else has changed since it was read.
  IF md5(v_old) <> '26976d5fd9ae07f91668a55bfc8d5594' THEN
    RAISE EXCEPTION 'ca-conservation-sweep-hourly command is not the one measured (md5 %); refusing to overwrite it', md5(v_old);
  END IF;
  PERFORM cron.alter_job(job_id := v_jobid, command := v_new);
  IF (SELECT command FROM cron.job WHERE jobid = v_jobid) IS DISTINCT FROM v_new
     OR (SELECT schedule FROM cron.job WHERE jobid = v_jobid) IS DISTINCT FROM '52 * * * *' THEN
    RAISE EXCEPTION 'ca-conservation-sweep-hourly did not read back as re-budgeted';
  END IF;
END
$sweep_budget$;

COMMIT;
