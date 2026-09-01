-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901012620; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

REVOKE ALL ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text)
  FROM anon;
REVOKE ALL ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text)
  TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.fn_ca_repair_write_failure(bigint, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute the ledger write-failure repair';
  END IF;
  IF has_function_privilege('authenticated',
       'public.fn_ca_repair_write_failure(bigint, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can still execute the ledger write-failure repair';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.fn_ca_repair_write_failure(bigint, text, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost execute on the ledger write-failure repair';
  END IF;
END $$;
