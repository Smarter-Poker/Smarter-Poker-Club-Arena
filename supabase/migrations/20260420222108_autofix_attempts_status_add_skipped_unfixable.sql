-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420222108 "autofix_attempts_status_add_skipped_unfixable"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 585f87f60b8b628d77010ecfd92f003b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

ALTER TABLE public.autofix_attempts DROP CONSTRAINT IF EXISTS autofix_attempts_status_check;
ALTER TABLE public.autofix_attempts
  ADD CONSTRAINT autofix_attempts_status_check
  CHECK (status = ANY (ARRAY['queued','running','pr_opened','merged','rejected','errored','skipped_unfixable']::text[]));
