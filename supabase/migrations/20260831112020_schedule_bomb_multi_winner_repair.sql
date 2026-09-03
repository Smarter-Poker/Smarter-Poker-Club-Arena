-- PHASE 1: keep multi-winner bomb pots repaired.
-- The engine's hourly sweep calls fn_backfill_bomb_pot_award_units, which by
-- construction skips multi-winner hands. This schedules the companion repair
-- DB-side so it needs no engine deploy and cannot drift from the engine build.
-- Runs 20 past the hour, off the other repair sweeps.
-- TIER 2. Rollback: SELECT cron.unschedule('bomb-multi-winner-repair-hourly');
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_backfill_bomb_multi_winner_units') THEN
    RAISE EXCEPTION 'pre-flight: fn_backfill_bomb_multi_winner_units missing';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='bomb-multi-winner-repair-hourly') THEN
    PERFORM cron.unschedule('bomb-multi-winner-repair-hourly');
  END IF;
END $$;

SELECT cron.schedule(
  'bomb-multi-winner-repair-hourly',
  '20 * * * *',
  $cron$
  select case
           when pg_try_advisory_lock(hashtext('bomb-multi-winner-repair'))
           then (select units_written from public.fn_backfill_bomb_multi_winner_units(500, false) limit 1)
           else 0
         end;
  select pg_advisory_unlock(hashtext('bomb-multi-winner-repair'));
  $cron$
);

DO $$
DECLARE v_active boolean;
BEGIN
  SELECT active INTO v_active FROM cron.job WHERE jobname='bomb-multi-winner-repair-hourly';
  IF v_active IS NULL THEN RAISE EXCEPTION 'post-apply: job not created'; END IF;
  IF NOT v_active THEN RAISE EXCEPTION 'post-apply: job inactive'; END IF;
  RAISE NOTICE 'post-apply: bomb-multi-winner-repair-hourly active';
END $$;
