-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828022429; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- watchdog_schedule_tournament_money_jobs
-- ============================================================================
-- WHAT WAS WRONG
--
-- pg_cron 1.6.4 is installed and 42 jobs are scheduled on this database. Not
-- one of them was a tournament money-integrity check. Verified against cron.job
-- on 2026-08-28:
--
--   fn_tournament_money_conservation   scheduled by nothing, called by no other
--                                      SQL function. Invoked only by hand.
--   auto_settle_completed_tournaments  scheduled by nothing, called by nothing.
--   fn_tournament_payout_sweep         scheduled by nothing; its only caller is
--                                      TypeScript (RakebackSettlerService).
--
-- So the conservation watchdog had two independent reasons to report nothing:
-- the scan cap (fixed in watchdog_conservation_scan_full_window) and the fact
-- that nobody ran it. Cron is busy with log pruning, leaderboard refreshes and
-- trending-group recomputes. It was not watching the money.
--
-- WHAT THIS MIGRATION SCHEDULES  (all jobnames prefixed 'tourney_')
--
-- Anything prefixed 'spin_' is another lane's and is deliberately untouched.
-- cron.schedule(jobname, ...) upserts by name, so re-running this is safe.
-- Every job takes a session advisory lock first, matching the house pattern
-- used by union-integrity-sweep and refresh-player-stats-hourly: pg_cron will
-- happily start a second copy of a job whose previous run is still going, and
-- these runs are seconds long, not milliseconds.
--
-- 1. tourney_money_conservation_hourly   '12 * * * *'
--    fn_tournament_money_conservation(2, 1.0, 200)
--    The fast tripwire. A 2-day window is ~3,300 qualifying events at current
--    volume (~11,100/week measured). Cost scales linearly with the window: a
--    full 30-day scan of 13,655 events measured 4.6s, so this is ~1s. Hourly is
--    the right trade -- new breakage is visible within the hour, and the job is
--    cheap enough that an occasional overlap with the deep scan is harmless.
--    The 30-minute settle grace period inside the function means a 2-day window
--    still has ~95x the slack it needs to avoid flagging events mid-settlement.
--    report cap 200: an hourly job should not be able to raise more than a
--    couple of hundred new alerts in one go.
--
-- 2. tourney_money_conservation_deep_daily   '25 3 * * *'
--    fn_tournament_money_conservation(45, 1.0, 500)
--    The backstop. 45 days catches events whose ledger is corrected late, and
--    catches anything the hourly job missed during an outage. Measured 4.6-5.0s
--    for a 30-45 day window (13,655-14,491 delta evaluations, each 5 correlated
--    subqueries against wallet_transactions at 2.38M rows and rake_records at
--    1.45M rows). This is genuinely expensive and MUST NOT be run at minute
--    granularity. 03:25 sits in the quiet band between the 03:15 garbage-
--    tournament flag and the 03:40 club-table reconcile, and clear of the
--    03:00/03:17 prune jobs.
--
-- 3. tourney_payout_sweep_detect_daily   '40 2 * * *'
--    fn_tournament_payout_sweep(30, false, 40000)
--    DETECT ONLY -- p_apply is false, so this pays nobody. It exists because
--    the only production caller of this sweep is TypeScript
--    (RakebackSettlerService.ts:831) passing p_days: 1, and that call site
--    cannot be changed from here. A 1-day window sees 384 tournaments; a
--    30-day window sees 35,042. This job gives the 30-day window server-side
--    so that underpayments older than a day are at least SEEN, and land in
--    financial_alerts, even while the TypeScript caller stays narrow.
--    The large p_limit is required: p_limit caps the SCAN in this function
--    (same defect class as the conservation function had) and its default is
--    50, so any smaller value silently truncates the sweep. Cost measured:
--    8,000 tournaments in 2.31s, 2,000 in 1.09s -- roughly 0.29ms each, so the
--    full 35,042 is ~10s. Daily at 02:40, clear of everything else.
--    Deliberately NOT scheduled with p_apply => true: applying top-ups is a
--    money write and needs a human to authorise it.
--
-- 4. tourney_auto_settle_completed   '*/10 * * * *'
--    auto_settle_completed_tournaments()
--
--    READ THIS BEFORE TRUSTING THIS JOB. The function is currently broken and
--    this job will not settle anything. Two separate problems, both verified
--    on 2026-08-28:
--
--    (a) It does not compile against the live schema. Its body reads
--        club_tournaments and tournament_entries. Neither relation exists in
--        this database, in any schema. Calling it raises
--        42P01: relation "club_tournaments" does not exist
--        immediately, at the FOR-over-SELECT on line 7. The live tables are
--        public.tournaments and public.tournament_players. This is dead code
--        that was left pointing at a schema that has since been renamed away.
--
--    (b) Even if the relations existed, it settles nothing. The loop body is
--        "UPDATE club_tournaments SET updated_at = NOW()" with the comment
--        "payouts handled by engine". It bumps a timestamp and increments a
--        counter it returns as 'checked'. No payout, no wallet write, no
--        status change. The name promises settlement the body does not deliver.
--
--    It is scheduled anyway, as asked, but wrapped so that the breakage is
--    LOUD rather than silent: the exception is caught and converted into a
--    deduped critical row in financial_alerts, instead of a cron failure that
--    only shows up in cron.job_run_details where nobody looks. The moment
--    someone repoints the function at tournaments/tournament_players, this job
--    starts working with no schedule change needed.
--
--    10-minute cadence is chosen for what the function is SUPPOSED to do --
--    catch a completed event whose payouts never landed -- where a 24-hour lag
--    would be a player-visible outage. It is trivially cheap either way.
--
-- Fixing (a) and (b) is NOT done here: rewriting a settlement function against
-- a different schema is a money-path change, not a detection change, and it
-- needs someone who knows what settlement is supposed to mean on this platform.
--
-- NO MONEY IS WRITTEN BY THIS MIGRATION OR BY ANY JOB IT CREATES.
-- ============================================================================

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron is not installed; tournament money watchdogs cannot be scheduled';
  END IF;
