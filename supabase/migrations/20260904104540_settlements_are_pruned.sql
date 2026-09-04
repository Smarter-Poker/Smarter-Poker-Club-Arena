-- ═══════════════════════════════════════════════════════════════════════════
--  ca_settlements GROWS FOREVER, AND NOBODY HAS EVER DELETED A ROW FROM IT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (measured 2026-09-04)
--
--     n_tup_del = 0          oldest row 2026-09-01, newest 2026-09-04
--     1,777,140 rows         1,296 MB (929 MB heap + 367 MB index)
--     1,639,731 'final'      137,409 'failed'
--
-- The entire 1.3 GB is THREE DAYS OLD. There is no prune anywhere - not in
-- cron.job, not in either repo, not in any migration. At ~590k rows and
-- ~430 MB a day it is roughly 13 GB a month, and on this trajectory it passes
-- hand_state_snapshots (7.3 GB, the current largest table) inside three weeks.
--
-- Every one of those rows is also WAL, and WAL volume is what a lagging
-- replication slot has to read through. The realtime slot was 136 MB behind and
-- climbing on the day this was written.
--
-- WHAT ca_settlements IS
--
-- An audit breadcrumb of the per-hand settlement state machine, written by
-- fn_ca_settle_hand_stacks_absolute. One INSERT and six UPDATEs per hand walk
-- the row open -> locked_for_calculation -> calculated -> validated ->
-- ledger_posted -> post_commit_verified -> final. It is functionally a
-- duplicate of settlement_idempotency_keys: both are keyed by table and hand
-- and both record the same outcome.
--
-- WHY A PRUNE IS SAFE, AND WHY IT IS NOT A MONEY EDIT
--
-- The rows themselves move no chips. The chip movement is
-- UPDATE table_seats SET stack inside the same function; these rows record that
-- it happened. And crucially THIS PRUNE RUNS OUTSIDE THAT TRANSACTION, on its
-- own schedule, so it cannot affect a settlement in flight. Verified before
-- writing it:
--
--   * zero inbound foreign keys, zero outbound foreign keys;
--   * not a member of the supabase_realtime publication;
--   * no view references it;
--   * exactly six functions reference it, and NONE reads a historical row.
--     fn_ca_settle_hand_stacks_absolute and fn_ca_settle_hand_stacks read
--     their own row; fn_union_settle_player_pnl and
--     fn_union_weekly_rakeback_close read theirs by
--     (settlement_type, external_ref); fn_ca_alarm_drill inserts one row a
--     month and rolls it back; fn_ca_midway_burnin_gate reads
--     `WHERE updated_at > v_since` - a recent window, never history.
--
-- 30 days is therefore enormously conservative: the oldest row in the table is
-- three days old and the only historical reader looks at minutes.
--
-- WHAT IT WILL NOT DELETE, EVER
--
--   * state = 'failed'. 137,409 of them in three days - a 7.7% hand-settlement
--     failure rate, every one carrying its error_detail ('conservation
--     violation', 'seat missing or left', 'seat write failed'). That is
--     evidence of an open defect and it is worth more than the disk it sits on.
--     It is raised separately; it must not be quietly swept away by a retention
--     job while somebody is still working out what it means.
--   * Anything not yet 'final'. A row still walking its state machine is a
--     settlement in progress.
--
-- HOW IT BEHAVES
--
-- Batched, like every other prune here, so it can never take a long lock:
-- p_batch rows per call, oldest first, returning how many it deleted so the
-- cron command can assert >= 0. It refuses to run while the platform is frozen
-- for the :55 maintenance break (CLAUDE.md section 13 rule 5 - a periodic sweep
-- checks the freeze before it touches anything), and it is scheduled to skip
-- the break window anyway.
--
-- ROLLBACK
--
--   SELECT cron.unschedule('sp_prune_ca_settlements_10m');
--   DROP FUNCTION IF EXISTS public.sp_prune_ca_settlements(integer, integer);
--
-- Deleted rows are not recoverable, which is why the window is 30 days and the
-- failed rows are untouchable.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.sp_prune_ca_settlements(
  p_batch         integer DEFAULT 5000,
  p_retain_days   integer DEFAULT 30
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted integer := 0;
  v_cutoff  timestamptz;
BEGIN
  IF p_batch IS NULL OR p_batch <= 0 THEN
    RAISE EXCEPTION 'sp_prune_ca_settlements: p_batch must be positive, got %', p_batch;
  END IF;

  -- A retention window shorter than a week is almost certainly a typo, and this
  -- function deletes irreversibly. Refuse rather than obey.
  IF p_retain_days IS NULL OR p_retain_days < 7 THEN
    RAISE EXCEPTION
      'sp_prune_ca_settlements: refusing a retention window of % days. Settlement history is evidence; if you really mean to shorten it, change the default here in a migration that says why.',
      p_retain_days;
  END IF;

  -- Never move anything while the platform is frozen for the maintenance break.
  IF public.fn_platform_frozen() THEN
    RETURN 0;
  END IF;

  v_cutoff := now() - make_interval(days => p_retain_days);

  WITH doomed AS (
    SELECT ctid
    FROM public.ca_settlements
    WHERE state = 'final'
      AND updated_at < v_cutoff
    ORDER BY updated_at
    LIMIT p_batch
  )
  DELETE FROM public.ca_settlements s
  USING doomed d
  WHERE s.ctid = d.ctid;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

COMMENT ON FUNCTION public.sp_prune_ca_settlements(integer, integer) IS
  'Batched retention prune for ca_settlements, which had no prune at all and was growing ~430 MB/day forever. Deletes only state = ''final'' rows older than p_retain_days (default 30). NEVER deletes ''failed'' rows - those are evidence of the 7.7% settlement failure rate - and never a row still walking its state machine. Runs outside the settlement transaction and skips the maintenance freeze.';

REVOKE ALL ON FUNCTION public.sp_prune_ca_settlements(integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sp_prune_ca_settlements(integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.sp_prune_ca_settlements(integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sp_prune_ca_settlements(integer, integer) TO service_role;

-- Every ten minutes, deliberately avoiding minutes 53-59: the platform freezes
-- for the maintenance break at :55 and the function would refuse anyway, but a
-- job that is scheduled never to be able to run is a job somebody will later
-- mistake for a broken one.
SELECT cron.unschedule('sp_prune_ca_settlements_10m')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sp_prune_ca_settlements_10m');

SELECT cron.schedule(
  'sp_prune_ca_settlements_10m',
  '7,17,27,37,47 * * * *',
  $cron$
select case
         when pg_try_advisory_lock(hashtext('sp-prune-ca-settlements'))
           then (select set_config('statement_timeout','30s',true) is not null
                    and public.sp_prune_ca_settlements(5000) >= 0)::text
         else 'skipped: previous run still in progress'
       end;
$cron$
);

DO $$
DECLARE
  v_job     int;
  v_deleted int;
  v_failed  bigint;
BEGIN
  SELECT count(*) INTO v_job FROM cron.job WHERE jobname = 'sp_prune_ca_settlements_10m';
  IF v_job <> 1 THEN
    RAISE EXCEPTION 'post-condition failed: expected exactly one sp_prune_ca_settlements_10m job, found %', v_job;
  END IF;

  -- Prove it runs and, right now, deletes NOTHING: the oldest row in the table
  -- is three days old and the window is thirty. A prune that removed rows on
  -- the day it shipped would mean the window was wrong.
  SELECT public.sp_prune_ca_settlements(100) INTO v_deleted;
  IF v_deleted <> 0 THEN
    RAISE EXCEPTION
      'post-condition failed: the prune deleted % rows on install. Nothing in ca_settlements should be 30 days old yet - re-measure before trusting this window.',
      v_deleted;
  END IF;

  SELECT count(*) INTO v_failed FROM public.ca_settlements WHERE state = 'failed';
  RAISE NOTICE 'sp_prune_ca_settlements installed. % failed settlements are retained and untouchable by this job.', v_failed;
END $$;
