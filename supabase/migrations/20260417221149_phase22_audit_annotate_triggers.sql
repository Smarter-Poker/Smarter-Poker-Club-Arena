-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260417221149 "phase22_audit_annotate_triggers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 672ec91a36eeab92f21f9b9ceb6d3942 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.
-- unqualified-write-ok: public.phase22_secdef_grant_audit because it ran once, at migration top level, as postgres
--   when production applied 20260417221149; it is in no function body and cannot be reached
--   through PostgREST. This file records that SQL; it is not new work.

-- Annotate the Phase 22 audit table with trigger-function flags.
-- Trigger functions (RETURNS trigger, no user-meaningful args) are SAFE
-- to revoke anon/authenticated EXECUTE from because trigger firing goes
-- through table ownership, not EXECUTE grants. Calling a trigger function
-- directly from code returns an error anyway ("trigger functions can only
-- be called as triggers").
--
-- This migration ONLY annotates the audit table — no production functions
-- are modified.

ALTER TABLE public.phase22_secdef_grant_audit
  ADD COLUMN IF NOT EXISTS is_trigger_function boolean,
  ADD COLUMN IF NOT EXISTS safe_to_revoke_anon boolean;

COMMENT ON COLUMN public.phase22_secdef_grant_audit.is_trigger_function IS
  'Function returns trigger type AND is only called via pg_trigger firing. Revoking anon/authenticated EXECUTE on these cannot break anything because triggers bypass the EXECUTE grant check.';
COMMENT ON COLUMN public.phase22_secdef_grant_audit.safe_to_revoke_anon IS
  'Derived: true if this is a trigger function (cannot be meaningfully called by users), OR if the function body itself blocks all execution (e.g., exec_sql/run_sql which RAISE EXCEPTION).';

-- Populate is_trigger_function
UPDATE public.phase22_secdef_grant_audit a
   SET is_trigger_function = true
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = a.function_name
   AND p.prorettype = 'trigger'::regtype;

-- Mark false for everything else (the UPDATE above only touches matches)
UPDATE public.phase22_secdef_grant_audit
   SET is_trigger_function = false
 WHERE is_trigger_function IS NULL;

-- Mark safe_to_revoke_anon = true for trigger functions + the known-disabled
-- sql-exec wrappers (exec_sql/run_sql/pgmigrate all RAISE EXCEPTION).
UPDATE public.phase22_secdef_grant_audit
   SET safe_to_revoke_anon = CASE
         WHEN is_trigger_function = true THEN true
         WHEN function_name IN ('exec_sql', 'run_sql', 'pgmigrate') THEN true
         ELSE false
       END;
