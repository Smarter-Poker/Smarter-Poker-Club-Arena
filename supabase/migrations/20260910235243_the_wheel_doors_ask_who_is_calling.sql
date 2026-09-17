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

-- CREATE OR REPLACE keeps the ACL, and the autorevoke event trigger strips
-- PUBLIC and anon on the way past anyway, but neither of those is visible to
-- somebody reading the file, and check-definer-authorization reads the file:
-- Postgres's own default on CREATE FUNCTION is EXECUTE TO PUBLIC, so a door
-- that only ever GRANTs reads as reachable by anyone. Said out loud here, for
-- both doors, so the ACL in the file is the ACL in the database.
REVOKE ALL ON FUNCTION public.fn_wheel_spin(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_wheel_free_spin(uuid, uuid, text) FROM PUBLIC, anon;
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
