-- the_guard_declaration_is_not_reachable_from_a_browser
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- 20260910143032 added fn_ca_declare_guard_redefinition and closed it with
--
--   REVOKE ALL ON FUNCTION public.fn_ca_declare_guard_redefinition(text, text)
--     FROM PUBLIC;
--
-- check-definer-authorization refused the push and it was right. That function
-- is SECURITY DEFINER, it WRITES (ca_guard_defs, ca_guard_def_history), and it
-- never asks who is calling - it cannot, there is nothing about a caller for it
-- to check. Revoking PUBLIC alone does not close it: `anon` and `authenticated`
-- hold EXECUTE in their own right, so the browser roles kept it. That is the
-- exact failure the guard's own text warns about - "revoking one role while
-- PUBLIC still holds it reads as a fix and does nothing" - and here it was the
-- other way round, which reads the same and does the same.
--
-- What it could have done in the wrong hands: move a guard's baseline. Not
-- money, but the thing that decides whether a CHANGED ALARM gets reported.
-- Somebody who could call it could redefine a watched guard and then silence
-- the notice about it. Option 1 in the guard's remedy list applies exactly:
-- nobody in a browser should ever call this. It is for a migration, in the same
-- transaction as the redefinition it declares.
--
-- GRANT and REVOKE do not fire pgrst_ddl_watch, so this costs no schema-cache
-- reload (club-arena CLAUDE.md, production DDL policy rule 5).
--
-- Wrap ALL DDL for one change in ONE transaction.

BEGIN;
SET LOCAL lock_timeout = '5s';

REVOKE ALL ON FUNCTION public.fn_ca_declare_guard_redefinition(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_declare_guard_redefinition(text, text)
  TO service_role;

DO $body$
DECLARE
  v_browser integer;
BEGIN
  -- prove it: neither browser role may execute it, by any route
  SELECT count(*) INTO v_browser
    FROM (VALUES ('anon'), ('authenticated'), ('public')) AS r(role_name)
   WHERE has_function_privilege(r.role_name,
           'public.fn_ca_declare_guard_redefinition(text, text)', 'EXECUTE');
  IF v_browser <> 0 THEN
    RAISE EXCEPTION '% browser role(s) can still execute the guard declaration', v_browser;
  END IF;

  IF NOT has_function_privilege('service_role',
        'public.fn_ca_declare_guard_redefinition(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute the guard declaration; a migration could not declare its own change';
  END IF;
END
$body$;

COMMIT;
