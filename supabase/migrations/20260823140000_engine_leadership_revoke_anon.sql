-- ═══════════════════════════════════════════════════════════════════════════
-- ENGINE LEADERSHIP IS NOT A PUBLIC API (2026-08-23)
-- ═══════════════════════════════════════════════════════════════════════════
-- The World Hub's Build Safety Gate (CHECK 10, economy invariants) went red on
-- `anon_mutating_definer_functions_check_auth_uid`. The two functions it named
-- are the engine's leader election:
--
--     public.claim_engine_leadership(text, text, integer)
--     public.release_engine_leadership(text)
--
-- Both are SECURITY DEFINER, both WRITE, and neither checks auth.uid() — by
-- design, because the only intended caller is the Hetzner engine holding the
-- service-role key (server/src/services/leadership.ts). No browser code calls
-- either one; a grep of src/ finds zero callers.
--
-- WHY THE ORIGINAL LOCKDOWN MISSED
--
-- 20260823_engine_leadership.sql already did the obvious thing:
--
--     REVOKE ALL ON FUNCTION ... FROM public;
--     GRANT EXECUTE ON FUNCTION ... TO service_role;
--
-- That is not enough on Supabase. The project ships
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO
-- anon, authenticated`, so every new function is created with EXPLICIT grants
-- to those two roles. `REVOKE ... FROM public` removes the PUBLIC
-- pseudo-role's grant and leaves the explicit ones untouched. The ACL proves
-- it — measured before this migration:
--
--     {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
-- So any anonymous visitor could call claim_engine_leadership and take the
-- lease out from under the running engine, or call release_engine_leadership
-- and drop it. That is a denial of service against every live table, reachable
-- from a browser console with the public anon key.
--
-- THE FIX: revoke the two roles by name. service_role keeps its grant, so the
-- engine is unaffected.
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.claim_engine_leadership(text, text, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.claim_engine_leadership(text, text, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.release_engine_leadership(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.release_engine_leadership(text) FROM authenticated;

-- The engine must still be able to elect a leader.
GRANT EXECUTE ON FUNCTION public.claim_engine_leadership(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_engine_leadership(text) TO service_role;

-- Assert the outcome rather than trusting the statements above: a REVOKE that
-- silently did nothing is exactly how this got shipped the first time.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(p.proname || ' (' || r.rolname || ')', ', ')
    INTO offender
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
  WHERE n.nspname = 'public'
    AND p.proname IN ('claim_engine_leadership', 'release_engine_leadership')
    AND has_function_privilege(r.rolname, p.oid, 'EXECUTE');

  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'engine leadership still callable by a client role: %', offender;
  END IF;

  IF NOT has_function_privilege('service_role',
        'public.claim_engine_leadership(text, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost EXECUTE on claim_engine_leadership - the engine could not elect a leader';
  END IF;
END $$;
