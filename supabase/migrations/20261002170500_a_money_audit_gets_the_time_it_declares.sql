-- ===========================================================================
--  A MONEY AUDIT GETS THE TIME IT DECLARES, OVER A WINDOW IT CAN FINISH
-- ===========================================================================
--
-- Launch-gate sweep, 2026-10-02. Read from cron.job_run_details, production.
--
-- In the 12 hours to 16:00 UTC these hourly money audits were cancelled by
-- statement timeout more often than they finished:
--   ca-ratchet-watch-hourly                 9 of 12 failed
--   ca-escalate-reconcile-criticals-hourly  8 of 12
--   rake-attribution-drift-audit-hourly     7 of 12
--   ca-payout-guarantee-check-hourly        7 of 12
--   rake-bbj-invariant-audit-hourly         5 of 12
--   tourney_money_conservation_hourly       3 of 12
--   ca-stats-witness-audit-15m              5 of 48
--   ca-results-without-a-hand-6h            no success in 12 hours
--   union-law-selftest (daily)              failed 10-01 and 10-02
-- A cancelled audit is a blind audit: the invariant it guards goes unchecked
-- for that hour, and fn_ca_cron_failure_watch files an "unknown" incident
-- that holds the burn-in launch gate red.
--
-- WHY. The limit that applies to a pg_cron statement is the role's 2 minutes.
-- A set_config('statement_timeout', ...) inside the cron statement, or a SET
-- on the function, does not change the timer of the statement already
-- running (fn_ca_ratchet_watch declares 30 s and runs 98-118 s; job 144 asks
-- for 120 s inside its own statement). Only a separate first statement in the
-- cron command does, as ca-conservation-sweep-hourly already does. And two
-- jobs re-read far more than one run needs:
--   * rake-attribution-drift-audit re-checks 24 hours every hour (115,670
--     weighted hands); one hour measured 6.0 s, so 24 hours is ~140 s. Every
--     hour is now checked twice by a 2-hour window.
--   * ca-results-without-a-hand looks back 7 days (109,817 completed events)
--     every 6 hours; 6 hours measured 5.4 s. It now looks back 1 day, which
--     still covers every event four times over.
-- And fn_ca_treasury_positions (ca-escalate-reconcile-criticals, once per
-- critical treasury) aggregates every club_treasury leg since the baseline
-- with no index on the treasury legs: two full scans of chip_ledger (8.1M
-- rows, 3.7 GB) per call. A partial index covers the credit legs for
-- index-only aggregation. (The matching debit index could not be built
-- concurrently on 2026-10-02 under write load; its invalid build,
-- idx_chip_ledger_treasury_out, is not used by any plan and is left for a
-- quiet window to drop and rebuild.)
--
-- WHAT CHANGES. Each command gets a first statement that sets the budget it
-- needs (300 s; 600 s for the daily union self-test), the two windows are
-- narrowed, and the credit-leg index is built CONCURRENTLY before the
-- transaction. No function body changes; no audit is weakened - every row
-- each audit used to cover is still covered by at least one run.
-- ===========================================================================
-- @live-proof: (SELECT count(*) FROM cron.job WHERE jobid IN (121,144,155,156,214,226,227,230,263) AND command LIKE 'SET statement_timeout = %') = 9

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chip_ledger_treasury_in
  ON public.chip_ledger (to_entity_id, created_at) INCLUDE (amount)
  WHERE to_type = 'club_treasury' AND to_entity_id IS NOT NULL;

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. Preimage: the nine commands are the ones read on 2026-10-02
-- ---------------------------------------------------------------------------

DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      (121, 'union-law-selftest',                     'SELECT public.fn_union_law_selftest();'),
      (144, 'tourney_money_conservation_hourly',      'fn_tournament_money_conservation(2, 1.0, 200)'),
      (155, 'rake-bbj-invariant-audit-hourly',        'fn_rake_bbj_audit(2)'),
      (156, 'rake-attribution-drift-audit-hourly',    'fn_rake_attribution_drift_audit(24)'),
      (214, 'ca-ratchet-watch-hourly',                'select public.fn_ca_ratchet_watch();'),
      (226, 'ca-escalate-reconcile-criticals-hourly', 'fn_ca_escalate_reconcile_criticals()'),
      (227, 'ca-payout-guarantee-check-hourly',       'fn_payout_guarantee_check()'),
      (230, 'ca-results-without-a-hand-6h',           'fn_detect_results_without_a_hand()'),
      (263, 'ca-stats-witness-audit-15m',             'ca_stats_witness_audit(10, 90)')) AS x(id, name, frag)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM cron.job j
                    WHERE j.jobid = r.id AND j.jobname = r.name AND j.active
                      AND strpos(j.command, r.frag) > 0
                      AND j.command NOT ILIKE 'SET statement_timeout%') THEN
      RAISE EXCEPTION 'preimage: cron job % (%) is not the command read on 2026-10-02', r.id, r.name;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'idx_chip_ledger_treasury_in' AND i.indisvalid) THEN
    RAISE EXCEPTION 'preimage: the treasury credit-leg index is missing or invalid; rebuild it before this transaction';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. Each audit gets the time it needs, set where it takes effect
-- ---------------------------------------------------------------------------

SELECT cron.alter_job(121, command := 'SET statement_timeout = ''600s''; ' || command)
  FROM cron.job WHERE jobid = 121;

SELECT cron.alter_job(144, command := 'SET statement_timeout = ''300s''; '
         || replace(command, 'set_config(''statement_timeout'',''120s'',true)',
                             'set_config(''statement_timeout'',''300s'',true)'))
  FROM cron.job WHERE jobid = 144;

SELECT cron.alter_job(155, command := 'SET statement_timeout = ''300s''; ' || command)
  FROM cron.job WHERE jobid = 155;

-- 24 hours re-read every hour -> 2 hours every hour: each hour is still
-- checked twice.
SELECT cron.alter_job(156, command := 'SET statement_timeout = ''300s''; '
         || replace(command, 'fn_rake_attribution_drift_audit(24)',
                             'fn_rake_attribution_drift_audit(2)'))
  FROM cron.job WHERE jobid = 156;

SELECT cron.alter_job(214, command := 'SET statement_timeout = ''300s''; ' || command)
  FROM cron.job WHERE jobid = 214;

SELECT cron.alter_job(226, command := 'SET statement_timeout = ''300s''; ' || command)
  FROM cron.job WHERE jobid = 226;

SELECT cron.alter_job(227, command := 'SET statement_timeout = ''300s''; ' || command)
  FROM cron.job WHERE jobid = 227;

-- 7 days re-read every 6 hours -> 1 day every 6 hours: each event is still
-- checked four times.
SELECT cron.alter_job(230, command := 'SET statement_timeout = ''300s''; '
         || replace(command, 'fn_detect_results_without_a_hand()',
                             'fn_detect_results_without_a_hand(1)'))
  FROM cron.job WHERE jobid = 230;

SELECT cron.alter_job(263, command := 'SET statement_timeout = ''300s''; '
         || replace(command, 'set_config(''statement_timeout'', ''120s'', true)',
                             'set_config(''statement_timeout'', ''300s'', true)'))
  FROM cron.job WHERE jobid = 263;

-- ---------------------------------------------------------------------------
-- 2. Postimage
-- ---------------------------------------------------------------------------

DO $post$
BEGIN
  IF (SELECT count(*) FROM cron.job
       WHERE jobid IN (121,144,155,156,214,226,227,230,263)
         AND active AND command LIKE 'SET statement_timeout = %') <> 9 THEN
    RAISE EXCEPTION 'postimage: not every audit command opens with its budget';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 156
                  AND strpos(command, 'fn_rake_attribution_drift_audit(2)') > 0)
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 230
                  AND strpos(command, 'fn_detect_results_without_a_hand(1)') > 0)
     OR EXISTS (SELECT 1 FROM cron.job WHERE jobid IN (144, 263)
                  AND strpos(command, '120s') > 0) THEN
    RAISE EXCEPTION 'postimage: a window or an inner budget was not rewritten';
  END IF;
END $post$;

COMMIT;
