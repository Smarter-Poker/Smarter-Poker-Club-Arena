-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260428210339 "x3_001_drop_phantom_overloads"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 610972f2ac584c8361efa7fe2026d4e8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DROP FUNCTION IF EXISTS public.record_rake(uuid, uuid, numeric, uuid);
DROP FUNCTION IF EXISTS public.record_rake(text, uuid, uuid, numeric, numeric, integer);
DROP FUNCTION IF EXISTS public.calculate_cascading_commission(numeric, uuid);
DROP FUNCTION IF EXISTS public.calculate_cascading_commission(uuid, numeric);
DROP FUNCTION IF EXISTS public.calculate_cascading_commission(text, uuid, uuid, numeric);
