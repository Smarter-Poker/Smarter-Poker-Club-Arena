-- RETIRE THE AUTO-SETTLER THAT NEVER SETTLED ANYTHING.
--
-- cron job `tourney_auto_settle_completed` has been running every 10 minutes
-- against public.auto_settle_completed_tournaments(). That function reads
-- `club_tournaments` and `tournament_entries`, neither of which exists in this
-- database - the live tables are public.tournaments and
-- public.tournament_players. So every run for as long as the job has existed
-- has thrown, been caught by the job's own handler, and filed the critical
-- alert that says in plain words: "Completed tournaments are NOT being
-- auto-settled."
--
-- The alert was accurate about the failure and misleading about the stakes.
-- Read the body: even against the right tables it selects finished events and
-- then does `UPDATE ... SET updated_at = NOW()`. It settles nothing, pays
-- nothing, and books nothing. It is a no-op that has been failing loudly.
--
-- Settlement is genuinely handled elsewhere and is working:
--   fn_sweep_unsettled_tournament_rake   engine, hourly    (rake)
--   fn_tournament_payout_sweep           pg_cron, daily    (places)
--   fn_settle_tournament_rake            engine, per event (at completion)
--
-- So this is retired rather than repaired. Rewriting it against the real
-- tables would create a fourth settlement path competing with three that work,
-- which is exactly what RULE 12 forbids. Dropping it removes a permanently
-- red critical alert that has been training everyone to ignore the
-- financial_alerts queue.
--
-- ROLLBACK
--   The function body is in this migration's history if it is ever wanted, and
--   the schedule was:
--     SELECT cron.schedule('tourney_auto_settle_completed', '*/10 * * * *', $$...$$);
--   Nothing should want it.

DO $unschedule$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tourney_auto_settle_completed') THEN
    PERFORM cron.unschedule('tourney_auto_settle_completed');
  END IF;
END
$unschedule$;

DROP FUNCTION IF EXISTS public.auto_settle_completed_tournaments();

UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now()
 WHERE source = 'tourney_auto_settle_completed'
   AND resolved IS NOT TRUE;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tourney_auto_settle_completed') THEN
    RAISE EXCEPTION 'the cron job is still scheduled';
  END IF;
  IF to_regprocedure('public.auto_settle_completed_tournaments()') IS NOT NULL THEN
    RAISE EXCEPTION 'the dead function still exists';
  END IF;
  -- The paths that DO settle must still be here; retiring the no-op must not
  -- have been the thing that removed settlement.
  IF to_regprocedure('public.fn_settle_tournament_rake(uuid, text)') IS NULL
     OR to_regprocedure('public.fn_tournament_payout_sweep(integer, boolean, integer)') IS NULL THEN
    RAISE EXCEPTION 'a real settlement path is missing; do not leave the estate without one';
  END IF;
END
$post$;
