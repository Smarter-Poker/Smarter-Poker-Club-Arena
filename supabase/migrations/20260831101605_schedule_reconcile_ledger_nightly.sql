-- PHASE 1: the money alarm had no schedule.
-- reconcile_ledger_nightly writes ledger_reconcile_log - the check that surfaced
-- the 1,033 unaccounted seat exits (431,906 chips) fixed 2026-08-31. It was in
-- NO pg_cron entry: 55 jobs were scheduled and this was not one of them. Its last
-- run before today was 2026-08-30 20:54, and today's only run was manual. A leak
-- detector that never runs is not a detector.
--
-- Every 6h rather than nightly: the function DELETEs its own rows for
-- CURRENT_DATE before re-inserting, so repeat runs in a day are idempotent, and
-- chip_ledger is only ~213k rows (measured seq scan 0.97s). Four checks a day
-- means a new leak surfaces within 6 hours instead of 24.
--
-- Advisory lock matches the house pattern used by the other sweeps so a slow run
-- can never overlap itself.
-- TIER 2. Rollback: SELECT cron.unschedule('reconcile-ledger-integrity-6h');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly') THEN
    RAISE EXCEPTION 'pre-flight: reconcile_ledger_nightly does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='reconcile-ledger-integrity-6h') THEN
    PERFORM cron.unschedule('reconcile-ledger-integrity-6h');
    RAISE NOTICE 'pre-flight: replaced existing schedule';
  END IF;
END $$;

SELECT cron.schedule(
  'reconcile-ledger-integrity-6h',
  '55 */6 * * *',
  $cron$
  select case
           when pg_try_advisory_lock(hashtext('reconcile-ledger-integrity'))
           then (select 1 from public.reconcile_ledger_nightly() limit 1)
           else 0
         end;
  select pg_advisory_unlock(hashtext('reconcile-ledger-integrity'));
  $cron$
);

DO $$
DECLARE v_active boolean; v_sched text;
BEGIN
  SELECT active, schedule INTO v_active, v_sched
    FROM cron.job WHERE jobname='reconcile-ledger-integrity-6h';
  IF v_active IS NULL THEN RAISE EXCEPTION 'post-apply: job was not created'; END IF;
  IF NOT v_active THEN RAISE EXCEPTION 'post-apply: job created but inactive'; END IF;
  IF v_sched <> '55 */6 * * *' THEN RAISE EXCEPTION 'post-apply: unexpected schedule %', v_sched; END IF;
  RAISE NOTICE 'post-apply: reconcile-ledger-integrity-6h active on %', v_sched;
END $$;
