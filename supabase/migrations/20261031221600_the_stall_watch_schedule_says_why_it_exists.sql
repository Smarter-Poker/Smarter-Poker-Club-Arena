-- 20261031221600_the_stall_watch_schedule_says_why_it_exists.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261031182445 (a byte-exact recording) scheduled ca-table-stall-watch-10s
-- with no stated reason, and a recording cannot carry a comment its SQL never
-- had. This re-registers the same job, same name, same schedule and same
-- command, with the reason CLAUDE.md 10.12 asks for. Nothing about what runs
-- changes; the job id does.
--
-- periodic-work: the 10-second read of the engine's /metrics IS the owner's
--   60-second "Tables Have Stopped Dealing" detector (owner, 2026-10-31: "AFTER
--   60 SECONDS, IT SHOULD TRIGGER"). It writes only its own watch rows and
--   operational alert events; it moves no chips, seats or money, re-drives
--   nothing and repairs nothing. The stalls it reports are fixed at their
--   causes in the engine (fleet stall gauge, paused label, closed-arena skip).
--
-- Not DDL: cron.unschedule/cron.schedule write rows in cron.job, so this
-- triggers no PostgREST schema reload and is not refused in the break window.

-- @live-proof: EXISTS(SELECT 1 FROM cron.job WHERE jobname = 'ca-table-stall-watch-10s' AND jobid > 509 AND schedule = '10 seconds' AND command = 'SELECT public.fn_ca_table_stall_watch_tick(60000)' AND active)

BEGIN;

SELECT cron.unschedule('ca-table-stall-watch-10s');
SELECT cron.schedule(
  'ca-table-stall-watch-10s',
  '10 seconds',
  'SELECT public.fn_ca_table_stall_watch_tick(60000)'
);

DO $$
BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'ca-table-stall-watch-10s'
        AND schedule = '10 seconds'
        AND command = 'SELECT public.fn_ca_table_stall_watch_tick(60000)'
        AND active) <> 1 THEN
    RAISE EXCEPTION 'ca-table-stall-watch-10s is not registered exactly once';
  END IF;
END $$;

COMMIT;
