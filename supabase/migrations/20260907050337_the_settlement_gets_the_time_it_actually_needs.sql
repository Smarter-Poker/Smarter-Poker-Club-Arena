-- THE SETTLEMENT GETS THE TIME IT ACTUALLY NEEDS
-- =============================================================================
-- The close job carried statement_timeout = 600s. Round 2 alone needs more than
-- that, so the cascade could never have finished, and the 2026-09-07 07:00 run
-- would have died in the middle of round 2 and rolled back rounds 1 and 2.
--
-- MEASURED, not estimated (probe rolled back, CLAUDE.md 11.5):
--
--   fn_settle_round2_club_to_agents stamps settled_at on every commission row
--   in the period. For 2026-08-31 to 2026-09-07 that is 2,124,321 rows out of
--   3,560,875 in a 2,035 MB table, and settled_at sits in the predicate of
--   agent_commissions_unsettled_idx, so no update is HOT and eight indexes are
--   maintained on every row version.
--
--     100,000 rows updated in 31.44 s  =  3,180 rows/sec
--     projected for 2,124,321 rows     =  668 s
--
--   Two full-cascade probes confirm it: one cancelled at 240 s and one at
--   540 s, both inside that UPDATE.
--
-- So the work is roughly 11 minutes for round 2 plus rounds 1, 3, ECO and the
-- invoices. The WALL CLOCK is not the constraint - the job starts at :05 and
-- the maintenance break announces at :53, which is 48 minutes - the 600 s cap
-- was. The ceiling moves to 2400 s, which still lands worst-case at :45, ahead
-- of the announce, and fn_union_settlement_cascade_due already refuses to start
-- after :45 or while the platform is frozen.
--
-- This is a ceiling, not an expectation. If a run ever approaches it, the
-- settled_at model is the thing to change: stamping two million rows a week to
-- record one fact per (club, agent, period) is the underlying cost, and
-- deriving "unsettled" from the last settled period end would remove the write
-- entirely. That is a design change and it is not being made at 05:00 on the
-- morning the invoices go out.
-- =============================================================================

BEGIN;

SELECT cron.schedule(
  'union-weekly-rakeback-close',
  '5 7,8,9,10 * * *',
  $cron$
  SET statement_timeout = '2400s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-close'))
             then (select set_config('statement_timeout','2400s',true) is not null
                      and public.fn_union_settlement_cascade_due() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $cron$);

DO $assert$
DECLARE v_cmd text; v_sched text;
BEGIN
  SELECT command, schedule INTO v_cmd, v_sched
    FROM cron.job WHERE jobname = 'union-weekly-rakeback-close';

  IF v_sched <> '5 7,8,9,10 * * *' THEN
    RAISE EXCEPTION 'close job schedule is %, expected 5 7,8,9,10 * * *', v_sched;
  END IF;
  IF v_cmd NOT LIKE '%2400s%' THEN
    RAISE EXCEPTION 'close job still carries the old statement_timeout: %', v_cmd;
  END IF;
  IF v_cmd NOT LIKE '%fn_union_settlement_cascade_due%' THEN
    RAISE EXCEPTION 'close job no longer calls the idempotent due runner: %', v_cmd;
  END IF;
END
$assert$;

COMMIT;
