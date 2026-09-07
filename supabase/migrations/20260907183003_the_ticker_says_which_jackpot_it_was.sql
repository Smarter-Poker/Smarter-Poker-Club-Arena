-- ═══════════════════════════════════════════════════════════════════════════
--  THE TICKER SAYS WHICH JACKPOT IT WAS
--  BBJ build plan phase 6 of 6 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A mini is a few hundred chips out of the backup reserve. The main jackpot is
-- a share of a six-figure pool. Listing both on the Previous Winners page and
-- in the ticker with no way to tell them apart would have the screen telling
-- players something untrue, which is the fault every phase-5 signal was about.
--
-- `fn_bbj_recent_hits` gains a trailing `kind` column, read from
-- `bbj_winners.kind`, defaulting to `main` for every hit that predates the
-- mini - which is all 29 of them.
--
-- REBUILT BY SUBSTITUTION, NOT RETYPED. Postgres will not change a function's
-- RETURNS TABLE with CREATE OR REPLACE, so this has to DROP and CREATE. Copying
-- 4,400 characters of a live client-facing function by hand to add one column
-- is a drift waiting to happen, so the migration reads `pg_get_functiondef`,
-- makes two mechanical string edits, and refuses if either fails to match. The
-- DROP and the CREATE commit in ONE transaction, so there is no window in which
-- the RPC is missing from the schema.
--
-- Additive for every existing caller: PostgREST returns the columns a client
-- selects, and `BBJRecentHits` names its own.
--
-- Verified after applying: the RPC still answers on the union pool, the three
-- most recent hits read 7,883.92 / 6,275.88 / 3,640.00 as before, every one
-- carries `kind: main`, `anon` still cannot execute it and `authenticated`
-- still can.
--
-- ROLLBACK: re-create the previous definition from the migration that last
-- defined it; the only difference is the trailing column.

BEGIN;
SET LOCAL lock_timeout = '8s';

DO $$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_recent_hits';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_bbj_recent_hits not found'; END IF;

  v_new := replace(v_def, 'recipients jsonb, total_hits integer)',
                          'recipients jsonb, total_hits integer, kind text)');
  IF v_new = v_def THEN RAISE EXCEPTION 'the RETURNS TABLE did not match what was expected'; END IF;

  v_def := v_new;
  v_new := replace(v_def, E'    (SELECT n FROM pool_total)\n  FROM hits x',
                          E'    (SELECT n FROM pool_total),\n    COALESCE(x.kind, ''main'')\n  FROM hits x');
  IF v_new = v_def THEN RAISE EXCEPTION 'the final SELECT did not match what was expected'; END IF;

  DROP FUNCTION public.fn_bbj_recent_hits(uuid, integer, timestamptz, uuid);
  EXECUTE v_new;
END $$;

REVOKE ALL ON FUNCTION public.fn_bbj_recent_hits(uuid, integer, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_recent_hits(uuid, integer, timestamptz, uuid) TO authenticated, service_role;

DO $$
DECLARE v_kind text; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.fn_bbj_recent_hits(
    'f9806a7f-e7a2-47d2-a676-36336e3a5337'::uuid, 5, NULL, NULL);
  IF v_n = 0 THEN RAISE EXCEPTION 'the recent-hits RPC came back empty after the rebuild'; END IF;

  SELECT kind INTO v_kind FROM public.fn_bbj_recent_hits(
    'f9806a7f-e7a2-47d2-a676-36336e3a5337'::uuid, 1, NULL, NULL);
  IF v_kind IS DISTINCT FROM 'main' THEN
    RAISE EXCEPTION 'every hit that predates the mini must read as main, got %', v_kind;
  END IF;

  IF has_function_privilege('anon', 'public.fn_bbj_recent_hits(uuid,integer,timestamptz,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the recent-hits RPC is readable without an account';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_bbj_recent_hits(uuid,integer,timestamptz,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a logged-in player can no longer read the previous winners';
  END IF;
END $$;

COMMIT;
