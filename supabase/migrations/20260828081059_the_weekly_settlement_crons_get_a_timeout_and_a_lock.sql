-- THE WEEKLY SETTLEMENT CRONS GET A TIMEOUT AND A LOCK.
--
-- union-weekly-rakeback-recompute and union-weekly-rakeback-close have each run
-- exactly ONCE in their history, and both runs failed:
--
--   00:05:01  recompute  FAILED  canceling statement due to statement timeout
--   00:10:00  close      FAILED  job startup timeout
--
-- Both were bare `SELECT public.fn_...();`. Every other money cron in this
-- database wraps itself in an advisory lock and raises statement_timeout first
-- — tourney_payout_sweep_detect_daily, tourney_money_conservation_deep_daily,
-- reconcile-club-member-daily-profit all do exactly that. These two were
-- written without it, hit the default 120s ceiling at two minutes, and the
-- close never got a worker.
--
-- So the weekly rakeback close has NEVER SUCCEEDED. That is the root of
-- "Player rakeback deferred: club treasury cannot fund payout" (240 alerts),
-- of union_treasury_selftest's 'lapsed_week_unclosed', and of Midway Union's
-- treasury sitting negative while union rake waits to come back to the clubs.
--
-- They are now built like every other money cron here: advisory lock so a slow
-- run cannot overlap itself, 600s statement_timeout, and enough space between
-- them that the close is not asking for a worker while the recompute still
-- holds one. Recompute moves to 23:40 Sunday, close stays Monday 00:10.
--
-- THIS DOES NOT UNFREEZE ANYTHING. settlement_locks still carries an active
-- GLOBAL_SETTLEMENT_FREEZE ("EMERGENCY: PROFIT DRIFT INVESTIGATION",
-- 2026-08-26 13:38), so the close will run, hit the freeze, and return
-- EMERGENCY_PROFIT_DRIFT_LOCK until a human lifts it. That is the correct
-- behaviour: the job should be capable and refused, not broken and refused.
--
-- ROLLBACK
--   SELECT cron.unschedule('union-weekly-rakeback-recompute');
--   SELECT cron.unschedule('union-weekly-rakeback-close');
--   then re-create with the bare SELECT bodies.

SELECT cron.unschedule('union-weekly-rakeback-recompute');
SELECT cron.unschedule('union-weekly-rakeback-close');

SELECT cron.schedule(
  'union-weekly-rakeback-recompute',
  '40 23 * * 0',
  $job$
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-recompute'))
             then (select set_config('statement_timeout','600s',true) is not null
                      and public.fn_rakeback_recompute_all_clubs() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $job$
);

SELECT cron.schedule(
  'union-weekly-rakeback-close',
  '10 0 * * 1',
  $job$
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-close'))
             then (select set_config('statement_timeout','600s',true) is not null
                      and public.fn_union_settlement_cascade_all() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $job$
);

DO $post$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname IN ('union-weekly-rakeback-recompute','union-weekly-rakeback-close')
     AND active AND command LIKE '%statement_timeout%' AND command LIKE '%pg_try_advisory_lock%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected 2 hardened weekly settlement jobs, found %', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.settlement_locks
                  WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'the GLOBAL_SETTLEMENT_FREEZE was lifted; this migration must not do that';
  END IF;
END
$post$;
