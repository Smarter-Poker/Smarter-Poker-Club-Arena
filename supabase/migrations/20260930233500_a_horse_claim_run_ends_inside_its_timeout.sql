-- ============================================================================
-- A HORSE CLAIM RUN ENDS INSIDE ITS TIMEOUT
-- ============================================================================
--
-- Version 20260930233500, the second version the swarm lead assigned to this
-- line. It follows 20260930233000_a_streak_milestone_never_takes_the_daily_reward_down.
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- WHAT WATCHING PRODUCTION FOUND (2026-10-01 00:06-00:13 UTC, read-only).
--
-- With the milestone out of the claim, every one of the 3,053 owed horse
-- rewards became payable at once, and fn_ca_horse_claim_due took its full 500
-- each minute. The runs at 00:07 and 00:09 died at exactly 120 seconds with
-- `canceling statement due to statement timeout` (pg_cron runs the job as
-- postgres, whose statement_timeout is 2min) and rolled back whole: they paid
-- nothing.
--
-- The time goes to the register. fn_ca_register_diamond_journal_row stamps
-- every journal row's supply_after by summing every Diamond row of
-- ca_mint_ledger - about 172,000 rows, 176 ms measured serially. A claim
-- writes one journal row and a milestone a second, so 500 claims and 160
-- milestones are well over two minutes of summing alone. Before 2026-09-29 the
-- sweep never met this: 99% of rewards were paid on the first tick after they
-- completed, never more than 294 in a minute, and while the milestone was
-- refusing claims a refused claim stopped before its credit was registered.
-- The backlog is the first time the sweep has had 500 payable rows.
--
-- THE FIX is in the sweep, because the sweep is what has to finish. It stops
-- starting claims 45 seconds into a run and commits what it paid; the rest are
-- still the oldest rows owed a minute later, so the next run takes them. 45
-- seconds leaves the two-minute limit a wide margin and keeps a run inside its
-- minute, so pg_cron - which skips a minute while the previous run is still
-- going - loses none. Nothing else in the function changes.
--
-- The register's sum is a cost every Diamond movement on the platform pays.
-- It is reported, not changed here: it is outside this line.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_ca_horse_claim_due   e29e852597c32cabda264ab14a9344ec
--
-- @live-proof: position('v_started timestamptz := clock_timestamp();' IN pg_get_functiondef('public.fn_ca_horse_claim_due(integer)'::regprocedure)) > 0 AND position('EXIT WHEN clock_timestamp() - v_started > interval ''45 seconds'';' IN pg_get_functiondef('public.fn_ca_horse_claim_due(integer)'::regprocedure)) > 0
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. THE SWEEP STOPS STARTING CLAIMS AT 45 SECONDS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_old1 text; v_new1 text; v_old2 text; v_new2 text; v_n integer;
BEGIN
  v_oid := 'public.fn_ca_horse_claim_due(integer)'::regprocedure;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'e29e852597c32cabda264ab14a9344ec' THEN
    RAISE EXCEPTION 'fn_ca_horse_claim_due is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old1 := E'  v_cap_resets timestamptz; v_by text; v_retry timestamptz; v_refused text;\n';
  v_new1 := E'  v_cap_resets timestamptz; v_by text; v_retry timestamptz; v_refused text;\n'
         || E'  v_started timestamptz := clock_timestamp();\n';
  v_old2 := E'  LOOP\n    BEGIN\n      PERFORM public.claim_daily_challenge_serialized_body(r.user_id, r.id, NULL);\n';
  v_new2 := E'  LOOP\n'
         || E'    -- A RUN ENDS INSIDE ITS TIMEOUT (2026-10-01). pg_cron runs this as postgres, whose\n'
         || E'    -- statement_timeout is two minutes, and a run that meets it pays nothing: it rolls back\n'
         || E'    -- whole. Every claim registers its credit through a sum over ca_mint_ledger, so 500 of\n'
         || E'    -- them do not fit. Stop starting claims at 45 seconds and commit what was paid; the rest\n'
         || E'    -- are still the oldest owed a minute later.\n'
         || E'    EXIT WHEN clock_timestamp() - v_started > interval ''45 seconds'';\n'
         || E'    BEGIN\n      PERFORM public.claim_daily_challenge_serialized_body(r.user_id, r.id, NULL);\n';
  v_n := (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'sweep: the declaration anchor occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'sweep: the loop head occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
  IF md5(replace(replace(pg_get_functiondef(v_oid), v_new1, v_old1), v_new2, v_old2)) <> 'e29e852597c32cabda264ab14a9344ec' THEN
    RAISE EXCEPTION 'sweep: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. THE EDIT LANDED, AND THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_txt text; v_bad text;
BEGIN
  v_txt := pg_get_functiondef('public.fn_ca_horse_claim_due(integer)'::regprocedure);
  IF position('v_started timestamptz := clock_timestamp();' IN v_txt) = 0
     OR position('EXIT WHEN clock_timestamp() - v_started > interval ''45 seconds'';' IN v_txt) = 0
     OR position('EXIT WHEN clock_timestamp() - v_started' IN v_txt) > position('PERFORM public.claim_daily_challenge_serialized_body(r.user_id, r.id, NULL);' IN v_txt) THEN
    RAISE EXCEPTION 'the sweep does not stop starting claims at 45 seconds';
  END IF;
  IF position('SKIP LOCKED' IN v_txt) = 0 OR position('ORDER BY u.completed_at, u.id' IN v_txt) = 0
     OR position('d.retry_after > now()' IN v_txt) = 0 OR position('milestones_refused integer' IN v_txt) = 0
     OR position('fn_platform_frozen' IN v_txt) = 0 OR position('pg_try_advisory_xact_lock' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the sweep lost something 20260930233000 gave it';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fn_ca_horse_claim_due') <> 1 THEN
    RAISE EXCEPTION 'fn_ca_horse_claim_due is not exactly one function';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_horse_claim_due(integer)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_horse_claim_due(integer)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_ca_horse_claim_due(integer)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'the sweep''s grants moved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'ca-horse-claim-due-minute' AND active
                    AND schedule = '* * * * *' AND command = 'SELECT public.fn_ca_horse_claim_due(500)') THEN
    RAISE EXCEPTION 'ca-horse-claim-due-minute is not scheduled as it was';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'a horse claim run ends inside its timeout: it stops starting claims at 45 seconds and commits what it paid';
END $m$;

COMMIT;
