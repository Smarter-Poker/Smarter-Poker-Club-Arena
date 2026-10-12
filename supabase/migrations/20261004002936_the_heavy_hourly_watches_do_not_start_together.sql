-- 20261004002936_the_heavy_hourly_watches_do_not_start_together.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE HEAVY HOURLY WATCHES DO NOT START TOGETHER (phase 7 of 9: availability).
-- Full account:
-- docs/changelog/2026-10-04-the-heavy-hourly-watches-do-not-start-together.md.
--
-- cron.job_run_details, 24 h to 00:30 UTC 2026-10-04:
--
--   161 rake-law-adherence-hourly  :40  avg 104 s, max 601 s, 9 FAILED of 23
--   214 ca-ratchet-watch-hourly    :35  avg 125 s, max 311 s, 1 failed
--   123 union-integrity-sweep      :35  avg 266 s, max 301 s
--   236 ca-escrow-shadow-hourly    :35  avg 104 s, max 198 s
--
-- 1. Job 161 runs `SELECT public.fn_rake_law_check('2 hours'::interval);` with
--    no statement_timeout of its own, so it inherits the postgres role's
--    2 minutes: 7 of its 9 failures are cancellations at exactly 120.0 s inside
--    fn_rake_law_violations / fn_effective_rake (the other 2 are pg_cron
--    startup timeouts during the outages). Its warm cost is about 23 s; it
--    passes 120 s only when it runs inside the :35-:42 pile-up.
--    20261002170500 gave nine heavy jobs the same 300 s prefix and missed this
--    one. It gets the prefix.
-- 2. Job 214 (the ratchet watch: about 20-40 s of reads on its own, 52-169 s in
--    production) starts at :35 with the union sweep and the escrow shadow. The
--    escrow shadow's :35 is fixed by its brief (tests/law/
--    EscrowShadowNeverRefuses.law.test.ts) and the union sweep is the money
--    sweep, so the ratchet watch moves to :29, after the :25-:26 rollups and
--    clear of the :50-:03 break window.
--
-- Same jobs, same commands (161 gains only the prefix), no new job, nothing
-- else rescheduled.
--
-- @live-proof: (SELECT bool_and(CASE j.jobid WHEN 161 THEN j.command LIKE 'SET statement_timeout = ''300s''; %' WHEN 214 THEN j.schedule = '29 * * * *' END) FROM cron.job j WHERE j.jobid IN (161, 214))

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job j
                  WHERE j.jobid = 161 AND j.jobname = 'rake-law-adherence-hourly' AND j.active
                    AND j.schedule = '40 * * * *'
                    AND j.command = 'SELECT public.fn_rake_law_check(''2 hours''::interval);') THEN
    RAISE EXCEPTION 'preimage: cron job 161 is not the command read on 2026-10-04';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job j
                  WHERE j.jobid = 214 AND j.jobname = 'ca-ratchet-watch-hourly' AND j.active
                    AND j.schedule = '35 * * * *'
                    AND j.command = 'SET statement_timeout = ''300s''; select public.fn_ca_ratchet_watch();') THEN
    RAISE EXCEPTION 'preimage: cron job 214 is not the job read on 2026-10-04';
  END IF;
END
$pre$;

SELECT cron.alter_job(161, command := 'SET statement_timeout = ''300s''; ' || command)
  FROM cron.job WHERE jobid = 161;

SELECT cron.alter_job(214, schedule := '29 * * * *')
  FROM cron.job WHERE jobid = 214;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job j
                  WHERE j.jobid = 161 AND j.active AND j.schedule = '40 * * * *'
                    AND j.command = 'SET statement_timeout = ''300s''; SELECT public.fn_rake_law_check(''2 hours''::interval);')
     OR NOT EXISTS (SELECT 1 FROM cron.job j
                     WHERE j.jobid = 214 AND j.active AND j.schedule = '29 * * * *'
                       AND j.command = 'SET statement_timeout = ''300s''; select public.fn_ca_ratchet_watch();') THEN
    RAISE EXCEPTION 'the two jobs are not as intended';
  END IF;
END
$post$;

COMMIT;
