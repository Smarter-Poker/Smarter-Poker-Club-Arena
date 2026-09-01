-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825214739; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Housekeeping: remove the throwaway helper functions an agent created while
-- probing the table-size and no-rathole rules on 2026-08-25. They exist only
-- to call atomic_table_buyin and capture its error message, and nothing
-- references them.
DROP FUNCTION IF EXISTS public.zz_probe_buyin_msg(uuid, int, uuid);
DROP FUNCTION IF EXISTS public.zz_probe_buyin_msg(uuid, int, uuid, numeric);
DROP FUNCTION IF EXISTS public.zz_probe2(uuid, int, uuid, numeric);
DROP FUNCTION IF EXISTS public.zz_probe3();
DROP FUNCTION IF EXISTS public.zz_probe4();

DO $verify$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname LIKE 'zz_probe%';
  IF n > 0 THEN
    RAISE EXCEPTION 'probe helpers still present: %', n;
  END IF;
END
$verify$;
