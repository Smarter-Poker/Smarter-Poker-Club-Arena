-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901134818; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The pre-push definer gate refused the mirror of
-- a_place_pays_once_and_a_finisher_places_once because it re-declares
-- fn_credit_and_log, a SECURITY DEFINER function that writes and never asks
-- who is calling.
--
-- Checked against production before answering it, rather than assuming either
-- way: anon, authenticated and PUBLIC already have NO execute on this
-- function, and service_role has it. The grants are correct and nothing is
-- exposed. CREATE OR REPLACE does not touch grants, so the migration did not
-- change them either.
--
-- The gate is reading the migration text, not the live catalogue, and it is
-- right to: a migration that declares a definer writer should say who may
-- call it rather than leaving a reader to go and check. This states the end
-- state that already holds. It is a no-op against production by design.

REVOKE ALL ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid, integer, text) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can still execute the credit funnel';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role lost execute on the credit funnel - the engine cannot pay anyone';
  END IF;
END $$;
