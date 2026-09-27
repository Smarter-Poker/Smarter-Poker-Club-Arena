-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424020604 "20260421189000_hg_revoke_public_grants_on_all_trigger_fns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 02023e080445a77fe56288b20784af46 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Sweep: revoke PUBLIC/anon/authenticated EXECUTE on ALL HG trigger
-- functions. Triggers fire via catalog lookup, not via role grants, so
-- no behavior change — pure hygiene. Achieves zero-trigger-fn-anon-exec.

DO $do$
DECLARE v_rec RECORD;
BEGIN
  FOR v_rec IN
    SELECT p.oid, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.prorettype = 'trigger'::regtype::oid
      AND (p.proname LIKE '%home_%' OR p.proname LIKE '%_home_%' OR p.proname LIKE 'fn_hg_%')
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    BEGIN
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION public.%I() FROM anon, authenticated, PUBLIC',
        v_rec.proname);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'skip %: %', v_rec.proname, SQLERRM;
    END;
  END LOOP;
END $do$;

-- Verify zero remaining
SELECT COUNT(*) AS remaining_trigger_fns_with_anon_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
  AND p.prorettype = 'trigger'::regtype::oid
  AND (p.proname LIKE '%home_%' OR p.proname LIKE '%_home_%' OR p.proname LIKE 'fn_hg_%')
  AND has_function_privilege('anon', p.oid, 'EXECUTE');
