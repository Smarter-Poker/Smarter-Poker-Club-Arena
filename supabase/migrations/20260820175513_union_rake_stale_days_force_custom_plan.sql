-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820175513 "union_rake_stale_days_force_custom_plan"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fd58f44d64b98a123bb787ee01db6ded of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The set-based scan is 2.3s when written with literal values but 19.2s when
-- the same SQL runs inside this function with parameters: the planner caches a
-- GENERIC plan that cannot use the actual union_id / date bounds to pick index
-- scans and row estimates. force_custom_plan makes it re-plan with the real
-- values on every call, which is exactly what a once-per-cycle maintenance
-- query wants.
ALTER FUNCTION public.fn_union_rake_stale_days(uuid, date, date)
  SET plan_cache_mode TO 'force_custom_plan';
