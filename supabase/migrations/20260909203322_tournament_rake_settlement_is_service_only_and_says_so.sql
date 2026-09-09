BEGIN;

/* 20260909202824 re-declared fn_settle_tournament_rake as SECURITY DEFINER and
   asserted, at apply time, that anon and authenticated cannot execute it -
   which was true, from an earlier REVOKE. check-definer-authorization reads
   the FILES, not the live catalogue, and will not take an assertion's word
   for it: a definer that writes must carry its own REVOKE and GRANT in the
   migration set that declares it, so the record says what production does.
   GRANT and REVOKE are not in pgrst_ddl_watch's list (CLAUDE.md section 2
   rule 5), so this costs no schema-cache reload. */

REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid, text) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_settle_tournament_rake(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_settle_tournament_rake(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can settle tournament rake';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_settle_tournament_rake(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the engine can no longer settle tournament rake';
  END IF;
END $$;

COMMIT;
