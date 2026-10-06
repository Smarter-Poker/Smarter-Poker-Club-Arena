-- ===========================================================================
--  AN AUDIT RUNS UNDER THE BUDGET IT WAS MEASURED AGAINST
-- ===========================================================================
--
-- Launch-gate sweep, 2026-10-03. Read from cron.job_run_details on production
-- at 02:20 UTC, last 6 hours, and timed read-only against production between
-- 02:35 and 02:55 UTC.
--
-- THE LIMIT THAT APPLIES. A pg_cron statement runs under the postgres role's
-- 2-minute statement_timeout. A SET on the function, or a set_config() inside
-- the cron statement, does not re-arm the timer of the statement already
-- running (migration 20261002170500 established this; job 144 proved it).
-- Only a separate FIRST statement in the cron command changes it. Eight jobs
-- below still had no such statement and were cancelled at 120 s:
--
--   job  name                                    6h      ok runs / cancel
--   128  club-rake-rollup-catchup                3 of 6  58-81 s / 120 s
--        (function declares 600 s, which never applied)
--   134  bbj-rollup-catchup                      2 of 6  the 2026-10-02 day
--        (86,000 contributions, 2 clubs) is built in ~90-110 s; cancelled at
--        120 s at 00:45 and 01:45, so the day has never been rolled up. On
--        2026-10-02 the same build was cancelled four times before landing.
--   143  spin_unpaid_check                       3 of 6  up to 117 s
--   178  ca-settlement-correctness-30m           3 of 6  up to 107 s
--   231  ca-pay-backed-payout-shortfalls-hourly  3 of 6  up to 117 s
--        (its SET LOCAL '120s' first statement is replaced, not prefixed)
--   123  union-integrity-sweep                   1 of 6  122 s
--        (set_config('statement_timeout','120s',true) inside the DO block is
--        the ineffective kind; it stays, the first statement now governs)
--   157  reconcile-ledger-integrity-6h           1 of 1  fn_bomb_pot_ledger_gaps
--        (function declares 300 s, which never applied)
--   76   refresh-player-stats-hourly             4 of 6  CREATE TEMP TABLE _ps
--        cancelled at 120 s; the one success took 40 s
--
-- Each now opens with SET statement_timeout = '300s'. That is a budget, not a
-- cure: a separate migration of the same sweep rewrites the functions behind
-- 143 and 178 so they need far less than this.
--
-- TWO WINDOWS THAT RE-READ FAR MORE THAN A RUN NEEDS:
--
--   227  ca-payout-guarantee-check-hourly (4 of 6 cancelled at 300 s).
--        fn_payout_guarantee_check() defaults to 7 days: 120,208 completed
--        events, each walked by four loops of per-event wallet_transactions
--        sums, every hour. The earners loop alone measured 9,965 ms over ONE
--        day (17,242 events, 17,979 index probes). It now reads 2 days, so
--        every completed event is still checked 48 times. The clearing pass
--        (open alerts -> paid since) is not windowed and is unchanged.
--
--   144  tourney_money_conservation_hourly (2 of 6 cancelled at 300 s).
--        fn_tournament_money_conservation(2, ...) calls
--        fn_tournament_conservation_delta once per event: 17,188 events in
--        2 days at ~8 ms each warm (300 calls measured 2.5 s) is ~140 s warm
--        and over 300 s under the current IO saturation. It now reads 1 day:
--        every event is still checked ~23 times after its 30-minute grace,
--        and pass 1 still re-checks every open alert whatever its age.
--
-- Nothing else changes: no function body, no schedule, no grant, no index.
-- ===========================================================================
-- @live-proof: (SELECT count(*) FROM cron.job WHERE jobid IN (76,123,128,134,143,157,178,231) AND active AND command LIKE 'SET statement_timeout = ''300s''; %') = 8 AND EXISTS (SELECT 1 FROM cron.job WHERE jobid = 227 AND strpos(command, 'fn_payout_guarantee_check(2)') > 0) AND EXISTS (SELECT 1 FROM cron.job WHERE jobid = 144 AND strpos(command, 'fn_tournament_money_conservation(1, 1.0, 200)') > 0)

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. Preimage: the ten commands are the ones read on 2026-10-03
-- ---------------------------------------------------------------------------

DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      (76,  'refresh-player-stats-hourly',            'public.fn_refresh_player_stats(now() - interval ''90 minutes'')'),
      (123, 'union-integrity-sweep',                  'PERFORM public.fn_union_integrity_sweep_all();'),
      (128, 'club-rake-rollup-catchup',               'SELECT public.fn_club_rake_rollup_catchup(3);'),
      (134, 'bbj-rollup-catchup',                     'SELECT public.fn_bbj_rollup_catchup(3);'),
      (143, 'spin_unpaid_check',                      'public.fn_spin_unpaid_check(7)'),
      (157, 'reconcile-ledger-integrity-6h',          'public.reconcile_ledger_nightly()'),
      (178, 'ca-settlement-correctness-30m',          'SELECT public.fn_ca_settlement_correctness_check();'),
      (231, 'ca-pay-backed-payout-shortfalls-hourly', 'public.fn_pay_backed_payout_shortfalls()')) AS x(id, name, frag)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM cron.job j
                    WHERE j.jobid = r.id AND j.jobname = r.name AND j.active
                      AND strpos(j.command, r.frag) > 0
                      AND ltrim(j.command) NOT ILIKE 'SET statement_timeout%') THEN
      RAISE EXCEPTION 'preimage: cron job % (%) is not the command read on 2026-10-03', r.id, r.name;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 231
                  AND ltrim(command) LIKE 'SET LOCAL statement_timeout = ''120s'';%') THEN
    RAISE EXCEPTION 'preimage: job 231 does not open with its SET LOCAL 120s';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 227 AND jobname = 'ca-payout-guarantee-check-hourly'
                  AND active AND command LIKE 'SET statement_timeout = ''300s''; %'
                  AND strpos(command, 'fn_payout_guarantee_check()') > 0) THEN
    RAISE EXCEPTION 'preimage: job 227 is not the 300 s, default-window command';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 144 AND jobname = 'tourney_money_conservation_hourly'
                  AND active AND command LIKE 'SET statement_timeout = ''300s''; %'
                  AND strpos(command, 'fn_tournament_money_conservation(2, 1.0, 200)') > 0) THEN
    RAISE EXCEPTION 'preimage: job 144 is not the 300 s, 2-day command';
  END IF;
END $pre$;

-- ---------------------------------------------------------------------------
-- 1. Each job gets its budget as the first statement, where it takes effect
-- ---------------------------------------------------------------------------

SELECT cron.alter_job(jobid, command := 'SET statement_timeout = ''300s''; ' || command)
  FROM cron.job WHERE jobid IN (76, 123, 128, 134, 143, 157, 178);

SELECT cron.alter_job(231, command := 'SET statement_timeout = ''300s''; '
         || replace(ltrim(command), 'SET LOCAL statement_timeout = ''120s'';', ''))
  FROM cron.job WHERE jobid = 231;

-- ---------------------------------------------------------------------------
-- 2. Two windows narrowed; every row is still read many times over
-- ---------------------------------------------------------------------------

-- 7 days every hour -> 2 days every hour: each completed event checked 48 times.
SELECT cron.alter_job(227, command := replace(command, 'fn_payout_guarantee_check()',
                                                       'fn_payout_guarantee_check(2)'))
  FROM cron.job WHERE jobid = 227;

-- 2 days every hour -> 1 day every hour: each event checked ~23 times.
SELECT cron.alter_job(144, command := replace(command, 'fn_tournament_money_conservation(2, 1.0, 200)',
                                                       'fn_tournament_money_conservation(1, 1.0, 200)'))
  FROM cron.job WHERE jobid = 144;

-- ---------------------------------------------------------------------------
-- 3. Postimage
-- ---------------------------------------------------------------------------

DO $post$
BEGIN
  IF (SELECT count(*) FROM cron.job
       WHERE jobid IN (76, 123, 128, 134, 143, 157, 178, 231)
         AND active AND command LIKE 'SET statement_timeout = ''300s''; %') <> 8 THEN
    RAISE EXCEPTION 'postimage: not every job opens with its 300 s budget';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobid = 231 AND strpos(command, '120s') > 0) THEN
    RAISE EXCEPTION 'postimage: job 231 still carries its 120 s statement';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 227
                  AND strpos(command, 'fn_payout_guarantee_check(2)') > 0)
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 144
                  AND strpos(command, 'fn_tournament_money_conservation(1, 1.0, 200)') > 0) THEN
    RAISE EXCEPTION 'postimage: a window was not rewritten';
  END IF;
END $post$;

COMMIT;
