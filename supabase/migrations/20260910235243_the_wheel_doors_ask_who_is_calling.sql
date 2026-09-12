-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260910235243; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260910235243   (the stamp IS the apply time, UTC: 2026-09-10 23:52:43)
--   name        the_wheel_doors_ask_who_is_calling
--   created_by  (not recorded)
--   statements  1 statement(s), 4049 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260910235243 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_wheel_spin, public.fn_wheel_free_spin
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- 20260910235243_the_wheel_doors_ask_who_is_calling.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  A DOOR ASKS WHO IS KNOCKING, EVEN WHEN THE ROOM BEHIND IT DOES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260910223856 split the wheel into one core and two thin SQL wrappers so a
-- welcome spin is provably the same wheel as a paid one. The core asks
-- auth.uid() on its first line and refuses a caller with no account, which is
-- correct; the wrappers did not, which is not.
--
-- check-definer-authorization blocked the push for it, and it was right to:
--
--   fn_wheel_spin ... SECURITY DEFINER, anon can execute it, and it never
--   calls auth.uid(), auth.role() or auth.jwt(). It runs as the owner, past
--   RLS, for a caller with no account - and it never asks who that caller is.
--
-- "The thing I call asks" is not the same promise as "I ask". A wrapper that
-- delegates its authorization is one refactor away from delegating it to
-- something that stopped asking, and nobody reading the wrapper can see that.
-- So each door asks first, in the same words the core would have used, and
-- then delegates. Two lines, and the check reads them.
--
-- Fix-forward: 20260910223856 is applied and stays as it is (CLAUDE.md).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_wheel_spin(p_club_id uuid, p_commit_id uuid, p_client_seed text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  RETURN public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, false);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_wheel_free_spin(p_club_id uuid, p_commit_id uuid, p_client_seed text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  RETURN public.fn_wheel_spin_core(p_club_id, p_commit_id, p_client_seed, true);
END $function$;

-- CREATE OR REPLACE keeps the ACL, but the autorevoke event trigger strips
-- PUBLIC and anon on the way past, so the grants are restated rather than
-- assumed.
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_free_spin(uuid, uuid, text) TO authenticated, service_role;

DO $$
DECLARE v_def text;
BEGIN
  FOR v_def IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND p.proname IN ('fn_wheel_spin', 'fn_wheel_free_spin')
                  AND p.pronargs = 3
  LOOP
    IF v_def NOT LIKE '%auth.uid() IS NULL%' THEN
      RAISE EXCEPTION 'a wheel door still does not ask who is calling';
    END IF;
  END LOOP;
  -- And the core is still the only thing that takes the welcome flag, still
  -- out of a browser's reach.
  IF has_function_privilege('authenticated', 'public.fn_wheel_spin_core(uuid, uuid, text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_wheel_spin_core is reachable by authenticated, so a browser can ask for a free spin';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_wheel_spin(uuid, uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_wheel_free_spin(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a wheel door lost its grant to authenticated';
  END IF;
END $$;

COMMIT;
