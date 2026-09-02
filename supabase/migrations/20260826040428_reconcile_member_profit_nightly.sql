-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826040428; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE TABLE IF NOT EXISTS public.club_member_daily_stats_profit_backup_20260826 (
  club_id      uuid        NOT NULL,
  table_id     uuid,
  user_id      uuid        NOT NULL,
  stat_date    date        NOT NULL,
  profit       numeric,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cmds_profit_backup_key
  ON public.club_member_daily_stats_profit_backup_20260826
     (stat_date, club_id, user_id);

ALTER TABLE public.club_member_daily_stats_profit_backup_20260826
  ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.club_member_daily_stats_profit_backup_20260826 IS
  'Pre-reconciliation values of club_member_daily_stats.profit, captured by migration 20260826050000 before the first backfill. Restore statement is in that migration ROLLBACK section. Safe to drop once the reconciled numbers have been accepted.';

INSERT INTO public.club_member_daily_stats_profit_backup_20260826
       (club_id, table_id, user_id, stat_date, profit)
SELECT s.club_id, s.table_id, s.user_id, s.stat_date, s.profit
  FROM public.club_member_daily_stats s
 WHERE s.stat_date >= DATE '2026-08-20'
   AND s.stat_date <  CURRENT_DATE
   AND NOT EXISTS (
         SELECT 1 FROM public.club_member_daily_stats_profit_backup_20260826 b
          WHERE b.stat_date = s.stat_date
            AND b.club_id   = s.club_id
            AND b.user_id   = s.user_id
            AND b.table_id IS NOT DISTINCT FROM s.table_id
       );

DO $backfill$
DECLARE
  d      date;
  result jsonb;
BEGIN
  FOR d IN
    SELECT DISTINCT stat_date
      FROM public.club_member_daily_stats
     WHERE stat_date >= DATE '2026-08-20'
       AND stat_date <  CURRENT_DATE
     ORDER BY 1
  LOOP
    result := public.fn_reconcile_club_member_daily_profit(d);
    RAISE NOTICE 'reconcile % -> %', d, result;
  END LOOP;
END
$backfill$;

DO $sched$
DECLARE
  v_existing bigint;
BEGIN
  SELECT jobid INTO v_existing FROM cron.job
   WHERE jobname = 'reconcile-club-member-daily-profit';

  IF v_existing IS NOT NULL THEN
    PERFORM cron.unschedule(v_existing);
  END IF;

  PERFORM cron.schedule(
    'reconcile-club-member-daily-profit',
    '35 0 * * *',
    $cmd$
    select case
             when pg_try_advisory_lock(hashtext('reconcile-club-member-daily-profit'))
               then (select set_config('statement_timeout','300s',true) is not null
                        and public.fn_reconcile_club_member_daily_profit(current_date - 1) is not null)::text
             else 'skipped: previous run still in progress'
           end;
    $cmd$
  );
END
$sched$;

DO $assert$
DECLARE
  v_backed_up bigint;
  v_scheduled bigint;
BEGIN
  SELECT count(*) INTO v_backed_up
    FROM public.club_member_daily_stats_profit_backup_20260826;
  IF v_backed_up = 0 THEN
    RAISE EXCEPTION 'profit backup is empty - refusing to claim a reversible backfill';
  END IF;

  SELECT count(*) INTO v_scheduled FROM cron.job
   WHERE jobname = 'reconcile-club-member-daily-profit' AND active;
  IF v_scheduled <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 active reconcile job, found %', v_scheduled;
  END IF;
END
$assert$;
