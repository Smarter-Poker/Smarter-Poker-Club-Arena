-- THE UNFUNDED CLUB IS A FACT ON THE PERIOD, NOT A WATCHER
-- =============================================================================
-- PHASE 5 of 8, part 7 - reverting part 6, and closing a grant that predates
-- this whole phase.
--
-- 1. THE WATCHER GOES. Migration 20260907193146 added
--    fn_rakeback_shortfall_watch and wired it into the hourly sweep to raise one
--    critical alert per club per day when a treasury cannot cover the rakeback
--    it owes. scripts/ci/check-no-new-band-aids.mjs refused it, and the refusal
--    is correct on the substance rather than on the spelling.
--
--    Dan, 2026-09-07: "IT IS NO LONGER ALLOWED TO CREATE ANYTHING THAT MONITORS
--    AND BACK FILLS OR ADJUSTS A PAYOUT OR ANY OTHER ISSUE ... I WANT HARD CODED
--    FIXES AT THE ROOT SOURCE."
--
--    The root cause here is fixed: the drain could not finish inside the 8s
--    service_role timeout, it now can, and 231,046.71 reached 987 players today.
--    What remains is that Midway Union holds 0.50 chips and owes 280,142.41.
--    That is not a defect in this code and no amount of code fixes it - the club
--    has no chips. Under the rule, the honest move is to say so and stop, not to
--    ship a daily alarm and call the shortfall handled.
--
--    It is already visible without a watcher, in two places that are read rather
--    than logged: rakeback_periods.deferred_reason carries
--    'insufficient_club_treasury' on every affected period, and
--    fn_rakeback_settlement_status() reports the club with fundable:false and
--    the exact shortfall - that is what the settlement dashboard calls. A
--    financial_alerts row would have been the 174th unresolved critical alert on
--    this platform, which is not how somebody comes to act on it.
--
--    So the sweep goes back to what Phase 4 left it as, and the one alert the
--    watcher raised is resolved with the reason.
--
-- 2. AND settle_club_rakeback STOPS ANSWERING anon. The grant is older than
--    this phase - CREATE OR REPLACE preserves grants, so replacing the body
--    carried it forward - but check-definer-authorization is right that a
--    SECURITY DEFINER money function reachable by a caller with no account is a
--    hole whoever opened it. The inner worker already refuses anyone who is not
--    the engine, the club owner or a platform admin; this stops the question
--    being askable at all. `authenticated` keeps EXECUTE, because a club owner
--    settling their own club and the admin dashboard both come through it.
-- =============================================================================

BEGIN;

-- 1. UNWIRE, THEN DROP -------------------------------------------------------

DO $migrate$
DECLARE v_def text; v_new text; v_a text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc
   WHERE proname='fn_union_integrity_sweep_all' AND pronamespace='public'::regnamespace;

  v_a := E'    -- A club that cannot pay its players'' rakeback says so, once a day.\n'
      || E'    BEGIN\n'
      || E'      PERFORM public.fn_rakeback_shortfall_watch();\n'
      || E'    EXCEPTION WHEN OTHERS THEN\n'
      || E'      INSERT INTO financial_alerts (source, severity, message, context)\n'
      || E'      VALUES (''fn_rakeback_shortfall_watch'', ''warning'',\n'
      || E'              ''The rakeback shortfall watch failed'',\n'
      || E'              jsonb_build_object(''error'', SQLERRM));\n'
      || E'    END;\n\n';

  IF position(v_a in v_def) = 0 THEN
    RAISE EXCEPTION 'the watcher is not wired into the sweep the way this migration expects';
  END IF;
  v_new := replace(v_def, v_a, '');
  IF v_new = v_def THEN RAISE EXCEPTION 'the unwiring did not take'; END IF;
  EXECUTE v_new;
END
$migrate$;

DROP FUNCTION IF EXISTS public.fn_rakeback_shortfall_watch();

UPDATE financial_alerts
   SET resolved = true, resolved_at = now(),
       resolution = 'Withdrawn with the watcher that raised it (CLAUDE.md 10.12: no new monitors in place of a fix). The shortfall itself is real and unchanged - Midway Union owes its players 280,142.41 against a 0.50 treasury - and is recorded on every affected period as deferred_reason = insufficient_club_treasury, and reported by fn_rakeback_settlement_status() with fundable:false and the exact figure. Funding the club is not something code can do.'
 WHERE source = 'fn_rakeback_shortfall_watch' AND NOT resolved;

-- 2. A MONEY FUNCTION DOES NOT ANSWER A CALLER WITH NO ACCOUNT ---------------

REVOKE ALL ON FUNCTION public.settle_club_rakeback(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settle_club_rakeback(uuid) TO authenticated, service_role;

-- ASSERTIONS -----------------------------------------------------------------

DO $assert$
DECLARE v_src text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE proname='fn_rakeback_shortfall_watch' AND pronamespace='public'::regnamespace) THEN
    RAISE EXCEPTION 'the watcher is still here';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_integrity_sweep_all' AND pronamespace='public'::regnamespace;
  IF v_src LIKE '%fn_rakeback_shortfall_watch%' THEN
    RAISE EXCEPTION 'the sweep still calls a function that no longer exists';
  END IF;
  -- Phases 1-4 must all still be in the sweep.
  IF v_src NOT LIKE '%fn_union_age_invoices%'
     OR v_src NOT LIKE '%fn_union_enforce_stop_loss%'
     OR v_src NOT LIKE '%fn_close_due_settlement_periods%'
     OR v_src NOT LIKE '%fn_settlement_lock_hygiene%'
     OR v_src NOT LIKE '%expire_settlement_locks%'
     OR v_src NOT LIKE '%fn_union_integrity_sweep(%' THEN
    RAISE EXCEPTION 'unwiring the watcher removed one of the sweep''s real jobs';
  END IF;

  IF has_function_privilege('anon','public.settle_club_rakeback(uuid)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still drive club rakeback settlement';
  END IF;
  IF NOT has_function_privilege('authenticated','public.settle_club_rakeback(uuid)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'a club owner can no longer settle their own club';
  END IF;
  IF NOT has_function_privilege('service_role','public.settle_club_rakeback(uuid)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'the cron and the engine can no longer settle anything';
  END IF;

  -- The shortfall is still legible without the watcher.
  IF (public.fn_rakeback_settlement_status()->'by_club'->0->>'fundable') <> 'false' THEN
    RAISE EXCEPTION 'the status report no longer says the club cannot fund what it owes';
  END IF;
END
$assert$;

COMMIT;
