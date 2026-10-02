-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260823032921 as "rls_on_by_default_for_new_public_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- See supabase/migrations/20260823050000_rls_on_by_default.sql (Club Arena)
-- for the full rationale.

CREATE OR REPLACE FUNCTION public.fn_rls_on_new_public_table()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  obj record;
  v_name text;
BEGIN
  -- Deliberate escape hatch, mirroring fn_autorevoke_privileged_anon's
  -- app.allow_privileged_anon_grant. A table that genuinely must ship without
  -- RLS sets this for the session and is then on the record for doing so.
  IF COALESCE(current_setting('app.allow_rls_off_table', true), 'off') = 'on' THEN
    RETURN;
  END IF;

  FOR obj IN
    SELECT * FROM pg_event_trigger_ddl_commands()
     WHERE schema_name = 'public' AND object_type = 'table'
  LOOP
    BEGIN
      SELECT c.relname INTO v_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.oid = obj.objid
         AND n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND NOT c.relrowsecurity;

      IF v_name IS NULL THEN
        CONTINUE;
      END IF;

      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
      RAISE NOTICE 'RLS enabled automatically on public.% (no policies yet, so only service_role and the owner can see it). Add a policy if clients need access.', v_name;
    EXCEPTION WHEN OTHERS THEN
      -- This trigger fires on EVERY CREATE TABLE in the estate. It must never
      -- be the reason a migration fails, so a problem here is reported and
      -- swallowed - CHECK 10 remains the backstop.
      RAISE WARNING 'fn_rls_on_new_public_table could not secure %: %', COALESCE(v_name, obj.object_identity), SQLERRM;
    END;
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.fn_rls_on_new_public_table() IS
  'Enables RLS on every newly created table in public. CREATE TABLE here inherits arwdxtm for anon and authenticated from the schema default privileges, so a new table is world-writable until someone notices - which on 2026-08-22 took two separate incidents and blocked every merge in the World Hub twice. Escape hatch: SET app.allow_rls_off_table = on.';

DROP EVENT TRIGGER IF EXISTS trg_rls_on_new_public_table;
CREATE EVENT TRIGGER trg_rls_on_new_public_table
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.fn_rls_on_new_public_table();

-- ── Post-apply assertions ───────────────────────────────────────────────────
DO $$
DECLARE v_enabled char;
BEGIN
  SELECT evtenabled INTO v_enabled FROM pg_event_trigger WHERE evtname = 'trg_rls_on_new_public_table';
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'trg_rls_on_new_public_table was not created';
  END IF;
  IF v_enabled = 'D' THEN
    RAISE EXCEPTION 'trg_rls_on_new_public_table was created DISABLED';
  END IF;

  -- The guard it backs up must still be clean.
  IF EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname <> 'spatial_ref_sys'
       AND (has_table_privilege('anon', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
         OR has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE'))
  ) THEN
    RAISE EXCEPTION 'no_rls_off_tables_writable_by_clients is failing at apply time';
  END IF;
END $$;
