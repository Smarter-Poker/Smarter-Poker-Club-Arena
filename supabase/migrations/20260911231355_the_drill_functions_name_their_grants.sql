-- ═══════════════════════════════════════════════════════════════════════════
--  THE DRILL FUNCTIONS NAME THEIR GRANTS
--  BBJ programme, post-audit phase 2 of 5 (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `CREATE OR REPLACE` preserves whatever the live function already held, so
-- re-declaring `fn_bbj_claim_drill` and `fn_bbj_arm_drill` while saying
-- nothing about their grants left the posture correct on THIS database and
-- undefined in any database rebuilt from the migration files.
--
-- `check-definer-authorization` refuses that, and it refused this - correctly.
-- `fn_bbj_claim_drill` is a SECURITY DEFINER that WRITES (it fires the arm)
-- and it never asks who is calling, so a browser role reaching it would let a
-- player burn an operator's armed drill on a hand of their choosing.
--
-- Live grants were already right - anon false, authenticated false,
-- service_role true - so these statements change nothing here. They make the
-- files say what the database does, which is the whole point of the rule.
-- GRANT/REVOKE do not fire `pgrst_ddl_watch`, so this reloads no schema cache
-- (CLAUDE.md section 2 rule 5).

BEGIN;

-- Nobody in a browser claims a drill. The ENGINE does, as service_role, on the
-- settlement path. PUBLIC is named as well as the roles: revoking one role
-- while PUBLIC still holds it reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_bbj_claim_drill(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_claim_drill(uuid, bigint) TO service_role;

-- ARMING is different and stays reachable from a browser: it is how a platform
-- admin arms a drill from an operator surface, and it asks who is calling on
-- its first line (`fn_is_platform_admin` reads `auth.uid()`). anon holds
-- nothing - a signed-out visitor has no admin surface to arm from.
REVOKE ALL ON FUNCTION public.fn_bbj_arm_drill(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_arm_drill(uuid, text, text) TO authenticated, service_role;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname || ':' || r.rolname, ', ')
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
   WHERE p.proname = 'fn_bbj_claim_drill'
     AND has_function_privilege(r.rolname, p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a browser role still holds EXECUTE on the drill claim: %', v_bad;
  END IF;

  IF NOT has_function_privilege('service_role', 'public.fn_bbj_claim_drill(uuid, bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the engine can no longer claim a drill';
  END IF;

  IF has_function_privilege('anon', 'public.fn_bbj_arm_drill(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a signed-out visitor can arm a drill';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.fn_bbj_arm_drill(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a platform admin can no longer arm a drill from an operator surface';
  END IF;
END $$;

COMMIT;
