-- 20260928154352_the_time_bank_debit_has_one_door_not_two_overloads.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT BROKE (production, 2026-09-28 14:49:15 UTC onward, engine 763e4cec)
--
-- Migration 20260928144831_time_bank_consume_is_idempotent_by_request_id was
-- applied to production from an unmerged branch (PR #5527). It meant to add an
-- optional `p_request_id uuid DEFAULT NULL` to fn_consume_time_bank with
-- CREATE OR REPLACE, and its header says existing behaviour "is untouched
-- byte-for-byte". It was not: CREATE OR REPLACE with a different argument
-- list does not replace a function, it creates a second one. Production has
-- held two since:
--
--   fn_consume_time_bank(p_user_id uuid, p_seconds integer)            oid 13551865
--   fn_consume_time_bank(p_user_id uuid, p_seconds integer,
--                        p_request_id uuid DEFAULT NULL)               oid 67021144
--
-- The engine calls the door by name through PostgREST with exactly
-- { p_user_id, p_seconds } (ServerTableEngineBase.onTimeBankAccounting and
-- consumeTimeBankSeconds). Both overloads accept that call, so PostgREST
-- refuses every one of them (PGRST203):
--
--   [TimeBank] consume unconfirmed: Could not choose the best candidate
--   function between: public.fn_consume_time_bank(p_user_id => uuid,
--   p_seconds => integer), public.fn_consume_time_bank(p_user_id => uuid,
--   p_seconds => integer, p_request_id => uuid)
--
-- First seen 14:49:15Z; 400 of them by 15:38Z. Every refusal sets the table
-- engine's timeBankAccountingUnconfirmed, which nothing in the process ever
-- clears, so:
--
--   * hasUnretiredStoppedTimeBankCustody() is true for that table for the
--     life of the process, and every stop of its tournament manager fails
--     "Tournament table <id> retained time-bank custody" (1,808 in 90 min);
--   * a manager whose lease proof then lapses cannot retire, is quarantined
--     (167 on /health at 15:40Z), and a DECIDED event it holds is never
--     finished: 42 SNG/Spin winners unpaid while the decided-but-running
--     sweep re-woke a quarantined manager every pass
--     (docs/changelog/2026-09-28-the-time-bank-debit-has-one-door.md);
--   * the restart certificate refuses every break (accounting_unconfirmed:
--     55 tables at 15:40Z; the 14:55Z break ended with 56 unparked and no
--     certificate), so no engine release can cut over.
--
-- THE FIX: one door. The two bodies were compared on production: with
-- p_request_id NULL the three-argument body takes exactly the two-argument
-- body's path (both receipt branches are `IF p_request_id IS NOT NULL`),
-- writes the same rows and returns the same object. Dropping the two-argument
-- overload therefore changes nothing for the running engine except that its
-- call resolves again - to the behaviour it had before 14:49 - and it keeps
-- the three-argument door PR #5527's engine will call. Nothing else in the
-- database calls fn_consume_time_bank (pg_proc prosrc search, 2026-09-28), and
-- both overloads carry the same owner, grants (postgres, service_role
-- EXECUTE), SECURITY DEFINER and search_path, so the surviving door is no
-- wider than the one removed.
--
-- WHERE THE THREE-ARGUMENT DOOR DOES NOT EXIST (a replay of main before
-- 20260928144831 is merged) this migration changes NOTHING: the drop only
-- ever removes the second of two overloads, never the only door. Any other
-- shape (a changed body, owner, grant or a third overload) aborts the whole
-- transaction.
--
-- What this does NOT do: an engine table already tainted stays tainted in
-- the running process (the flag is in memory). Clearing those needs the
-- engine side of PR #5527 / #5530 and a restart; this stops the count growing.

-- The door is live when exactly one fn_consume_time_bank remains, which is
-- true both where the drop ran and where there was nothing to drop.
-- @live-proof: (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_consume_time_bank')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  v_two   oid := to_regprocedure('public.fn_consume_time_bank(uuid,integer)');
  v_three oid := to_regprocedure('public.fn_consume_time_bank(uuid,integer,uuid)');
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_consume_time_bank';

  IF v_three IS NULL THEN
    -- Only the original door exists: nothing is ambiguous, nothing to do.
    IF v_two IS NULL OR v_count <> 1 THEN
      RAISE EXCEPTION 'fn_consume_time_bank: unexpected overload set (count %, three-argument door absent)', v_count;
    END IF;
    RETURN;
  END IF;

  IF v_two IS NULL THEN
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'fn_consume_time_bank: unexpected overload set (count %, two-argument door absent)', v_count;
    END IF;
    RETURN; -- already one door
  END IF;

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'fn_consume_time_bank: expected exactly two overloads, found %', v_count;
  END IF;

  -- Exact pre-image of both overloads (read on production 2026-09-28 15:4xZ).
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_two) <> '7832bfb717daaeb625372bdd3ccc7d60'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_three) <> '6adbdcd86c910c09e56b4f10193d2e55' THEN
    RAISE EXCEPTION 'fn_consume_time_bank: body pre-image changed; refusing to drop an overload that was not read';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid IN (v_two, v_three)
       AND (NOT prosecdef
            OR pg_get_userbyid(proowner) <> 'postgres'
            OR proconfig IS DISTINCT FROM ARRAY['search_path=public']
            OR proacl::text IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}')
  ) THEN
    RAISE EXCEPTION 'fn_consume_time_bank: owner, grant or config pre-image changed';
  END IF;
  -- The surviving door must give the two-argument call its old meaning.
  IF pg_get_function_arguments(v_three)
       <> 'p_user_id uuid, p_seconds integer, p_request_id uuid DEFAULT NULL::uuid' THEN
    RAISE EXCEPTION 'fn_consume_time_bank: the three-argument door no longer defaults p_request_id to NULL';
  END IF;

  EXECUTE 'DROP FUNCTION public.fn_consume_time_bank(uuid, integer)';
END
$pre$;

DO $post$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_consume_time_bank';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'fn_consume_time_bank: post-image has % overloads, expected exactly one', v_count;
  END IF;
  IF to_regprocedure('public.fn_consume_time_bank(uuid,integer,uuid)') IS NOT NULL
     AND (SELECT proacl::text FROM pg_proc
           WHERE oid = to_regprocedure('public.fn_consume_time_bank(uuid,integer,uuid)'))
         IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'fn_consume_time_bank: surviving door grants changed';
  END IF;
END
$post$;

COMMIT;