END
$mig$;

-- 1. Fast tripwire: 2-day conservation check, hourly.
SELECT cron.schedule(
  'tourney_money_conservation_hourly',
  '12 * * * *',
  $cmd$
select case
         when pg_try_advisory_lock(hashtext('tourney-money-conservation-hourly'))
           then (select set_config('statement_timeout','120s',true) is not null
                    and (public.fn_tournament_money_conservation(2, 1.0, 200) ->> 'check_ran') = 'true')::text
         else 'skipped: previous run still in progress'
       end;
  $cmd$
);

-- 2. Backstop: 45-day conservation check, nightly. Expensive (~5s, ~14k delta
--    evaluations). Do not increase this cadence without re-measuring.
SELECT cron.schedule(
  'tourney_money_conservation_deep_daily',
  '25 3 * * *',
  $cmd$
select case
         when pg_try_advisory_lock(hashtext('tourney-money-conservation-deep'))
           then (select set_config('statement_timeout','600s',true) is not null
                    and (public.fn_tournament_money_conservation(45, 1.0, 500) ->> 'check_ran') = 'true')::text
         else 'skipped: previous run still in progress'
       end;
  $cmd$
);

-- 3. Payout sweep, DETECT ONLY (p_apply => false). Gives the 30-day window
--    server-side that the TypeScript caller's p_days: 1 cannot reach.
--    p_limit must stay large: in this function p_limit caps the SCAN, not the
--    report, and its default of 50 would truncate the sweep to nothing.
SELECT cron.schedule(
  'tourney_payout_sweep_detect_daily',
  '40 2 * * *',
  $cmd$
select case
         when pg_try_advisory_lock(hashtext('tourney-payout-sweep-detect'))
           then (select set_config('statement_timeout','600s',true) is not null
                    and (public.fn_tournament_payout_sweep(30, false, 40000) ->> 'ok') = 'true')::text
         else 'skipped: previous run still in progress'
       end;
  $cmd$
);

-- 4. Auto-settle. Currently raises 42P01 on every call (see header). The guard
--    turns that into one deduped critical alert rather than a silent cron
--    failure every ten minutes.
SELECT cron.schedule(
  'tourney_auto_settle_completed',
  '*/10 * * * *',
  $cmd$
DO $job$
DECLARE
  v_res jsonb;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('tourney-auto-settle-completed')) THEN
    RAISE NOTICE 'skipped: previous run still in progress';
    RETURN;
  END IF;
  PERFORM set_config('statement_timeout', '120s', true);
  BEGIN
    v_res := public.auto_settle_completed_tournaments();
    RAISE NOTICE 'tourney_auto_settle_completed: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical', 'tourney_auto_settle_completed',
           'Tournament auto-settler is not runnable: ' || SQLERRM,
           jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM,
                              'function', 'public.auto_settle_completed_tournaments()',
                              'detail', 'Function body references club_tournaments / tournament_entries, which do not exist in this database. Live tables are public.tournaments / public.tournament_players. Completed tournaments are NOT being auto-settled.')
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts
        WHERE source = 'tourney_auto_settle_completed'
          AND resolved IS NOT TRUE);
  END;
END
$job$;
  $cmd$
);

