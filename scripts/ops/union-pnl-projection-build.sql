-- Operator runbook for 20260929044303 (a union close reads narrow projections).
-- Run each block by hand, in order, as the database owner (postgres). Nothing
-- here writes a balance, a ledger row or any source table.

-- 1. After the migration: where each build starts (end_block is fixed).
SELECT public.fn_union_pnl_projection_status();

-- 2. Start the throttled build: one runner a minute, 50 s of work, the
--    build's share of disk time held at 25% (it sleeps 3x each step).
--    Default blocks per step: 128 events pages, 64 hand pages, 16 credit pages.
SELECT cron.schedule('union-pnl-projection-build', '* * * * *',
  $$CALL public.sp_union_pnl_projection_build(128, 100, 50, 25)$$);

-- 3. Watch it (percent per projection; rows_written; completed_at).
SELECT public.fn_union_pnl_projection_status();
SELECT status, start_time, end_time, left(return_message, 120)
  FROM cron.job_run_details WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='union-pnl-projection-build')
 ORDER BY start_time DESC LIMIT 5;
-- Slow it down or speed it up without stopping (takes effect next minute):
-- SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='union-pnl-projection-build'),
--   command => $$CALL public.sp_union_pnl_projection_build(128, 100, 50, 10)$$);
-- Pause (resumable: the next run continues from next_block):
-- SELECT cron.unschedule('union-pnl-projection-build');

-- 4. When status says "ready": true, stop the job and prove the projections
--    on a 1% page sample of every source (read-only; ~1% of each source's IO).
SELECT cron.unschedule('union-pnl-projection-build');
SET statement_timeout = '600s';
SELECT public.fn_union_pnl_projection_verify(1);   -- expect "ok": true, every "mismatched": 0

-- 5. The Midway week's projected reads (each should take seconds, not minutes).
SET statement_timeout = '120s';
SELECT count(*) FROM public.fn_union_pnl_touched_registrations('2026-09-21 07:00+00','2026-09-28 07:00+00',true);
SELECT count(*) FROM public.fn_union_pnl_week_hand_lines('fade0000-0000-0000-0000-000000000001','2026-09-21 07:00+00','2026-09-28 07:00+00',true);
SELECT count(*) FROM public.fn_union_pnl_week_shaped_hands('fade0000-0000-0000-0000-000000000001','2026-09-21 07:00+00','2026-09-28 07:00+00',true);
SELECT count(*) FROM public.fn_union_pnl_week_union_credits('fade0000-0000-0000-0000-000000000001','2026-09-21 07:00+00','2026-09-28 07:00+00',true);
