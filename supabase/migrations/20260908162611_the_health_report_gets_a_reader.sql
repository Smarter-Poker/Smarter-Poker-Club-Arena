-- 20260908162611_the_health_report_gets_a_reader.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- APPLIED TO PRODUCTION 2026-09-08 via the us-west-2 session pooler.

-- THE HEALTH REPORT HAD NO READER, AND ONE FUNCTION WAS LEFT BEHIND DEAD.
-- (.agents/rules/00-agent-playbook.md RULE 1 PART C.2 and RULE 7; CLAUDE.md 10.86 rule 3)
--
-- Both of these were found by running the playbook's own VERIFICATION PASS against my own work,
-- rather than by anybody complaining. Neither is a bug in what the code does; both are the same
-- defect this programme spent the day on, in the work that fixed it.
--
-- 1. **NOTHING READ `fn_ca_diamond_health()`.** Measured: 0 cron callers, no application caller.
--    It is fourteen areas over 28 reporting functions, built precisely because a defect had
--    survived a week of daily review among them - and then it sat there with nobody scheduled to
--    open it. That is exactly what "the flip had no hand" was four hours earlier: an instrument
--    that is correct, complete, and unreachable. CLAUDE.md 10.86 rule 3 states the test in one
--    line: **a guard must have a reader, and you must name them.**
--
--    `fn_ca_diamond_health_watch()` runs it on a schedule and files a CRITICAL incident naming
--    every area that is `critical` or `unknown`. The reader is therefore the incident table, which
--    the flip forecast, the trial-balance watch and a person all already read - no new surface,
--    and nothing new to remember to look at.
--
--    IT IS NOT A REPAIR JOB (10.12). It repairs nothing and pays nobody; it turns a report that
--    exists into a report that is read. And it is deliberately NOT an always-on alarm: it files
--    only on `critical`/`unknown`, never on `attention`, because two areas sit amber today for
--    reasons that are Dan's decision (the budget plans) and a fixed cause (evaluation coverage),
--    and an alarm that fires every hour on those would be muted inside a week.
--
-- 2. **`fn_ca_normalise_claim_loop` IS DEAD.** It existed to pin the two copies of the horse claim
--    loop character-for-character while merging them was too risky. Migration 20260908152950 then
--    removed the loop from the event path entirely, so what it pinned no longer exists. Measured:
--    0 functions reference it, 0 cron jobs, 0 views, and 0 event functions still carry a claim
--    loop. The playbook is blunt about this - "Dead code is unacceptable" - and it is right: a
--    function whose name says it guards something, guarding nothing, is worse than no function,
--    because the next reader assumes the guard is live.
--
--    Dropped. The law test that describes it reads the migration FILE, which is history and does
--    not change, so nothing that documents the episode is lost.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. The report gets a reader.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_health_watch()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE v_bad integer; v_detail jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_ca_diamond_health_watch: service_role required';
  END IF;

  -- `unknown` counts as bad. An area that could not be read is not an area that is fine, and the
  -- whole point of giving health an `unknown` status was that somebody would act on it.
  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object('area', h.area, 'status', h.status, 'detail', h.detail)), '[]'::jsonb)
    INTO v_bad, v_detail
    FROM public.fn_ca_diamond_health() h
   WHERE h.status IN ('critical', 'unknown');

  IF v_bad > 0 THEN
    PERFORM public.fn_ca_diamond_incident(
      'DR0:health_critical', 'critical', NULL, NULL, 'fn_ca_diamond_health_watch',
      jsonb_build_object('areas', v_bad, 'detail', v_detail));
  END IF;

  RETURN v_bad;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_health_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_health_watch() TO service_role;

COMMENT ON FUNCTION public.fn_ca_diamond_health_watch() IS
  'Reads fn_ca_diamond_health and files a CRITICAL incident naming every area that is critical or unknown. Exists because the health report had NO reader - 0 cron callers, no application caller - which is the same defect as nine rules whose arming function nothing called. Files only on critical/unknown, never on attention, so it does not become an always-on alarm on the two areas that are amber by decision.';

SELECT cron.schedule('ca-diamond-health-watch-hourly', '35 * * * *',
                     $cron$SELECT public.fn_ca_diamond_health_watch()$cron$)
 WHERE NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-health-watch-hourly');

-- ---------------------------------------------------------------------------
-- 2. The dead function goes.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_refs integer;
BEGIN
  -- Prove it is dead BEFORE dropping it, in this transaction, rather than trusting the measurement
  -- taken a minute ago in another one.
  SELECT count(*) INTO v_refs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname <> 'fn_ca_normalise_claim_loop'
     AND p.prosrc LIKE '%fn_ca_normalise_claim_loop%';
  IF v_refs <> 0 THEN
    RAISE EXCEPTION '% function(s) still call the normaliser; it is not dead', v_refs;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE command LIKE '%fn_ca_normalise_claim_loop%') THEN
    RAISE EXCEPTION 'a cron job still calls the normaliser';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname LIKE 'record_daily_challenge_event%'
                AND strpos(p.prosrc, 'FOR v_claim IN') > 0) THEN
    RAISE EXCEPTION 'an event function still carries a claim loop, so the normaliser still has a job';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.fn_ca_normalise_claim_loop(text);

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n integer; v_bad integer;
BEGIN
  -- the report has a reader, and it is scheduled
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-health-watch-hourly' AND active) THEN
    RAISE EXCEPTION 'the health report still has no reader';
  END IF;

  -- AND THE READER ACTUALLY WORKS. Asserting the function exists proves nothing (10.86): run it,
  -- and require its answer to agree with the report it is reading.
  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_health() h WHERE h.status IN ('critical','unknown');
  v_bad := public.fn_ca_diamond_health_watch();
  IF v_bad <> v_n THEN
    RAISE EXCEPTION 'the watch counted % bad areas where the report shows %', v_bad, v_n;
  END IF;
  -- and it stayed quiet, because nothing is critical
  IF v_n = 0 AND EXISTS (SELECT 1 FROM public.ca_diamond_incidents
                          WHERE rule = 'DR0:health_critical' AND occurred_at >= now() - interval '1 minute') THEN
    RAISE EXCEPTION 'the watch filed a critical incident with no critical area';
  END IF;

  -- the dead function is gone and nothing broke
  IF to_regprocedure('public.fn_ca_normalise_claim_loop(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'the dead normaliser survived';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'record_daily_challenge_event%') <> 3 THEN
    RAISE EXCEPTION 'an event function was lost';
  END IF;
  IF (SELECT count(*) FROM public.fn_ca_diamond_health()) < 14 THEN
    RAISE EXCEPTION 'the health report lost an area';
  END IF;

  -- and the money still adds up
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register';
  END IF;

  RAISE NOTICE 'health has a reader (% bad area(s) right now); the dead normaliser is dropped', v_bad;
END $$;

COMMIT;
